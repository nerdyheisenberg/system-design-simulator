// CHAOS SCENARIO LIBRARY
// Each scenario says what it does, what it teaches, and which book chapter
// explains the defence. `targets` filters which node types you can aim it at.

export const CHAOS = [
  // ---------------------------------------------------------------- network
  {
    id: 'net_latency_100', name: 'Injected latency +100ms', cat: 'Network', sev: 'medium',
    desc: 'Adds 100ms to every call handled by the target.',
    lesson: 'Latency does not stay local. A caller holding a thread for 100ms extra needs 100x more threads at the same RPS (Little\'s Law). Watch the caller saturate before the target does.',
    chapter: '04_networking_deep_dive.md', durationSec: 60,
    effect: { addLatencyMs: 100 },
  },
  {
    id: 'net_latency_500', name: 'Cross-region latency +500ms', cat: 'Network', sev: 'high',
    desc: 'Simulates traffic being served from the wrong continent.',
    lesson: 'This is what a bad failover looks like. Any synchronous call that crosses an ocean costs you 2x the RTT, on every single hop.',
    chapter: '20_deployment_multiregion_dr_cost.md', durationSec: 60,
    effect: { addLatencyMs: 500 },
  },
  {
    id: 'net_partition', name: 'Network partition', cat: 'Network', sev: 'critical',
    desc: 'The target becomes unreachable while still being alive.',
    lesson: 'CAP in the flesh. A partition forces you to choose: refuse writes (CP) or accept divergence (AP). Silent split-brain is the worst of both.',
    chapter: '21_distributed_systems_theory_consensus.md', durationSec: 45,
    effect: { kill: true, killSec: 45 },
  },
  {
    id: 'net_packet_loss', name: 'Packet loss 10%', cat: 'Network', sev: 'medium',
    desc: 'One in ten packets disappears; TCP retransmits.',
    lesson: 'Loss does not cost you 10% of throughput. TCP congestion control backs off, so you can lose half your goodput and see enormous tail latency.',
    chapter: '04_networking_deep_dive.md', durationSec: 60,
    effect: { serviceMult: 2.4, errorAdd: 0.03 },
  },
  {
    id: 'net_bandwidth', name: 'Bandwidth throttle', cat: 'Network', sev: 'medium',
    desc: 'The pipe to the target is saturated.',
    lesson: 'Bandwidth limits hit large payloads first. Compression and pagination are latency features, not just cost features.',
    chapter: '04_networking_deep_dive.md', durationSec: 60,
    effect: { capacityMult: 0.35, serviceMult: 1.8 },
  },
  {
    id: 'dns_failure', name: 'DNS resolution failure', cat: 'Network', sev: 'high',
    desc: 'Name resolution starts failing for a portion of clients.',
    lesson: 'DNS TTL is your real failover time. Clients that cached a dead IP keep hammering it until the TTL expires.',
    chapter: '04_networking_deep_dive.md', durationSec: 40,
    effect: { errorAdd: 0.25 }, targets: ['dns'],
  },

  // ---------------------------------------------------------- infrastructure
  {
    id: 'node_crash', name: 'Instance crash', cat: 'Infrastructure', sev: 'high',
    desc: 'Hard-kills the target. It comes back only if it has a standby.',
    lesson: 'The question is never "will it crash" but "how long until traffic stops being sent to it". Health-check interval x unhealthy threshold is your real detection time.',
    chapter: '03_reliability_availability_performance.md', durationSec: 60,
    effect: { kill: true, killSec: 60 },
  },
  {
    id: 'az_outage', name: 'Availability-zone outage', cat: 'Infrastructure', sev: 'critical',
    desc: 'Removes one third of the capacity of every component simultaneously.',
    lesson: 'Correlated failure. Redundancy only helps when failures are independent: three replicas in one AZ is one replica.',
    chapter: '20_deployment_multiregion_dr_cost.md', durationSec: 90, global: true,
    effect: { capacityMult: 0.66 },
  },
  {
    id: 'cpu_starvation', name: 'CPU starvation', cat: 'Infrastructure', sev: 'medium',
    desc: 'A noisy neighbour steals 60% of the target\'s CPU.',
    lesson: 'Utilisation and latency are not linear. Losing 60% of CPU at rho=0.5 is survivable; at rho=0.7 it is an outage.',
    chapter: '02_scalability_and_estimation.md', durationSec: 60,
    effect: { capacityMult: 0.4, serviceMult: 1.6 },
  },
  {
    id: 'disk_saturation', name: 'Disk I/O saturation', cat: 'Infrastructure', sev: 'high',
    desc: 'IOPS collapse: every read leaves the page cache.',
    lesson: 'Databases die on IO before they die on CPU. If the working set stops fitting in RAM, latency jumps by 100x, not 10%.',
    chapter: '06_storage_engines_internals.md', durationSec: 60,
    effect: { serviceMult: 8, capacityMult: 0.3 },
  },
  {
    id: 'memory_leak', name: 'Memory leak', cat: 'Infrastructure', sev: 'medium',
    desc: 'Memory climbs steadily, GC pauses grow, then OOM.',
    lesson: 'Gradual degradation is harder to detect than a crash. Alert on the derivative (growth rate), not the absolute value.',
    chapter: '19_observability_and_operations.md', durationSec: 120,
    effect: { ramp: { overSec: 90, serviceMult: 6, capacityMult: 0.35 } },
  },
  {
    id: 'clock_skew', name: 'Clock skew', cat: 'Infrastructure', sev: 'medium',
    desc: 'The target\'s clock drifts by several seconds.',
    lesson: 'Anything using wall-clock time for ordering, leases or token expiry breaks. This is why fencing tokens and logical clocks exist.',
    chapter: '21_distributed_systems_theory_consensus.md', durationSec: 60,
    effect: { errorAdd: 0.08 },
  },

  // ----------------------------------------------------------------- traffic
  {
    id: 'flash_crowd', name: 'Flash crowd (10x)', cat: 'Traffic', sev: 'high',
    desc: 'Instant 10x traffic surge across the whole system.',
    lesson: 'Autoscaling takes 30-120 seconds. Your queue, cache and rate limiter are what carry you until the new capacity arrives.',
    chapter: '02_scalability_and_estimation.md', durationSec: 45, global: true,
    effect: { trafficMult: 10 },
  },
  {
    id: 'ddos', name: 'DDoS / bot flood (50x)', cat: 'Traffic', sev: 'critical',
    desc: 'Massive junk traffic with no cache locality.',
    lesson: 'You cannot scale your way out of a DDoS. You have to shed it at the edge, before it costs you anything.',
    chapter: '18_security_and_identity.md', durationSec: 40, global: true,
    effect: { trafficMult: 50 },
  },
  {
    id: 'thundering_herd', name: 'Thundering herd', cat: 'Traffic', sev: 'high',
    desc: 'Every client reconnects at the same instant after an outage.',
    lesson: 'Synchronised retries turn recovery into a second outage. Jitter is not optional.',
    chapter: '23_building_blocks_and_algorithms.md', durationSec: 25, global: true,
    effect: { trafficMult: 18 },
  },
  {
    id: 'slowloris', name: 'Slow clients (Slowloris)', cat: 'Traffic', sev: 'high',
    desc: 'Clients hold connections open without completing requests.',
    lesson: 'This attacks concurrency, not bandwidth. A few thousand slow sockets can exhaust a thread-per-request server from a phone.',
    chapter: '18_security_and_identity.md', durationSec: 60,
    effect: { capacityMult: 0.15, serviceMult: 4 },
  },
  {
    id: 'hot_key', name: 'Hot key / celebrity problem', cat: 'Traffic', sev: 'high',
    desc: '40% of traffic lands on a single key or partition.',
    lesson: 'Sharding gives you capacity on average, not per key. One celebrity account can saturate a single shard while the other 99 idle.',
    chapter: '09_replication_partitioning_consistency.md', durationSec: 60,
    effect: { capacityMult: 0.3 },
  },
  {
    id: 'write_burst', name: 'Write burst', cat: 'Traffic', sev: 'high',
    desc: 'The read/write mix inverts and writes start to dominate.',
    lesson: 'Caches and read replicas do nothing for writes. Write scaling means sharding, batching or a queue. Nothing else.',
    chapter: '09_replication_partitioning_consistency.md', durationSec: 60, global: true,
    effect: { readPctOverride: 15 },
  },

  // -------------------------------------------------------------- data layer
  {
    id: 'db_crash', name: 'Primary database crash', cat: 'Data', sev: 'critical',
    desc: 'Kills the primary. Multi-AZ recovers after the failover time; otherwise it stays down.',
    lesson: 'Failover is neither instant nor free: connections reset, caches go cold, and all the queued work arrives at once when it returns.',
    chapter: '07_relational_databases_and_transactions.md', durationSec: 90,
    effect: { kill: true, killSec: 90 },
    targets: ['pg_primary', 'sql_sharded', 'newsql', 'document_db', 'wide_column', 'kv_store'],
  },
  {
    id: 'replica_lag', name: 'Replication lag spike', cat: 'Data', sev: 'medium',
    desc: 'Replicas fall many seconds behind the primary.',
    lesson: 'Users read their own writes and see nothing. Either route recent writers to the primary or make the UI honest about staleness.',
    chapter: '09_replication_partitioning_consistency.md', durationSec: 75,
    effect: { ramp: { overSec: 40, serviceMult: 3 }, errorAdd: 0.02 },
    targets: ['pg_replica', 'document_db', 'wide_column'],
  },
  {
    id: 'cache_flush', name: 'Cache flush / cold cache', cat: 'Data', sev: 'critical',
    desc: 'The cache is emptied. Hit ratio drops to near zero.',
    lesson: 'The load your database sees is lambda x (1 - hitRatio). Going from 95% to 0% is a 20x load multiplier landing in one second.',
    chapter: '11_caching_cdn_and_edge.md', durationSec: 60,
    effect: { hitMult: 0.03 },
    targets: ['redis', 'redis_cluster', 'memcached', 'local_cache', 'cdn'],
  },
  {
    id: 'cache_stampede', name: 'Cache stampede', cat: 'Data', sev: 'high',
    desc: 'A block of hot keys expires simultaneously.',
    lesson: 'Without TTL jitter or request coalescing, every concurrent miss becomes an independent origin call for the same value.',
    chapter: '11_caching_cdn_and_edge.md', durationSec: 30,
    effect: { hitMult: 0.25 },
    targets: ['redis', 'redis_cluster', 'memcached', 'local_cache', 'cdn'],
  },
  {
    id: 'cache_node_loss', name: 'Cache node failure', cat: 'Data', sev: 'high',
    desc: 'A cache node dies and its key range has to be rehashed.',
    lesson: 'With naive modulo hashing, losing 1 of N nodes invalidates almost all keys. Consistent hashing invalidates only 1/N.',
    chapter: '23_building_blocks_and_algorithms.md', durationSec: 45,
    effect: { kill: true, killSec: 45 },
    targets: ['redis', 'redis_cluster', 'memcached'],
  },
  {
    id: 'conn_pool_exhaust', name: 'Connection pool exhaustion', cat: 'Data', sev: 'critical',
    desc: 'Long-running queries hold every connection open.',
    lesson: 'Connections are the scarcest database resource. Concurrency = RPS x latency; when that exceeds the pool, everything queues.',
    chapter: '07_relational_databases_and_transactions.md', durationSec: 60,
    effect: { capacityMult: 0.12, serviceMult: 3 },
    targets: ['pg_primary', 'pg_replica', 'sql_sharded', 'newsql', 'document_db'],
  },
  {
    id: 'lock_contention', name: 'Lock contention / deadlock', cat: 'Data', sev: 'high',
    desc: 'Hot rows serialise; some transactions abort and retry.',
    lesson: 'Amdahl\'s Law with a database accent: the serialised fraction caps your throughput no matter how many app servers you add.',
    chapter: '10_distributed_transactions_and_integrity.md', durationSec: 60,
    effect: { capacityMult: 0.25, serviceMult: 4, errorAdd: 0.05 },
  },
  {
    id: 'compaction_storm', name: 'Compaction / vacuum storm', cat: 'Data', sev: 'medium',
    desc: 'Background maintenance consumes the IO budget.',
    lesson: 'LSM stores trade write speed for background merge debt. When compaction falls behind, reads have to touch many more files.',
    chapter: '06_storage_engines_internals.md', durationSec: 75,
    effect: { ramp: { overSec: 45, serviceMult: 4, capacityMult: 0.4 } },
  },
  {
    id: 'disk_full', name: 'Disk full', cat: 'Data', sev: 'critical',
    desc: 'The volume fills up and writes start failing.',
    lesson: 'A full disk is a total write outage with no graceful degradation. Alert at 70%, not 95%.',
    chapter: '19_observability_and_operations.md', durationSec: 60,
    effect: { errorAdd: 0.6, capacityMult: 0.5 },
  },

  // ------------------------------------------------------------- application
  {
    id: 'thread_exhaust', name: 'Thread pool exhaustion', cat: 'Application', sev: 'critical',
    desc: 'Workers are all blocked waiting on something slow.',
    lesson: 'The service is not busy, it is waiting. CPU sits at 5% while the queue explodes. Bulkheads and short timeouts are the cure.',
    chapter: '03_reliability_availability_performance.md', durationSec: 60,
    effect: { capacityMult: 0.1 },
  },
  {
    id: 'gc_pause', name: 'GC pause storm', cat: 'Application', sev: 'medium',
    desc: 'Long stop-the-world pauses spike the tail.',
    lesson: 'GC pauses are invisible in p50 and brutal in p99. Always alert on percentiles, never on averages.',
    chapter: '03_reliability_availability_performance.md', durationSec: 60,
    effect: { serviceMult: 1.4, errorAdd: 0.01, ramp: { overSec: 20, serviceMult: 3 } },
  },
  {
    id: 'bad_deploy', name: 'Bad deploy (2x slower)', cat: 'Application', sev: 'high',
    desc: 'A regression doubles processing time on the target.',
    lesson: 'A 2x slowdown halves capacity. If you were running above 50% utilisation, you are now over 100%.',
    chapter: '20_deployment_multiregion_dr_cost.md', durationSec: 75,
    effect: { serviceMult: 2.2 },
  },
  {
    id: 'retry_storm', name: 'Retry storm', cat: 'Application', sev: 'critical',
    desc: 'Errors trigger retries which cause more errors.',
    lesson: 'Positive feedback. Retries multiply load exactly when the system has the least capacity. Retry budgets and circuit breakers break the loop.',
    chapter: '23_building_blocks_and_algorithms.md', durationSec: 45,
    effect: { errorAdd: 0.25, capacityMult: 0.6 },
  },
  {
    id: 'poison_message', name: 'Poison message', cat: 'Application', sev: 'medium',
    desc: 'A message that always fails is redelivered forever.',
    lesson: 'Without a dead-letter queue and a redelivery cap, one bad message blocks a whole partition indefinitely.',
    chapter: '12_messaging_and_event_streaming.md', durationSec: 60,
    effect: { errorAdd: 0.2, capacityMult: 0.55 },
    targets: ['queue', 'kafka', 'worker_pool', 'pubsub'],
  },
  {
    id: 'consumer_lag', name: 'Consumer group stall', cat: 'Application', sev: 'high',
    desc: 'Consumers stop draining and the backlog grows.',
    lesson: 'Queue depth is the leading indicator. Alert on backlog age, because depth alone hides a slow drain.',
    chapter: '12_messaging_and_event_streaming.md', durationSec: 60,
    effect: { capacityMult: 0.08 },
    targets: ['worker_pool', 'stream_processor'],
  },

  // -------------------------------------------------------------- dependency
  {
    id: 'third_party_slow', name: 'Third-party API degradation', cat: 'Dependency', sev: 'high',
    desc: 'An external dependency\'s latency goes to several seconds.',
    lesson: 'Their latency becomes your thread occupancy. Without a timeout shorter than your own SLO, their incident is your incident.',
    chapter: '03_reliability_availability_performance.md', durationSec: 75,
    effect: { serviceMult: 8 },
    targets: ['third_party', 'payment_gw', 'notification'],
  },
  {
    id: 'third_party_429', name: 'Downstream rate limit (429)', cat: 'Dependency', sev: 'medium',
    desc: 'The provider starts rejecting requests above their quota.',
    lesson: 'You cannot retry your way past a quota. Queue, batch, or degrade. Retrying just burns the budget faster.',
    chapter: '15_apis_and_protocols.md', durationSec: 60,
    effect: { capacityMult: 0.25, errorAdd: 0.2 },
    targets: ['third_party', 'payment_gw', 'notification'],
  },
  {
    id: 'third_party_outage', name: 'Third-party total outage', cat: 'Dependency', sev: 'critical',
    desc: 'The external dependency returns errors for everything.',
    lesson: 'Decide now: does your product fail closed (payments) or fail open (recommendations)? That answer belongs in the design, not the incident.',
    chapter: '03_reliability_availability_performance.md', durationSec: 60,
    effect: { kill: true, killSec: 60 },
    targets: ['third_party', 'payment_gw', 'notification'],
  },
  {
    id: 'cert_expiry', name: 'TLS certificate expiry', cat: 'Dependency', sev: 'critical',
    desc: 'Every TLS handshake to the target fails.',
    lesson: 'The most preventable outage in the industry. Automate renewal and alert 30 days out.',
    chapter: '18_security_and_identity.md', durationSec: 45,
    effect: { errorAdd: 0.95 },
  },

  // -------------------------------------------------------------- AI / agent
  {
    id: 'mcp_outage', name: 'MCP tool server outage', cat: 'AI & Agents', sev: 'high',
    desc: 'The agent\'s tool backend stops responding.',
    lesson: 'An agent making N tool calls per request has N chances to fail. Tool reliability compounds: 0.99^10 = 90%.',
    chapter: '15_apis_and_protocols.md', durationSec: 60,
    effect: { kill: true, killSec: 60 }, targets: ['mcp_server'],
  },
  {
    id: 'llm_slow', name: 'LLM provider slowdown', cat: 'AI & Agents', sev: 'high',
    desc: 'Token generation slows by 4x.',
    lesson: 'LLM latency scales with output tokens. Streaming turns a 6-second wait into a 0.4-second perceived wait for the same total work.',
    chapter: '23_building_blocks_and_algorithms.md', durationSec: 60,
    effect: { serviceMult: 4 }, targets: ['llm_service', 'agent_runtime'],
  },
  {
    id: 'context_overflow', name: 'Context window overflow', cat: 'AI & Agents', sev: 'medium',
    desc: 'Prompts exceed the model budget and requests fail.',
    lesson: 'Context is a hard resource limit like memory. Budget it explicitly: truncate, summarise or retrieve less.',
    chapter: '23_building_blocks_and_algorithms.md', durationSec: 60,
    effect: { errorAdd: 0.3 }, targets: ['agent_runtime', 'llm_service'],
  },
  {
    id: 'vector_stale', name: 'Vector index staleness', cat: 'AI & Agents', sev: 'low',
    desc: 'The ANN index stops refreshing and recall degrades.',
    lesson: 'Search quality failures are silent. No error rate moves, users just get worse answers. Monitor recall, not only latency.',
    chapter: '14_search_systems.md', durationSec: 90,
    effect: { serviceMult: 2, errorAdd: 0.02 }, targets: ['vector_db'],
  },
];

export const CHAOS_CATEGORIES = [...new Set(CHAOS.map((c) => c.cat))];

export function chaosFor(nodeType) {
  return CHAOS.filter((c) => !c.targets || c.targets.includes(nodeType));
}
