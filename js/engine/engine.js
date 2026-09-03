// SIMULATION ENGINE
// -----------------------------------------------------------------------------
// Two coupled models run every tick:
//
//  1. FLOW MODEL (deterministic, O(nodes + edges))
//     Propagates request *rates* through the graph. Each node is an M/G/c
//     station: capacity = workers / occupancy, utilisation ρ = λ/capacity,
//     queue depth integrated over time, drops on overflow. Cost is independent
//     of RPS, so 100 RPS and 5,000,000 RPS both run at 60fps.
//
//  2. PATH SAMPLER (stochastic, ~240 virtual requests per tick)
//     Walks individual requests through the live graph, drawing service times
//     from lognormal distributions and queue waits from the flow model. This is
//     what produces honest p50/p95/p99 tails, fan-out amplification, and the
//     packets you see travelling along the edges.
//
// A third pass (reverse topological) feeds *downstream* latency back into each
// caller's occupancy time. That single feedback loop is what makes thread-pool
// exhaustion and cascading failure emerge on their own rather than being faked.

import { makeRng, clamp, Ring, percentiles } from '../core/util.js';
import { kingmanWait, effectiveHitRatio, retryAmplification } from '../core/queueing.js';
import { BY_ID, deriveModel, defaultCfg } from '../model/catalog.js';

const SECONDS_PER_MONTH = 2.6e6;
const MAX_LAT_MS = 120000;
const SAMPLES_PER_TICK = 240;
const LAT_WINDOW = 4000;

export const OUTCOMES = ['ok', 'throttled', 'dropped', 'timeout', 'error'];

export class Engine {
  constructor() {
    this.graph = null;
    this.nodes = new Map();
    this.edges = new Map();
    this.order = [];
    this.rng = makeRng(12345);
    this.t = 0;                  // simulated seconds
    this.seed = 12345;
    this.chaos = [];             // active chaos instances
    this.samples = [];           // last tick's sampled walks (for animation)
    this.latRing = new Ring(LAT_WINDOW);
    this.metrics = blankMetrics();
    this.history = {
      p50: new Ring(600), p95: new Ring(600), p99: new Ring(600),
      rps: new Ring(600), ok: new Ring(600), err: new Ring(600), cost: new Ring(600),
    };
    this.eventLog = [];
  }

  // ---------------------------------------------------------------- topology

  load(graph) {
    this.graph = graph;
    this.rebuild();
    this.reset();
  }

  rebuild() {
    const g = this.graph;
    const prev = this.nodes;
    this.nodes = new Map();
    for (const gn of g.nodes) {
      const def = BY_ID[gn.type];
      if (!def) continue;
      const cfg = { ...defaultCfg(gn.type), ...(gn.cfg || {}) };
      const model = deriveModel(gn.type, cfg);
      const old = prev.get(gn.id);
      this.nodes.set(gn.id, {
        id: gn.id, type: gn.type, def, cfg, model,
        out: [], in: [],
        // live state
        inRate: 0, acceptRate: 0, outRate: 0, servedRate: 0,
        dropRate: 0, throttleRate: 0, errorRate: 0,
        errFrac: 0, dropFrac: 0, throttleFrac: 0, retryAmp: 1,
        queue: old?.queue ?? 0, rho: 0, waitMs: 0, respMs: 0, downstreamMs: 0,
        occupancyMs: model.serviceMs, serviceMsEff: model.serviceMs,
        replicasNow: old?.replicasNow ?? (model.minReplicas ?? model.replicas),
        capacity: 1, workersEff: model.workers, concurrency: 0, connUtil: 0,
        hitRatioEff: model.hitRatio ?? 0,
        down: false, downTimer: 0, breakerOpen: false, breakerTimer: 0,
        chaosMods: neutralMods(),
        cost: 0, payloadKB: 20,
        series: old?.series ?? { rho: new Ring(300), queue: new Ring(300), lat: new Ring(300) },
        notes: [],
      });
    }
    this.edges = new Map();
    for (const ge of g.edges) {
      const from = this.nodes.get(ge.from), to = this.nodes.get(ge.to);
      if (!from || !to) continue;
      const e = { id: ge.id, from: ge.from, to: ge.to, kind: ge.kind || 'default', weight: ge.weight ?? 1, ratio: ge.ratio ?? 1, rate: 0, latMs: ge.latMs ?? 0.4, activity: 0 };
      this.edges.set(ge.id, e);
      from.out.push(e); to.in.push(e);
    }
    this.order = topoOrder(this.nodes);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.t = 0;
    this.latRing.clear();
    this.samples = [];
    this.eventLog = [];
    for (const k of Object.keys(this.history)) this.history[k].clear();
    for (const nd of this.nodes.values()) {
      nd.queue = 0; nd.rho = 0; nd.waitMs = 0; nd.respMs = 0; nd.downstreamMs = 0;
      nd.errFrac = 0; nd.dropFrac = 0; nd.throttleFrac = 0; nd.retryAmp = 1;
      nd.occupancyMs = nd.model.serviceMs;
      nd.replicasNow = nd.model.minReplicas ?? nd.model.replicas;
      nd.down = false; nd.downTimer = 0; nd.breakerOpen = false; nd.breakerTimer = 0;
      nd.series.rho.clear(); nd.series.queue.clear(); nd.series.lat.clear();
    }
    this.metrics = blankMetrics();
  }

  // ---------------------------------------------------------------- chaos

  injectChaos(instance) {
    this.chaos.push({ ...instance, elapsed: 0 });
    this.log('chaos', `${instance.name}${instance.targetLabel ? ' → ' + instance.targetLabel : ''}`);
  }
  clearChaos() { this.chaos.length = 0; }

  log(kind, text) {
    this.eventLog.unshift({ t: this.t, kind, text });
    if (this.eventLog.length > 200) this.eventLog.pop();
  }

  // ---------------------------------------------------------------- main tick

  /** dt in simulated seconds. */
  step(dt) {
    if (!this.graph) return;
    this.t += dt;
    const wl = this.graph.workload;

    // 1. expire / apply chaos ------------------------------------------------
    for (const nd of this.nodes.values()) nd.chaosMods = neutralMods();
    for (let i = this.chaos.length - 1; i >= 0; i--) {
      const c = this.chaos[i];
      c.elapsed += dt;
      if (c.durationSec && c.elapsed > c.durationSec) {
        this.log('recover', `${c.name} ended`);
        this.chaos.splice(i, 1);
        continue;
      }
      applyChaos(this, c);
    }

    // 2. downed nodes + failover --------------------------------------------
    for (const nd of this.nodes.values()) {
      if (nd.downTimer > 0) {
        nd.downTimer -= dt;
        if (nd.downTimer <= 0) { nd.down = false; this.log('recover', `${label(this, nd)} recovered`); }
      }
      if (nd.chaosMods.kill && !nd.down) {
        nd.down = true;
        nd.downTimer = nd.model.multiAz ? (nd.model.failoverSec || 45) : (nd.chaosMods.killSec || 1e9);
        this.log('fail', `${label(this, nd)} is DOWN${nd.model.multiAz ? ` (failover ~${nd.model.failoverSec}s)` : ''}`);
      }
    }

    // 3. traffic generation --------------------------------------------------
    let trafficMult = 1;
    for (const c of this.chaos) if (c.trafficMult) trafficMult *= c.trafficMult;
    const globalRps = shapeTraffic(wl, this.t) * trafficMult;
    for (const nd of this.nodes.values()) nd._pendingIn = 0;

    let totalShare = 0;
    for (const nd of this.nodes.values()) if (nd.model && nd.def.dispatch === 'source') totalShare += (nd.cfg.sharePct ?? 100);
    for (const nd of this.nodes.values()) {
      if (nd.def.dispatch === 'source') {
        nd._pendingIn = globalRps * ((nd.cfg.sharePct ?? 100) / Math.max(1, totalShare));
        nd.payloadKB = nd.cfg.payloadKB ?? 20;
      }
      const per = nd.model.periodic;
      if (per) {
        const phase = this.t % Math.max(1, per.everySec);
        nd._active = phase < per.durationSec;
        nd._pendingIn += nd._active ? per.rps : 0;
      }
    }

    // 4. FORWARD FLOW PASS ---------------------------------------------------
    const readFrac = clamp((wl.readPct ?? 90) / 100, 0, 1);
    for (const id of this.order) {
      const nd = this.nodes.get(id);
      if (!nd) continue;
      this.stepNode(nd, dt, readFrac, wl);
    }

    // 5. REVERSE PASS: propagate downstream latency into caller occupancy -----
    for (let i = this.order.length - 1; i >= 0; i--) {
      const nd = this.nodes.get(this.order[i]);
      if (!nd) continue;
      nd.downstreamMs = downstreamLatency(this, nd);
      nd.respMs = nd.waitMs + nd.serviceMsEff + nd.downstreamMs;
      // A synchronous caller holds its worker for the whole downstream call.
      // A cache does not: on a miss it is the *caller* that goes to the origin,
      // so the cache server itself is free again after its own lookup.
      const target = nd.def.dispatch === 'cache'
        ? nd.serviceMsEff
        : nd.serviceMsEff + nd.downstreamMs;
      const next = nd.occupancyMs + (target - nd.occupancyMs) * clamp(dt * 3, 0, 1);
      nd.occupancyMs = Number.isFinite(next) ? clamp(next, 0.005, MAX_LAT_MS) : nd.model.serviceMs;
    }

    // 6. PATH SAMPLER --------------------------------------------------------
    this.runSamples(readFrac, wl);

    // 7. aggregate -----------------------------------------------------------
    this.aggregate(globalRps, dt);
  }

  // ---------------------------------------------------------------- per node

  stepNode(nd, dt, readFrac, wl) {
    const m = nd.model, mods = nd.chaosMods;

    let inRate = Math.max(0, nd._pendingIn);
    nd.inRate = inRate;

    if (nd.down) {
      nd.acceptRate = 0; nd.outRate = 0; nd.servedRate = 0;
      nd.dropRate = inRate; nd.throttleRate = 0; nd.errorRate = 0;
      nd.rho = 0; nd.waitMs = 0; nd.queue = Math.min(nd.queue, m.queueCap);
      nd.serviceMsEff = m.serviceMs;
      nd.dropFrac = 1; nd.throttleFrac = 0; nd.errFrac = 0;
      this.push(nd, 0, readFrac);
      nd.series.rho.push(0); nd.series.queue.push(nd.queue); nd.series.lat.push(0);
      return;
    }

    // --- effective service time (read/write mix, chaos, skew) --------------
    const writeFrac = 1 - readFrac;
    const readMs = m.readMs ?? m.serviceMs;
    const writeMs = m.writeMs ?? m.serviceMs;
    let svc = (m.readMs || m.writeMs !== m.serviceMs)
      ? readFrac * readMs + writeFrac * writeMs
      : m.serviceMs;
    svc *= mods.serviceMult;
    if (m.bufferRatio !== undefined && m.bufferRatio < 1) {
      // Working set does not fit in the buffer pool, so reads leave the page cache.
      svc *= 1 + (1 - m.bufferRatio) * 5;
    }
    nd.serviceMsEff = svc;

    // --- autoscaling -------------------------------------------------------
    if (m.autoscale) {
      const perRep = m.perReplicaWorkers * (1000 / Math.max(0.01, nd.occupancyMs));
      const desired = clamp(Math.ceil(inRate / Math.max(1e-6, perRep * m.autoscale.target)), m.minReplicas, m.maxReplicas);
      const rate = desired > nd.replicasNow ? dt / Math.max(1, m.autoscale.startupSec) : dt / Math.max(1, m.autoscale.cooldownSec * 3);
      nd.replicasNow = clamp(nd.replicasNow + (desired - nd.replicasNow) * clamp(rate, 0, 1), m.minReplicas, m.maxReplicas);
      nd.workersEff = Math.max(1, nd.replicasNow * m.perReplicaWorkers);
    } else {
      nd.replicasNow = m.replicas;
      nd.workersEff = Math.max(1, m.workers);
    }
    nd.workersEff *= mods.capacityMult;

    // --- capacity ----------------------------------------------------------
    const occ = Math.max(0.005, nd.occupancyMs);
    let capacity = nd.workersEff * (1000 / occ);
    if (m.hardCapRps) capacity = Math.min(capacity, m.hardCapRps * mods.capacityMult);
    if (m.skew) capacity /= m.skew;                     // hot shard / hot key
    if (m.serialisation) capacity = Math.min(capacity, m.hardCapRps || capacity);
    if (m.iops) capacity = Math.min(capacity, m.iops * mods.capacityMult);
    capacity = Math.max(0.001, capacity);
    nd.capacity = capacity;

    // --- admission control: rate limiting / throttling ---------------------
    let throttled = 0;
    const limit = m.throttleRps;
    if (limit !== undefined && isFinite(limit) && inRate > limit) {
      throttled = inRate - limit;
    }
    if (m.shedFrac) throttled += (inRate - throttled) * m.shedFrac;   // WAF blocks attacks
    let accepted = Math.max(0, inRate - throttled);

    // --- queueing ----------------------------------------------------------
    const net = accepted - capacity;
    nd.queue = Math.max(0, nd.queue + net * dt);
    let dropped = 0;
    if (nd.queue > m.queueCap) {
      dropped = (nd.queue - m.queueCap) / Math.max(1e-6, dt);
      nd.queue = m.queueCap;
    }
    if (m.hardCapConc) {
      // Serverless: no queue at all, excess concurrency is rejected immediately.
      const concNeeded = accepted * (occ / 1000);
      if (concNeeded > m.hardCapConc) {
        const over = (concNeeded - m.hardCapConc) / (occ / 1000);
        dropped += over; nd.queue = 0;
      }
    }
    accepted = Math.max(0, accepted - dropped);
    nd.rho = accepted / capacity;

    // --- waiting time ------------------------------------------------------
    // Erlang-C is O(c), so the server count is capped for very wide stations.
    // The per-server service time is rescaled to keep c/service == capacity,
    // which preserves utilisation exactly while keeping the maths cheap.
    const stableLambda = Math.min(accepted, capacity * 0.985);
    const cEff = Math.max(1, Math.round(Math.min(nd.workersEff, 2048)));
    const svcEff = cEff / capacity;
    let wait = kingmanWait(stableLambda, svcEff, cEff, 1, m.cs2 ?? 1) * 1000;
    if (!isFinite(wait)) wait = MAX_LAT_MS;
    wait += (nd.queue / capacity) * 1000;               // backlog drain time
    nd.waitMs = clamp(wait, 0, MAX_LAT_MS);

    // --- errors ------------------------------------------------------------
    let errFrac = clamp((m.baseErr ?? 0) + mods.errorAdd, 0, 1);
    if (m.external && nd.rho > 1) errFrac = clamp(errFrac + 0.3, 0, 1);
    nd.errFrac = errFrac;
    nd.throttleFrac = inRate > 0 ? throttled / inRate : 0;
    nd.dropFrac = (inRate - throttled) > 0 ? dropped / (inRate - throttled) : 0;

    nd.acceptRate = accepted;
    nd.throttleRate = throttled;
    nd.dropRate = dropped;
    nd.errorRate = accepted * errFrac;
    nd.servedRate = Math.max(0, accepted - nd.errorRate);
    nd.concurrency = nd.servedRate * ((nd.serviceMsEff + nd.waitMs + nd.downstreamMs) / 1000);
    nd.connUtil = m.connLimit ? nd.concurrency / m.connLimit : nd.concurrency / Math.max(1, nd.workersEff);

    // --- circuit breaker state machine ------------------------------------
    if (m.breaker) {
      const childErr = childErrorFraction(this, nd);
      if (nd.breakerOpen) {
        nd.breakerTimer -= dt;
        if (nd.breakerTimer <= 0) { nd.breakerOpen = false; this.log('recover', `${label(this, nd)} breaker HALF-OPEN`); }
      } else if (childErr > m.errThresh) {
        nd.breakerOpen = true; nd.breakerTimer = m.openSec;
        this.log('fail', `${label(this, nd)} breaker OPEN (downstream errors ${(childErr * 100).toFixed(0)}%)`);
      }
    }

    // --- cache split -------------------------------------------------------
    let forward = nd.servedRate;
    if (nd.def.dispatch === 'cache') {
      let hit = m.workingSetGB
        ? effectiveHitRatio(m.hitRatio, m.memGB, m.workingSetGB)
        : m.hitRatio;
      hit *= mods.hitMult;
      if (m.hardCapRps && nd.rho > 1) hit *= 0.6;        // cache node saturated
      nd.hitRatioEff = clamp(hit, 0, 1);
      forward = nd.servedRate * (1 - nd.hitRatioEff);
    }

    // --- retry amplification ----------------------------------------------
    if (m.retries > 0) {
      const p = childErrorFraction(this, nd);
      let amp = retryAmplification(p, m.retries + 1);
      if (m.retryBudget) amp = Math.min(amp, 1 + m.retryBudget);
      nd.retryAmp = Number.isFinite(amp) ? amp : 1;
      forward *= nd.retryAmp;
    } else nd.retryAmp = 1;

    if (m.fanoutMult) forward *= m.fanoutMult;
    if (nd.breakerOpen) forward = 0;
    if (!Number.isFinite(forward)) forward = 0;

    nd.outRate = forward;
    this.push(nd, forward, readFrac);

    nd.series.rho.push(nd.rho);
    nd.series.queue.push(nd.queue);
    nd.series.lat.push(nd.waitMs + nd.serviceMsEff);
  }

  /** Distribute a node's output rate onto its outgoing edges. */
  push(nd, rate, readFrac) {
    const outs = nd.out.filter((e) => e.kind !== 'replication');
    if (outs.length === 0) { for (const e of nd.out) e.rate = 0; return; }
    const usable = nd.breakerOpen
      ? outs.filter((e) => e.kind === 'fallback')
      : outs.filter((e) => e.kind !== 'fallback');
    const pool = usable.length ? usable : outs;

    const reads = pool.filter((e) => e.kind === 'read');
    const writes = pool.filter((e) => e.kind === 'write');
    const plain = pool.filter((e) => e.kind !== 'read' && e.kind !== 'write');

    for (const e of nd.out) e.rate = 0;

    if (nd.def.dispatch === 'all' || nd.def.dispatch === 'cache') {
      // Fan-out: every dependency is called on every applicable request.
      for (const e of pool) {
        const share = e.kind === 'read' ? readFrac : e.kind === 'write' ? 1 - readFrac : 1;
        e.rate = rate * share * (e.ratio ?? 1);
      }
    } else {
      // Load balancing: a request goes to exactly one dependency, so the shares
      // must sum to 1. Untyped edges are eligible for both reads and writes.
      const spread = (edges, share) => {
        if (!edges.length || share <= 0) return;
        const total = edges.reduce((s, e) => s + Math.max(0, e.weight), 0) || 1;
        for (const e of edges) e.rate += rate * share * (Math.max(0, e.weight) / total) * (e.ratio ?? 1);
      };
      spread([...reads, ...plain], readFrac);
      spread([...writes, ...plain], 1 - readFrac);
    }
    for (const e of pool) {
      const to = this.nodes.get(e.to);
      if (!Number.isFinite(e.rate)) e.rate = 0;
      if (to) to._pendingIn += e.rate;
      e.activity = e.rate;
    }
  }

  // ---------------------------------------------------------------- sampler

  runSamples(readFrac, wl) {
    const sources = [];
    for (const nd of this.nodes.values()) if (nd.def.dispatch === 'source') sources.push(nd);
    this.samples.length = 0;
    if (!sources.length) { this.outcomeFrac = { ok: 0, throttled: 0, dropped: 0, timeout: 0, error: 0 }; return; }

    const counts = { ok: 0, throttled: 0, dropped: 0, timeout: 0, error: 0 };
    const rng = this.rng;
    const timeout = wl.timeoutMs ?? 3000;
    const lats = [];

    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      const src = sources.length === 1 ? sources[0] : weightedPick(rng, sources, (n) => n.cfg.sharePct ?? 100);
      const ctx = { t: 0, hops: 0, timeout, isRead: rng() < readFrac, path: [], rng, engine: this };
      const outcome = this.visit(src, ctx);
      counts[outcome]++;
      if (outcome === 'ok') { lats.push(ctx.t); this.latRing.push(ctx.t); }
      if (this.samples.length < 90) this.samples.push({ path: ctx.path.slice(), outcome, latency: ctx.t });
    }
    const total = SAMPLES_PER_TICK;
    this.outcomeFrac = {
      ok: counts.ok / total, throttled: counts.throttled / total,
      dropped: counts.dropped / total, timeout: counts.timeout / total, error: counts.error / total,
    };
    this.tickLatencies = lats;
  }

  visit(nd, ctx) {
    const rng = ctx.rng;
    if (ctx.hops++ > 48) return 'error';
    ctx.path.push(nd.id);
    if (nd.down) return 'error';
    if (nd.throttleFrac > 0 && rng() < nd.throttleFrac) return 'throttled';
    if (nd.dropFrac > 0 && rng() < nd.dropFrac) return 'dropped';

    // service time draw
    const m = nd.model;
    const sigma = Math.sqrt(Math.log(1 + Math.max(0.02, m.cs2 ?? 1)));
    let svc = rng.lognormal(Math.max(0.001, nd.serviceMsEff), Math.min(1.6, sigma));
    if (m.scatter && m.scatter > 1) {
      // Scatter-gather: you wait for the slowest shard, not the average one.
      const n = Math.min(m.scatter, 12);
      let mx = 0;
      for (let i = 0; i < n; i++) mx = Math.max(mx, rng.lognormal(Math.max(0.001, nd.serviceMsEff), sigma));
      svc = mx;
    }
    if (m.coldPct && rng() < m.coldPct) svc += m.coldMs;
    if (m.missExtraMs === undefined && nd.def.dispatch === 'cache') { /* no-op */ }

    const wait = nd.waitMs > 0 ? rng.exp(nd.waitMs) : 0;
    ctx.t += svc + wait;
    if (ctx.t > ctx.timeout) return 'timeout';
    if (nd.errFrac > 0 && rng() < nd.errFrac) return 'error';

    // dispatch
    const disp = nd.def.dispatch;
    if (disp === 'terminal') return 'ok';
    if (disp === 'async') { ctx.t += 0; return 'ok'; }   // producer is released at enqueue

    let children = nd.out
      .filter((e) => e.kind !== 'replication')
      .filter((e) => nd.breakerOpen ? e.kind === 'fallback' : e.kind !== 'fallback')
      .filter((e) => e.kind === 'read' ? ctx.isRead : e.kind === 'write' ? !ctx.isRead : true)
      .map((e) => ({ e, node: this.nodes.get(e.to) }))
      .filter((x) => x.node);

    if (nd.breakerOpen && children.length === 0) return m.fallback ? 'ok' : 'error';
    if (children.length === 0) return 'ok';

    if (disp === 'cache') {
      if (rng() < nd.hitRatioEff) return 'ok';
      if (m.missExtraMs) ctx.t += m.missExtraMs;
    }

    if (disp === 'split') {
      const pick = weightedPick(rng, children, (x) => x.e.weight);
      ctx.t += pick.e.latMs;
      return this.visit(pick.node, ctx);
    }

    // 'all' / 'cache' miss path: call every dependency
    const parallel = m.callMode === 'parallel';
    const loops = Math.max(1, m.loops || 1);
    const before = ctx.t;
    let worst = 0, result = 'ok';
    for (const ch of children) {
      const start = parallel ? before : ctx.t;
      ctx.t = start + ch.e.latMs;
      const r = this.visit(ch.node, ctx);
      if (r !== 'ok') result = r;
      worst = Math.max(worst, ctx.t);
      if (!parallel && ctx.t > ctx.timeout) return 'timeout';
    }
    ctx.t = parallel ? worst : ctx.t;
    // An agent loop repeats the whole dependency round trip once per step.
    if (loops > 1) ctx.t = before + (ctx.t - before) * loops;
    if (ctx.t > ctx.timeout) return 'timeout';
    if (result !== 'ok' && m.fallback) return 'ok';
    return result;
  }

  // ---------------------------------------------------------------- metrics

  aggregate(globalRps, dt) {
    const of = this.outcomeFrac || { ok: 1, throttled: 0, dropped: 0, timeout: 0, error: 0 };
    const arr = this.latRing.toArray();
    const [p50, p90, p95, p99, p999] = percentiles(arr, [0.5, 0.9, 0.95, 0.99, 0.999]);

    let cost = 0;
    const costBreakdown = [];
    for (const nd of this.nodes.values()) {
      const tel = { inRate: nd.inRate, outRate: nd.outRate, replicas: nd.replicasNow, payloadKB: this.graph.workload.payloadKB ?? 20 };
      let c = 0;
      try { c = nd.def.cost(nd.cfg, tel) || 0; } catch { c = 0; }
      nd.cost = c; cost += c;
      if (c > 0) costBreakdown.push({ id: nd.id, name: nd.def.name, cost: c });
    }
    costBreakdown.sort((a, b) => b.cost - a.cost);

    const okRps = globalRps * of.ok;
    this.metrics = {
      t: this.t,
      offeredRps: globalRps,
      okRps,
      throttledRps: globalRps * of.throttled,
      droppedRps: globalRps * of.dropped,
      timeoutRps: globalRps * of.timeout,
      errorRps: globalRps * of.error,
      successRate: of.ok,
      p50, p90, p95, p99, p999,
      mean: arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
      cost, costBreakdown,
      samples: arr.length,
    };

    this.history.p50.push(p50); this.history.p95.push(p95); this.history.p99.push(p99);
    this.history.rps.push(globalRps); this.history.ok.push(okRps);
    this.history.err.push(globalRps * (of.error + of.timeout + of.dropped));
    this.history.cost.push(cost);
  }

  nodeState(id) { return this.nodes.get(id); }
}

// ============================================================ helpers

function blankMetrics() {
  return { t: 0, offeredRps: 0, okRps: 0, throttledRps: 0, droppedRps: 0, timeoutRps: 0, errorRps: 0, successRate: 1, p50: 0, p90: 0, p95: 0, p99: 0, p999: 0, mean: 0, cost: 0, costBreakdown: [], samples: 0 };
}

function neutralMods() {
  return { serviceMult: 1, capacityMult: 1, errorAdd: 0, hitMult: 1, kill: false, killSec: 0, extraRps: 0 };
}

function label(engine, nd) {
  const gn = engine.graph.nodes.find((n) => n.id === nd.id);
  return gn?.label || nd.def.name;
}

/** Kahn topological sort; cycles are broken deterministically (retry loops). */
function topoOrder(nodes) {
  const indeg = new Map();
  for (const [id, nd] of nodes) indeg.set(id, 0);
  for (const [, nd] of nodes) for (const e of nd.out) if (e.kind !== 'replication') indeg.set(e.to, (indeg.get(e.to) || 0) + 1);

  const q = [];
  for (const [id, nd] of nodes) if (nd.def.dispatch === 'source' || indeg.get(id) === 0) q.push(id);
  const seen = new Set(q);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    const nd = nodes.get(id);
    for (const e of nd.out) {
      if (e.kind === 'replication') continue;
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) <= 0 && !seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  for (const id of nodes.keys()) if (!seen.has(id)) { order.push(id); seen.add(id); }
  return order;
}

/** Expected added latency from a node's synchronous dependencies. */
function downstreamLatency(engine, nd) {
  const disp = nd.def.dispatch;
  if (disp === 'terminal' || disp === 'async') return 0;
  const kids = nd.out
    .filter((e) => e.kind !== 'replication' && e.kind !== 'fallback')
    .map((e) => ({ e, node: engine.nodes.get(e.to) }))
    .filter((x) => x.node && x.node.def.dispatch !== 'async');
  if (!kids.length) return 0;

  // A dependency called on only a fraction of requests contributes only that
  // fraction of its latency to the caller's average occupancy.
  const each = kids.map((k) => (k.e.latMs + k.node.respMs) * Math.min(1, k.e.ratio ?? 1));
  if (each.some((v) => !Number.isFinite(v))) return 0;
  let v;
  if (disp === 'split') {
    const total = kids.reduce((s, k) => s + k.e.weight, 0) || 1;
    v = kids.reduce((s, k, i) => s + each[i] * (k.e.weight / total), 0);
  } else if (nd.model.callMode === 'parallel') {
    v = Math.max(...each);
  } else {
    v = each.reduce((a, b) => a + b, 0);
  }
  if (disp === 'cache') v *= (1 - nd.hitRatioEff);
  if (nd.model.loops > 1) v *= nd.model.loops;
  return clamp(v, 0, MAX_LAT_MS);
}

function childErrorFraction(engine, nd) {
  const kids = nd.out.filter((e) => e.kind !== 'replication' && e.kind !== 'fallback').map((e) => engine.nodes.get(e.to)).filter(Boolean);
  if (!kids.length) return 0;
  let worst = 0;
  for (const k of kids) {
    const bad = k.down ? 1 : clamp((k.errFrac || 0) + (k.dropFrac || 0) + (k.rho > 1.15 ? 0.4 : 0), 0, 1);
    worst = Math.max(worst, bad);
  }
  return Number.isFinite(worst) ? worst : 0;
}

function weightedPick(rng, arr, weightFn) {
  let total = 0;
  for (const a of arr) total += Math.max(0, weightFn(a));
  if (total <= 0) return arr[Math.floor(rng() * arr.length)];
  let r = rng() * total;
  for (const a of arr) { r -= Math.max(0, weightFn(a)); if (r <= 0) return a; }
  return arr[arr.length - 1];
}

// ------------------------------------------------------------- traffic shape

export function shapeTraffic(wl, t) {
  const base = wl.rps ?? 1000;
  switch (wl.pattern) {
    case 'steady': return base;
    case 'ramp': {
      const dur = wl.rampSec ?? 120;
      return base * clamp(t / dur, 0.02, 1);
    }
    case 'spike': {
      const period = wl.spikePeriodSec ?? 60;
      const phase = t % period;
      const inSpike = phase > period * 0.5 && phase < period * 0.5 + (wl.spikeSec ?? 12);
      return inSpike ? base * (wl.spikeMult ?? 8) : base;
    }
    case 'diurnal': {
      const period = wl.diurnalSec ?? 240;
      const x = (t % period) / period;
      return base * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (x - 0.25))) * 1.4);
    }
    case 'flashsale': {
      const start = wl.saleAtSec ?? 30;
      if (t < start) return base * 0.4;
      const since = t - start;
      const peak = base * (wl.spikeMult ?? 20);
      if (since < 3) return base * 0.4 + (peak - base * 0.4) * (since / 3);
      return peak * Math.max(0.35, Math.exp(-(since - 3) / (wl.decaySec ?? 90)));
    }
    case 'sawtooth': {
      const period = wl.spikePeriodSec ?? 40;
      return base * (0.3 + 1.4 * ((t % period) / period));
    }
    default: return base;
  }
}

// ------------------------------------------------------------- chaos applier

function applyChaos(engine, c) {
  const targets = c.targetId
    ? [engine.nodes.get(c.targetId)].filter(Boolean)
    : [...engine.nodes.values()].filter((n) => !c.match || c.match(n));
  for (const nd of targets) {
    const m = nd.chaosMods;
    if (c.serviceMult) m.serviceMult *= c.serviceMult;
    if (c.addLatencyMs) m.serviceMult *= 1 + c.addLatencyMs / Math.max(0.1, nd.serviceMsEff);
    if (c.capacityMult) m.capacityMult *= c.capacityMult;
    if (c.errorAdd) m.errorAdd += c.errorAdd;
    if (c.hitMult !== undefined) m.hitMult *= c.hitMult;
    if (c.kill) { m.kill = true; m.killSec = c.killSec ?? 1e9; }
    if (c.ramp) {
      // Gradual degradation (memory leaks, replication lag, compaction debt).
      const f = clamp(c.elapsed / Math.max(1, c.ramp.overSec), 0, 1);
      m.serviceMult *= 1 + ((c.ramp.serviceMult ?? 1) - 1) * f;
      m.capacityMult *= 1 - (1 - (c.ramp.capacityMult ?? 1)) * f;
    }
  }
}
