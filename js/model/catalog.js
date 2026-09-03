// COMPONENT CATALOG
// -----------------------------------------------------------------------------
// Every component declares:
//   params   – what the learner can tune
//   derive() – translates params into the queueing model the engine understands
//              ({ replicas, workers, serviceMs, queueCap, ... })
//   cost()   – USD/month, AWS-ish list prices (us-east-1, on-demand)
//   caps     – capability tags the System Design Doctor reasons about
//   chapter  – the book chapter that explains this component
//
// dispatch semantics (used by the engine):
//   source    generates traffic
//   split     load is shared across outgoing edges  (one child per request)
//   all       load is sent to every outgoing edge   (fan-out)
//   cache     hit fraction returns immediately, miss fraction flows onward
//   terminal  request ends here (databases, storage)
//   async     caller is released at enqueue; consumers drain independently

const CAT = {
  client:  { label: 'Client & Edge',    color: '#38bdf8' },
  network: { label: 'Traffic & Routing', color: '#60a5fa' },
  resil:   { label: 'Resilience',        color: '#f472b6' },
  compute: { label: 'Compute',           color: '#34d399' },
  sql:     { label: 'Relational Data',   color: '#fbbf24' },
  nosql:   { label: 'NoSQL & Analytics', color: '#fb923c' },
  cache:   { label: 'Caching',           color: '#f87171' },
  storage: { label: 'Storage',           color: '#a78bfa' },
  msg:     { label: 'Messaging',         color: '#c084fc' },
  coord:   { label: 'Coordination',      color: '#2dd4bf' },
  ai:      { label: 'AI & Agents',       color: '#e879f9' },
  ext:     { label: 'External & Ops',    color: '#94a3b8' },
};

export const CATEGORIES = CAT;

// ---- param shorthand --------------------------------------------------------
const n = (k, label, def, min, max, step, unit, help) =>
  ({ k, label, type: 'num', def, min, max, step, unit, help });
const s = (k, label, def, options, help) => ({ k, label, type: 'select', def, options, help });
const b = (k, label, def, help) => ({ k, label, type: 'bool', def, help });
const pct = (k, label, def, help) => ({ k, label, type: 'num', def, min: 0, max: 100, step: 1, unit: '%', help });

const COMMON = {
  replicas: (def = 2, max = 200) => n('replicas', 'Replicas / nodes', def, 1, max, 1, '', 'How many independent instances. 1 replica = single point of failure.'),
  timeout: (def = 1000) => n('timeoutMs', 'Downstream timeout', def, 10, 60000, 10, 'ms', 'How long this component waits before giving up on a call.'),
  retries: (def = 0) => n('retries', 'Retry attempts', def, 0, 5, 1, '', 'Extra attempts on failure. Each retry multiplies load on the failing dependency.'),
};

const list = [];
const C = (def) => { list.push(def); return def; };

// =============================================================================
// CLIENT & EDGE
// =============================================================================

C({
  id: 'client', name: 'Client / Users', cat: 'client', glyph: 'USR', dispatch: 'source',
  blurb: 'Traffic source. Global RPS, read/write mix and traffic shape are set in the toolbar.',
  chapter: '01_from_zero_computers_networks_web.md',
  caps: ['source'], singleton: false,
  params: [
    n('sharePct', 'Share of global traffic', 100, 0, 100, 1, '%', 'If you have several client nodes, this splits the global RPS between them.'),
    n('rttMs', 'Client network RTT', 25, 0, 500, 1, 'ms', 'Round-trip time from user device to your edge. Mobile 4G ≈ 50–120ms.'),
    n('payloadKB', 'Avg response size', 20, 0.1, 10000, 0.1, 'KB', 'Drives egress bandwidth cost and transfer time.'),
  ],
  derive: (c) => ({ replicas: 1, workers: 1e9, serviceMs: Math.max(0.01, c.rttMs), queueCap: 1e9, cs2: 1.2 }),
  cost: () => 0,
});

C({
  id: 'dns', name: 'DNS', cat: 'client', glyph: 'DNS', dispatch: 'split',
  blurb: 'Name resolution. Cached by TTL, so it rarely appears in steady-state latency — but a wrong TTL makes failover glacial.',
  chapter: '04_networking_deep_dive.md',
  caps: ['dns'],
  params: [
    n('ttlSec', 'Record TTL', 60, 1, 86400, 1, 's', 'Failover cannot be faster than the TTL for clients that already resolved.'),
    n('lookupMs', 'Uncached lookup', 20, 1, 300, 1, 'ms', ''),
    pct('cacheHit', 'Resolver cache hit', 97, 'Fraction of lookups served from a client/OS/resolver cache.'),
    b('geo', 'Geo / latency-based routing', true, 'Routes users to the closest healthy region.'),
  ],
  derive: (c) => ({ replicas: 4, workers: 1e7, serviceMs: Math.max(0.05, c.lookupMs * (1 - c.cacheHit / 100)), queueCap: 1e9, cs2: 0.6 }),
  cost: (c, t) => 0.5 + (t.outRate * 2.6e6 / 1e6) * 0.4,
});

C({
  id: 'cdn', name: 'CDN / Edge Cache', cat: 'client', glyph: 'CDN', dispatch: 'cache',
  blurb: 'Serves cacheable bytes from a PoP near the user. The single biggest latency and cost win for read-heavy, static-heavy traffic.',
  chapter: '11_caching_cdn_and_edge.md',
  caps: ['cdn', 'cache', 'edge'],
  params: [
    pct('hitRatio', 'Cache hit ratio', 88, 'Fraction served at the edge without touching origin.'),
    n('edgeMs', 'Edge serve latency', 12, 1, 200, 1, 'ms', ''),
    n('originMs', 'Origin fetch overhead', 45, 1, 2000, 1, 'ms', 'Extra latency on a miss: PoP → origin round trip.'),
    n('pops', 'Edge PoPs', 60, 1, 500, 1, '', ''),
    b('shield', 'Origin shield', false, 'A mid-tier cache that collapses simultaneous misses. Kills origin stampedes.'),
    n('egressGBmo', 'Egress price', 0.085, 0, 1, 0.005, '$/GB', ''),
  ],
  derive: (c) => ({ replicas: c.pops, workers: 1e7, serviceMs: Math.max(0.1, c.edgeMs), queueCap: 1e9, cs2: 0.5, hitRatio: c.hitRatio / 100, missExtraMs: c.originMs, coalescing: c.shield }),
  cost: (c, t) => {
    const gb = (t.outRate * 2.6e6 * (t.payloadKB || 20)) / 1e6;
    return gb * c.egressGBmo + c.pops * 0.5;
  },
});

C({
  id: 'waf', name: 'WAF / DDoS Shield', cat: 'client', glyph: 'WAF', dispatch: 'split',
  blurb: 'Inspects requests at the edge and drops malicious ones before they reach your origin.',
  chapter: '18_security_and_identity.md',
  caps: ['waf', 'security'],
  params: [
    n('inspectMs', 'Inspection overhead', 3, 0, 100, 0.5, 'ms', ''),
    pct('blockPct', 'Traffic classified as attack', 2, ''),
    pct('falsePositive', 'False-positive rate', 0.1, 'Legitimate users you wrongly block — real cost of aggressive rules.'),
    n('capacity', 'Scrubbing capacity', 500000, 1000, 5e6, 1000, 'rps', ''),
  ],
  derive: (c) => ({ replicas: 8, workers: 1e7, serviceMs: Math.max(0.05, c.inspectMs), queueCap: 1e9, cs2: 0.4, hardCapRps: c.capacity, dropFrac: c.falsePositive / 100, shedFrac: c.blockPct / 100 }),
  cost: (c, t) => 20 + (t.inRate * 2.6e6 / 1e6) * 0.6,
});

// =============================================================================
// TRAFFIC & ROUTING
// =============================================================================

C({
  id: 'lb_l4', name: 'Load Balancer (L4)', cat: 'network', glyph: 'L4', dispatch: 'split',
  blurb: 'Transport-level balancing. Forwards TCP/UDP flows without parsing HTTP — very cheap, very fast, no content-based routing.',
  chapter: '05_load_balancing_proxies_traffic.md',
  caps: ['lb', 'ha'],
  params: [
    s('algo', 'Algorithm', 'round_robin', ['round_robin', 'least_conn', 'ip_hash', 'random'], 'least_conn and power-of-two-choices handle heterogeneous backends far better than round robin.'),
    n('procMs', 'Forwarding latency', 0.6, 0.05, 20, 0.05, 'ms', ''),
    n('capacity', 'Throughput ceiling', 400000, 100, 5e6, 100, 'rps', ''),
    n('healthSec', 'Health-check interval', 5, 1, 120, 1, 's', 'Worst-case time to notice a dead backend ≈ interval × unhealthy threshold.'),
    n('unhealthy', 'Unhealthy threshold', 3, 1, 10, 1, 'checks', ''),
    n('replicas', 'LB nodes', 2, 1, 16, 1, '', 'A single LB node is itself a SPOF.'),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: 1e7, serviceMs: Math.max(0.05, c.procMs), queueCap: 1e9, cs2: 0.3, hardCapRps: c.capacity, detectSec: c.healthSec * c.unhealthy, algo: c.algo }),
  cost: (c, t) => c.replicas * 18 + (t.inRate * 2.6e6 / 1e6) * 0.008,
});

C({
  id: 'lb_l7', name: 'L7 Proxy / Ingress', cat: 'network', glyph: 'L7', dispatch: 'split',
  blurb: 'Parses HTTP. Enables path/header routing, TLS termination, retries, sticky sessions — at the cost of CPU per request.',
  chapter: '05_load_balancing_proxies_traffic.md',
  caps: ['lb', 'ha', 'tls', 'retry'],
  params: [
    s('algo', 'Algorithm', 'least_conn', ['round_robin', 'least_conn', 'p2c', 'ip_hash', 'weighted'], 'p2c = power of two choices: pick two at random, send to the less loaded. Near-optimal with almost no coordination.'),
    n('procMs', 'Proxy overhead', 2, 0.1, 50, 0.1, 'ms', ''),
    b('tls', 'TLS termination', true, 'Adds a handshake cost on new connections.'),
    n('capacity', 'Throughput ceiling', 120000, 100, 2e6, 100, 'rps', ''),
    COMMON.retries(1),
    COMMON.timeout(2000),
    b('outlier', 'Outlier ejection', true, 'Temporarily removes backends that return errors — a cheap circuit breaker.'),
    n('replicas', 'Proxy nodes', 2, 1, 64, 1, '', ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * 4096, serviceMs: Math.max(0.05, c.procMs + (c.tls ? 0.6 : 0)), queueCap: c.replicas * 20000, cs2: 0.6, hardCapRps: c.capacity, retries: c.retries, timeoutMs: c.timeoutMs, algo: c.algo }),
  cost: (c, t) => c.replicas * 42 + (t.inRate * 2.6e6 / 1e6) * 0.012,
});

C({
  id: 'api_gateway', name: 'API Gateway', cat: 'network', glyph: 'GW', dispatch: 'split',
  blurb: 'Single front door: authentication, rate limiting, request validation, routing and aggregation.',
  chapter: '15_apis_and_protocols.md',
  caps: ['gateway', 'auth', 'ratelimit'],
  params: [
    n('authMs', 'Auth / JWT verify', 4, 0, 200, 0.5, 'ms', 'Cache the JWKS. Remote token introspection on every request is a classic latency bug.'),
    n('procMs', 'Routing + validation', 3, 0.1, 100, 0.1, 'ms', ''),
    b('rateLimit', 'Rate limiting enabled', true, ''),
    n('limitRps', 'Global rate limit', 60000, 10, 2e6, 10, 'rps', 'Requests above this get HTTP 429 instead of taking the system down.'),
    COMMON.timeout(3000),
    n('replicas', 'Gateway nodes', 3, 1, 64, 1, '', ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * 2048, serviceMs: Math.max(0.05, c.authMs + c.procMs), queueCap: c.replicas * 10000, cs2: 0.7, throttleRps: c.rateLimit ? c.limitRps : Infinity, timeoutMs: c.timeoutMs }),
  cost: (c, t) => c.replicas * 55 + (t.inRate * 2.6e6 / 1e6) * 1.0,
});

C({
  id: 'service_mesh', name: 'Service Mesh Sidecar', cat: 'network', glyph: 'MSH', dispatch: 'split',
  blurb: 'Per-pod proxy providing mTLS, retries, timeouts and observability without touching application code. You pay ~1ms and one extra hop per call.',
  chapter: '16_microservices_and_service_architecture.md',
  caps: ['mesh', 'retry', 'breaker', 'observability'],
  params: [
    n('procMs', 'Sidecar hop (in+out)', 1.4, 0.1, 20, 0.1, 'ms', ''),
    b('mtls', 'mTLS between services', true, ''),
    COMMON.retries(2),
    b('breaker', 'Circuit breaking', true, ''),
    n('cpuOverheadPct', 'CPU overhead per pod', 12, 0, 80, 1, '%', ''),
  ],
  derive: (c) => ({ replicas: 8, workers: 1e6, serviceMs: Math.max(0.05, c.procMs + (c.mtls ? 0.4 : 0)), queueCap: 1e7, cs2: 0.5, retries: c.retries }),
  cost: (c) => 25,
});

C({
  id: 'websocket_gw', name: 'WebSocket Gateway', cat: 'network', glyph: 'WS', dispatch: 'all',
  blurb: 'Holds long-lived duplex connections. The scaling unit is *concurrent connections and memory*, not requests per second.',
  chapter: '15_apis_and_protocols.md',
  caps: ['realtime', 'stateful'],
  params: [
    n('replicas', 'Gateway nodes', 4, 1, 500, 1, '', ''),
    n('connPerNode', 'Connections per node', 50000, 100, 1e6, 100, '', 'Each idle connection still costs a file descriptor and ~10–40KB of kernel + user memory.'),
    n('kbPerConn', 'Memory per connection', 24, 1, 512, 1, 'KB', ''),
    n('pushMs', 'Push / frame latency', 3, 0.1, 200, 0.1, 'ms', ''),
    n('msgPerConnMin', 'Messages per conn/min', 4, 0, 600, 1, '', ''),
    b('sticky', 'Sticky routing', true, 'Reconnects must land on a node that knows the session — or you need a shared presence store.'),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * 4096, serviceMs: Math.max(0.05, c.pushMs), queueCap: c.replicas * 50000, cs2: 0.8, maxConns: c.replicas * c.connPerNode, memGB: (c.replicas * c.connPerNode * c.kbPerConn) / 1e6 }),
  cost: (c) => c.replicas * 95,
});

// =============================================================================
// RESILIENCE
// =============================================================================

C({
  id: 'rate_limiter', name: 'Rate Limiter', cat: 'resil', glyph: 'RL', dispatch: 'split',
  blurb: 'Token bucket / sliding window admission control. Converts an outage into a set of 429s — the single cheapest way to survive a flash crowd.',
  chapter: '23_building_blocks_and_algorithms.md#rate-limiting',
  caps: ['ratelimit', 'shed'],
  params: [
    s('algo', 'Algorithm', 'token_bucket', ['token_bucket', 'leaky_bucket', 'fixed_window', 'sliding_window_log', 'sliding_window_counter'], 'Fixed window allows 2x burst at the boundary. Sliding window log is exact but O(n) memory.'),
    n('rate', 'Sustained rate', 20000, 1, 2e6, 1, 'rps', ''),
    n('burst', 'Burst capacity', 40000, 1, 4e6, 1, 'tokens', 'How much instantaneous overshoot you absorb before shedding.'),
    n('procMs', 'Decision latency', 0.4, 0.01, 20, 0.01, 'ms', ''),
    b('distributed', 'Distributed (shared counter)', true, 'A shared Redis counter is accurate but adds a network hop; local buckets are fast but drift.'),
  ],
  derive: (c) => ({ replicas: 4, workers: 1e7, serviceMs: Math.max(0.02, c.procMs + (c.distributed ? 0.6 : 0)), queueCap: 1e7, cs2: 0.2, throttleRps: c.rate, burst: c.burst }),
  cost: () => 15,
});

C({
  id: 'circuit_breaker', name: 'Circuit Breaker', cat: 'resil', glyph: 'CB', dispatch: 'split',
  blurb: 'Watches a dependency\'s error rate. When it trips OPEN, calls fail instantly instead of piling up threads waiting for a timeout.',
  chapter: '03_reliability_availability_performance.md',
  caps: ['breaker', 'fallback'],
  params: [
    pct('errorThreshold', 'Error rate to trip', 50, ''),
    n('windowSec', 'Rolling window', 10, 1, 300, 1, 's', ''),
    n('openSec', 'Open duration', 30, 1, 600, 1, 's', 'While OPEN, all calls fail fast. Then a few probes are allowed (HALF-OPEN).'),
    n('halfOpenProbes', 'Half-open probes', 5, 1, 100, 1, '', ''),
    b('fallback', 'Serve fallback response', true, 'Degrade gracefully (stale cache, default value) instead of returning 500.'),
  ],
  derive: (c) => ({ replicas: 1, workers: 1e7, serviceMs: 0.05, queueCap: 1e7, cs2: 0.1, breaker: true, errThresh: c.errorThreshold / 100, openSec: c.openSec, fallback: c.fallback }),
  cost: () => 0,
});

C({
  id: 'bulkhead', name: 'Bulkhead / Semaphore', cat: 'resil', glyph: 'BH', dispatch: 'split',
  blurb: 'Caps concurrency per dependency so one slow downstream cannot consume every thread in the pool. Ships hulls, but for thread pools.',
  chapter: '03_reliability_availability_performance.md',
  caps: ['bulkhead', 'isolation'],
  params: [
    n('permits', 'Concurrent permits', 50, 1, 10000, 1, '', 'Little\'s Law: permits ≥ rps × latency, or you throttle yourself.'),
    n('queueLen', 'Wait queue length', 100, 0, 100000, 1, '', ''),
    n('acquireMs', 'Acquire overhead', 0.1, 0, 10, 0.01, 'ms', ''),
  ],
  derive: (c) => ({ replicas: 1, workers: c.permits, serviceMs: Math.max(0.02, c.acquireMs), queueCap: c.queueLen, cs2: 0.2, bulkhead: c.permits }),
  cost: () => 0,
});

C({
  id: 'retry_policy', name: 'Retry + Backoff', cat: 'resil', glyph: 'RTY', dispatch: 'split',
  blurb: 'Retries transient failures. With jitter it heals blips; without jitter and a budget it synchronises clients into a thundering herd.',
  chapter: '23_building_blocks_and_algorithms.md#retry',
  caps: ['retry'],
  params: [
    n('attempts', 'Max attempts', 3, 1, 10, 1, '', ''),
    n('baseMs', 'Base backoff', 50, 1, 5000, 1, 'ms', ''),
    s('jitter', 'Jitter strategy', 'full', ['none', 'full', 'equal', 'decorrelated'], 'none = synchronised retry storm. full jitter is the AWS-recommended default.'),
    pct('budgetPct', 'Retry budget', 20, 'Cap retries at this share of normal traffic; beyond it, fail fast.'),
  ],
  derive: (c) => ({ replicas: 1, workers: 1e7, serviceMs: 0.05, queueCap: 1e7, cs2: 0.1, retries: c.attempts - 1, jitter: c.jitter, retryBudget: c.budgetPct / 100 }),
  cost: () => 0,
});

// =============================================================================
// COMPUTE
// =============================================================================

C({
  id: 'web_server', name: 'Web Server', cat: 'compute', glyph: 'WEB', dispatch: 'all',
  blurb: 'Terminates HTTP, renders or proxies. Thread/worker count × service time is your hard throughput ceiling.',
  chapter: '01_from_zero_computers_networks_web.md',
  caps: ['compute', 'stateless'],
  params: [
    n('replicas', 'Instances', 3, 1, 500, 1, '', ''),
    n('threads', 'Workers per instance', 64, 1, 8192, 1, '', ''),
    n('cpuMs', 'CPU time per request', 8, 0.1, 5000, 0.1, 'ms', ''),
    n('backlog', 'Accept backlog', 1024, 0, 65535, 1, '', 'Requests waiting for a worker. Full backlog = connection refused.'),
    COMMON.timeout(5000),
    s('size', 'Instance size', 'm6i.large', ['t3.small', 'm6i.large', 'm6i.xlarge', 'c6i.2xlarge', 'c6i.4xlarge'], ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * c.threads, serviceMs: c.cpuMs, queueCap: c.replicas * c.backlog, cs2: 1.0, timeoutMs: c.timeoutMs }),
  cost: (c) => c.replicas * ({ 't3.small': 15, 'm6i.large': 70, 'm6i.xlarge': 140, 'c6i.2xlarge': 248, 'c6i.4xlarge': 496 }[c.size] || 70),
});

C({
  id: 'app_server', name: 'App Service', cat: 'compute', glyph: 'SVC', dispatch: 'all',
  blurb: 'A business-logic service. Calls its dependencies sequentially by default — every hop adds to the critical path.',
  chapter: '16_microservices_and_service_architecture.md',
  caps: ['compute', 'stateless'],
  params: [
    n('replicas', 'Instances', 4, 1, 2000, 1, '', ''),
    n('threads', 'Concurrency per instance', 100, 1, 20000, 1, '', 'Threads, goroutines or event-loop slots.'),
    n('cpuMs', 'Own CPU time per request', 6, 0.05, 5000, 0.05, 'ms', 'Time spent in *this* service, excluding downstream calls.'),
    s('callMode', 'Dependency calls', 'sequential', ['sequential', 'parallel'], 'Sequential adds latencies. Parallel takes the max — but amplifies the tail (chapter 03).'),
    n('backlog', 'Request queue depth', 2000, 0, 200000, 1, '', ''),
    COMMON.timeout(1500),
    COMMON.retries(0),
    pct('errorPct', 'Baseline error rate', 0.05, ''),
    s('size', 'Instance size', 'm6i.large', ['t3.small', 'm6i.large', 'm6i.xlarge', 'c6i.2xlarge', 'c6i.4xlarge', 'r6i.2xlarge'], ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * c.threads, serviceMs: c.cpuMs, queueCap: c.replicas * c.backlog, cs2: 1.0, callMode: c.callMode, timeoutMs: c.timeoutMs, retries: c.retries, baseErr: c.errorPct / 100 }),
  cost: (c) => c.replicas * ({ 't3.small': 15, 'm6i.large': 70, 'm6i.xlarge': 140, 'c6i.2xlarge': 248, 'c6i.4xlarge': 496, 'r6i.2xlarge': 380 }[c.size] || 70),
});

C({
  id: 'k8s_deploy', name: 'Container Cluster (HPA)', cat: 'compute', glyph: 'K8S', dispatch: 'all',
  blurb: 'Autoscaling pod deployment. Scaling is not instant: metrics lag, then pods must be scheduled, pulled and warmed.',
  chapter: '17_containers_docker_kubernetes.md',
  caps: ['compute', 'stateless', 'autoscale'],
  params: [
    n('minPods', 'Min pods', 3, 1, 2000, 1, '', ''),
    n('maxPods', 'Max pods', 30, 1, 5000, 1, '', ''),
    n('threads', 'Concurrency per pod', 80, 1, 10000, 1, '', ''),
    n('cpuMs', 'CPU time per request', 10, 0.05, 5000, 0.05, 'ms', ''),
    pct('targetCpu', 'HPA target CPU', 65, 'Scale out above this utilisation. Above ~80% queueing delay explodes before pods arrive.'),
    n('startupSec', 'Pod startup time', 25, 1, 600, 1, 's', 'Image pull + JVM/runtime warm-up. This is your real scaling latency.'),
    n('cooldownSec', 'Scale-up stabilisation', 15, 0, 600, 1, 's', ''),
    s('size', 'Pod size', '1vCPU/2GB', ['0.5vCPU/1GB', '1vCPU/2GB', '2vCPU/4GB', '4vCPU/8GB'], ''),
  ],
  derive: (c) => ({ replicas: c.minPods, minReplicas: c.minPods, maxReplicas: c.maxPods, workers: c.minPods * c.threads, perReplicaWorkers: c.threads, serviceMs: c.cpuMs, queueCap: c.maxPods * 2000, cs2: 1.0, autoscale: { target: c.targetCpu / 100, startupSec: c.startupSec, cooldownSec: c.cooldownSec } }),
  cost: (c, t) => (t.replicas || c.minPods) * ({ '0.5vCPU/1GB': 18, '1vCPU/2GB': 36, '2vCPU/4GB': 72, '4vCPU/8GB': 144 }[c.size] || 36) + 73,
});

C({
  id: 'serverless', name: 'Serverless Function', cat: 'compute', glyph: 'FN', dispatch: 'all',
  blurb: 'Scales to zero and to thousands, but cold starts hit the tail and concurrency limits are a hard wall.',
  chapter: '17_containers_docker_kubernetes.md',
  caps: ['compute', 'stateless', 'autoscale', 'serverless'],
  params: [
    n('maxConcurrency', 'Max concurrent executions', 1000, 1, 100000, 1, '', 'Account/function limit. Exceeding it returns throttle errors.'),
    n('execMs', 'Execution time', 60, 1, 900000, 1, 'ms', ''),
    n('coldMs', 'Cold start penalty', 320, 0, 10000, 10, 'ms', ''),
    pct('coldPct', 'Cold start share', 4, 'Rises sharply during scale-up and after idle periods.'),
    n('memMB', 'Memory', 512, 128, 10240, 64, 'MB', 'On Lambda, memory buys CPU — and price scales with it.'),
    b('provisioned', 'Provisioned concurrency', false, 'Removes cold starts, removes scale-to-zero savings.'),
  ],
  derive: (c) => ({ replicas: 1, workers: c.maxConcurrency, serviceMs: c.execMs + (c.provisioned ? 0 : (c.coldPct / 100) * c.coldMs), queueCap: 0, cs2: c.provisioned ? 1.0 : 3.5, coldMs: c.provisioned ? 0 : c.coldMs, coldPct: c.provisioned ? 0 : c.coldPct / 100, hardCapConc: c.maxConcurrency }),
  cost: (c, t) => {
    const invocations = t.inRate * 2.6e6;
    const gbSec = (invocations * (c.execMs / 1000) * (c.memMB / 1024));
    return invocations / 1e6 * 0.2 + gbSec * 0.0000166667 + (c.provisioned ? c.maxConcurrency * (c.memMB / 1024) * 10 : 0);
  },
});

C({
  id: 'worker_pool', name: 'Worker / Consumer Pool', cat: 'compute', glyph: 'WRK', dispatch: 'all',
  blurb: 'Pulls from a queue and does the slow work off the request path. Consumer throughput is what actually drains your backlog.',
  chapter: '12_messaging_and_event_streaming.md',
  caps: ['compute', 'consumer'],
  params: [
    n('replicas', 'Workers', 6, 1, 5000, 1, '', ''),
    n('concurrency', 'Concurrency per worker', 8, 1, 2000, 1, '', ''),
    n('jobMs', 'Job processing time', 250, 1, 600000, 1, 'ms', ''),
    n('prefetch', 'Prefetch / batch size', 10, 1, 10000, 1, '', ''),
    pct('failPct', 'Job failure rate', 1, 'Failed jobs should end in a dead-letter queue, not an infinite redelivery loop.'),
    b('idempotent', 'Idempotent handler', true, 'At-least-once delivery means duplicates. Without idempotency you double-charge people.'),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * c.concurrency, serviceMs: c.jobMs, queueCap: c.replicas * c.prefetch * 10, cs2: 1.4, baseErr: c.failPct / 100, idempotent: c.idempotent }),
  cost: (c) => c.replicas * 70,
});

C({
  id: 'cron', name: 'Batch / Cron Job', cat: 'compute', glyph: 'CRN', dispatch: 'all',
  blurb: 'Periodic bulk work. Its danger is that it competes for the same database as your live traffic, at the worst possible moment.',
  chapter: '13_big_data_batch_stream_analytics.md',
  caps: ['batch'],
  params: [
    n('everyMin', 'Interval', 60, 1, 10080, 1, 'min', ''),
    n('durationSec', 'Run duration', 120, 1, 86400, 1, 's', ''),
    n('loadRps', 'Load while running', 500, 0, 200000, 10, 'rps', 'Extra pressure on shared dependencies during the run.'),
    b('offPeak', 'Off-peak schedule', false, ''),
  ],
  derive: (c) => ({ replicas: 1, workers: 64, serviceMs: 20, queueCap: 1e6, cs2: 1.0, periodic: { everySec: c.everyMin * 60, durationSec: c.durationSec, rps: c.loadRps, offPeak: c.offPeak } }),
  cost: (c) => 25,
});

C({
  id: 'stream_processor', name: 'Stream Processor', cat: 'compute', glyph: 'FLK', dispatch: 'all',
  blurb: 'Flink / Kafka Streams style stateful processing: windows, joins, aggregations, with checkpointed state.',
  chapter: '13_big_data_batch_stream_analytics.md',
  caps: ['compute', 'stream', 'stateful'],
  params: [
    n('parallelism', 'Parallelism', 8, 1, 2000, 1, '', 'Cannot usefully exceed the source partition count.'),
    n('perEventMs', 'Processing per event', 1.2, 0.01, 1000, 0.01, 'ms', ''),
    n('windowSec', 'Window size', 60, 1, 86400, 1, 's', ''),
    n('checkpointSec', 'Checkpoint interval', 30, 1, 3600, 1, 's', 'Recovery replays from the last checkpoint — this is your worst-case reprocessing time.'),
    n('stateGB', 'Managed state', 20, 0, 10000, 1, 'GB', ''),
    b('exactlyOnce', 'Exactly-once semantics', true, 'Two-phase commit to sinks. Correct, but adds latency at every checkpoint.'),
  ],
  derive: (c) => ({ replicas: c.parallelism, workers: c.parallelism, serviceMs: c.perEventMs * (c.exactlyOnce ? 1.3 : 1), queueCap: 5e6, cs2: 1.1, parallelism: c.parallelism }),
  cost: (c) => c.parallelism * 90 + c.stateGB * 0.12,
});

// =============================================================================
// RELATIONAL DATA
// =============================================================================

C({
  id: 'pg_primary', name: 'SQL Primary (PostgreSQL)', cat: 'sql', glyph: 'PG', dispatch: 'terminal',
  blurb: 'The single writer. Its connection limit — not its CPU — is usually what kills you first.',
  chapter: '07_relational_databases_and_transactions.md',
  caps: ['db', 'sql', 'write', 'stateful', 'spof'],
  params: [
    n('maxConns', 'Max connections', 100, 5, 20000, 5, '', 'PostgreSQL forks a backend process per connection. 100–500 is the practical ceiling without a pooler.'),
    n('readMs', 'Read query time', 3, 0.05, 10000, 0.05, 'ms', ''),
    n('writeMs', 'Write query time', 9, 0.05, 10000, 0.05, 'ms', 'Includes WAL fsync. Group commit amortises this across concurrent writers.'),
    n('iops', 'Storage IOPS', 12000, 100, 500000, 100, '', ''),
    n('dataGB', 'Data size', 500, 1, 1e6, 1, 'GB', ''),
    n('workingSetGB', 'Hot working set', 24, 0.1, 1e6, 0.1, 'GB', 'The portion of the data actually touched by live traffic. This is what has to fit in memory.'),
    n('bufferGB', 'Buffer pool', 32, 0.5, 4096, 0.5, 'GB', 'If the working set does not fit here, every read becomes a disk read and latency jumps by orders of magnitude.'),
    s('isolation', 'Isolation level', 'read_committed', ['read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'], 'Serializable is correct and slow: expect aborts and retries under contention.'),
    b('multiAz', 'Multi-AZ standby', true, 'Synchronous standby with automatic failover (~30–120s). Without it, the primary is a SPOF.'),
    n('failoverSec', 'Failover time', 45, 1, 900, 1, 's', ''),
    s('size', 'Instance class', 'db.r6g.xlarge', ['db.t4g.medium', 'db.r6g.large', 'db.r6g.xlarge', 'db.r6g.4xlarge', 'db.r6g.12xlarge'], ''),
  ],
  derive: (c) => ({
    replicas: 1, workers: c.maxConns, serviceMs: c.readMs, writeMs: c.writeMs, readMs: c.readMs,
    queueCap: c.maxConns * 4, cs2: 1.6, connLimit: c.maxConns, iops: c.iops,
    multiAz: c.multiAz, failoverSec: c.failoverSec, isolation: c.isolation,
    bufferRatio: Math.min(1, c.bufferGB / Math.max(0.1, c.workingSetGB)),
  }),
  cost: (c) => ({ 'db.t4g.medium': 60, 'db.r6g.large': 190, 'db.r6g.xlarge': 380, 'db.r6g.4xlarge': 1500, 'db.r6g.12xlarge': 4500 }[c.size] || 380) * (c.multiAz ? 2 : 1) + c.dataGB * 0.115,
});

C({
  id: 'pg_replica', name: 'SQL Read Replica', cat: 'sql', glyph: 'RR', dispatch: 'terminal',
  blurb: 'Scales reads horizontally. Asynchronous replication means a user can write, immediately read, and not see their own write.',
  chapter: '09_replication_partitioning_consistency.md',
  caps: ['db', 'sql', 'read', 'replica', 'stateful'],
  params: [
    n('replicas', 'Replica count', 2, 1, 64, 1, '', ''),
    n('maxConns', 'Max connections each', 100, 5, 20000, 5, '', ''),
    n('readMs', 'Read query time', 3, 0.05, 5000, 0.05, 'ms', ''),
    n('lagMs', 'Replication lag', 120, 0, 600000, 10, 'ms', 'Under write bursts this grows — replicas apply WAL single-threaded.'),
    b('readYourWrites', 'Read-your-writes routing', false, 'Route a user to the primary for a short window after they write.'),
    s('size', 'Instance class', 'db.r6g.large', ['db.t4g.medium', 'db.r6g.large', 'db.r6g.xlarge', 'db.r6g.4xlarge'], ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * c.maxConns, serviceMs: c.readMs, queueCap: c.replicas * c.maxConns * 4, cs2: 1.5, connLimit: c.replicas * c.maxConns, lagMs: c.lagMs, readOnly: true }),
  cost: (c) => c.replicas * ({ 'db.t4g.medium': 60, 'db.r6g.large': 190, 'db.r6g.xlarge': 380, 'db.r6g.4xlarge': 1500 }[c.size] || 190),
});

C({
  id: 'sql_sharded', name: 'Sharded SQL Cluster', cat: 'sql', glyph: 'SHD', dispatch: 'terminal',
  blurb: 'Horizontal write scaling by splitting rows across independent databases. You gain write throughput and lose cross-shard joins and transactions.',
  chapter: '09_replication_partitioning_consistency.md',
  caps: ['db', 'sql', 'write', 'shard', 'stateful'],
  params: [
    n('shards', 'Shard count', 8, 1, 4096, 1, '', ''),
    n('connsPerShard', 'Connections per shard', 100, 5, 5000, 5, '', ''),
    n('queryMs', 'Single-shard query', 4, 0.05, 5000, 0.05, 'ms', ''),
    s('strategy', 'Shard key strategy', 'hash', ['hash', 'range', 'directory', 'consistent_hash'], 'Range keys are prone to hot shards (e.g. sharding by timestamp). Consistent hashing minimises resharding movement.'),
    pct('hotShardSkew', 'Hot-shard skew', 15, 'Extra share of traffic landing on the busiest shard. Real workloads are never uniform.'),
    pct('crossShardPct', 'Cross-shard queries', 5, 'These must scatter-gather: latency becomes the max over shards.'),
    b('multiAz', 'Standby per shard', true, ''),
  ],
  derive: (c) => ({ replicas: c.shards, workers: c.shards * c.connsPerShard, serviceMs: c.queryMs * (1 + c.crossShardPct / 100 * 2.5), queueCap: c.shards * c.connsPerShard * 4, cs2: 1.5, connLimit: c.shards * c.connsPerShard, skew: 1 + c.hotShardSkew / 100, shards: c.shards, fanout: c.crossShardPct / 100 }),
  cost: (c) => c.shards * 380 * (c.multiAz ? 2 : 1),
});

C({
  id: 'pgbouncer', name: 'Connection Pooler', cat: 'sql', glyph: 'PGB', dispatch: 'split',
  blurb: 'Multiplexes thousands of app connections onto a handful of real database connections. Usually the fix for "too many clients already".',
  chapter: '07_relational_databases_and_transactions.md',
  caps: ['pool'],
  params: [
    s('mode', 'Pooling mode', 'transaction', ['session', 'transaction', 'statement'], 'Transaction pooling gives the best multiplexing but forbids session state (prepared statements, temp tables, advisory locks).'),
    n('clientConns', 'Client-side connections', 5000, 10, 200000, 10, '', ''),
    n('serverConns', 'Server-side connections', 60, 1, 5000, 1, '', 'The number that actually reaches the database.'),
    n('procMs', 'Pooler overhead', 0.3, 0.01, 20, 0.01, 'ms', ''),
  ],
  derive: (c) => ({ replicas: 2, workers: c.serverConns, serviceMs: Math.max(0.02, c.procMs), queueCap: c.clientConns, cs2: 0.6, poolTo: c.serverConns }),
  cost: () => 40,
});

C({
  id: 'newsql', name: 'NewSQL (Spanner/Cockroach)', cat: 'sql', glyph: 'NSQ', dispatch: 'terminal',
  blurb: 'Distributed SQL with consensus-replicated ranges. Horizontal scale and strong consistency — paid for in cross-node commit latency.',
  chapter: '21_distributed_systems_theory_consensus.md',
  caps: ['db', 'sql', 'write', 'read', 'distributed', 'strong'],
  params: [
    n('nodes', 'Nodes', 6, 3, 500, 1, '', ''),
    n('readMs', 'Local read', 3, 0.1, 1000, 0.1, 'ms', ''),
    n('commitMs', 'Consensus commit', 12, 1, 2000, 1, 'ms', 'A quorum round trip. Cross-region deployments pay full RTT here.'),
    b('multiRegion', 'Multi-region', false, 'Survives a region loss; commits now cost inter-region RTT (60–150ms).'),
    n('regionRttMs', 'Inter-region RTT', 80, 1, 400, 1, 'ms', ''),
    n('connsPerNode', 'Connections per node', 500, 10, 20000, 10, '', ''),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: c.nodes * c.connsPerNode, serviceMs: c.readMs, writeMs: c.commitMs + (c.multiRegion ? c.regionRttMs : 0), queueCap: c.nodes * c.connsPerNode * 2, cs2: 1.2, connLimit: c.nodes * c.connsPerNode, strong: true }),
  cost: (c) => c.nodes * 520,
});

// =============================================================================
// NOSQL & ANALYTICS
// =============================================================================

C({
  id: 'kv_store', name: 'Key-Value Store (DynamoDB)', cat: 'nosql', glyph: 'KV', dispatch: 'terminal',
  blurb: 'Single-digit-millisecond lookups at any scale, provided every access goes through the partition key. Hot partitions are the failure mode.',
  chapter: '08_nosql_and_polyglot_persistence.md',
  caps: ['db', 'nosql', 'kv', 'read', 'write', 'managed'],
  params: [
    s('mode', 'Capacity mode', 'on_demand', ['provisioned', 'on_demand'], 'Provisioned is cheaper at steady load; on-demand absorbs spikes but still has a burst ramp.'),
    n('rcu', 'Provisioned read units', 20000, 1, 4e6, 100, 'RCU', ''),
    n('wcu', 'Provisioned write units', 5000, 1, 4e6, 100, 'WCU', ''),
    n('readMs', 'Read latency', 4, 0.5, 500, 0.1, 'ms', ''),
    n('writeMs', 'Write latency', 9, 0.5, 1000, 0.1, 'ms', ''),
    b('strong', 'Strongly consistent reads', false, 'Costs 2x read units and higher latency.'),
    pct('hotKeySkew', 'Hot partition skew', 10, 'A single partition caps at ~3000 RCU / 1000 WCU regardless of table capacity.'),
    n('dataGB', 'Data size', 200, 1, 1e6, 1, 'GB', ''),
  ],
  derive: (c) => ({
    replicas: 32, workers: 100000, serviceMs: c.readMs * (c.strong ? 1.4 : 1), writeMs: c.writeMs,
    queueCap: 1e6, cs2: 0.9,
    hardCapRps: c.mode === 'provisioned' ? Math.max(1, c.rcu) : 1e7,
    skew: 1 + c.hotKeySkew / 100,
  }),
  cost: (c, t) => {
    if (c.mode === 'provisioned') return c.rcu * 0.09 + c.wcu * 0.47 + c.dataGB * 0.25;
    const reads = t.inRate * 2.6e6 * 0.9, writes = t.inRate * 2.6e6 * 0.1;
    return (reads / 1e6) * 0.25 + (writes / 1e6) * 1.25 + c.dataGB * 0.25;
  },
});

C({
  id: 'document_db', name: 'Document Store (MongoDB)', cat: 'nosql', glyph: 'DOC', dispatch: 'terminal',
  blurb: 'Flexible schema, rich secondary indexes, replica-set failover. Watch unindexed queries — a collection scan at scale is an outage.',
  chapter: '08_nosql_and_polyglot_persistence.md',
  caps: ['db', 'nosql', 'document', 'read', 'write', 'stateful'],
  params: [
    n('shards', 'Shards', 3, 1, 200, 1, '', ''),
    n('replicaSet', 'Replicas per shard', 3, 1, 9, 1, '', ''),
    n('readMs', 'Indexed read', 4, 0.1, 5000, 0.1, 'ms', ''),
    n('writeMs', 'Write', 8, 0.1, 5000, 0.1, 'ms', ''),
    pct('unindexedPct', 'Unindexed queries', 2, 'These scan the collection: latency scales with data size, not result size.'),
    n('connsPerNode', 'Connections per node', 1000, 10, 50000, 10, '', ''),
    s('writeConcern', 'Write concern', 'majority', ['w1', 'majority', 'all'], 'w:1 acknowledges from the primary only — a failover can lose those writes.'),
  ],
  derive: (c) => ({ replicas: c.shards * c.replicaSet, workers: c.shards * c.connsPerNode, serviceMs: c.readMs * (1 + c.unindexedPct / 100 * 30), writeMs: c.writeMs * ({ w1: 1, majority: 1.6, all: 2.4 }[c.writeConcern] || 1.6), queueCap: c.shards * c.connsPerNode, cs2: 1.4, connLimit: c.shards * c.connsPerNode }),
  cost: (c) => c.shards * c.replicaSet * 260,
});

C({
  id: 'wide_column', name: 'Wide-Column (Cassandra)', cat: 'nosql', glyph: 'CAS', dispatch: 'terminal',
  blurb: 'Leaderless, tunable-consistency, write-optimised LSM store. Superb write throughput; reads suffer if compaction falls behind.',
  chapter: '08_nosql_and_polyglot_persistence.md',
  caps: ['db', 'nosql', 'column', 'write', 'read', 'distributed'],
  params: [
    n('nodes', 'Nodes', 6, 3, 1000, 1, '', ''),
    n('rf', 'Replication factor', 3, 1, 9, 1, '', ''),
    s('consistency', 'Consistency level', 'quorum', ['one', 'quorum', 'local_quorum', 'all'], 'R + W > RF gives strong consistency. QUORUM/QUORUM is the usual choice.'),
    n('writeMs', 'Write latency', 2, 0.1, 500, 0.1, 'ms', 'Append to commit log + memtable. Very fast.'),
    n('readMs', 'Read latency', 6, 0.1, 2000, 0.1, 'ms', ''),
    pct('compactionLoad', 'Compaction overhead', 12, 'Background merging steals IO. If it falls behind, reads touch many SSTables.'),
    n('connsPerNode', 'Connections per node', 1024, 10, 50000, 10, '', ''),
  ],
  derive: (c) => {
    const mult = { one: 1, local_quorum: 1.25, quorum: 1.5, all: 2.2 }[c.consistency] || 1.5;
    return { replicas: c.nodes, workers: c.nodes * c.connsPerNode, serviceMs: c.readMs * mult * (1 + c.compactionLoad / 100), writeMs: c.writeMs * mult, queueCap: c.nodes * c.connsPerNode, cs2: 1.3, connLimit: c.nodes * c.connsPerNode, rf: c.rf };
  },
  cost: (c) => c.nodes * 340,
});

C({
  id: 'olap', name: 'Columnar OLAP (ClickHouse)', cat: 'nosql', glyph: 'OLA', dispatch: 'terminal',
  blurb: 'Analytical scans over billions of rows. Optimised for few, huge queries — not for thousands of tiny point lookups.',
  chapter: '13_big_data_batch_stream_analytics.md',
  caps: ['db', 'analytics', 'read'],
  params: [
    n('nodes', 'Nodes', 4, 1, 500, 1, '', ''),
    n('queryMs', 'Typical query', 400, 5, 600000, 5, 'ms', ''),
    n('concurrency', 'Max concurrent queries', 24, 1, 2000, 1, '', 'OLAP engines saturate on a handful of concurrent scans. This is a hard wall.'),
    n('dataTB', 'Data volume', 20, 0.01, 10000, 0.01, 'TB', ''),
    pct('compression', 'Compression ratio', 85, ''),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: c.concurrency, serviceMs: c.queryMs, queueCap: c.concurrency * 8, cs2: 2.0 }),
  cost: (c) => c.nodes * 480 + c.dataTB * 1000 * (1 - c.compression / 100) * 0.023,
});

C({
  id: 'search', name: 'Search Cluster (Elasticsearch)', cat: 'nosql', glyph: 'ES', dispatch: 'terminal',
  blurb: 'Inverted-index search. Queries scatter to every shard and gather — so tail latency is the max across shards, not the mean.',
  chapter: '14_search_systems.md',
  caps: ['db', 'search', 'read', 'write'],
  params: [
    n('nodes', 'Data nodes', 5, 1, 500, 1, '', ''),
    n('shards', 'Primary shards', 10, 1, 1000, 1, '', 'Every query fans out to all of them. More shards = worse tail latency.'),
    n('replicasPerShard', 'Replicas per shard', 1, 0, 9, 1, '', ''),
    n('queryMs', 'Per-shard query', 15, 0.5, 10000, 0.5, 'ms', ''),
    n('indexMs', 'Index document', 6, 0.1, 5000, 0.1, 'ms', ''),
    n('refreshSec', 'Refresh interval', 1, 0.1, 300, 0.1, 's', 'How long until a written document becomes searchable. Near-real-time, not real-time.'),
    n('heapGB', 'Heap per node', 31, 1, 64, 1, 'GB', 'Above ~32GB you lose compressed object pointers and effectively waste memory.'),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: c.nodes * 200, serviceMs: c.queryMs, writeMs: c.indexMs, queueCap: c.nodes * 1000, cs2: 1.6, scatter: c.shards, lagMs: c.refreshSec * 1000 }),
  cost: (c) => c.nodes * 420,
});

C({
  id: 'timeseries', name: 'Time-Series DB', cat: 'nosql', glyph: 'TSD', dispatch: 'terminal',
  blurb: 'Append-heavy, timestamp-indexed store with downsampling and retention tiers. Cardinality — not volume — is what blows it up.',
  chapter: '19_observability_and_operations.md',
  caps: ['db', 'timeseries', 'write'],
  params: [
    n('nodes', 'Nodes', 3, 1, 200, 1, '', ''),
    n('writeMs', 'Ingest per sample', 0.4, 0.01, 100, 0.01, 'ms', ''),
    n('queryMs', 'Range query', 90, 1, 60000, 1, 'ms', ''),
    n('cardinality', 'Active series', 2000000, 1000, 1e9, 1000, '', 'Every unique label combination is a series. Unbounded labels (user IDs!) explode memory.'),
    n('retentionDays', 'Retention', 30, 1, 3650, 1, 'd', ''),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: c.nodes * 500, serviceMs: c.queryMs, writeMs: c.writeMs, queueCap: 1e6, cs2: 1.2, cardinality: c.cardinality }),
  cost: (c) => c.nodes * 260 + (c.cardinality / 1e6) * 40 + c.retentionDays * 3,
});

C({
  id: 'graph_db', name: 'Graph Database', cat: 'nosql', glyph: 'GRF', dispatch: 'terminal',
  blurb: 'Index-free adjacency for multi-hop traversals. Cost grows with traversal depth, not table size.',
  chapter: '08_nosql_and_polyglot_persistence.md',
  caps: ['db', 'graph', 'read'],
  params: [
    n('nodes', 'Nodes', 3, 1, 100, 1, '', ''),
    n('hopMs', 'Latency per hop', 2.5, 0.1, 500, 0.1, 'ms', ''),
    n('depth', 'Typical traversal depth', 3, 1, 12, 1, 'hops', ''),
    n('concurrency', 'Concurrent queries', 200, 1, 20000, 1, '', ''),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: c.concurrency, serviceMs: c.hopMs * c.depth, queueCap: c.concurrency * 10, cs2: 1.8 }),
  cost: (c) => c.nodes * 400,
});

// =============================================================================
// CACHING
// =============================================================================

C({
  id: 'redis', name: 'Cache (Redis)', cat: 'cache', glyph: 'RDS', dispatch: 'cache',
  blurb: 'In-memory cache-aside layer. The hit ratio is everything: 95% → 90% doubles the load reaching your database.',
  chapter: '11_caching_cdn_and_edge.md',
  caps: ['cache', 'kv'],
  params: [
    pct('hitRatio', 'Target hit ratio', 92, ''),
    n('memGB', 'Memory', 26, 0.1, 4096, 0.1, 'GB', ''),
    n('workingSetGB', 'Working set', 30, 0.1, 100000, 0.1, 'GB', 'If the working set exceeds memory, the real hit ratio drops below your target.'),
    n('getMs', 'GET latency', 0.4, 0.05, 50, 0.01, 'ms', ''),
    n('ttlSec', 'TTL', 300, 1, 604800, 1, 's', ''),
    s('eviction', 'Eviction policy', 'allkeys-lru', ['noeviction', 'allkeys-lru', 'allkeys-lfu', 'volatile-ttl', 'allkeys-random'], 'noeviction returns errors when full. LFU beats LRU for skewed access patterns.'),
    b('jitterTtl', 'TTL jitter', false, 'Randomise expiry so a million keys do not expire in the same second.'),
    b('coalescing', 'Request coalescing', false, 'On a miss, only one request goes to the origin; the rest wait for its result. Kills stampedes.'),
    n('opsCap', 'Ops ceiling', 200000, 1000, 1e7, 1000, 'ops/s', 'A single Redis node is single-threaded for commands: ~100–200k ops/s.'),
    n('replicas', 'Nodes', 1, 1, 100, 1, '', ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * 64, serviceMs: Math.max(0.02, c.getMs), queueCap: 1e6, cs2: 0.4, hitRatio: c.hitRatio / 100, memGB: c.memGB, workingSetGB: c.workingSetGB, ttlSec: c.ttlSec, jitter: c.jitterTtl, coalescing: c.coalescing, hardCapRps: c.opsCap * c.replicas, eviction: c.eviction }),
  cost: (c) => c.replicas * (c.memGB * 8 + 30),
});

C({
  id: 'redis_cluster', name: 'Redis Cluster', cat: 'cache', glyph: 'RCL', dispatch: 'cache',
  blurb: 'Sharded Redis with 16384 hash slots. Scales throughput and memory; multi-key operations must stay inside one slot.',
  chapter: '11_caching_cdn_and_edge.md',
  caps: ['cache', 'kv', 'distributed', 'ha'],
  params: [
    n('shards', 'Shards', 3, 1, 500, 1, '', ''),
    n('replicasPerShard', 'Replicas per shard', 1, 0, 5, 1, '', 'Needed for automatic failover.'),
    pct('hitRatio', 'Target hit ratio', 94, ''),
    n('memPerShardGB', 'Memory per shard', 26, 0.1, 512, 0.1, 'GB', ''),
    n('workingSetGB', 'Working set', 50, 0.1, 100000, 0.1, 'GB', ''),
    n('getMs', 'GET latency', 0.5, 0.05, 50, 0.01, 'ms', ''),
    pct('hotKeySkew', 'Hot-key skew', 12, 'One celebrity key can saturate a single shard while the rest idle.'),
    b('coalescing', 'Request coalescing', true, ''),
    n('opsCapPerShard', 'Ops per shard', 180000, 1000, 2e6, 1000, 'ops/s', ''),
  ],
  derive: (c) => ({ replicas: c.shards * (1 + c.replicasPerShard), workers: c.shards * 128, serviceMs: Math.max(0.02, c.getMs), queueCap: 1e6, cs2: 0.4, hitRatio: c.hitRatio / 100, memGB: c.shards * c.memPerShardGB, workingSetGB: c.workingSetGB, coalescing: c.coalescing, hardCapRps: c.shards * c.opsCapPerShard, skew: 1 + c.hotKeySkew / 100 }),
  cost: (c) => c.shards * (1 + c.replicasPerShard) * (c.memPerShardGB * 8 + 30),
});

C({
  id: 'local_cache', name: 'In-Process Cache', cat: 'cache', glyph: 'LOC', dispatch: 'cache',
  blurb: 'Nanosecond lookups with zero network hop — but N replicas mean N copies, N cold starts and N stale views.',
  chapter: '11_caching_cdn_and_edge.md',
  caps: ['cache', 'local'],
  params: [
    pct('hitRatio', 'Hit ratio', 60, 'Lower than a shared cache: each replica only warms its own slice of traffic.'),
    n('getMs', 'Lookup latency', 0.01, 0.001, 5, 0.001, 'ms', ''),
    n('memMB', 'Memory per instance', 256, 1, 65536, 1, 'MB', ''),
    n('ttlSec', 'TTL', 30, 1, 86400, 1, 's', 'Your staleness window is bounded by this — invalidation across N replicas is a hard problem.'),
  ],
  derive: (c) => ({ replicas: 1, workers: 1e7, serviceMs: Math.max(0.001, c.getMs), queueCap: 1e9, cs2: 0.1, hitRatio: c.hitRatio / 100, local: true, ttlSec: c.ttlSec }),
  cost: () => 0,
});

C({
  id: 'memcached', name: 'Memcached', cat: 'cache', glyph: 'MC', dispatch: 'cache',
  blurb: 'Multi-threaded, pure LRU slab cache. Simpler and more predictable than Redis; no persistence, no data structures.',
  chapter: '11_caching_cdn_and_edge.md',
  caps: ['cache', 'kv'],
  params: [
    pct('hitRatio', 'Hit ratio', 90, ''),
    n('nodes', 'Nodes', 3, 1, 200, 1, '', ''),
    n('memGB', 'Memory per node', 16, 0.1, 512, 0.1, 'GB', ''),
    n('getMs', 'GET latency', 0.25, 0.02, 20, 0.01, 'ms', ''),
    n('opsCap', 'Ops per node', 500000, 1000, 5e6, 1000, 'ops/s', 'Multi-threaded, so higher than single Redis.'),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: c.nodes * 256, serviceMs: Math.max(0.02, c.getMs), queueCap: 1e6, cs2: 0.3, hitRatio: c.hitRatio / 100, memGB: c.nodes * c.memGB, hardCapRps: c.nodes * c.opsCap }),
  cost: (c) => c.nodes * (c.memGB * 7 + 25),
});

// =============================================================================
// STORAGE
// =============================================================================

C({
  id: 'object_store', name: 'Object Storage (S3)', cat: 'storage', glyph: 'S3', dispatch: 'terminal',
  blurb: 'Effectively infinite, eleven nines of durability, high per-object latency. Great for blobs, terrible as a database.',
  chapter: '06_storage_engines_internals.md',
  caps: ['storage', 'durable', 'blob'],
  params: [
    n('getMs', 'GET first byte', 45, 5, 5000, 1, 'ms', ''),
    n('putMs', 'PUT latency', 120, 5, 10000, 1, 'ms', ''),
    n('dataTB', 'Stored data', 5, 0.001, 100000, 0.001, 'TB', ''),
    s('tier', 'Storage class', 'standard', ['standard', 'infrequent', 'glacier_ir', 'glacier_deep'], 'Cheaper tiers cost more per request and can take hours to restore.'),
    n('objectKB', 'Average object size', 250, 1, 5e6, 1, 'KB', ''),
    b('multipart', 'Multipart upload', true, ''),
  ],
  derive: (c) => ({ replicas: 64, workers: 1e6, serviceMs: c.getMs, writeMs: c.putMs, queueCap: 1e9, cs2: 1.9 }),
  cost: (c, t) => {
    const perGB = { standard: 0.023, infrequent: 0.0125, glacier_ir: 0.004, glacier_deep: 0.00099 }[c.tier] || 0.023;
    const reqs = t.inRate * 2.6e6;
    return c.dataTB * 1024 * perGB + (reqs / 1000) * 0.0004;
  },
});

C({
  id: 'block_store', name: 'Block Storage (EBS)', cat: 'storage', glyph: 'EBS', dispatch: 'terminal',
  blurb: 'A network-attached virtual disk. Its IOPS and throughput limits are the invisible ceiling under many "slow database" incidents.',
  chapter: '06_storage_engines_internals.md',
  caps: ['storage', 'block'],
  params: [
    s('type', 'Volume type', 'gp3', ['gp3', 'io2', 'st1'], ''),
    n('sizeGB', 'Size', 500, 1, 65536, 1, 'GB', ''),
    n('iops', 'Provisioned IOPS', 3000, 100, 256000, 100, '', ''),
    n('ioMs', 'Latency per IO', 0.8, 0.05, 100, 0.05, 'ms', ''),
    n('throughputMBs', 'Throughput', 125, 1, 4000, 1, 'MB/s', ''),
  ],
  derive: (c) => ({ replicas: 1, workers: Math.max(1, Math.round(c.iops * c.ioMs / 1000)), serviceMs: c.ioMs, queueCap: 4096, cs2: 1.1, hardCapRps: c.iops }),
  cost: (c) => c.sizeGB * (c.type === 'io2' ? 0.125 : c.type === 'st1' ? 0.045 : 0.08) + (c.type === 'io2' ? c.iops * 0.065 : Math.max(0, c.iops - 3000) * 0.005),
});

C({
  id: 'data_lake', name: 'Data Lake / HDFS', cat: 'storage', glyph: 'LAK', dispatch: 'terminal',
  blurb: 'Cheap columnar files (Parquet/Iceberg) queried by an engine on top. Optimised for scan throughput, not latency.',
  chapter: '13_big_data_batch_stream_analytics.md',
  caps: ['storage', 'analytics'],
  params: [
    n('dataTB', 'Data volume', 100, 0.1, 1e6, 0.1, 'TB', ''),
    n('scanMs', 'Query scan time', 3000, 50, 600000, 50, 'ms', ''),
    n('concurrency', 'Concurrent scans', 20, 1, 2000, 1, '', ''),
    s('format', 'File format', 'parquet', ['parquet', 'orc', 'avro', 'json'], 'Row formats (JSON) read every byte; columnar formats read only the columns you asked for.'),
  ],
  derive: (c) => ({ replicas: 1, workers: c.concurrency, serviceMs: c.scanMs, queueCap: c.concurrency * 5, cs2: 2.2 }),
  cost: (c) => c.dataTB * 1024 * 0.023 + 200,
});

// =============================================================================
// MESSAGING
// =============================================================================

C({
  id: 'queue', name: 'Message Queue (SQS)', cat: 'msg', glyph: 'MQ', dispatch: 'async',
  blurb: 'A buffer between a fast producer and a slow consumer. It converts "we fell over" into "we are behind" — the single most valuable trade in system design.',
  chapter: '12_messaging_and_event_streaming.md',
  caps: ['queue', 'async', 'buffer'],
  params: [
    n('maxDepth', 'Max queue depth', 1000000, 100, 1e9, 100, 'msgs', ''),
    n('enqueueMs', 'Enqueue latency', 6, 0.1, 500, 0.1, 'ms', 'This is all the producer waits for. The real work happens later.'),
    n('visibilitySec', 'Visibility timeout', 30, 1, 43200, 1, 's', 'Too short and a slow job gets delivered twice while still running.'),
    b('fifo', 'FIFO ordering', false, 'Ordering caps throughput (~3000 msg/s per message group on SQS FIFO).'),
    b('dlq', 'Dead-letter queue', true, 'Poison messages go here after N failures instead of looping forever.'),
    n('maxReceive', 'Max receives before DLQ', 5, 1, 100, 1, '', ''),
  ],
  derive: (c) => ({ replicas: 8, workers: 1e7, serviceMs: Math.max(0.05, c.enqueueMs), queueCap: c.maxDepth, cs2: 0.7, async: true, buffer: c.maxDepth, hardCapRps: c.fifo ? 3000 : 1e7, dlq: c.dlq }),
  cost: (c, t) => (t.inRate * 2.6e6 / 1e6) * 0.4,
});

C({
  id: 'kafka', name: 'Event Log (Kafka)', cat: 'msg', glyph: 'KFK', dispatch: 'async',
  blurb: 'A durable, replayable, partitioned log. Parallelism is capped by the partition count — more consumers than partitions simply idle.',
  chapter: '12_messaging_and_event_streaming.md',
  caps: ['queue', 'async', 'buffer', 'log', 'replay'],
  params: [
    n('brokers', 'Brokers', 3, 1, 500, 1, '', ''),
    n('partitions', 'Partitions', 12, 1, 10000, 1, '', 'This is the hard ceiling on consumer parallelism within a group.'),
    n('rf', 'Replication factor', 3, 1, 9, 1, '', ''),
    s('acks', 'Producer acks', 'all', ['0', '1', 'all'], 'acks=0 can lose data silently. acks=all waits for the in-sync replicas.'),
    n('produceMs', 'Produce latency', 4, 0.1, 2000, 0.1, 'ms', ''),
    n('batchMs', 'Linger / batching', 5, 0, 500, 1, 'ms', 'Batching trades a little latency for a lot of throughput.'),
    n('retentionHr', 'Retention', 168, 1, 8760, 1, 'h', ''),
    n('mbPerBrokerS', 'Throughput per broker', 100, 1, 2000, 1, 'MB/s', ''),
    n('msgKB', 'Message size', 2, 0.1, 10000, 0.1, 'KB', ''),
  ],
  derive: (c) => {
    const ackMult = { '0': 0.4, '1': 1, all: 1.6 }[c.acks] ?? 1.6;
    const byteCap = (c.brokers * c.mbPerBrokerS * 1024) / Math.max(0.1, c.msgKB);
    return { replicas: c.brokers, workers: 1e7, serviceMs: Math.max(0.05, c.produceMs * ackMult + c.batchMs * 0.5), queueCap: 1e9, cs2: 0.6, async: true, partitions: c.partitions, hardCapRps: byteCap, buffer: 1e9, replay: true };
  },
  cost: (c) => c.brokers * 400 + (c.retentionHr / 24) * 20,
});

C({
  id: 'pubsub', name: 'Pub/Sub Fan-out', cat: 'msg', glyph: 'PUB', dispatch: 'all',
  blurb: 'One publish becomes N deliveries. Fan-out amplification is where "it worked in staging" quietly turns into a 50x load multiplier.',
  chapter: '12_messaging_and_event_streaming.md',
  caps: ['queue', 'async', 'fanout'],
  params: [
    n('subscribers', 'Subscribers', 4, 1, 10000, 1, '', ''),
    n('deliverMs', 'Delivery latency', 8, 0.1, 5000, 0.1, 'ms', ''),
    s('delivery', 'Delivery guarantee', 'at_least_once', ['at_most_once', 'at_least_once', 'exactly_once'], ''),
    b('ordered', 'Ordered delivery', false, ''),
  ],
  derive: (c) => ({ replicas: 6, workers: 1e7, serviceMs: Math.max(0.05, c.deliverMs), queueCap: 1e8, cs2: 0.8, async: true, fanoutMult: c.subscribers }),
  cost: (c, t) => (t.inRate * 2.6e6 * c.subscribers / 1e6) * 0.4,
});

C({
  id: 'dlq', name: 'Dead-Letter Queue', cat: 'msg', glyph: 'DLQ', dispatch: 'terminal',
  blurb: 'Where poison messages go to be looked at by a human. Without one, a single bad message can block a partition forever.',
  chapter: '12_messaging_and_event_streaming.md',
  caps: ['dlq', 'async'],
  params: [
    n('retentionDays', 'Retention', 14, 1, 365, 1, 'd', ''),
    b('alerting', 'Alert on non-empty', true, 'A DLQ nobody watches is just a slower way to lose data.'),
  ],
  derive: () => ({ replicas: 2, workers: 1e6, serviceMs: 2, queueCap: 1e9, cs2: 0.5, async: true }),
  cost: () => 5,
});

// =============================================================================
// COORDINATION
// =============================================================================

C({
  id: 'consensus', name: 'Consensus Cluster (Raft)', cat: 'coord', glyph: 'RFT', dispatch: 'terminal',
  blurb: 'An odd number of nodes agreeing on a log. Writes cost a quorum round trip; losing quorum means losing writes entirely.',
  chapter: '21_distributed_systems_theory_consensus.md',
  caps: ['coord', 'strong', 'consensus'],
  params: [
    n('nodes', 'Nodes', 5, 3, 15, 2, '', 'Odd numbers only. 5 nodes tolerate 2 failures; 4 nodes also tolerate only 1.'),
    n('rttMs', 'Inter-node RTT', 1.5, 0.1, 300, 0.1, 'ms', ''),
    n('electionMs', 'Election timeout', 1000, 50, 30000, 50, 'ms', 'Unavailability window after a leader crash.'),
    n('applyMs', 'State machine apply', 0.5, 0.01, 100, 0.01, 'ms', ''),
    n('writeCap', 'Write ceiling', 20000, 100, 1e6, 100, 'rps', 'All writes serialise through one leader.'),
  ],
  derive: (c) => ({ replicas: c.nodes, workers: 512, serviceMs: c.applyMs, writeMs: c.rttMs * 2 + c.applyMs, queueCap: 20000, cs2: 0.9, hardCapRps: c.writeCap, quorum: Math.floor(c.nodes / 2) + 1, electionMs: c.electionMs }),
  cost: (c) => c.nodes * 150,
});

C({
  id: 'dist_lock', name: 'Distributed Lock', cat: 'coord', glyph: 'LCK', dispatch: 'terminal',
  blurb: 'Mutual exclusion across machines. Every lock is a serialisation point — Amdahl\'s Law charges you for it directly.',
  chapter: '21_distributed_systems_theory_consensus.md',
  caps: ['coord', 'lock'],
  params: [
    n('acquireMs', 'Acquire latency', 3, 0.1, 1000, 0.1, 'ms', ''),
    n('holdMs', 'Lock hold time', 25, 0.1, 60000, 0.1, 'ms', 'Throughput per lock key ≈ 1000 / holdMs. That is your hard ceiling.'),
    n('leaseMs', 'Lease / TTL', 10000, 100, 600000, 100, 'ms', 'Guards against a crashed holder wedging everyone forever.'),
    n('keys', 'Distinct lock keys', 1000, 1, 1e7, 1, '', 'More keys = more parallelism. One global lock = one request at a time.'),
    b('fencing', 'Fencing tokens', true, 'Without them, a paused-then-resumed holder can corrupt data after its lease expired.'),
  ],
  derive: (c) => ({ replicas: 3, workers: c.keys, serviceMs: c.acquireMs + c.holdMs, queueCap: 100000, cs2: 1.3, hardCapRps: c.keys * (1000 / Math.max(0.1, c.holdMs)), serialisation: true }),
  cost: () => 120,
});

C({
  id: 'service_registry', name: 'Service Discovery', cat: 'coord', glyph: 'REG', dispatch: 'split',
  blurb: 'Where instances register and clients look up healthy peers. Registry staleness sets how fast traffic stops hitting a dead pod.',
  chapter: '16_microservices_and_service_architecture.md',
  caps: ['coord', 'discovery'],
  params: [
    n('lookupMs', 'Lookup latency', 1.5, 0.05, 200, 0.05, 'ms', ''),
    n('heartbeatSec', 'Heartbeat interval', 10, 1, 300, 1, 's', ''),
    b('clientCache', 'Client-side cache', true, ''),
  ],
  derive: (c) => ({ replicas: 3, workers: 1e6, serviceMs: c.clientCache ? 0.05 : c.lookupMs, queueCap: 1e6, cs2: 0.4, staleSec: c.heartbeatSec * 3 }),
  cost: () => 90,
});

C({
  id: 'config_server', name: 'Config / Feature Flags', cat: 'coord', glyph: 'CFG', dispatch: 'split',
  blurb: 'Runtime configuration and kill switches. The fastest mitigation you own — if the client caches, so a config outage is not your outage.',
  chapter: '19_observability_and_operations.md',
  caps: ['coord', 'config'],
  params: [
    n('pollSec', 'Poll interval', 30, 1, 3600, 1, 's', ''),
    b('localFallback', 'Local fallback values', true, 'Without this, the config service becomes a hard dependency of everything.'),
    n('lookupMs', 'Lookup latency', 1, 0.05, 200, 0.05, 'ms', ''),
  ],
  derive: (c) => ({ replicas: 2, workers: 1e6, serviceMs: 0.05, queueCap: 1e6, cs2: 0.3, hardDep: !c.localFallback }),
  cost: () => 45,
});

// =============================================================================
// AI & AGENTS
// =============================================================================

C({
  id: 'llm_service', name: 'LLM Inference', cat: 'ai', glyph: 'LLM', dispatch: 'all',
  blurb: 'GPU-bound generation. Latency scales with output tokens, and concurrency is bounded by KV-cache memory, not CPU.',
  chapter: '23_building_blocks_and_algorithms.md',
  caps: ['compute', 'ai', 'expensive'],
  params: [
    n('gpus', 'GPU replicas', 2, 1, 500, 1, '', ''),
    n('batchSize', 'Continuous batch size', 16, 1, 512, 1, '', ''),
    n('inTokens', 'Input tokens', 1200, 1, 1000000, 10, '', ''),
    n('outTokens', 'Output tokens', 300, 1, 100000, 10, '', ''),
    n('msPerTok', 'Time per output token', 18, 0.5, 500, 0.5, 'ms', ''),
    n('ttftMs', 'Time to first token', 320, 10, 10000, 10, 'ms', ''),
    b('streaming', 'Stream response', true, 'Perceived latency becomes TTFT instead of total generation time.'),
    n('costPer1kIn', 'Cost / 1k input tokens', 0.0005, 0, 1, 0.0001, '$', ''),
    n('costPer1kOut', 'Cost / 1k output tokens', 0.0015, 0, 1, 0.0001, '$', ''),
  ],
  derive: (c) => ({ replicas: c.gpus, workers: c.gpus * c.batchSize, serviceMs: c.ttftMs + c.outTokens * c.msPerTok, perceivedMs: c.streaming ? c.ttftMs : c.ttftMs + c.outTokens * c.msPerTok, queueCap: c.gpus * c.batchSize * 10, cs2: 0.35 }),
  cost: (c, t) => {
    const calls = t.inRate * 2.6e6;
    return c.gpus * 2200 + (calls * c.inTokens / 1000) * c.costPer1kIn + (calls * c.outTokens / 1000) * c.costPer1kOut;
  },
});

C({
  id: 'agent_runtime', name: 'Agent Runtime', cat: 'ai', glyph: 'AGT', dispatch: 'all',
  blurb: 'Plans, calls tools, loops. Every reasoning step is another full LLM round trip — cost and latency multiply by the step count.',
  chapter: '23_building_blocks_and_algorithms.md',
  caps: ['compute', 'ai'],
  params: [
    n('replicas', 'Instances', 3, 1, 500, 1, '', ''),
    n('steps', 'Reasoning steps', 4, 1, 50, 1, '', 'A 4-step agent makes 4 LLM calls and 4 tool calls per user request.'),
    n('overheadMs', 'Orchestration overhead/step', 25, 1, 5000, 1, 'ms', ''),
    n('contextTokens', 'Context budget', 32000, 1000, 2000000, 1000, 'tokens', ''),
    n('concurrency', 'Concurrent sessions', 200, 1, 100000, 1, '', ''),
    b('memory', 'Persistent memory', true, ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.concurrency, serviceMs: c.overheadMs * c.steps, queueCap: c.concurrency * 5, cs2: 1.6, fanoutMult: c.steps, loops: c.steps, steps: c.steps }),
  cost: (c) => c.replicas * 90,
});

C({
  id: 'mcp_server', name: 'MCP Tool Server', cat: 'ai', glyph: 'MCP', dispatch: 'all',
  blurb: 'Exposes tools to an agent. It sits on the critical path of every reasoning step, so its p99 becomes the agent\'s p99 × steps.',
  chapter: '15_apis_and_protocols.md',
  caps: ['compute', 'ai', 'tool'],
  params: [
    n('replicas', 'Instances', 2, 1, 200, 1, '', ''),
    n('toolMs', 'Tool execution time', 180, 1, 120000, 1, 'ms', ''),
    n('concurrency', 'Concurrent calls', 64, 1, 10000, 1, '', ''),
    pct('failPct', 'Tool failure rate', 2, ''),
    n('tools', 'Registered tools', 25, 1, 1000, 1, '', 'Every tool schema consumes context window on every call.'),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * c.concurrency, serviceMs: c.toolMs, queueCap: c.replicas * c.concurrency * 4, cs2: 0.9, baseErr: c.failPct / 100 }),
  cost: (c) => c.replicas * 70,
});

C({
  id: 'vector_db', name: 'Vector Database', cat: 'ai', glyph: 'VEC', dispatch: 'terminal',
  blurb: 'Approximate nearest-neighbour search over embeddings. Recall, latency and memory are a three-way trade-off you must pick explicitly.',
  chapter: '14_search_systems.md',
  caps: ['db', 'ai', 'search', 'read'],
  params: [
    n('vectors', 'Indexed vectors', 10000000, 1000, 1e10, 1000, '', ''),
    n('dims', 'Dimensions', 1536, 8, 8192, 8, '', ''),
    s('index', 'Index type', 'hnsw', ['flat', 'ivf', 'hnsw', 'ivf_pq'], 'flat = exact but O(n). HNSW = fast + accurate + memory hungry. IVF-PQ = compressed, lower recall.'),
    n('queryMs', 'ANN query time', 12, 0.5, 10000, 0.5, 'ms', ''),
    pct('recall', 'Recall@10', 95, ''),
    n('concurrency', 'Concurrent queries', 200, 1, 20000, 1, '', ''),
    n('reindexMin', 'Index refresh', 15, 0, 1440, 1, 'min', 'New documents are not searchable until the index refreshes.'),
  ],
  derive: (c) => ({ replicas: 3, workers: c.concurrency, serviceMs: c.queryMs, queueCap: c.concurrency * 8, cs2: 1.3, memGB: (c.vectors * c.dims * 4) / 1e9 * (c.index === 'ivf_pq' ? 0.12 : 1), lagMs: c.reindexMin * 60000 }),
  cost: (c) => Math.max(70, ((c.vectors * c.dims * 4) / 1e9) * 12),
});

C({
  id: 'embedding_svc', name: 'Embedding Service', cat: 'ai', glyph: 'EMB', dispatch: 'all',
  blurb: 'Turns text into vectors. Batching is the difference between an affordable pipeline and a GPU bill you have to explain.',
  chapter: '14_search_systems.md',
  caps: ['compute', 'ai'],
  params: [
    n('replicas', 'Replicas', 2, 1, 200, 1, '', ''),
    n('batch', 'Batch size', 32, 1, 1024, 1, '', ''),
    n('perItemMs', 'Time per item', 6, 0.1, 1000, 0.1, 'ms', ''),
    n('costPer1M', 'Cost per 1M tokens', 0.02, 0, 10, 0.001, '$', ''),
  ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * c.batch, serviceMs: c.perItemMs, queueCap: c.replicas * c.batch * 20, cs2: 0.9 }),
  cost: (c) => c.replicas * 300,
});

// =============================================================================
// EXTERNAL & OPS
// =============================================================================

C({
  id: 'third_party', name: 'Third-Party API', cat: 'ext', glyph: 'EXT', dispatch: 'terminal',
  blurb: 'A dependency you do not control, cannot scale and cannot fix. Always wrap it in a timeout, a breaker and a fallback.',
  chapter: '03_reliability_availability_performance.md',
  caps: ['external', 'uncontrolled'],
  params: [
    n('latencyMs', 'Typical latency', 220, 1, 60000, 1, 'ms', ''),
    n('p99Ms', 'p99 latency', 1800, 1, 120000, 10, 'ms', 'External p99s are usually far worse than their marketing page suggests.'),
    n('rateLimit', 'Their rate limit', 1000, 1, 1e6, 1, 'rps', 'Exceed it and you get 429s, not extra capacity.'),
    pct('errorPct', 'Error rate', 1, ''),
    n('slaPct', 'Published SLA', 99.9, 90, 100, 0.01, '%', 'Their SLA is a hard ceiling on yours if you depend on them synchronously.'),
  ],
  derive: (c) => ({ replicas: 1, workers: 1e6, serviceMs: c.latencyMs, queueCap: 1e6, cs2: Math.max(1, Math.pow(c.p99Ms / Math.max(1, c.latencyMs), 0.6)), hardCapRps: c.rateLimit, baseErr: c.errorPct / 100, external: true, p99Ms: c.p99Ms }),
  cost: () => 0,
});

C({
  id: 'payment_gw', name: 'Payment Gateway', cat: 'ext', glyph: 'PAY', dispatch: 'terminal',
  blurb: 'Slow, rate-limited, and the one call you absolutely must not double-execute. Idempotency keys are mandatory.',
  chapter: '10_distributed_transactions_and_integrity.md',
  caps: ['external', 'uncontrolled', 'critical'],
  params: [
    n('latencyMs', 'Authorisation latency', 900, 50, 60000, 10, 'ms', ''),
    n('rateLimit', 'Rate limit', 300, 1, 100000, 1, 'rps', ''),
    pct('errorPct', 'Decline / error rate', 3, ''),
    b('idempotencyKeys', 'Idempotency keys', true, 'Without these, a retried timeout charges the customer twice.'),
    b('webhookAsync', 'Async webhook confirmation', true, 'Do not hold an HTTP request open for a 3-second payment.'),
  ],
  derive: (c) => ({ replicas: 1, workers: 4096, serviceMs: c.latencyMs, queueCap: 20000, cs2: 2.2, hardCapRps: c.rateLimit, baseErr: c.errorPct / 100, external: true, idempotent: c.idempotencyKeys }),
  // Interchange fees are a cost of revenue, not infrastructure spend, so they
  // are deliberately excluded from the monthly infrastructure estimate.
  cost: () => 0,
});

C({
  id: 'notification', name: 'Email / SMS / Push', cat: 'ext', glyph: 'NTF', dispatch: 'terminal',
  blurb: 'High-latency, rate-limited delivery. Belongs behind a queue, never on the synchronous request path.',
  chapter: '25_case_studies_part2.md',
  caps: ['external', 'async'],
  params: [
    n('latencyMs', 'Send latency', 400, 10, 60000, 10, 'ms', ''),
    n('rateLimit', 'Provider rate limit', 500, 1, 100000, 1, 'rps', ''),
    pct('bouncePct', 'Bounce / failure rate', 2, ''),
    n('costPer1k', 'Cost per 1k messages', 0.6, 0, 100, 0.01, '$', ''),
  ],
  derive: (c) => ({ replicas: 1, workers: 4096, serviceMs: c.latencyMs, queueCap: 1e6, cs2: 1.8, hardCapRps: c.rateLimit, baseErr: c.bouncePct / 100, external: true }),
  cost: (c, t) => (t.inRate * 2.6e6 / 1000) * c.costPer1k,
});

C({
  id: 'observability', name: 'Metrics / Logs / Traces', cat: 'ext', glyph: 'OBS', dispatch: 'terminal',
  blurb: 'You cannot operate what you cannot see. Also: unsampled tracing at scale can cost more than the system it observes.',
  chapter: '19_observability_and_operations.md',
  caps: ['observability'],
  params: [
    pct('traceSample', 'Trace sampling rate', 5, 'Tail-based sampling keeps the interesting traces at a fraction of the cost.'),
    n('logKB', 'Log bytes per request', 2, 0, 1000, 0.1, 'KB', ''),
    n('retentionDays', 'Retention', 14, 1, 730, 1, 'd', ''),
    n('ingestMs', 'Ingest latency', 1, 0.05, 500, 0.05, 'ms', ''),
    b('async', 'Non-blocking export', true, 'A blocking exporter turns an observability outage into an application outage.'),
  ],
  derive: (c) => ({ replicas: 4, workers: 1e7, serviceMs: c.async ? 0.05 : c.ingestMs, queueCap: 1e8, cs2: 0.5, async: c.async }),
  cost: (c, t) => {
    const gb = (t.inRate * 2.6e6 * c.logKB) / 1e6;
    return gb * 0.5 * (c.retentionDays / 30) + (t.inRate * 2.6e6 * c.traceSample / 100 / 1e6) * 2;
  },
});

// =============================================================================

export const COMPONENTS = list;
export const BY_ID = Object.fromEntries(list.map((c) => [c.id, c]));

export function defaultCfg(typeId) {
  const def = BY_ID[typeId];
  if (!def) return {};
  const cfg = {};
  for (const p of def.params) cfg[p.k] = p.def;
  return cfg;
}

export function deriveModel(typeId, cfg) {
  const def = BY_ID[typeId];
  if (!def) return { replicas: 1, workers: 1, serviceMs: 1, queueCap: 0, cs2: 1 };
  const merged = { ...defaultCfg(typeId), ...cfg };
  const m = def.derive(merged);
  return {
    replicas: 1, workers: 1, serviceMs: 1, queueCap: 0, cs2: 1,
    writeMs: m.serviceMs, ...m,
  };
}

export function componentsByCategory() {
  const groups = new Map();
  for (const c of list) {
    if (!groups.has(c.cat)) groups.set(c.cat, []);
    groups.get(c.cat).push(c);
  }
  return groups;
}
