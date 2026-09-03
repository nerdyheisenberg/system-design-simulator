# System Design Simulator

A browser-based **queueing-network simulator** for distributed system architectures — the
practical companion to the [System Design book](../system-design-book/README.md) in this
repository.

Draw an architecture, push traffic through it, break it on purpose, and get told *why*
it failed and *how* to fix it — with the arithmetic shown and a link to the chapter that
explains the principle.

```
python3 system-design-simulator/serve.py
# -> http://127.0.0.1:8123/system-design-simulator/
```

No Node, no npm, no build step, no backend, no account. Plain ES modules and one Python
static file server. The engine runs entirely in your browser.

> Serve from the **repository root** (which `serve.py` does automatically) so that the
> "read the chapter" links resolve into `../system-design-book/`.

---

## Why this exists

Static diagrams hide runtime physics. A box-and-arrow picture of "load balancer → app
servers → database with a Redis cache" looks identical whether it serves 500 requests per
second or falls over at 5,000. It cannot show you that:

- your app servers are *waiting*, not working, and the CPU graph will stay flat while the
  queue explodes;
- 40 replicas × 100 threads is 4,000 connections against a database that accepts 100;
- your 95% cache hit ratio becomes 0% for one second when the hot keys expire together,
  and that second is a 20× load multiplier;
- three retries against a struggling backend triples its load at exactly the moment it has
  the least capacity.

This tool makes those things happen in front of you, then explains them.

---

## What it does

| | |
| --- | --- |
| **56 components** | DNS, CDN, WAF, L4/L7 balancers, API gateway, service mesh, WebSocket gateway, rate limiter, circuit breaker, bulkhead, retry policy, web/app servers, autoscaling pod clusters, serverless, worker pools, cron, stream processors, SQL primary/replica/sharded/NewSQL, connection pooler, DynamoDB-style KV, MongoDB, Cassandra, ClickHouse, Elasticsearch, time-series, graph DB, Redis (single + cluster), Memcached, in-process cache, S3, EBS, data lake, SQS, Kafka, pub/sub, DLQ, Raft consensus, distributed lock, service discovery, config service, LLM inference, agent runtime, MCP tool server, vector DB, embeddings, third-party APIs, payment gateway, notifications, observability. |
| **41 chaos scenarios** | Across network, infrastructure, traffic, data layer, application, dependency and AI/agent failure domains. Each one states what it teaches. |
| **21 blueprints** | From "the naive design" to a ride-hailing dispatch system, an order matching engine, a multi-region active-active deployment, and an agentic MCP pipeline. |
| **14 guided missions** | Measurable objectives, scripted incidents, live pass/fail grading, and a hint on every objective you have not met yet. |
| **The System Design Doctor** | ~35 static design rules plus ~15 live runtime diagnostics. Names the bottleneck, shows the arithmetic, gives concrete fixes, links to the chapter. |
| **Cost model** | AWS us-east-1 list prices, driven by the live simulated rate, with a per-component breakdown and a budget you can fail against. |
| **Design score** | A letter grade from reliability, latency, design quality, utilisation and cost. |

---

## How the simulation works

Three passes run every tick (100ms of simulated time).

**1 · Flow model** — deterministic, `O(nodes + edges)`.
Request *rates* propagate through the graph. Each component is an M/G/c service station:

```
capacity      = workers / occupancy
utilisation ρ = λ / capacity
queue depth   ∫ (λ − capacity) dt , clamped to the buffer size
queue wait    Kingman's VUT approximation, + backlog/throughput drain time
```

Because it works on rates rather than individual requests, 100 rps and 5,000,000 rps cost
the same to simulate — both run at 60fps.

**2 · Feedback pass** — reverse topological order.
Each caller's *occupancy* is `own service time + downstream latency`, because a synchronous
caller holds its worker for the entire downstream call. This single feedback loop is what
makes thread-pool exhaustion, connection starvation and cascading failure emerge on their
own instead of being scripted. (Caches are excluded: on a miss it is the caller, not the
cache server, that goes to the origin.)

**3 · Path sampler** — ~240 virtual requests per tick.
Individual requests are walked through the live graph. Service times are drawn from
lognormal distributions parameterised by each component's coefficient of variation; queue
waits are drawn from the flow model; scatter-gather nodes take the max over shards; cold
starts, retries, breaker state, cache hits and read/write routing are all resolved per
request. This is what produces honest p50/p95/p99 tails, fan-out tail amplification, and
the packets you see travelling along the edges.

Everything is seeded, so the same design and seed give the same run every time.

### What the numbers rest on

`js/core/queueing.js` is deliberately small and readable: Erlang-B/C, M/M/c waiting time,
Kingman's approximation, Little's Law, the Universal Scalability Law, tail-at-scale
fan-out amplification, retry amplification, and effective cache hit ratio under a Zipfian
working set. If you disagree with a number, that file is where to argue with it.

### What it does not model

Deliberate simplifications, so you know where the edges are: no per-shard key
distributions (skew is a scalar), no TCP-level congestion control, no cache coherency
protocols, no JIT warm-up curves, and a single global read/write ratio rather than a
per-endpoint mix. It is a teaching instrument, not a capacity planner — treat every
number as an order of magnitude for *comparing designs*, not as a production forecast.

---

## Using it

**Start here:** press **Missions** and work down the list. Each mission gives you a
deliberately broken design, a target, and a hint when you are stuck.

A productive loop for any design:

1. **Raise the load until something turns red.** That number is your real capacity. The
   Telemetry tab tells you which component gave up first.
2. **Read the Doctor tab.** It names the bottleneck and shows the arithmetic that proves
   it. "Show me" highlights the component on the canvas.
3. **Inject a chaos scenario.** A design that survives steady state and dies on a cache
   flush is not finished.
4. **Check the Cost tab.** Meeting the SLO at four times the budget is not meeting the
   requirements.
5. **Delete a component and confirm the Doctor complains.** Understanding *why* something
   is needed beats memorising that it is.

### Canvas controls

| Action | How |
| --- | --- |
| Add a component | Drag from the palette, or double-click it |
| Connect two components | Drag from the dot on a node's right edge |
| Change a connection's kind | Double-click it, or right-click for the menu |
| Select / multi-select | Click · Shift+drag for a marquee |
| Duplicate / delete | `Ctrl`+`D` · `Delete` |
| Run / pause · fit | `Space` · `F` |
| Pan / zoom | Drag empty space · scroll |

### Connection kinds

| Kind | Meaning |
| --- | --- |
| `default` | All requests may use this path |
| `read` | Only read requests — route these to replicas and caches |
| `write` | Only write requests — route these to the primary |
| `replication` | Data replication, excluded from request flow |
| `fallback` | Used only while the upstream circuit breaker is OPEN |

Each connection also has a **calls-per-request ratio**. Set it to `0.01` for a stream
processor that aggregates 100 events into one write, or `3` for a request that triggers
three downstream calls. This is how you model fan-in and fan-out honestly.

---

## Publishing it online

The simulator is 100% static — no backend, no build step, no network calls at runtime, no
external assets. It runs on GitHub Pages, Netlify, S3, or any static host as-is.

> It will **not** work by double-clicking `index.html`. Browsers block ES modules over
> `file://`. Use `serve.py` or any static server.

The only thing that depends on where you host it is the "read the chapter" links, which is
why [`js/config.js`](./js/config.js) exists.

**Recommended — publish the book and the simulator together.** Push a repository
containing both `system-design-book/` and `system-design-simulator/`, then enable
Pages (Settings → Pages → Deploy from branch → `main` / root). Leave `bookBase: 'auto'`.

```
https://<you>.github.io/<repo>/system-design-simulator/
```

On `*.github.io`, `auto` rewrites chapter links to `github.com/<you>/<repo>/blob/main/…`
rather than relative paths, because GitHub Pages cannot render `.md` files — with Jekyll
they become `.html`, and with `.nojekyll` they download as plain text. GitHub itself
renders them properly.

**Publishing the simulator on its own.** It works, but there is no book to link to. Set:

```js
bookBase: 'none',   // chapter references render as plain labels
```

or point at wherever the book actually lives:

```js
bookBase: 'https://github.com/<you>/<book-repo>/blob/main/system-design-book/',
```

Also change `githubBranch` if your default branch is not `main`, and set `bookBase`
explicitly if you deploy inside a `<you>.github.io` repository — that one case cannot be
detected from the client.

A `.nojekyll` file is included so Pages serves the tree verbatim. If you publish from a
repository root, put a copy of it there too.

---

## Project layout

```
system-design-simulator/
  index.html            shell
  serve.py              local static server (repo root, caching disabled)
  .nojekyll             tell GitHub Pages to serve the tree verbatim
  css/app.css
  js/
    config.js           deployment config: where the book chapters live
    core/util.js        seeded RNG, ring buffers, percentiles, formatting, DOM helpers
    core/queueing.js    Erlang-C, Kingman, Little's Law, USL, tail amplification
    model/catalog.js    56 component definitions: params, queueing model, cost, chapter
    model/blueprints.js 21 reference architectures
    model/missions.js   14 graded missions
    model/chaos.js      41 failure scenarios
    engine/engine.js    flow model + feedback pass + path sampler
    doctor/doctor.js    static design review, live diagnosis, scoring
    ui/canvas.js        infinite canvas editor + packet animation
    ui/charts.js        dependency-free canvas charts
    ui/app.js           wiring, panels, persistence
```

Designs persist to `localStorage` automatically and can be exported to / imported from
JSON, so you can keep an architecture under version control or share it.

## Extending it

Adding a component is one entry in `js/model/catalog.js`:

```js
C({
  id: 'my_thing', name: 'My Thing', cat: 'compute', glyph: 'MT',
  dispatch: 'all',                       // source | split | all | cache | terminal | async
  caps: ['compute', 'stateless'],        // what the Doctor reasons about
  chapter: '16_microservices_and_service_architecture.md',
  blurb: 'One sentence on what it is for and how it fails.',
  params: [ n('replicas', 'Instances', 3, 1, 500, 1, '', 'help text') ],
  derive: (c) => ({ replicas: c.replicas, workers: c.replicas * 100, serviceMs: 5, queueCap: 2000, cs2: 1 }),
  cost: (c) => c.replicas * 70,
});
```

New Doctor rules go in `reviewStatic()` (design-time) or `diagnose()` (runtime). Every
finding should answer three questions: what happened, why, and what to do about it.
