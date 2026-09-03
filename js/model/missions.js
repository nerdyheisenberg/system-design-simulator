// GUIDED MISSIONS
// A mission gives you a starting topology, a workload, a set of measurable
// objectives, and (sometimes) a scripted incident. Objectives must all hold
// simultaneously for `holdSec` of simulated time before the mission passes.
//
// The `check(ctx)` API:
//   ctx.m           – current metrics (p50/p95/p99, successRate, cost, rps...)
//   ctx.has(cap)    – is any component with this capability in the design?
//   ctx.count(type) – how many nodes of a component type
//   ctx.maxRho      – highest utilisation of any component
//   ctx.crit        – number of critical Doctor findings
//   ctx.warn        – number of warning Doctor findings
//   ctx.elapsed     – simulated seconds since the run started

export const MISSIONS = [
  {
    id: 'm01_first_bottleneck', name: 'Find the first bottleneck', level: '1 · Foundations',
    chapter: '02_scalability_and_estimation.md', blueprint: 'naive',
    brief: 'One web server, one database, 800 rps. Something here is already close to the edge. Raise the traffic until it breaks, work out which component gave up first and why, then make it survive 5,000 rps with p99 under 300ms.',
    teaches: 'Capacity = concurrency ÷ service time. Every component has a hard ceiling, and utilisation above ~0.7 makes queueing delay grow faster than the load that caused it.',
    workload: { rps: 5000, pattern: 'ramp', rampSec: 45, readPct: 92, sloP99Ms: 300, sloSuccessPct: 99 },
    holdSec: 15,
    objectives: [
      { id: 'rps', label: 'Serve at least 4,800 rps successfully', hint: 'Watch which node turns red first. Scaling the wrong one changes nothing.', check: (c) => c.m.okRps >= 4800 },
      { id: 'p99', label: 'Keep p99 latency under 300ms', hint: 'Latency is dominated by queueing wait, not service time. Reduce utilisation, not work.', check: (c) => c.m.p99 > 0 && c.m.p99 < 300 },
      { id: 'success', label: 'Success rate at or above 99%', hint: 'Drops come from full queues. Something upstream needs to shed or something downstream needs capacity.', check: (c) => c.m.successRate >= 0.99 },
      { id: 'headroom', label: 'No component above 85% utilisation', hint: 'Aim for 60-70%. That is where you have room to absorb a spike.', check: (c) => c.maxRho <= 0.85 },
    ],
  },
  {
    id: 'm02_cache', name: 'Make reads cheap', level: '1 · Foundations',
    chapter: '11_caching_cdn_and_edge.md', blueprint: 'crud',
    brief: 'A read-heavy API is hammering PostgreSQL at 25,000 rps. Add caching so the database sees a small fraction of that, without breaking the latency target.',
    teaches: 'Origin load = λ × (1 − hit ratio). Hit ratio is the single highest-leverage number in most read-heavy systems.',
    workload: { rps: 25000, pattern: 'steady', readPct: 96, sloP99Ms: 120, sloSuccessPct: 99.5 },
    holdSec: 15,
    objectives: [
      { id: 'cache', label: 'A cache exists in the read path', hint: 'Cache (Redis) or Redis Cluster, sitting between the app and the database.', check: (c) => c.has('cache') },
      { id: 'dbload', label: 'Database receives under 3,000 rps', hint: 'That needs roughly a 90% effective hit ratio. Check the cache is big enough for the working set.', check: (c) => c.rateInto((n) => n.def.caps.includes('db')) < 3000 },
      { id: 'p99', label: 'p99 under 120ms', check: (c) => c.m.p99 > 0 && c.m.p99 < 120 },
      { id: 'ok', label: 'Success rate at or above 99.5%', check: (c) => c.m.successRate >= 0.995 },
    ],
  },
  {
    id: 'm03_spof', name: 'Remove every single point of failure', level: '2 · Reliability',
    chapter: '03_reliability_availability_performance.md', blueprint: 'naive',
    brief: 'One web server, one database, no standby. At 40 seconds an instance is killed, and at 90 seconds the database. Build a topology that does not notice.',
    teaches: 'Redundancy only counts when something detects the failure and stops routing to it. Detection time is health-check interval × unhealthy threshold.',
    workload: { rps: 6000, pattern: 'steady', readPct: 90, sloP99Ms: 400, sloSuccessPct: 99 },
    chaos: [{ chaosId: 'node_crash', atSec: 40, targetCap: 'compute' }, { chaosId: 'db_crash', atSec: 90 }],
    holdSec: 20, minRunSec: 120,
    objectives: [
      { id: 'nospof', label: 'Doctor reports no single point of failure', hint: 'Every component on the path needs ≥2 replicas, and the SQL primary needs a Multi-AZ standby.', check: (c) => !c.findings.some((f) => f.id === 'spof') },
      { id: 'survive', label: 'Success rate stays at or above 99% through both incidents', hint: 'Balancers must detect the dead instance quickly. Shorten the health-check interval.', check: (c) => c.m.successRate >= 0.99 },
      { id: 'p99', label: 'p99 stays under 400ms during failover', check: (c) => c.m.p99 > 0 && c.m.p99 < 400 },
    ],
  },
  {
    id: 'm04_stampede', name: 'Survive a cold cache', level: '2 · Reliability',
    chapter: '11_caching_cdn_and_edge.md', blueprint: 'url_shortener',
    brief: 'At 30 seconds the cache is flushed. Right now that would push 40,000 rps straight into the datastore. Design so the flush is a blip, not an outage.',
    teaches: 'A cache is a capacity multiplier, and multipliers work in both directions. Coalescing, jitter and a shielded origin are what stop a flush from becoming an outage.',
    workload: { rps: 40000, pattern: 'steady', readPct: 99, sloP99Ms: 100, sloSuccessPct: 99 },
    chaos: [{ chaosId: 'cache_flush', atSec: 30 }],
    holdSec: 20, minRunSec: 100,
    patch: (g) => {
      const c = g.nodes.find((n) => n.type === 'redis_cluster');
      if (c) Object.assign(c.cfg, { coalescing: false, shards: 2, memPerShardGB: 8, workingSetGB: 90 });
    },
    objectives: [
      { id: 'coalesce', label: 'Request coalescing is enabled on the cache', hint: 'Select the cache node and turn on "Request coalescing".', check: (c) => c.anyCfg((n) => n.def.caps.includes('cache'), (cfg) => cfg.coalescing === true || cfg.shield === true) },
      { id: 'survive', label: 'Success rate stays at or above 99% while the cache is cold', hint: 'The origin must be able to absorb the miss traffic, or something must shed it.', check: (c) => c.m.successRate >= 0.99 },
      { id: 'p99', label: 'p99 stays under 400ms during the flush', check: (c) => c.m.p99 > 0 && c.m.p99 < 400 },
    ],
  },
  {
    id: 'm05_connections', name: 'Fix the connection arithmetic', level: '2 · Reliability',
    chapter: '07_relational_databases_and_transactions.md', blueprint: 'crud',
    brief: 'Scale the API to 40 replicas with 100 threads each and watch the database refuse connections. Then make it work.',
    teaches: 'Connections are consumed by concurrency (Little\'s Law), not by request rate. Poolers exist because databases cannot fork a process per caller thread.',
    workload: { rps: 15000, pattern: 'steady', readPct: 85, sloP99Ms: 250, sloSuccessPct: 99.5 },
    holdSec: 15,
    objectives: [
      { id: 'pool', label: 'A connection pooler sits in front of the database', hint: 'Add the Connection Pooler component in transaction mode.', check: (c) => c.has('pool') },
      { id: 'connmath', label: 'Doctor no longer reports broken connection arithmetic', check: (c) => !c.findings.some((f) => f.id.startsWith('conn_math')) },
      { id: 'connutil', label: 'Database connection utilisation below 85%', check: (c) => c.maxOf((n) => (n.model.connLimit ? n.connUtil : 0)) < 0.85 },
      { id: 'ok', label: 'Success rate at or above 99.5%', check: (c) => c.m.successRate >= 0.995 },
    ],
  },
  {
    id: 'm06_writes', name: 'Absorb a write burst', level: '3 · Scaling',
    chapter: '12_messaging_and_event_streaming.md', blueprint: 'crud',
    brief: 'The read/write mix flips: 70% of 20,000 rps are now writes. Caches and replicas will not help you here.',
    teaches: 'Writes cannot be cached. Your only levers are buffering (queue), partitioning (shard) and reducing work per write (batch).',
    workload: { rps: 20000, pattern: 'steady', readPct: 30, sloP99Ms: 300, sloSuccessPct: 99 },
    holdSec: 15,
    objectives: [
      { id: 'buffer', label: 'Writes go through a queue or the datastore is sharded', hint: 'Either a Message Queue / Kafka in the write path, or a Sharded SQL Cluster.', check: (c) => c.has('queue') || c.has('shard') || c.count('kv_store') > 0 },
      { id: 'ok', label: 'Success rate at or above 99%', check: (c) => c.m.successRate >= 0.99 },
      { id: 'p99', label: 'p99 under 300ms', check: (c) => c.m.p99 > 0 && c.m.p99 < 300 },
      { id: 'backlog', label: 'No queue backlog growing without bound', hint: 'Consumer capacity must exceed the arrival rate, not just buffer it.', check: (c) => c.maxOf((n) => (n.def.dispatch === 'async' ? n.queue : 0)) < 200000 },
    ],
  },
  {
    id: 'm07_flash', name: 'Flash sale: 30× in three seconds', level: '3 · Scaling',
    chapter: '24_case_studies_part1.md', blueprint: 'flash_sale',
    brief: 'Traffic goes from 2,000 to 150,000 rps in three seconds and decays over 90. Autoscaling will not arrive in time. Keep the site up and do not oversell.',
    teaches: 'When you cannot add capacity fast enough, the only remaining tools are shedding, buffering and precomputation. Decide which requests matter and refuse the rest cheaply.',
    workload: { rps: 5000, pattern: 'flashsale', spikeMult: 30, saleAtSec: 20, decaySec: 90, readPct: 70, sloP99Ms: 800, sloSuccessPct: 95 },
    holdSec: 25, minRunSec: 90,
    objectives: [
      { id: 'shed', label: 'Admission control at the edge', hint: 'A Rate Limiter or WAF before the gateway. Refusing traffic at the edge costs almost nothing.', check: (c) => c.has('ratelimit') || c.has('waf') },
      { id: 'ok', label: 'Success rate at or above 95% of admitted traffic', check: (c) => c.m.successRate >= 0.95 },
      { id: 'nodrop', label: 'Fewer than 2% of requests dropped or timing out', hint: 'A 429 is fine. A timeout is not: you paid for the work and threw it away.', check: (c) => (c.m.droppedRps + c.m.timeoutRps) < c.m.offeredRps * 0.02 },
      { id: 'db', label: 'Database utilisation stays below 90%', check: (c) => c.maxOf((n) => (n.def.caps.includes('db') ? n.rho : 0)) < 0.9 },
    ],
  },
  {
    id: 'm08_tail', name: 'Kill the tail', level: '3 · Scaling',
    chapter: '03_reliability_availability_performance.md', blueprint: 'microservices',
    brief: 'The median is fine and the 99th percentile is terrible. Six services, a parallel fan-out and a slow recommendation service. Get p99 within 4× of p50.',
    teaches: 'Fan-out means waiting for the slowest of N. p99 of a 5-way parallel call is roughly the p99.8 of each dependency.',
    workload: { rps: 8000, pattern: 'steady', readPct: 88, sloP99Ms: 250, sloSuccessPct: 99.5 },
    holdSec: 15,
    objectives: [
      { id: 'ratio', label: 'p99 no more than 4× p50', hint: 'Reduce fan-out width, cache the slow branch, or make it optional with a short timeout.', check: (c) => c.m.p50 > 0 && c.m.p99 / c.m.p50 <= 4 },
      { id: 'p99', label: 'p99 under 250ms', check: (c) => c.m.p99 > 0 && c.m.p99 < 250 },
      { id: 'ok', label: 'Success rate at or above 99.5%', check: (c) => c.m.successRate >= 0.995 },
    ],
  },
  {
    id: 'm09_dependency', name: 'Contain a failing dependency', level: '4 · Resilience',
    chapter: '03_reliability_availability_performance.md', blueprint: 'ecommerce',
    brief: 'At 35 seconds the payment provider degrades to multi-second latency, then goes down entirely. Browsing must stay fast for everyone who is not checking out.',
    teaches: 'Isolation. A failure in one dependency should cost you that feature, not the whole product. Bulkheads, breakers and timeouts are how you buy that.',
    workload: { rps: 9000, pattern: 'steady', readPct: 88, sloP99Ms: 500, sloSuccessPct: 97 },
    chaos: [{ chaosId: 'third_party_slow', atSec: 35, targetType: 'payment_gw' }, { chaosId: 'third_party_outage', atSec: 100, targetType: 'payment_gw' }],
    holdSec: 20, minRunSec: 140,
    objectives: [
      { id: 'breaker', label: 'The external dependency is behind a circuit breaker', check: (c) => c.has('breaker') || c.has('mesh') },
      { id: 'bulkhead', label: 'Concurrency to it is bounded (bulkhead or queue)', hint: 'Otherwise every thread in the checkout service ends up blocked on it.', check: (c) => c.has('bulkhead') || c.has('queue') },
      { id: 'ok', label: 'Overall success rate stays at or above 97%', hint: 'Checkout may degrade. Browsing must not.', check: (c) => c.m.successRate >= 0.97 },
      { id: 'p99', label: 'p99 stays under 500ms while the provider is down', hint: 'If p99 tracks their latency, your timeout is too long or nothing is failing fast.', check: (c) => c.m.p99 > 0 && c.m.p99 < 500 },
    ],
  },
  {
    id: 'm10_retry', name: 'Break the retry storm', level: '4 · Resilience',
    chapter: '23_building_blocks_and_algorithms.md', blueprint: 'microservices',
    brief: 'Turn retries up to 3 attempts everywhere, then inject a backend slowdown and watch the load multiply. Now make the system recover instead of collapsing.',
    teaches: 'Retries are load amplification triggered by failure — a positive feedback loop. Budgets, breakers and jitter turn it into negative feedback.',
    workload: { rps: 10000, pattern: 'steady', readPct: 85, sloP99Ms: 400, sloSuccessPct: 98 },
    chaos: [{ chaosId: 'bad_deploy', atSec: 30, targetCap: 'db' }, { chaosId: 'thundering_herd', atSec: 80 }],
    holdSec: 20, minRunSec: 120,
    patch: (g) => {
      for (const n of g.nodes) if (n.type === 'app_server') n.cfg.retries = 3;
      const mesh = g.nodes.find((n) => n.type === 'service_mesh');
      if (mesh) Object.assign(mesh.cfg, { breaker: false, retries: 3 });
    },
    objectives: [
      { id: 'noamp', label: 'No component amplifying load more than 1.4×', hint: 'Reduce attempts, add a retry budget, or add a breaker.', check: (c) => c.maxOf((n) => n.retryAmp ?? 1) <= 1.4 },
      { id: 'breaker', label: 'A circuit breaker or mesh protects the retried dependency', check: (c) => c.has('breaker') || c.has('mesh') },
      { id: 'recover', label: 'Success rate back at or above 98%', check: (c) => c.m.successRate >= 0.98 },
    ],
  },
  {
    id: 'm11_budget', name: 'Meet the SLO on a budget', level: '5 · Trade-offs',
    chapter: '20_deployment_multiregion_dr_cost.md', blueprint: 'social_feed',
    brief: 'The current design meets the latency target and costs far too much. Hit 99.9% success and p99 under 250ms for under $18,000/month.',
    teaches: 'Architecture is a purchasing decision. A design that meets the SLO at four times the budget has not met the requirements.',
    workload: { rps: 25000, pattern: 'steady', readPct: 92, sloP99Ms: 250, sloSuccessPct: 99.9, budgetUsd: 18000 },
    holdSec: 20,
    objectives: [
      { id: 'cost', label: 'Estimated cost under $18,000/month', hint: 'Caching is the cheapest capacity you can buy. Right-size instances against real utilisation.', check: (c) => c.m.cost > 0 && c.m.cost < 18000 },
      { id: 'p99', label: 'p99 under 250ms', check: (c) => c.m.p99 > 0 && c.m.p99 < 250 },
      { id: 'ok', label: 'Success rate at or above 99.9%', check: (c) => c.m.successRate >= 0.999 },
      { id: 'util', label: 'No component under 25% utilised', hint: 'Idle capacity is money on fire. Scale it down.', check: (c) => c.minActiveRho() >= 0.25 },
    ],
  },
  {
    id: 'm12_multiregion', name: 'Survive losing a region', level: '5 · Trade-offs',
    chapter: '20_deployment_multiregion_dr_cost.md', blueprint: 'multiregion',
    brief: 'At 45 seconds an entire availability zone disappears, then a region-wide latency event hits. Stay inside the SLO.',
    teaches: 'Correlated failure defeats naive redundancy, and every cross-region synchronous write costs a full RTT you cannot optimise away.',
    workload: { rps: 20000, pattern: 'steady', readPct: 88, sloP99Ms: 600, sloSuccessPct: 99.5 },
    chaos: [{ chaosId: 'az_outage', atSec: 45 }, { chaosId: 'net_latency_500', atSec: 120, targetCap: 'compute' }],
    holdSec: 20, minRunSec: 160,
    objectives: [
      { id: 'ok', label: 'Success rate at or above 99.5% throughout', check: (c) => c.m.successRate >= 0.995 },
      { id: 'p99', label: 'p99 under 600ms throughout', check: (c) => c.m.p99 > 0 && c.m.p99 < 600 },
      { id: 'nocrit', label: 'No critical findings from the Doctor', check: (c) => c.crit === 0 },
    ],
  },
  {
    id: 'm13_agent', name: 'Make an agent affordable', level: '6 · AI Systems',
    chapter: '15_apis_and_protocols.md', blueprint: 'agent',
    brief: 'A 4-step agent costs a fortune and its p99 is measured in minutes. Cut cost below $90,000/month and p99 below 45 seconds without removing the agent.',
    teaches: 'Every reasoning step multiplies latency, cost and failure probability. Caching, fewer steps and smaller context are the only real levers.',
    workload: { rps: 5, pattern: 'steady', readPct: 92, timeoutMs: 180000, sloP99Ms: 45000, sloSuccessPct: 98, budgetUsd: 90000 },
    holdSec: 20,
    objectives: [
      { id: 'cost', label: 'Cost under $90,000/month', hint: 'Reduce steps, shrink the input context, or put a semantic cache in front of the LLM.', check: (c) => c.m.cost > 0 && c.m.cost < 90000 },
      { id: 'p99', label: 'p99 under 45 seconds', check: (c) => c.m.p99 > 0 && c.m.p99 < 45000 },
      { id: 'ok', label: 'Success rate at or above 98%', hint: 'Tool reliability compounds: 0.98^4 is 92%. Protect the tool calls.', check: (c) => c.m.successRate >= 0.98 },
    ],
  },
  {
    id: 'm14_greenfield', name: 'Greenfield: design it yourself', level: '6 · Open Challenge',
    chapter: '26_interview_playbook_and_question_bank.md', blueprint: null,
    brief: 'Empty canvas. 50,000 rps, 93% reads, 99.95% success, p99 under 150ms, under $30,000/month, and it must survive a database crash and a cache flush. This is a full interview answer, simulated.',
    teaches: 'Everything. Start from the client, work down, and justify each component with a number rather than a habit.',
    workload: { rps: 50000, pattern: 'steady', readPct: 93, payloadKB: 30, sloP99Ms: 150, sloSuccessPct: 99.95, budgetUsd: 30000 },
    chaos: [{ chaosId: 'cache_flush', atSec: 60 }, { chaosId: 'db_crash', atSec: 130 }],
    holdSec: 25, minRunSec: 180,
    objectives: [
      { id: 'ok', label: 'Success rate at or above 99.95%', check: (c) => c.m.successRate >= 0.9995 },
      { id: 'p99', label: 'p99 under 150ms', check: (c) => c.m.p99 > 0 && c.m.p99 < 150 },
      { id: 'cost', label: 'Cost under $30,000/month', check: (c) => c.m.cost > 0 && c.m.cost < 30000 },
      { id: 'nocrit', label: 'Zero critical Doctor findings', check: (c) => c.crit === 0 },
      { id: 'headroom', label: 'No component above 80% utilisation', check: (c) => c.maxRho <= 0.8 },
    ],
  },
];

/** Builds the evaluation context the objective checks receive. */
export function missionContext(engine, findings) {
  const states = [...engine.nodes.values()];
  const active = states.filter((n) => n.inRate > 0 && n.def.dispatch !== 'source');
  return {
    engine, m: engine.metrics, elapsed: engine.t, findings,
    crit: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    has: (cap) => states.some((n) => (n.def.caps || []).includes(cap)),
    count: (type) => states.filter((n) => n.type === type).length,
    maxRho: active.length ? Math.max(...active.map((n) => n.rho)) : 0,
    minActiveRho: () => (active.length ? Math.min(...active.map((n) => n.rho)) : 1),
    maxOf: (fn) => (states.length ? Math.max(...states.map(fn)) : 0),
    rateInto: (pred) => states.filter(pred).reduce((s, n) => s + n.inRate, 0),
    anyCfg: (pred, cfgTest) => states.filter(pred).some((n) => cfgTest(n.cfg)),
  };
}
