// Queueing-theory primitives. Everything the engine claims about latency is
// derived from these functions, so the numbers can be checked by hand.
//
// Reference chapters:
//   02_scalability_and_estimation.md  — Little's Law, USL
//   03_reliability_availability_performance.md — percentiles, tail amplification

import { clamp } from './util.js';

/**
 * Erlang-C: probability an arriving request has to wait in an M/M/c queue.
 *   c   = number of parallel servers (threads, connections, pods)
 *   a   = offered load in erlangs = λ / µ  (arrival rate / per-server service rate)
 * Returns 0..1. Computed with the numerically stable recursive Erlang-B form so
 * it does not overflow for large c (c can be thousands of goroutines/connections).
 */
export function erlangC(c, a) {
  if (c <= 0) return 1;
  if (a <= 0) return 0;
  const rho = a / c;
  if (rho >= 1) return 1;
  // Erlang-B recursion: B(0,a)=1 ; B(n,a) = a*B(n-1,a) / (n + a*B(n-1,a))
  let b = 1;
  for (let n = 1; n <= c; n++) b = (a * b) / (n + a * b);
  const denom = 1 - rho * (1 - b);
  if (denom <= 1e-12) return 1;
  return b / denom;
}

/**
 * Mean waiting time (time in queue, excluding service) for M/M/c, in the same
 * time unit as serviceTime.
 *   Wq = C(c, a) / (c*µ − λ)
 */
export function waitMMc(lambda, serviceTime, c) {
  if (lambda <= 0 || c <= 0) return 0;
  const mu = 1 / serviceTime;              // per-server completions per unit time
  const capacity = c * mu;
  if (lambda >= capacity) return Infinity; // unstable: queue grows without bound
  const a = lambda / mu;
  const pWait = erlangC(c, a);
  return pWait / (capacity - lambda);
}

/**
 * M/D/1-ish correction. Deterministic service (fixed-size work, e.g. a CDN edge
 * hit or a hash lookup) queues half as badly as exponential service.
 * variability = squared coefficient of variation (Cs²): 1 = exponential,
 * 0 = deterministic, >1 = heavy-tailed (GC pauses, cold starts).
 */
export function kingmanWait(lambda, serviceTime, c, ca2 = 1, cs2 = 1) {
  if (lambda <= 0 || c <= 0) return 0;
  const capacity = c / serviceTime;
  const rho = lambda / capacity;
  if (rho >= 1) return Infinity;
  // Kingman's VUT: Wq ≈ ((Ca²+Cs²)/2) · (ρ^(√(2(c+1))−1) / (c(1−ρ))) · serviceTime
  const V = (ca2 + cs2) / 2;
  const U = Math.pow(rho, Math.sqrt(2 * (c + 1)) - 1) / (c * (1 - rho));
  return V * U * serviceTime;
}

/** Little's Law: L = λ · W. Concurrency needed to sustain a rate at a latency. */
export const concurrencyNeeded = (rps, latencySec) => rps * latencySec;

/** Inverse Little's Law: how long a backlog of `queueDepth` takes to drain. */
export const drainTimeSec = (queueDepth, throughputRps) =>
  throughputRps <= 0 ? Infinity : queueDepth / throughputRps;

/**
 * Tail-at-scale amplification. If a request fans out to n backends in parallel
 * and waits for all of them, the chance of hitting at least one slow backend is
 * 1 − (1 − p)^n. Returns the effective percentile you actually observe.
 * (Chapter 03, "the tail at scale".)
 */
export function fanoutTailPercentile(p, n) {
  return 1 - Math.pow(1 - p, n);
}

/** Availability of n independent replicas where k are required (series/parallel). */
export function parallelAvailability(single, n) { return 1 - Math.pow(1 - single, n); }
export function seriesAvailability(list) { return list.reduce((a, b) => a * b, 1); }

/**
 * Universal Scalability Law. Throughput of N workers relative to 1, given
 * contention (σ, serialisation) and coherency (κ, crosstalk) penalties.
 * Explains why 100 app servers on one database do NOT give 100x.
 */
export function usl(n, sigma = 0.03, kappa = 0.0001) {
  return n / (1 + sigma * (n - 1) + kappa * n * (n - 1));
}

/**
 * Retry amplification. With `attempts` total tries against a backend whose
 * failure probability is p, the load multiplier the backend actually sees.
 * This is why retries without a circuit breaker turn a blip into an outage.
 */
export function retryAmplification(p, attempts) {
  let mult = 1, pf = 1;
  for (let i = 1; i < attempts; i++) { pf *= clamp(p, 0, 1); mult += pf; }
  return mult;
}

/**
 * Cache stampede factor: when a hot key expires, `concurrent` requests all miss
 * simultaneously and hit the origin. Without request coalescing the origin sees
 * the full burst.
 */
export function stampedeFactor(concurrent, coalescing) { return coalescing ? 1 : Math.max(1, concurrent); }

/** Effective hit ratio after accounting for working-set vs cache memory. */
export function effectiveHitRatio(configuredHitRatio, cacheGB, workingSetGB) {
  if (workingSetGB <= 0) return configuredHitRatio;
  const coverage = clamp(cacheGB / workingSetGB, 0, 1);
  // Zipfian access: a cache covering x of the key space serves more than x of
  // the traffic. x^0.5 is a decent approximation for typical web workloads.
  return clamp(configuredHitRatio * Math.pow(coverage, 0.5), 0, configuredHitRatio);
}
