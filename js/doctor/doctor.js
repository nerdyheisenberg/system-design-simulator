// THE SYSTEM DESIGN DOCTOR
// -----------------------------------------------------------------------------
// Two kinds of feedback:
//
//   reviewStatic(graph)  – design review of the topology, before you press play.
//                          Catches SPOFs, missing layers, impossible connection
//                          arithmetic, dangerous defaults.
//
//   diagnose(engine)     – live root-cause analysis while the simulation runs.
//                          Names the bottleneck, shows the arithmetic that
//                          proves it, and gives a concrete fix.
//
// Every finding carries: what happened, WHY (with the formula), how to fix it,
// and the chapter of the book that explains the underlying principle.

import { BY_ID } from '../model/catalog.js';
import { fmtNum, fmtMs, clamp } from '../core/util.js';
import { bookBase } from '../config.js';

const F = (o) => ({ severity: 'warn', nodeIds: [], fix: [], ...o });

// =============================================================================
// graph helpers
// =============================================================================

function analyse(graph) {
  const nodes = graph.nodes.filter((n) => BY_ID[n.type]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const succ = new Map(nodes.map((n) => [n.id, []]));
  const pred = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) { succ.get(e.from).push(e); pred.get(e.to).push(e); }

  const def = (n) => BY_ID[n.type];
  const caps = (n) => def(n).caps || [];
  const has = (n, c) => caps(n).includes(c);
  const cfg = (n) => ({ ...Object.fromEntries(def(n).params.map((p) => [p.k, p.def])), ...(n.cfg || {}) });
  const label = (n) => n.label || def(n).name;

  const sources = nodes.filter((n) => def(n).dispatch === 'source');
  const reachable = new Set();
  const stack = sources.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of succ.get(id) || []) stack.push(e.to);
  }

  // longest synchronous chain (ignores async hops, which release the caller)
  const memo = new Map();
  const depth = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return 0;
    if (def(n).dispatch === 'async') return 1;
    let best = 0;
    for (const e of succ.get(id) || []) {
      if (e.kind === 'replication') continue;
      best = Math.max(best, depth(e.to, new Set(seen)));
    }
    const v = 1 + best;
    memo.set(id, v);
    return v;
  };

  const hasCycle = (() => {
    const state = new Map();
    const visit = (id) => {
      const st = state.get(id);
      if (st === 1) return true;
      if (st === 2) return false;
      state.set(id, 1);
      for (const e of succ.get(id) || []) if (e.kind !== 'replication' && visit(e.to)) return true;
      state.set(id, 2);
      return false;
    };
    return nodes.some((n) => visit(n.id));
  })();

  const find = (cap) => nodes.filter((n) => has(n, cap));

  return { nodes, byId, edges, succ, pred, def, caps, has, cfg, label, sources, reachable, depth, hasCycle, find };
}

// =============================================================================
// STATIC DESIGN REVIEW
// =============================================================================

export function reviewStatic(graph) {
  const g = analyse(graph);
  const out = [];
  const wl = graph.workload || {};
  const readPct = wl.readPct ?? 90;
  const rps = wl.rps ?? 1000;

  if (!g.nodes.length) {
    return [F({ id: 'empty', severity: 'info', title: 'Empty canvas', what: 'Drop a Client node and start building, or load a blueprint from the toolbar.', chapter: '00_how_to_use_this_book.md' })];
  }

  // --- entry points --------------------------------------------------------
  if (!g.sources.length) {
    out.push(F({
      id: 'no_source', severity: 'critical', title: 'No traffic source',
      what: 'Nothing in this diagram generates requests, so the simulator has nothing to push through it.',
      why: 'Every simulation starts from a Client node. Its share of the global RPS is what flows into the rest of the graph.',
      fix: ['Drag a **Client / Users** component onto the canvas.', 'Connect it to your first entry point (CDN, WAF, load balancer or API gateway).'],
      chapter: '00_how_to_use_this_book.md',
    }));
  }

  const orphans = g.nodes.filter((n) => !g.reachable.has(n.id));
  if (orphans.length) {
    out.push(F({
      id: 'orphans', severity: 'warn', title: `${orphans.length} component(s) receive no traffic`,
      what: `${orphans.map(g.label).join(', ')} ${orphans.length === 1 ? 'is' : 'are'} not reachable from any client.`,
      why: 'Unreachable components still cost money every month while contributing nothing. In a real account this is how you end up paying for a cluster nobody uses.',
      fix: ['Connect them into the request path, or delete them.'],
      nodeIds: orphans.map((n) => n.id), chapter: '20_deployment_multiregion_dr_cost.md',
    }));
  }

  if (g.hasCycle) {
    out.push(F({
      id: 'cycle', severity: 'warn', title: 'Circular dependency detected',
      what: 'Your graph contains a cycle in the synchronous call path.',
      why: 'Synchronous cycles between services deadlock under load: A waits on B while B waits on A, and both hold a thread. They also make deployments order-dependent.',
      fix: ['Break the cycle with an event/queue hop so the callback is asynchronous.', 'Or extract the shared logic into a third service that both call.'],
      chapter: '16_microservices_and_service_architecture.md',
    }));
  }

  // --- single points of failure -------------------------------------------
  const spofs = [];
  for (const nnode of g.nodes) {
    if (!g.reachable.has(nnode.id)) continue;
    const d = g.def(nnode);
    if (d.dispatch === 'source' || g.has(nnode, 'external')) continue;
    const c = g.cfg(nnode);
    const reps = c.replicas ?? c.nodes ?? c.brokers ?? c.shards ?? c.minPods ?? c.gpus ?? null;
    if (reps === 1) spofs.push(nnode);
    if (nnode.type === 'pg_primary' && !c.multiAz) spofs.push(nnode);
  }
  if (spofs.length) {
    const uniq = [...new Set(spofs)];
    out.push(F({
      id: 'spof', severity: 'critical', title: `Single point of failure: ${uniq.map(g.label).join(', ')}`,
      what: `${uniq.length === 1 ? 'This component runs' : 'These components run'} as a single instance with no standby. When it dies, everything behind it dies with it.`,
      why: 'Availability in series multiplies. One 99.9% component makes the whole path at most 99.9% — about 43 minutes of downtime a month, and that is assuming everything else is perfect.',
      fix: [
        'Increase the replica count to at least 2 (3 for quorum systems).',
        'For a SQL primary, enable the **Multi-AZ standby** so failover is automatic.',
        'Put a load balancer in front so traffic stops being sent to the dead instance.',
        'Then run the **Instance crash** chaos scenario and confirm the success rate stays above your SLO.',
      ],
      nodeIds: uniq.map((n) => n.id), chapter: '03_reliability_availability_performance.md',
    }));
  }

  // --- load balancing ------------------------------------------------------
  const computeNodes = g.nodes.filter((n) => g.has(n, 'compute') && g.reachable.has(n.id));
  const lbs = g.find('lb').concat(g.find('gateway'));
  const multiReplicaCompute = computeNodes.filter((n) => (g.cfg(n).replicas ?? g.cfg(n).minPods ?? 1) > 1);
  for (const c of multiReplicaCompute) {
    const upstream = (g.pred.get(c.id) || []).map((e) => g.byId.get(e.from));
    const balanced = upstream.some((u) => u && (g.has(u, 'lb') || g.has(u, 'gateway') || g.has(u, 'mesh') || g.has(u, 'queue') || g.has(u, 'cdn')));
    if (upstream.length && !balanced) {
      out.push(F({
        id: 'no_lb_' + c.id, severity: 'warn', title: `${g.label(c)} has ${g.cfg(c).replicas ?? g.cfg(c).minPods} replicas but nothing balancing across them`,
        what: 'Multiple instances only help if something distributes requests across them and stops sending traffic to unhealthy ones.',
        why: 'Without a balancer the caller has to do client-side load balancing and its own health checking. Most do neither, so one instance gets all the load and a dead instance keeps receiving traffic until it times out.',
        fix: ['Insert an **L7 Proxy / Ingress** or **Load Balancer (L4)** between the caller and this service.', 'Prefer least-connections or power-of-two-choices over round robin when request costs vary.'],
        nodeIds: [c.id], chapter: '05_load_balancing_proxies_traffic.md',
      }));
      break;
    }
  }

  // --- database exposure ---------------------------------------------------
  for (const src of g.sources) {
    for (const e of g.succ.get(src.id) || []) {
      const t = g.byId.get(e.to);
      // A CDN or edge cache is *meant* to be client-facing; an origin datastore is not.
      const edgeTier = t && (g.has(t, 'cdn') || g.has(t, 'edge') || g.has(t, 'waf'));
      if (t && !edgeTier && (g.has(t, 'db') || g.has(t, 'cache'))) {
        out.push(F({
          id: 'db_exposed', severity: 'critical', title: 'Client talks directly to a datastore',
          what: `${g.label(src)} is connected straight to ${g.label(t)}.`,
          why: 'There is no authentication, no rate limiting, no query validation and no connection multiplexing between the internet and your data. A single client can exhaust the connection pool, and credentials must live on the client.',
          fix: ['Put an **API Gateway** and an application tier between the client and the datastore.', 'Never expose database ports to untrusted networks.'],
          nodeIds: [src.id, t.id], chapter: '18_security_and_identity.md',
        }));
      }
    }
  }

  // --- caching -------------------------------------------------------------
  const caches = g.find('cache');
  const dbs = g.nodes.filter((n) => g.has(n, 'db') && g.reachable.has(n.id));
  if (readPct >= 70 && dbs.length && !caches.length) {
    out.push(F({
      id: 'no_cache', severity: 'warn', title: `${readPct}% of your traffic is reads and there is no cache anywhere`,
      what: 'Every read goes to a database that costs 10-100x more per operation than an in-memory lookup.',
      why: `At ${fmtNum(rps)} RPS with ${readPct}% reads, a cache with a 90% hit ratio would cut database load from ${fmtNum(rps * readPct / 100)} to ${fmtNum(rps * readPct / 100 * 0.1)} reads/sec, and cut p50 read latency by roughly an order of magnitude.`,
      fix: [
        'Add a **Cache (Redis)** in front of the database using the cache-aside pattern.',
        'Add a **CDN** if any of these reads are cacheable static or semi-static content.',
        'Then re-run and compare the database utilisation before and after.',
      ],
      nodeIds: dbs.map((n) => n.id), chapter: '11_caching_cdn_and_edge.md',
    }));
  }
  for (const c of caches) {
    const cf = g.cfg(c);
    if (cf.workingSetGB && cf.memGB && cf.workingSetGB > cf.memGB * 1.05) {
      out.push(F({
        id: 'cache_undersized_' + c.id, severity: 'warn', title: `${g.label(c)} is smaller than its working set`,
        what: `Cache memory is ${cf.memGB}GB but the working set is ${cf.workingSetGB}GB.`,
        why: `The configured hit ratio of ${cf.hitRatio}% is aspirational. With only ${(cf.memGB / cf.workingSetGB * 100).toFixed(0)}% coverage, the simulator will apply a realistic effective hit ratio well below that, and the shortfall lands on your database.`,
        fix: ['Increase cache memory, or shrink what you cache (store IDs, not whole objects).', 'Switch eviction to **allkeys-lfu** if access is skewed: LFU keeps the genuinely hot keys, LRU keeps the recently scanned ones.'],
        nodeIds: [c.id], chapter: '11_caching_cdn_and_edge.md',
      }));
    }
    if (cf.jitterTtl === false && cf.coalescing === false) {
      out.push(F({
        id: 'stampede_' + c.id, severity: 'warn', title: `${g.label(c)} is exposed to cache stampedes`,
        what: 'TTL jitter is off and request coalescing is off.',
        why: 'Keys written together expire together. When a hot key expires, every concurrent request misses at once and they all hit the origin with the identical query. A 95% hit ratio becomes 0% for one very expensive second.',
        fix: ['Turn on **TTL jitter** so expiry is spread over a window.', 'Turn on **request coalescing** so only one miss per key reaches the origin.', 'Verify with the **Cache stampede** chaos scenario.'],
        nodeIds: [c.id], chapter: '11_caching_cdn_and_edge.md',
      }));
    }
  }

  // --- CDN -----------------------------------------------------------------
  const payload = wl.payloadKB ?? 20;
  if (payload >= 100 && !g.find('cdn').length) {
    out.push(F({
      id: 'no_cdn', severity: 'warn', title: `Average response is ${payload}KB with no CDN`,
      what: 'Large responses are being served from origin to every user, everywhere.',
      why: `At ${fmtNum(rps)} RPS and ${payload}KB per response you are pushing ${fmtNum(rps * payload / 1024)} MB/s out of origin, roughly ${fmtNum(rps * payload * 2.6e6 / 1e6 / 1024)} TB/month. At $0.085/GB that is real money, and every user pays the full origin RTT.`,
      fix: ['Add a **CDN / Edge Cache** in front of your entry point.', 'Set long TTLs with content-hashed URLs so cache invalidation becomes a deploy, not an API call.'],
      chapter: '11_caching_cdn_and_edge.md',
    }));
  }

  // --- write path ----------------------------------------------------------
  const writePct = 100 - readPct;
  const queues = g.find('queue');
  if (writePct >= 25 && !queues.length && dbs.length) {
    out.push(F({
      id: 'no_queue', severity: 'warn', title: `${writePct}% writes going synchronously to the database`,
      what: 'There is no buffer between your request path and your write path.',
      why: `Writes cannot be cached and cannot be served by read replicas. At ${fmtNum(rps * writePct / 100)} writes/sec every spike lands directly on the primary. A queue converts "we fell over" into "we are behind", which is almost always the better failure.`,
      fix: [
        'Put a **Message Queue** or **Event Log (Kafka)** between the API and the write workers for anything that does not need a synchronous answer.',
        'Keep the synchronous path for things the user must see immediately; make the rest eventually consistent.',
        'Remember the trade: the user now gets a 202, not a 200. Design the UI for it.',
      ],
      nodeIds: dbs.map((n) => n.id), chapter: '12_messaging_and_event_streaming.md',
    }));
  }

  // --- connection arithmetic ----------------------------------------------
  for (const db of dbs) {
    const dbCfg = g.cfg(db);
    const limit = dbCfg.maxConns ? dbCfg.maxConns * (dbCfg.replicas ?? 1) : null;
    if (!limit) continue;
    const callers = (g.pred.get(db.id) || []).map((e) => g.byId.get(e.from)).filter(Boolean);
    const pooled = callers.some((c) => g.has(c, 'pool'));
    let demand = 0;
    for (const c of callers) {
      const cc = g.cfg(c);
      demand += (cc.replicas ?? cc.minPods ?? 1) * (cc.threads ?? cc.concurrency ?? 0);
    }
    if (demand > limit && !pooled) {
      out.push(F({
        id: 'conn_math_' + db.id, severity: 'critical', title: `Connection arithmetic does not work for ${g.label(db)}`,
        what: `Callers can open up to ${fmtNum(demand)} concurrent connections; the database accepts ${fmtNum(limit)}.`,
        why: 'PostgreSQL forks a backend process per connection. Past a few hundred you spend more time context-switching than querying, and new connections are simply refused with "too many clients already". This is the single most common way a healthy-looking service takes down its database.',
        fix: [
          `Add a **Connection Pooler** in transaction mode between the app tier and ${g.label(db)}.`,
          `Set the app-side pool per instance to roughly ${Math.max(1, Math.floor(limit / Math.max(1, callers.reduce((s, c) => s + (g.cfg(c).replicas ?? g.cfg(c).minPods ?? 1), 0))))} connections instead of ${fmtNum(demand / Math.max(1, callers.length))}.`,
          'Remember: you need connections = RPS x query latency (Little\'s Law), not connections = threads.',
        ],
        nodeIds: [db.id, ...callers.map((c) => c.id)], chapter: '07_relational_databases_and_transactions.md',
      }));
    }
  }

  // --- read replicas -------------------------------------------------------
  const primaries = g.nodes.filter((n) => n.type === 'pg_primary' && g.reachable.has(n.id));
  if (readPct >= 80 && primaries.length && !g.find('replica').length) {
    out.push(F({
      id: 'no_replica', severity: 'info', title: 'Read-heavy workload with no read replicas',
      what: 'All reads and writes go to the single primary.',
      why: 'Read replicas are the cheapest way to scale reads on a relational database. The cost is staleness: asynchronous replication means a user can write and then not see their own write.',
      fix: [
        'Add a **SQL Read Replica** and connect it with a **read** edge (right-click an edge to set its kind).',
        'Route the primary a **write** edge only.',
        'Handle read-your-writes: pin a user to the primary for a few seconds after they write.',
      ],
      nodeIds: primaries.map((n) => n.id), chapter: '09_replication_partitioning_consistency.md',
    }));
  }

  // --- admission control ---------------------------------------------------
  const entry = g.sources.flatMap((s) => (g.succ.get(s.id) || []).map((e) => g.byId.get(e.to))).filter(Boolean);
  const guarded = entry.some((n) => n && (g.has(n, 'ratelimit') || g.has(n, 'waf') || g.has(n, 'cdn')));
  if (entry.length && !guarded) {
    out.push(F({
      id: 'no_admission', severity: 'warn', title: 'No admission control at the edge',
      what: 'Nothing between the internet and your compute limits how much traffic can arrive.',
      why: 'Every system has a capacity. Without a rate limiter you discover it by falling over; with one you discover it by returning 429 to the excess and staying up for everyone else. Shedding load is a feature.',
      fix: [
        'Add a **Rate Limiter**, or enable rate limiting on the **API Gateway**.',
        'Set the limit near your measured knee (the RPS where p99 starts climbing), not at your theoretical maximum.',
        'Add a **WAF / DDoS Shield** if you are internet-facing.',
        'Test it with the **DDoS / bot flood** scenario: success rate for legitimate users should stay high.',
      ],
      chapter: '23_building_blocks_and_algorithms.md',
    }));
  }

  // --- external dependencies ----------------------------------------------
  for (const ext of g.find('external')) {
    if (!g.reachable.has(ext.id)) continue;
    const callers = (g.pred.get(ext.id) || []).map((e) => g.byId.get(e.from)).filter(Boolean);
    const protectedBy = callers.some((c) => g.has(c, 'breaker') || g.has(c, 'bulkhead') || g.has(c, 'queue'));
    if (!protectedBy) {
      out.push(F({
        id: 'unprotected_ext_' + ext.id, severity: 'critical', title: `${g.label(ext)} is an unprotected external dependency`,
        what: 'A service you do not control sits on your synchronous critical path with nothing isolating it.',
        why: 'When their p99 goes to 5 seconds, your threads are held for 5 seconds. Your capacity collapses by the same factor even though your own code is fine. Their SLA becomes a hard ceiling on yours.',
        fix: [
          'Wrap it in a **Circuit Breaker** with a fallback response.',
          'Add a **Bulkhead** so at most N of your threads can ever be blocked on it.',
          'Set a timeout shorter than your own SLO. A timeout longer than your SLO is not a timeout.',
          'If the call does not need to be synchronous, put it behind a **Message Queue**.',
        ],
        nodeIds: [ext.id], chapter: '03_reliability_availability_performance.md',
      }));
    }
  }

  // --- retries without breakers -------------------------------------------
  const retriers = g.nodes.filter((n) => (g.cfg(n).retries ?? g.cfg(n).attempts ?? 0) > 0 && g.reachable.has(n.id));
  if (retriers.length && !g.find('breaker').length && !g.find('mesh').length) {
    out.push(F({
      id: 'retry_no_breaker', severity: 'warn', title: 'Retries are enabled but nothing can stop them',
      what: `${retriers.map(g.label).join(', ')} will retry failed calls, and there is no circuit breaker or retry budget in the design.`,
      why: 'Retries are load amplification triggered by failure. With 3 attempts against a struggling backend you triple its load at exactly the moment it has the least capacity. This is the mechanism behind most cascading outages.',
      fix: [
        'Add a **Circuit Breaker** in front of the retried dependency.',
        'Use a **Retry + Backoff** component with full jitter and a retry budget (cap retries at ~20% of normal traffic).',
        'Only retry idempotent operations, and only on retryable errors.',
        'Confirm with the **Retry storm** chaos scenario.',
      ],
      nodeIds: retriers.map((n) => n.id), chapter: '23_building_blocks_and_algorithms.md',
    }));
  }

  // --- queue hygiene -------------------------------------------------------
  for (const q of queues) {
    const qc = g.cfg(q);
    if (qc.dlq === false) {
      out.push(F({
        id: 'no_dlq_' + q.id, severity: 'warn', title: `${g.label(q)} has no dead-letter queue`,
        what: 'Messages that always fail will be redelivered forever.',
        why: 'One poison message blocks a partition, consumes consumer capacity indefinitely and generates infinite error logs. The consumer never makes progress past it.',
        fix: ['Enable the **Dead-letter queue** and set a max-receive count.', 'Alert when the DLQ is non-empty. A DLQ nobody watches is just a slower way to lose data.'],
        nodeIds: [q.id], chapter: '12_messaging_and_event_streaming.md',
      }));
    }
    const consumers = (g.succ.get(q.id) || []).map((e) => g.byId.get(e.to)).filter(Boolean);
    for (const c of consumers) {
      if (g.cfg(c).idempotent === false) {
        out.push(F({
          id: 'not_idempotent_' + c.id, severity: 'warn', title: `${g.label(c)} is not idempotent behind an at-least-once queue`,
          what: 'The queue guarantees at-least-once delivery, so duplicates are certain, not hypothetical.',
          why: 'A visibility timeout that expires while a job is still running causes redelivery. If the handler is not idempotent, you send the email twice, charge the card twice, or double-count the metric.',
          fix: ['Make the handler idempotent with a natural key or an **idempotency key** table.', 'Or use exactly-once semantics where the platform supports it, and accept the throughput cost.'],
          nodeIds: [c.id], chapter: '10_distributed_transactions_and_integrity.md',
        }));
      }
    }
  }
  for (const k of g.nodes.filter((n) => n.type === 'kafka')) {
    const kc = g.cfg(k);
    const consumers = (g.succ.get(k.id) || []).map((e) => g.byId.get(e.to)).filter(Boolean);
    const parallel = consumers.reduce((s, c) => s + (g.cfg(c).replicas ?? 1) * (g.cfg(c).concurrency ?? g.cfg(c).parallelism ?? 1), 0);
    if (parallel > kc.partitions) {
      out.push(F({
        id: 'kafka_part_' + k.id, severity: 'warn', title: `More consumers (${parallel}) than partitions (${kc.partitions})`,
        what: `${parallel - kc.partitions} consumer slots will sit permanently idle.`,
        why: 'Within a consumer group, a partition is assigned to exactly one consumer. Partition count is a hard ceiling on parallelism, and you cannot reduce partitions later without rebuilding the topic.',
        fix: [`Increase partitions to at least ${parallel} (a common rule is 2-3x your expected peak consumer count).`, 'Or reduce consumer replicas and save the money.'],
        nodeIds: [k.id], chapter: '12_messaging_and_event_streaming.md',
      }));
    }
    if (kc.acks === '0') {
      out.push(F({
        id: 'kafka_acks_' + k.id, severity: 'critical', title: `${g.label(k)} is running with acks=0`,
        what: 'The producer does not wait for any acknowledgement.',
        why: 'Messages are dropped silently on broker failure, network blips, or buffer overflow. You will not see an error, you will see missing data days later.',
        fix: ['Set acks=all with min.insync.replicas=2.', 'Use acks=0 only for genuinely disposable telemetry.'],
        nodeIds: [k.id], chapter: '12_messaging_and_event_streaming.md',
      }));
    }
  }

  // --- chain depth & fan-out ----------------------------------------------
  for (const src of g.sources) {
    const d = g.depth(src.id);
    if (d > 6) {
      out.push(F({
        id: 'deep_chain', severity: 'warn', title: `Synchronous call chain is ${d} hops deep`,
        what: 'A single user request traverses many services before anything is returned.',
        why: 'Latency adds and availability multiplies. Ten hops at 99.9% each gives 99.0% overall (7 hours of downtime a month). Each hop also adds its own p99, and p99s do not average out, they accumulate.',
        fix: [
          'Collapse chatty adjacent services, or introduce a BFF that fans out in parallel instead of in series.',
          'Make non-essential hops asynchronous via a queue.',
          'Cache aggressively at the top of the chain so most requests never reach the bottom.',
        ],
        chapter: '16_microservices_and_service_architecture.md',
      }));
      break;
    }
  }
  for (const nnode of g.nodes) {
    const kids = (g.succ.get(nnode.id) || []).filter((e) => e.kind !== 'replication');
    const c = g.cfg(nnode);
    if (kids.length >= 4 && c.callMode === 'parallel') {
      out.push(F({
        id: 'fanout_' + nnode.id, severity: 'info', title: `${g.label(nnode)} fans out to ${kids.length} dependencies in parallel`,
        what: 'The response waits for the slowest of them.',
        why: `If each dependency has a 1% chance of being slow, the chance that at least one is slow is 1 - 0.99^${kids.length} = ${((1 - Math.pow(0.99, kids.length)) * 100).toFixed(1)}%. Your p99 becomes roughly their p${(100 - 100 / kids.length).toFixed(1)}. This is the tail at scale.`,
        fix: [
          'Send hedged requests: after p95 elapses, fire a duplicate to a second replica and take the first answer.',
          'Make non-critical branches optional with a short timeout and a default value.',
          'Reduce the fan-out by denormalising the data these calls fetch.',
        ],
        nodeIds: [nnode.id], chapter: '03_reliability_availability_performance.md',
      }));
      break;
    }
  }

  // --- locks ---------------------------------------------------------------
  for (const lock of g.find('lock')) {
    if (!g.reachable.has(lock.id)) continue;
    const lc = g.cfg(lock);
    const ceiling = lc.keys * (1000 / Math.max(0.1, lc.holdMs));
    out.push(F({
      id: 'lock_' + lock.id, severity: ceiling < rps ? 'critical' : 'info',
      title: `${g.label(lock)} caps throughput at ~${fmtNum(ceiling)} rps`,
      what: `${lc.keys} lock keys x (1000ms / ${lc.holdMs}ms hold time) = ${fmtNum(ceiling)} acquisitions per second, maximum.`,
      why: 'A lock is a serialisation point. Amdahl\'s Law says the serial fraction sets your ceiling regardless of how much parallel capacity you add behind it.',
      fix: [
        'Shorten the hold time. It is a linear multiplier on your ceiling.',
        'Increase key cardinality (lock per user, not per table).',
        'Ask whether you need a lock at all: optimistic concurrency with a version column, or a conditional write, is usually cheaper.',
        lc.fencing === false ? 'Enable **fencing tokens**: without them a paused holder can corrupt data after its lease expires.' : null,
      ].filter(Boolean),
      nodeIds: [lock.id], chapter: '21_distributed_systems_theory_consensus.md',
    }));
  }

  // --- payments / idempotency ---------------------------------------------
  for (const pay of g.nodes.filter((x) => x.type === 'payment_gw')) {
    if (g.cfg(pay).idempotencyKeys === false) {
      out.push(F({
        id: 'pay_idem_' + pay.id, severity: 'critical', title: 'Payment gateway without idempotency keys',
        what: 'A retried request can charge the customer twice.',
        why: 'A timeout is not a failure. The charge may well have succeeded and only the response was lost. Without an idempotency key the provider has no way to recognise the retry as the same operation.',
        fix: ['Enable **idempotency keys** and generate one per business operation, not per HTTP attempt.', 'Persist the key before you call, so a crash mid-flight is still recoverable.'],
        nodeIds: [pay.id], chapter: '10_distributed_transactions_and_integrity.md',
      }));
    }
  }

  // --- autoscaling & observability ----------------------------------------
  if (!g.find('autoscale').length && computeNodes.length) {
    out.push(F({
      id: 'no_autoscale', severity: 'info', title: 'Nothing in this design autoscales',
      what: 'Capacity is fixed at whatever you provisioned.',
      why: 'Fixed capacity means you either pay for peak all month or fall over at peak. Neither is necessary for stateless tiers.',
      fix: ['Swap a stateless **App Service** for a **Container Cluster (HPA)**.', 'Remember scaling is not instant: the simulator models pod startup time, so watch what happens in the 30 seconds before the new pods arrive.'],
      chapter: '17_containers_docker_kubernetes.md',
    }));
  }
  if (!g.find('observability').length && g.nodes.length > 4) {
    out.push(F({
      id: 'no_obs', severity: 'info', title: 'No observability in the design',
      what: 'There is no metrics, logging or tracing component.',
      why: 'Mean time to recovery is dominated by mean time to *detect* and mean time to *locate*. Without traces, a 6-hop request that got slow is a 6-way guess.',
      fix: ['Add a **Metrics / Logs / Traces** component.', 'Instrument RED metrics (Rate, Errors, Duration) per service and alert on p99, not on averages.'],
      chapter: '19_observability_and_operations.md',
    }));
  }

  // --- config hard dependency ---------------------------------------------
  for (const cfgn of g.nodes.filter((x) => x.type === 'config_server')) {
    if (g.cfg(cfgn).localFallback === false) {
      out.push(F({
        id: 'cfg_hard_' + cfgn.id, severity: 'warn', title: 'Config service is a hard dependency',
        what: 'There are no local fallback values.',
        why: 'You have made a control-plane component into a data-plane dependency. When config is unavailable, every service that reads it fails, including the ones that were otherwise perfectly healthy.',
        fix: ['Enable **local fallback values** and cache the last known good config on disk.', 'Control-plane outages should never become data-plane outages.'],
        nodeIds: [cfgn.id], chapter: '19_observability_and_operations.md',
      }));
    }
  }

  // --- what is already good -----------------------------------------------
  const good = [];
  if (caches.length) good.push('caching layer present');
  if (queues.length) good.push('asynchronous write buffer present');
  if (g.find('breaker').length || g.find('mesh').length) good.push('circuit breaking present');
  if (g.find('ratelimit').length || g.find('waf').length) good.push('admission control at the edge');
  if (g.find('autoscale').length) good.push('autoscaling enabled');
  if (g.find('replica').length) good.push('read replicas for read scaling');
  if (g.find('pool').length) good.push('connection pooling');
  if (g.find('observability').length) good.push('observability wired in');
  if (good.length) {
    out.push(F({ id: 'good', severity: 'good', title: 'What this design already gets right', what: good.join(' • '), chapter: null }));
  }

  return out;
}

// =============================================================================
// LIVE DIAGNOSIS
// =============================================================================

export function diagnose(engine) {
  if (!engine.graph) return [];
  const out = [];
  const m = engine.metrics;
  const graph = engine.graph;
  const wl = graph.workload;
  const label = (nd) => graph.nodes.find((n) => n.id === nd.id)?.label || nd.def.name;
  const states = [...engine.nodes.values()].filter((nd) => nd.inRate > 0 || nd.down);

  // ---- total outage -------------------------------------------------------
  const dead = states.filter((nd) => nd.down);
  for (const nd of dead) {
    const hasSiblings = nd.model.replicas > 1;
    out.push(F({
      id: 'down_' + nd.id, severity: 'critical', title: `${label(nd)} is DOWN`,
      what: `${fmtNum(nd.inRate)} rps are arriving at a component that is not answering.${nd.downTimer > 0 && nd.downTimer < 1e6 ? ` Recovery in ~${nd.downTimer.toFixed(0)}s.` : ' It has no automatic recovery path.'}`,
      why: hasSiblings
        ? 'Its siblings should be absorbing this traffic. If success rate has collapsed anyway, your balancer has not detected the failure yet: detection time is health-check interval x unhealthy threshold.'
        : 'Nothing else can serve this traffic. Every request that depends on this component is failing.',
      fix: [
        'Add redundancy so a peer can take over.',
        'Shorten the health-check interval to cut detection time (at the cost of more check traffic).',
        'Add a **Circuit Breaker** with a fallback so callers fail fast and degrade instead of hanging.',
      ],
      nodeIds: [nd.id], chapter: '03_reliability_availability_performance.md',
    }));
  }

  // ---- saturation ranking -------------------------------------------------
  const saturated = states.filter((nd) => nd.rho > 0.8 && !nd.down).sort((a, b) => b.rho - a.rho);
  for (const nd of saturated.slice(0, 3)) {
    const util = nd.rho;
    // Size against *arriving* load, not what currently gets through: once the
    // queue overflows, throughput equals capacity and would advise "no change".
    const offered = Math.max(nd.inRate, nd.acceptRate);
    const perReplica = nd.capacity / Math.max(1, nd.replicasNow);
    const need = Math.max(1, Math.ceil(offered / Math.max(1e-9, perReplica) / 0.7));
    out.push(F({
      id: 'sat_' + nd.id, severity: util > 1 ? 'critical' : 'warn',
      title: `${label(nd)} is ${util > 1 ? 'OVERLOADED' : 'saturated'} at ${(util * 100).toFixed(0)}% utilisation`,
      what: `${fmtNum(offered)} rps arriving against a capacity of ${fmtNum(nd.capacity)} rps. Queue depth ${fmtNum(nd.queue)}, added wait ${fmtMs(nd.waitMs)}.`,
      why: util > 1
        ? `Arrivals exceed capacity, so the queue grows without bound: it is gaining ${fmtNum(Math.max(0, offered - nd.capacity))} requests every second. There is no latency number that fixes this, only more capacity or less load. ${nd.model.queueCap ? `The queue caps at ${fmtNum(nd.model.queueCap)}, after which requests are dropped.` : ''}`
        : `Queueing delay grows as 1/(1-rho). At rho=${util.toFixed(2)} you are on the steep part of the curve: a further 10% of traffic will roughly ${util > 0.9 ? 'triple' : 'double'} the wait time. Capacity here = ${fmtNum(nd.workersEff)} workers / ${fmtMs(nd.occupancyMs)} occupancy.`,
      fix: [
        `Scale out to about ${need.toLocaleString()} ${nd.model.autoscale ? 'pods' : 'replicas'} to land near 70% utilisation (currently ${Math.round(nd.replicasNow).toLocaleString()}).`,
        nd.downstreamMs > nd.serviceMsEff * 1.5
          ? `Most of this component's occupancy (${fmtMs(nd.downstreamMs)} of ${fmtMs(nd.occupancyMs)}) is spent *waiting on its dependencies*, not working. Fix the downstream bottleneck first, or make the call asynchronous.`
          : `Reduce per-request work: currently ${fmtMs(nd.serviceMsEff)} of its own service time.`,
        'Add a cache in front so fewer requests reach it at all.',
        'Add admission control upstream so the excess is shed as 429 instead of queueing.',
      ],
      nodeIds: [nd.id], chapter: '02_scalability_and_estimation.md',
    }));
  }

  // ---- drops --------------------------------------------------------------
  for (const nd of states.filter((x) => x.dropRate > x.inRate * 0.01).sort((a, b) => b.dropRate - a.dropRate).slice(0, 2)) {
    out.push(F({
      id: 'drop_' + nd.id, severity: 'critical', title: `${label(nd)} is dropping ${fmtNum(nd.dropRate)} rps`,
      what: `${((nd.dropRate / Math.max(1e-9, nd.inRate)) * 100).toFixed(1)}% of requests arriving here are refused outright.`,
      why: nd.model.hardCapConc
        ? `Concurrency limit reached: ${fmtNum(nd.model.hardCapConc)} simultaneous executions. Serverless platforms have no queue, they reject immediately.`
        : `The queue is full (${fmtNum(nd.model.queueCap)} slots). Once the buffer is full, the only remaining option is to refuse work.`,
      fix: [
        'Add capacity so arrivals stop exceeding service rate. A bigger queue only delays the failure and makes latency worse while it does.',
        'Shed earlier and more cheaply: a 429 at the edge costs almost nothing, a drop here has already consumed work upstream.',
        'For serverless, raise reserved concurrency or put a queue in front to smooth the burst.',
      ],
      nodeIds: [nd.id], chapter: '05_load_balancing_proxies_traffic.md',
    }));
  }

  // ---- connection pool ----------------------------------------------------
  for (const nd of states.filter((x) => x.model.connLimit && x.connUtil > 0.85)) {
    out.push(F({
      id: 'conn_' + nd.id, severity: nd.connUtil > 1 ? 'critical' : 'warn',
      title: `${label(nd)} connection pool at ${(nd.connUtil * 100).toFixed(0)}%`,
      what: `Little's Law: ${fmtNum(nd.servedRate)} rps x ${fmtMs(nd.serviceMsEff + nd.waitMs)} = ${fmtNum(nd.concurrency)} concurrent connections needed, against a limit of ${fmtNum(nd.model.connLimit)}.`,
      why: 'Concurrency, not request rate, is what consumes connections. Slow queries hold connections longer, so latency and connection pressure feed each other: the slower it gets, the more connections it needs, which makes it slower.',
      fix: [
        'Add a **Connection Pooler** in transaction mode. It multiplexes thousands of client connections onto tens of server connections.',
        'Make the queries faster (index, or stop fetching columns you do not use). Halving query time halves connection demand.',
        'Add a cache so fewer queries are issued at all.',
        'Set a statement timeout so one runaway query cannot hold a connection forever.',
      ],
      nodeIds: [nd.id], chapter: '07_relational_databases_and_transactions.md',
    }));
  }

  // ---- cache health -------------------------------------------------------
  for (const nd of states.filter((x) => x.def.dispatch === 'cache')) {
    const configured = nd.model.hitRatio ?? 0;
    if (nd.hitRatioEff < configured - 0.05) {
      const downstream = nd.outRate;
      out.push(F({
        id: 'cachehit_' + nd.id, severity: nd.hitRatioEff < configured * 0.5 ? 'critical' : 'warn',
        title: `${label(nd)} effective hit ratio is ${(nd.hitRatioEff * 100).toFixed(1)}% (configured ${(configured * 100).toFixed(0)}%)`,
        what: `${fmtNum(downstream)} rps are missing the cache and hitting the origin.`,
        why: `Origin load = arrival rate x (1 - hit ratio). Every percentage point of hit ratio you lose near the top of the range is enormous: 99% to 98% doubles origin load. Right now you are sending ${(100 * (1 - nd.hitRatioEff)).toFixed(1)}% of ${fmtNum(nd.acceptRate)} rps downstream.`,
        fix: [
          nd.model.workingSetGB && nd.model.memGB && nd.model.workingSetGB > nd.model.memGB
            ? `Cache memory (${nd.model.memGB}GB) is smaller than the working set (${nd.model.workingSetGB}GB). Grow the cache or cache smaller values.`
            : 'Check the eviction policy: LFU retains genuinely hot keys where LRU is fooled by scans.',
          !nd.model.coalescing ? 'Enable request coalescing so simultaneous misses for the same key collapse into one origin call.' : null,
          !nd.model.jitter ? 'Enable TTL jitter so keys do not all expire in the same second.' : null,
          'Consider a second cache tier (in-process cache in front of Redis) for the very hottest keys.',
        ].filter(Boolean),
        nodeIds: [nd.id], chapter: '11_caching_cdn_and_edge.md',
      }));
    }
  }

  // ---- retry amplification ------------------------------------------------
  for (const nd of states.filter((x) => (x.retryAmp ?? 1) > 1.4)) {
    out.push(F({
      id: 'retry_' + nd.id, severity: 'critical', title: `${label(nd)} is amplifying load ${(nd.retryAmp).toFixed(2)}x through retries`,
      what: `${fmtNum(nd.servedRate)} rps of real traffic is generating ${fmtNum(nd.outRate)} rps of downstream calls.`,
      why: 'Retries are a positive feedback loop. The dependency fails, so you retry, which increases its load, which makes it fail more. Without a budget or breaker this converges on total collapse rather than recovery.',
      fix: [
        'Add a **Circuit Breaker** so calls fail fast once the error rate crosses a threshold.',
        'Cap retries with a retry budget (e.g. retries may not exceed 20% of base traffic).',
        'Use full jitter on the backoff so clients do not resynchronise.',
        'Reduce attempts from ' + ((nd.model.retries ?? 0) + 1) + ' to 2. The second attempt captures most of the benefit; the third mostly adds load.',
      ],
      nodeIds: [nd.id], chapter: '23_building_blocks_and_algorithms.md',
    }));
  }

  // ---- timeout budget -----------------------------------------------------
  for (const nd of states) {
    const t = nd.model.timeoutMs;
    if (!t) continue;
    if (nd.downstreamMs > t) {
      out.push(F({
        id: 'timeout_' + nd.id, severity: 'critical', title: `${label(nd)} times out before its dependencies answer`,
        what: `Downstream latency is ${fmtMs(nd.downstreamMs)} but the timeout is ${fmtMs(t)}.`,
        why: 'Every request does the full amount of work and then throws it away. You pay all the cost and get none of the benefit, and if retries are on you pay it several times.',
        fix: [
          'Fix the downstream latency first, this is a symptom.',
          'Set timeouts as a budget that decreases down the chain: if the user-facing SLO is 1s, the next hop gets 800ms, the one after 600ms.',
          'Never set an inner timeout longer than an outer one, or the outer one fires first and the inner work continues, wasted.',
        ],
        nodeIds: [nd.id], chapter: '03_reliability_availability_performance.md',
      }));
      break;
    }
  }

  // ---- tail amplification -------------------------------------------------
  if (m.p50 > 0 && m.p99 / m.p50 > 8 && m.samples > 200) {
    const worst = states.filter((x) => x.def.dispatch !== 'source').sort((a, b) => (b.waitMs + b.serviceMsEff) - (a.waitMs + a.serviceMsEff))[0];
    out.push(F({
      id: 'tail', severity: 'warn', title: `Tail latency is ${(m.p99 / m.p50).toFixed(1)}x the median`,
      what: `p50 ${fmtMs(m.p50)}, p95 ${fmtMs(m.p95)}, p99 ${fmtMs(m.p99)}.${worst ? ` The slowest single hop is ${label(worst)} at ${fmtMs(worst.waitMs + worst.serviceMsEff)}.` : ''}`,
      why: 'A healthy system has p99 within about 3-5x of p50. A large ratio means variance: queueing, garbage collection, cold starts, or fan-out where you wait for the slowest of N. Averages hide this completely, which is why nobody should page on an average.',
      fix: [
        'Reduce utilisation. Queueing variance explodes above rho=0.7 long before the mean does.',
        'Use hedged requests on read paths: after p95 elapses, send a duplicate and take whichever answers first.',
        'Cut fan-out width, or make optional branches genuinely optional with short timeouts.',
        'For serverless, enable provisioned concurrency to remove cold starts from the tail.',
      ],
      nodeIds: worst ? [worst.id] : [], chapter: '03_reliability_availability_performance.md',
    }));
  }

  // ---- throttling ---------------------------------------------------------
  if (m.throttledRps > m.offeredRps * 0.02) {
    out.push(F({
      id: 'throttling', severity: 'warn', title: `${fmtNum(m.throttledRps)} rps are being rate limited`,
      what: `${((m.throttledRps / Math.max(1e-9, m.offeredRps)) * 100).toFixed(1)}% of users are receiving HTTP 429.`,
      why: 'This is deliberate load shedding and it is working: the system is staying up. But it is only the right answer if the limit is set near your real capacity. If the backend has headroom, you are refusing traffic you could have served.',
      fix: [
        'Check downstream utilisation. If everything is below 60%, your limit is too low. Raise it.',
        'If downstream is saturated, the limit is doing its job. Add capacity to raise it safely.',
        'Rate limit per tenant/API key rather than globally, so one abusive client does not consume everyone\'s budget.',
      ],
      chapter: '23_building_blocks_and_algorithms.md',
    }));
  }

  // ---- async backlog ------------------------------------------------------
  for (const nd of states.filter((x) => x.def.dispatch === 'async' && x.queue > 1000)) {
    const consumers = nd.out.map((e) => engine.nodes.get(e.to)).filter(Boolean);
    const drain = consumers.reduce((s, c) => s + c.capacity, 0);
    const drainSec = drain > nd.inRate ? nd.queue / (drain - nd.inRate) : Infinity;
    out.push(F({
      id: 'backlog_' + nd.id, severity: isFinite(drainSec) ? 'warn' : 'critical',
      title: `${label(nd)} backlog is ${fmtNum(nd.queue)} messages`,
      what: isFinite(drainSec)
        ? `Consumers drain ${fmtNum(drain)} rps against ${fmtNum(nd.inRate)} rps arriving. The backlog clears in about ${drainSec > 3600 ? (drainSec / 3600).toFixed(1) + ' hours' : drainSec.toFixed(0) + ' seconds'} if traffic stops growing.`
        : `Consumers drain only ${fmtNum(drain)} rps against ${fmtNum(nd.inRate)} rps arriving. This backlog will never clear.`,
      why: 'A queue absorbing a burst is the system working as designed. A queue growing steadily means your consumer capacity is genuinely below your arrival rate, and the buffer is only postponing the failure. Watch the *age* of the oldest message, not just the depth.',
      fix: [
        `Scale consumers: you need at least ${Math.max(1, Math.ceil(nd.inRate / Math.max(1, drain / Math.max(1, consumers.reduce((s, c) => s + c.replicasNow, 0))))).toLocaleString()} workers just to keep up, more to catch up.`,
        'Reduce per-job time, or batch jobs so fixed overhead is amortised.',
        'For Kafka, confirm you have enough partitions: consumers beyond the partition count sit idle.',
      ],
      nodeIds: [nd.id, ...consumers.map((c) => c.id)], chapter: '12_messaging_and_event_streaming.md',
    }));
  }

  // ---- autoscaler at ceiling ---------------------------------------------
  for (const nd of states.filter((x) => x.model.autoscale && x.replicasNow >= x.model.maxReplicas - 0.01 && x.rho > 0.85)) {
    out.push(F({
      id: 'hpa_' + nd.id, severity: 'critical', title: `${label(nd)} has hit its autoscaling ceiling`,
      what: `Running at max (${nd.model.maxReplicas} pods) and still ${(nd.rho * 100).toFixed(0)}% utilised.`,
      why: 'The autoscaler has no moves left. Whatever the max was protecting you from (cost, a downstream connection limit) is now the thing capping your availability.',
      fix: [
        'Raise maxReplicas, but first check what breaks next. Usually it is the database connection limit.',
        'Lower the HPA target CPU so it starts scaling earlier: scaling is not instant and you are always scaling for the traffic of 30 seconds ago.',
        'Make each pod cheaper per request (caching, fewer downstream calls).',
      ],
      nodeIds: [nd.id], chapter: '17_containers_docker_kubernetes.md',
    }));
  }

  // ---- breaker open -------------------------------------------------------
  for (const nd of states.filter((x) => x.breakerOpen)) {
    out.push(F({
      id: 'breaker_' + nd.id, severity: 'info', title: `${label(nd)} circuit breaker is OPEN`,
      what: `Calls are failing fast for another ${nd.breakerTimer.toFixed(0)}s${nd.model.fallback ? ', serving the fallback response' : ''}.`,
      why: 'This is the breaker doing exactly its job: it has stopped your threads from piling up on a dependency that is not answering. Latency should have dropped sharply the moment it tripped.',
      fix: nd.model.fallback
        ? ['Nothing to fix here. Verify the fallback is actually useful to the user rather than an empty page.']
        : ['Enable a **fallback response** so users get degraded service (stale data, defaults) instead of an error.'],
      nodeIds: [nd.id], chapter: '03_reliability_availability_performance.md',
    }));
  }

  // ---- SLO --------------------------------------------------------------
  const slo = wl.sloSuccessPct ?? 99;
  const sloLat = wl.sloP99Ms ?? 500;
  if (m.samples > 100) {
    if (m.successRate * 100 < slo) {
      const budgetPerMonth = (1 - slo / 100) * 30 * 24 * 60;
      const burn = (1 - m.successRate) / Math.max(1e-9, 1 - slo / 100);
      out.push(F({
        id: 'slo_success', severity: 'critical', title: `Success rate ${(m.successRate * 100).toFixed(2)}% is below the ${slo}% objective`,
        what: `${fmtNum(m.errorRps + m.timeoutRps + m.droppedRps)} rps are failing (${fmtNum(m.errorRps)} errors, ${fmtNum(m.timeoutRps)} timeouts, ${fmtNum(m.droppedRps)} drops).`,
        why: `Your monthly error budget at ${slo}% is about ${budgetPerMonth.toFixed(0)} minutes of full outage. At the current failure rate you are burning it ${burn.toFixed(1)}x faster than sustainable: the whole month's budget goes in ${(budgetPerMonth / Math.max(0.01, burn)).toFixed(0)} minutes.`,
        fix: ['Work down the critical findings above, highest severity first.', 'The bottleneck is almost always the most saturated component: fix that one and re-measure before changing anything else.'],
        chapter: '03_reliability_availability_performance.md',
      }));
    }
    if (m.p99 > sloLat) {
      out.push(F({
        id: 'slo_lat', severity: 'warn', title: `p99 latency ${fmtMs(m.p99)} exceeds the ${fmtMs(sloLat)} objective`,
        what: `p50 ${fmtMs(m.p50)} • p95 ${fmtMs(m.p95)} • p99 ${fmtMs(m.p99)} • p99.9 ${fmtMs(m.p999)}.`,
        why: 'p99 means one request in a hundred. A user making 100 requests in a session almost certainly hits it. p99 is a common experience, not an edge case.',
        fix: ['Find the hop with the largest wait time in the node list and attack that first.', 'Latency budgets should be assigned per hop, not just measured end to end.'],
        chapter: '03_reliability_availability_performance.md',
      }));
    }
  }

  // ---- cost ---------------------------------------------------------------
  const budget = wl.budgetUsd ?? 0;
  if (budget > 0 && m.cost > budget) {
    const top = m.costBreakdown.slice(0, 3);
    out.push(F({
      id: 'cost', severity: 'warn', title: `Estimated $${Math.round(m.cost).toLocaleString()}/month exceeds the $${budget.toLocaleString()} budget`,
      what: `Largest line items: ${top.map((t) => `${t.name} $${Math.round(t.cost).toLocaleString()}`).join(', ')}.`,
      why: 'Architecture decisions are purchasing decisions. A design that meets the SLO at 4x the budget has not met the requirements.',
      fix: [
        'Cache harder: a cache hit is roughly two orders of magnitude cheaper than a database read.',
        'Right-size instances against actual utilisation rather than peak headroom.',
        'Move cold data to a cheaper storage tier.',
        'Use autoscaling so you stop paying for peak capacity 24/7.',
      ],
      chapter: '20_deployment_multiregion_dr_cost.md',
    }));
  }

  if (!out.length && m.samples > 50) {
    out.push(F({
      id: 'healthy', severity: 'good', title: 'System is healthy at this load',
      what: `${fmtNum(m.okRps)} rps served, p99 ${fmtMs(m.p99)}, success ${(m.successRate * 100).toFixed(2)}%, $${Math.round(m.cost).toLocaleString()}/month.`,
      why: 'Nothing is saturated and nothing is failing. This is the moment to find the breaking point rather than to stop.',
      fix: [
        'Raise the RPS until something turns red. Note the number: that is your real capacity.',
        'Inject a chaos scenario and see whether the design degrades gracefully or falls off a cliff.',
        'Try removing a component and confirm the simulator complains. Understanding why something is needed beats memorising that it is.',
      ],
      chapter: null,
    }));
  }

  return out;
}

// =============================================================================
// SCORING
// =============================================================================

export function scoreDesign(engine, staticFindings, runtimeFindings) {
  const m = engine.metrics;
  const wl = engine.graph?.workload || {};
  const slo = wl.sloSuccessPct ?? 99;
  const sloLat = wl.sloP99Ms ?? 500;

  const reliability = clamp(100 - (Math.max(0, slo - m.successRate * 100) * 12), 0, 100);
  const latency = clamp(100 - Math.max(0, (m.p99 - sloLat) / Math.max(1, sloLat)) * 45, 0, 100);
  const all = [...staticFindings, ...runtimeFindings];
  const crit = all.filter((f) => f.severity === 'critical').length;
  const warn = all.filter((f) => f.severity === 'warn').length;
  const design = clamp(100 - crit * 18 - warn * 7, 0, 100);
  const util = (() => {
    const nodes = [...engine.nodes.values()].filter((n) => n.inRate > 0 && n.def.dispatch !== 'source');
    if (!nodes.length) return 100;
    const avg = nodes.reduce((s, n) => s + clamp(n.rho, 0, 1.5), 0) / nodes.length;
    return clamp(100 - Math.abs(avg - 0.6) * 110, 0, 100);
  })();
  const budget = wl.budgetUsd ?? 0;
  const cost = budget > 0 ? clamp(100 - Math.max(0, (m.cost - budget) / budget) * 60, 0, 100) : 100;

  const score = Math.round(reliability * 0.28 + latency * 0.2 + design * 0.32 + util * 0.1 + cost * 0.1);
  const safe = Number.isFinite(score) ? clamp(score, 0, 100) : 0;
  const grade = safe >= 92 ? 'A+' : safe >= 85 ? 'A' : safe >= 76 ? 'B' : safe >= 65 ? 'C' : safe >= 50 ? 'D' : 'F';
  return { score: safe, grade, parts: { reliability, latency, design, util, cost }, crit, warn };
}

export function chapterUrl(chapter) {
  const base = bookBase();
  if (!chapter || !base) return null;
  return base + chapter;
}

/** Human-readable chapter name, used when no book is linked. */
export function chapterLabel(chapter) {
  if (!chapter) return '';
  return chapter.split('#')[0].replace(/^\d+_/, '').replace(/_/g, ' ').replace('.md', '');
}
