# Bay Hub Load Testing Plan

Status: proposed load-test program for validating a bay-style hub deployment on
systemd-backed VMs before and during dogfooding.

This plan is deliberately hub-first. The point is to answer:

- does a bay with `N` hub worker processes perform materially better than one
  monolithic hub process?
- where does the hub control plane saturate first?
- how much headroom do we gain from adding hub workers inside one bay VM?

This is not yet a full end-to-end project-host throughput plan. It starts with
what can be measured on a fresh bay VM as soon as the bay boots cleanly, then
adds project-host-sensitive flows later.

## Scope

### In Scope First

- account bootstrap / login-adjacent control-plane work
- repeated project list reads
- repeated collaborator list reads
- repeated mention / notification reads
- repeated collaborator mutation cycles
- hub worker scale-up impact (`1`, `2`, `4`, maybe `8` workers)
- router/persist/hub worker steady-state behavior under synthetic control-plane
  load

### Explicitly Out Of Scope For The First VM

- large project-host CPU / memory workloads
- kernel / editor / terminal performance inside projects
- bulk backup / restore throughput
- cross-bay replication
- WAN latency and internet edge behavior

Those matter, but they should not block the first answer to “is a scalable bay
hub better than one hub process?”

## Existing Harness We Should Reuse

Do not invent a separate benchmark harness first. Reuse what is already in the
repo.

### Existing CLI Load Commands

The current CLI already has useful control-plane load commands in
[load.ts](/home/user/cocalc-ai-clone/src/packages/cli/src/bin/commands/load.ts):

- `cocalc load bootstrap`
- `cocalc load projects`
- `cocalc load collaborators`
- `cocalc load my-collaborators`
- `cocalc load mentions`
- `cocalc load collaborator-cycle`
- `cocalc load seed users`

These are the right starting point because they already measure:

- repeated control-plane RPCs
- concurrency
- warmup vs measured iterations
- latency and throughput summaries

### Existing Fixture / Persona Work

The previous benchmark work in
[/home/user/cocalc-ai/src/scripts/dev/phase3_control_plane_benchmark.py](/home/user/cocalc-ai/src/scripts/dev/phase3_control_plane_benchmark.py)
already established useful personas:

- `light`: about `20` visible projects
- `normal`: about `200` visible projects
- `heavy`: about `1000+` visible projects
- `extreme`: about `10000` visible projects

It also already leaned on:

- collaborator-heavy fixture projects
- high-iteration repeated read paths
- p50/p95/p99 latency comparisons
- Postgres delta inspection

That prior work should be treated as the baseline style to preserve.

## Test Environment Shape

For the first disposable bay VM, keep the environment simple:

- one bay VM
- bay-local Postgres
- bay-local `conat-persist`
- bay-local `conat-router`
- variable number of bay hub workers
- same built release for all runs

Run the same suite at:

- `1` hub worker
- `2` hub workers
- `4` hub workers
- optionally `8` hub workers if CPU count justifies it

The measurement question is not just raw max throughput. It is:

- how p95/p99 behave as workers increase
- whether DB or router/persist becomes the limiting factor
- whether worker count reduces tail latency or just moves contention elsewhere

## Same-Host Worker Scale Probe

Before spending time on a fresh VM, run the same worker shape against the
current dogfood-sized dev host. The helper below starts extra `--conat-api`
workers that connect to the existing seed bay entrypoint and then runs the
hot-path probe through the normal bay URL:

```sh
cd src
COCALC_BAY_WORKER_SCALE_COUNT=8 \
COCALC_BAY_WORKER_SCALE_CONCURRENCIES="32 64 128 256" \
COCALC_BAY_WORKER_SCALE_ITERATIONS=600 \
COCALC_BAY_WORKER_SCALE_WARMUP=60 \
  ./scripts/dev/bay-worker-scale-benchmark.sh start-run
```

Stop the extra workers after the run:

```sh
cd src
./scripts/dev/bay-worker-scale-benchmark.sh stop
```

This is not a substitute for the final systemd VM test. It is a fast way to
answer whether one Node process is the obvious limiting factor before adding
deployment friction.

When testing split Conat router ingress, split both sides of the topology. If
clients enter through two router ports but all hub/API workers still register
through one router, the measurement is mostly a single-router test plus extra
cluster forwarding. The helper supports comma- or space-separated lists for
both axes:

```sh
cd src
CONAT_SOCKETIO_COUNT=2 ./scripts/dev/hub-daemon.sh restart

COCALC_BAY_WORKER_SCALE_COUNT=8 \
COCALC_BAY_WORKER_SCALE_CONAT_SERVERS="http://localhost:9102 http://localhost:9103" \
COCALC_BAY_WORKER_SCALE_APIS="http://localhost:9102 http://localhost:9103" \
COCALC_BAY_WORKER_SCALE_CONCURRENCIES="128 256 384" \
COCALC_BAY_WORKER_SCALE_ITERATIONS=800 \
COCALC_BAY_WORKER_SCALE_WARMUP=80 \
  ./scripts/dev/bay-worker-scale-benchmark.sh start-run
```

Read split-router results carefully:

- `aggregate_scenarios_per_sec` is the completed fixed-iteration batch rate
  using the parent wall time.
- `sum_child_scenarios_per_sec` is the sum of each client group's independent
  rate and is closer to a sustained active-user model where both router groups
  keep generating work for the full interval.

After split-router experiments, stop the extra workers and restart the dev hub
without `CONAT_SOCKETIO_COUNT=2` unless the next test explicitly needs the
split-router shape.

### Initial Same-Host Evidence

Host shape:

- GCE `t2d-standard-16`
- `16` vCPU / `63 GiB`
- current dev hub running a local 3-bay cluster inside the project container
- load target: `cocalc load three-bay --hot-path`
- scenario shape: five sequential user hot-path control-plane reads per
  scenario

Observed peak throughput:

| API workers | Best concurrency | Scenarios/sec | Component reads/sec |
| --- | ---: | ---: | ---: |
| 1 existing dev hub process | 32-64 | ~55 | ~275 |
| 4 extra `--conat-api` workers | 32 | ~137 | ~685 |
| 8 extra `--conat-api` workers | 256 | ~177 | ~883 |
| 12 extra `--conat-api` workers | 384 | ~171 | ~855 |
| 8 extra workers + 2 router ports split on clients and workers | 256 | ~223 sustained child-sum | ~1115 sustained child-sum |

The first split-router probe shows a real improvement over single-router ingress
when both worker registration and client entry are split, but it is not yet a
clean capacity number. The seed router port was consistently slower than the
child router port, so the next attribution pass should measure router CPU,
event-loop delay, cluster-forwarding counts, and Postgres pressure on the same
run.

First attribution pass for the corrected split-router run:

- run shape: `CONAT_SOCKETIO_COUNT=2`, 8 extra API workers, workers split
  round-robin across `9102` and `9103`, clients split across `9102` and `9103`,
  total concurrency 256
- measured throughput: about 210 sustained child-sum scenarios/sec, or about
  1052 component reads/sec, with 0 failures
- extra API workers averaged roughly 32-39% CPU each
- the seed bay main hub process averaged about 40% CPU
- attached bay hub processes averaged about 25-27% CPU
- the seed router child averaged about 16% CPU; attached bay router children
  were much lower
- seed Postgres averaged about 2% CPU in this sample

This shifts the current hypothesis away from raw CPU saturation in a single
router or Postgres. The remaining likely bottlenecks are request choreography
and latency: sequential hot-path component reads, Conat RPC/socket.io overhead,
cluster forwarding asymmetry, or benchmark/load-generator shape. A duration-based
load mode would make the split-client aggregate rate cleaner than fixed
iterations per client group.

Interpretation:

- Multi-process hub API workers materially improve the measured hot path.
- The first jump is large: roughly `2.5x` from one process to four extra API
  workers.
- Eight workers nearly reaches the `1000` component-read/sec target on this
  host.
- Twelve workers did not improve this workload, so the current same-host
  bottleneck is probably shared: request choreography, Conat RPC/socket.io
  overhead, cluster forwarding asymmetry, client-side load generation, or a
  serialized server path.
- The next useful benchmark should add event-loop delay and Conat
  cluster-forwarding counters, then switch from fixed iterations per split
  client group to fixed-duration split clients.

## Required Metrics

For every benchmark run, record at minimum:

- wall-clock start and finish time
- workload name
- persona / fixture size
- configured hub worker count
- concurrency
- warmup iterations
- measured iterations
- p50 latency
- p95 latency
- p99 latency
- ops/sec

Also capture host-level resource usage during the run:

- total CPU
- per-process CPU for:
  - postgres
  - `conat-persist`
  - `conat-router`
  - each hub worker
- RSS / memory
- load average
- disk read/write and iowait
- Postgres stats if practical:
  - active connections
  - locks
  - tuples returned/fetched
  - buffer hit/read deltas

The first pass can store this in plain JSON/JSONL plus a markdown summary.

## Phase A: Fresh-VM Control Plane Benchmarks

These should run as soon as the bay boots and the control plane is usable.

### A1. Bootstrap / Login Sweep

Purpose:

- test the account bootstrap path
- approximate login-adjacent load on the hub without requiring browser auth for
  every sample

Use:

- `cocalc load bootstrap`

Run across personas:

- light
- normal
- heavy
- extreme

Suggested starting shape:

```sh
cocalc load bootstrap --iterations 500 --warmup 50 --concurrency 16
```

Then repeat with:

- concurrency `1`
- concurrency `8`
- concurrency `16`
- concurrency `32`

What to learn:

- bootstrap tail latency under parallel sign-in style pressure
- whether extra hub workers materially improve p95/p99
- whether Postgres becomes the dominant bottleneck

### A2. Project List Sweep

Purpose:

- test the most important “user signs in and sees lots of projects” path

Use:

- `cocalc load projects`

Suggested starting shape:

```sh
cocalc load projects --iterations 500 --warmup 50 --concurrency 16 --limit 2000
```

Run across personas:

- light limit `50`
- normal limit `250`
- heavy limit `2000`
- extreme limit `10000` or a realistic upper bound if the API path becomes too
  expensive for one run

This is one of the key go/no-go tests for dogfooding.

### A3. My-Collaborators Sweep

Purpose:

- stress the account-wide collaborator summary path
- catch hub or DB regressions that only show up on “social graph” style reads

Use:

- `cocalc load my-collaborators`

Suggested starting shape:

```sh
cocalc load my-collaborators --iterations 500 --warmup 50 --concurrency 16 --limit 2000
```

### A4. Collaborator-Heavy Project Read

Purpose:

- stress one large collaborator list on one project

Use:

- `cocalc load collaborators --project <fixture-project-id>`

Suggested starting shape:

```sh
cocalc load collaborators --project <fixture-project-id> --iterations 500 --warmup 50 --concurrency 16
```

The fixture project should have many collaborators, ideally reusing the same
kind of seeded fixture that the earlier phase-3 benchmark used.

### A5. Mention / Notification Read Sweep

Purpose:

- catch slow account-side notification paths
- exercise another projection-backed read path

Use:

- `cocalc load mentions`

Suggested starting shape:

```sh
cocalc load mentions --iterations 500 --warmup 50 --concurrency 16 --limit 2000
```

### A6. Collaborator Mutation Cycle

Purpose:

- test a realistic hub write-heavy flow instead of only reads
- exercise invite/remove/add logic and related reactivity

Use:

- `cocalc load seed users`
- `cocalc load collaborator-cycle`

Suggested prep:

```sh
cocalc load seed users --count 500 --prefix hub-load --project <fixture-project-id>
```

Suggested run:

```sh
cocalc load collaborator-cycle \
  --project <fixture-project-id> \
  --prefix hub-load \
  --count 500 \
  --iterations 500 \
  --warmup 50 \
  --concurrency 16
```

This is important because a hub that only reads fast but serializes badly on
collaborator mutations is still not acceptable.

## Phase B: Long-Lived Connection Pressure

This should follow once the bay is basically stable under Phase A.

### B1. Many Idle / Mostly Idle Browser Tabs

Purpose:

- model one account with many open browser tabs
- measure long-lived control connections and subscription overhead

This likely needs a small dedicated harness, not just current `cocalc load`
commands. The first version can be browserless if it:

- authenticates
- opens the same stable control connection shape the browser uses
- subscribes to account/project channels
- mostly idles while a smaller background workload mutates state

Key metrics:

- total open control sockets
- hub worker memory growth
- router/persist CPU and message throughput
- latency for update fanout while sockets stay open

### B2. Burst Update Fanout

Purpose:

- measure whether many connected clients receive updates promptly when project
  state changes arrive in bursts

This is the first place where a small custom harness may be justified if the
existing CLI does not already expose the right subscribe-and-wait shape.

## Phase C: Project-Aware Hub Flows

These should wait until the bay can talk cleanly to project hosts.

### C1. Project Start Latency

Measure:

- `request start`
- `host chosen`
- `start acknowledged`
- `project reported running`

This is partly a hub test and partly a project-host/fabric test, but it matters
for user-facing performance.

### C2. Project Open Latency

Measure:

- `open project`
- route resolution
- control-plane readiness
- project-host connection handoff readiness

### C3. Mixed Read + Start/Open Load

Purpose:

- ensure heavy account reads do not make interactive project open/start unusable

Example:

- background `load projects` and `load bootstrap`
- foreground loop of project start/open on a smaller set of projects

## Worker Scaling Matrix

Run the same Phase A suite for each worker count:

- `1`
- `2`
- `4`
- optionally `8`

For each count, keep everything else fixed:

- same release
- same VM type
- same Postgres config
- same dataset
- same benchmark parameters

The result should let us answer:

- is `2` workers already enough?
- does `4` help p99 materially?
- when do returns flatten because Postgres or router/persist dominates?

## Recommended Initial Acceptance Targets

These are not permanent SLOs. They are first dogfooding gates.

For the first bay dogfood target:

- no benchmark run should have correctness failures
- p99 should stay bounded rather than explode superlinearly with modest
  concurrency
- `heavy` bootstrap and project-list runs should be materially better at `2+`
  workers than `1`
- hub worker crashes or router/persist restarts under load are release blockers
- if `4` workers is not materially better than `2`, the bottleneck is probably
  elsewhere and we should measure that before adding more workers

## Concrete First Run Order

When the first disposable bay VM is ready, run in this order:

1. verify bay boots cleanly and stays idle without restarts
2. seed personas / collaborator fixtures
3. run `bootstrap` at worker count `1`
4. run `projects` at worker count `1`
5. run `my-collaborators` and `collaborators` at worker count `1`
6. repeat all of the above at worker counts `2` and `4`
7. run `collaborator-cycle`
8. inspect CPU/memory/DB contention
9. write a markdown summary of the safe operating envelope

Do not start with a giant mixed workload. First get clean single-scenario
numbers.

## Suggested Missing Helper Scripts

These are worth adding after the first manual run:

- `scripts/dev/bay-hub-benchmark.py`
  - orchestrates persona seeding
  - runs the chosen `cocalc load ...` matrix
  - captures bay worker count, timings, and host stats
  - writes JSON + markdown summary
- optional lightweight long-lived connection harness for B1/B2

The first version should stay CLI-first and shell-friendly, not browser-heavy.

## Non-Goals

This plan is not trying to prove:

- project-host compute scalability
- notebook/editor terminal performance
- backup throughput
- multi-bay correctness

Those are separate programs. This one is about proving that the hub side of the
bay architecture is worth having.
