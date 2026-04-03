# Phase 0 Collaborator Load Baseline: 2026-04-03

Status: local one-bay Launchpad / Lite baseline for collaborator-heavy read
paths, captured after seeding a project with `500` synthetic collaborators.

This note complements the earlier project-list baselines:

- [phase-0-load-baseline-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-2026-04-03.md)
- [phase-0-load-baseline-heavy-account-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-heavy-account-2026-04-03.md)

Raw results are in
[phase-0-collaborator-load-baseline-2026-04-03.jsonl](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-collaborator-load-baseline-2026-04-03.jsonl).

## Environment

- Date: `2026-04-03T06:48:00-07:00`
- Repo: `/home/wstein/build/cocalc-lite4`
- API: `http://localhost:13004`
- CLI:
  `/home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js`
- Deployment mode: one-bay local Launchpad on the developer laptop
- Browser session id: `NQrnBoOeCS`
- Benchmark project id: `808a3597-997e-47c1-b026-563bd42b34cd`
- Hostname: `lite`
- Kernel: `Linux 6.17.0-20-generic x86_64 GNU/Linux`
- CPU threads visible via `nproc`: `8`
- Memory at benchmark time: about `18 GiB` available
- Uptime / load at benchmark time:
  `up 1 day, 9:59, load average: 1.48, 1.10, 0.59`

## Fixture Setup

Before the benchmark matrix, the following fixture was created:

```bash
cd src
eval "$(pnpm -s dev:env:hub)"
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load seed users \
  --json \
  --count 500 \
  --prefix phase0-collab-bench-20260403 \
  --project 808a3597-997e-47c1-b026-563bd42b34cd \
  --concurrency 16
```

Fixture result:

- `500` accounts created
- `500` collaborators added
- `0` failures
- `accounts_per_sec`: `30.791`

After seeding:

- project-scoped collaborator listing returned `501` rows
- account-wide `my-collaborators` listing returned `506` rows

## Commands

Benchmark commands:

```bash
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborators --json --iterations 200 --warmup 20 --concurrency 1 \
  --project 808a3597-997e-47c1-b026-563bd42b34cd
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborators --json --iterations 200 --warmup 20 --concurrency 8 \
  --project 808a3597-997e-47c1-b026-563bd42b34cd
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborators --json --iterations 200 --warmup 20 --concurrency 32 \
  --project 808a3597-997e-47c1-b026-563bd42b34cd
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborators --json --iterations 200 --warmup 20 --concurrency 64 \
  --project 808a3597-997e-47c1-b026-563bd42b34cd
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborators --json --iterations 1000 --warmup 100 --concurrency 32 \
  --project 808a3597-997e-47c1-b026-563bd42b34cd

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load my-collaborators --json --iterations 200 --warmup 20 --concurrency 1 \
  --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load my-collaborators --json --iterations 200 --warmup 20 --concurrency 8 \
  --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load my-collaborators --json --iterations 200 --warmup 20 --concurrency 32 \
  --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load my-collaborators --json --iterations 200 --warmup 20 --concurrency 64 \
  --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load my-collaborators --json --iterations 1000 --warmup 100 --concurrency 32 \
  --limit 2000
```

## Results

### Project-Scoped Collaborator Listing

| label                                  |   ops/s |  p50 ms |  p95 ms |  p99 ms |  avg ms | failures |
| -------------------------------------- | ------: | ------: | ------: | ------: | ------: | -------: |
| `collaborators-i200-w20-c1-project`    | 115.408 |   7.519 |   9.921 |  13.238 |   7.794 |        0 |
| `collaborators-i200-w20-c8-project`    | 490.268 |  13.286 |  18.551 |  21.765 |  13.918 |        0 |
| `collaborators-i200-w20-c32-project`   | 444.299 |  55.914 | 100.810 | 106.478 |  64.552 |        0 |
| `collaborators-i200-w20-c64-project`   | 442.581 | 131.059 | 166.991 | 173.172 | 129.410 |        0 |
| `collaborators-i1000-w100-c32-project` | 367.119 |  76.926 | 124.925 | 135.211 |  79.902 |        0 |

### Account-Wide `my-collaborators`

| label                                       |   ops/s |  p50 ms |  p95 ms |  p99 ms |  avg ms | failures |
| ------------------------------------------- | ------: | ------: | ------: | ------: | ------: | -------: |
| `my-collaborators-i200-w20-c1-limit2000`    |  88.984 |   9.422 |  14.214 |  19.349 |  10.018 |        0 |
| `my-collaborators-i200-w20-c8-limit2000`    | 300.377 |  19.572 |  46.512 |  58.284 |  23.120 |        0 |
| `my-collaborators-i200-w20-c32-limit2000`   | 388.923 |  71.832 | 103.274 | 109.558 |  74.322 |        0 |
| `my-collaborators-i200-w20-c64-limit2000`   | 382.284 | 153.109 | 232.947 | 242.752 | 152.245 |        0 |
| `my-collaborators-i1000-w100-c32-limit2000` | 358.115 |  74.770 | 111.721 | 127.873 |  78.088 |        0 |

## Interpretation

- Both collaborator-heavy read paths are still stable at `0` failures on this
  local one-bay deployment.
- Project-scoped collaborator listing and account-wide `my-collaborators` have
  similar long-run c32 latency envelopes, around `128 ms` to `135 ms` `p99`.
- The project-scoped path has better single-worker throughput, while
  `my-collaborators` catches up more at higher concurrency.
- Neither path scaled meaningfully past concurrency `32` on this machine. At
  `64`, latency rose sharply while throughput stayed roughly flat.

## Phase 1 Regression Gates

These are local regression guardrails, not customer-facing SLOs.

Primary gates:

- `collaborators-i1000-w100-c32-project`
  - failures must stay at `0`
  - `p99` should stay at or below `165 ms`
  - throughput should stay at or above `325 ops/s`
- `my-collaborators-i1000-w100-c32-limit2000`
  - failures must stay at `0`
  - `p99` should stay at or below `155 ms`
  - throughput should stay at or above `320 ops/s`

Secondary saturation probes:

- `collaborators-i200-w20-c64-project`
  - failures must stay at `0`
  - `p99` should stay at or below `210 ms`
- `my-collaborators-i200-w20-c64-limit2000`
  - failures must stay at `0`
  - `p99` should stay at or below `290 ms`

As with the project-list baselines, more than about `20%` throughput loss or
more than about `30%` `p99` regression should be treated as a likely Phase 1
performance regression until explained.

## What This Still Does Not Cover

- collaborator add/remove mutation latency
- invite-based flows vs direct admin adds
- project rename under heavy collaborator fanout
- browser-tab fanout and live changefeed / projection update cost
- inter-bay replication of collaborator-visible summaries
- org-shaped collaboration patterns across many projects

Those should be added next, but this note captures the first meaningful local
baseline for collaborator-heavy control-plane reads.
