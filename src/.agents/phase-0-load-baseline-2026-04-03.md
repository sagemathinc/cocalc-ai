# Phase 0 Load Baseline: 2026-04-03

Status: local one-bay Launchpad / Lite baseline captured before the Phase 1
projection rewrite and bay-routing work.

This baseline is intentionally modest. It is not a production capacity claim.
It is a regression reference for future Phase 1 work on the same repository and
roughly the same local hardware.

Raw results are in
[phase-0-load-baseline-2026-04-03.jsonl](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-2026-04-03.jsonl).

## Environment

- Date: `2026-04-03T00:38:36-07:00`
- Repo: `/home/wstein/build/cocalc-lite4`
- API: `http://localhost:13004`
- CLI:
  `/home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js`
- Deployment mode: one-bay local Launchpad on the developer laptop
- Browser session id: `NQrnBoOeCS`
- Target project id: `ea5023db-e0c3-42e1-b067-cd6dd4ffb3a0`
- Hostname: `lite`
- Kernel: `Linux 6.17.0-20-generic x86_64 GNU/Linux`
- CPU threads visible via `nproc`: `8`
- Memory at benchmark time: about `18 GiB` available
- Uptime / load at benchmark time:
  `up 1 day, 3:50, load average: 1.77, 1.62, 1.71`

## Dataset

- Authenticated account had `39` visible projects.
- `load projects` therefore exercised a small account shape, not a heavy or
  extreme persona.
- Project-list benchmark used `--limit 100`, which did not truncate results for
  this account.

## Commands

The benchmark matrix was run from `src/` after:

```bash
eval "$(pnpm -s dev:env:hub)"
```

Commands:

```bash
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load bootstrap --json --iterations 200 --warmup 20 --concurrency 1
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load bootstrap --json --iterations 200 --warmup 20 --concurrency 8
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load bootstrap --json --iterations 200 --warmup 20 --concurrency 32
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load bootstrap --json --iterations 200 --warmup 20 --concurrency 64

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 1 --limit 100
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 8 --limit 100
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 32 --limit 100
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 64 --limit 100

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load bootstrap --json --iterations 1000 --warmup 100 --concurrency 32
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 1000 --warmup 100 --concurrency 32 --limit 100
```

## Results

| label                          |    ops/s | p50 ms | p95 ms | p99 ms | avg ms | failures |
| ------------------------------ | -------: | -----: | -----: | -----: | -----: | -------: |
| `bootstrap-i200-w20-c1`        |  322.007 |  3.124 |  4.555 |  5.230 |  2.848 |        0 |
| `bootstrap-i200-w20-c8`        |  597.580 |  8.292 | 23.873 | 26.944 | 11.489 |        0 |
| `bootstrap-i200-w20-c32`       | 1081.861 | 26.500 | 27.657 | 29.753 | 26.174 |        0 |
| `bootstrap-i200-w20-c64`       | 1076.927 | 51.226 | 54.658 | 57.296 | 49.346 |        0 |
| `projects-i200-w20-c1-l100`    |  307.311 |  2.633 |  4.259 |  4.904 |  2.879 |        0 |
| `projects-i200-w20-c8-l100`    |  682.940 |  8.804 | 17.746 | 21.565 |  9.669 |        0 |
| `projects-i200-w20-c32-l100`   |  809.592 | 34.355 | 39.882 | 46.590 | 34.625 |        0 |
| `projects-i200-w20-c64-l100`   |  728.257 | 70.571 | 89.914 | 95.712 | 71.940 |        0 |
| `bootstrap-i1000-w100-c32`     | 1049.196 | 25.142 | 33.123 | 33.860 | 25.843 |        0 |
| `projects-i1000-w100-c32-l100` |  816.236 | 34.026 | 41.217 | 54.653 | 35.298 |        0 |

## Interpretation

- The load harness is working against a real local one-bay Launchpad deployment.
- Control-plane bootstrap and small-account project-list loads are both fast on
  this machine.
- At concurrency `32`, bootstrap sustained about `1049 ops/s` and project-list
  load sustained about `816 ops/s` with no failures.
- At concurrency `64`, throughput stopped scaling much further and latency rose
  sharply. That is useful as a local saturation probe.
- Because the account only had `39` projects, these numbers do not answer the
  heavy-user question yet.

## Phase 1 Regression Gates

These are practical local guardrails for future development on this machine or
similar hardware. They are not customer-facing SLOs.

Primary gates:

- `bootstrap-i1000-w100-c32`
  - failures must stay at `0`
  - `p99` should stay at or below `45 ms`
  - throughput should stay at or above `900 ops/s`
- `projects-i1000-w100-c32-l100`
  - failures must stay at `0`
  - `p99` should stay at or below `70 ms`
  - throughput should stay at or above `700 ops/s`

Secondary saturation probes:

- `bootstrap-i200-w20-c64`
  - failures must stay at `0`
  - `p99` should stay at or below `75 ms`
- `projects-i200-w20-c64-l100`
  - failures must stay at `0`
  - `p99` should stay at or below `120 ms`

If the same benchmark matrix later shows:

- any nonzero failure count
- more than about `20%` throughput loss on the primary gates
- more than about `30%` `p99` regression on the primary gates

then the Phase 1 change set should be treated as performance-regressing until
explained.

## What This Does Not Cover Yet

- heavy users with `1000+` or `10000+` projects
- collaborator-list or collaborator-change workloads
- project rename latency
- project start / route-to-host latency
- browser-tab fanout and long-lived websocket pressure
- inter-bay replication lag
- multi-bay routing cost

Those should be added to the load harness and measured next, but this local
baseline is enough to start detecting obvious regressions in the current one-bay
control-plane path.
