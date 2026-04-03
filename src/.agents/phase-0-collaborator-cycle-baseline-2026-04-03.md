# Phase 0 Collaborator Cycle Baseline: 2026-04-03

Status: local one-bay Launchpad / Lite baseline for repeated collaborator
mutation cycles.

This note records the first mutation-side benchmark added to the `cocalc load`
harness. It is intentionally narrow: each sample removes a collaborator from a
project and then directly adds the same collaborator back, restoring state
before the next sample.

Raw results are in
[phase-0-collaborator-cycle-baseline-2026-04-03.jsonl](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-collaborator-cycle-baseline-2026-04-03.jsonl).

Related baselines:

- [phase-0-load-baseline-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-2026-04-03.md)
- [phase-0-load-baseline-heavy-account-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-heavy-account-2026-04-03.md)
- [phase-0-collaborator-load-baseline-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-collaborator-load-baseline-2026-04-03.md)

## Environment

- Date: `2026-04-03T07:05:37-07:00`
- Repo: `/home/wstein/build/cocalc-lite4`
- API: `http://localhost:13004`
- CLI:
  `/home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js`
- Deployment mode: one-bay local Launchpad on the developer laptop
- Browser session id: `pJSNEKrR3u`
- Benchmark project id: `808a3597-997e-47c1-b026-563bd42b34cd`
- Seed prefix: `phase0-collab-bench-20260403`
- Hostname: `lite`
- Kernel: `Linux 6.17.0-20-generic x86_64 GNU/Linux`
- CPU threads visible via `nproc`: `8`
- Memory at benchmark time: about `18 GiB` available

## Fixture Shape

This benchmark reuses the collaborator-heavy fixture from
[phase-0-collaborator-load-baseline-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-collaborator-load-baseline-2026-04-03.md):

- one project with `500` synthetic collaborators added via
  `cocalc load seed users`
- deterministic account pool using the prefix
  `phase0-collab-bench-20260403`
- cycle runs use the first `32` or `64` accounts from that pool depending on
  the benchmark

Important design detail:

- worker `n` always cycles the same seeded account
- each sample does:
  1. remove collaborator
  2. direct admin add collaborator
- final state is restored after every sample

This makes the mutation workload repeatable at concurrency without workers
fighting over the same account.

## Commands

```bash
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborator-cycle --json \
  --project 808a3597-997e-47c1-b026-563bd42b34cd \
  --prefix phase0-collab-bench-20260403 \
  --count 32 --iterations 200 --warmup 20 --concurrency 1

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborator-cycle --json \
  --project 808a3597-997e-47c1-b026-563bd42b34cd \
  --prefix phase0-collab-bench-20260403 \
  --count 32 --iterations 200 --warmup 20 --concurrency 8

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborator-cycle --json \
  --project 808a3597-997e-47c1-b026-563bd42b34cd \
  --prefix phase0-collab-bench-20260403 \
  --count 64 --iterations 200 --warmup 20 --concurrency 32

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborator-cycle --json \
  --project 808a3597-997e-47c1-b026-563bd42b34cd \
  --prefix phase0-collab-bench-20260403 \
  --count 64 --iterations 200 --warmup 20 --concurrency 64

node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load collaborator-cycle --json \
  --project 808a3597-997e-47c1-b026-563bd42b34cd \
  --prefix phase0-collab-bench-20260403 \
  --count 64 --iterations 1000 --warmup 100 --concurrency 32
```

## Results

| label                                   |  ops/s |   p50 ms |   p95 ms |   p99 ms |   avg ms | failures |
| --------------------------------------- | -----: | -------: | -------: | -------: | -------: | -------: |
| `collaborator-cycle-i200-w20-c1-n32`    | 17.655 |   46.126 |   82.410 |  101.417 |   50.849 |        0 |
| `collaborator-cycle-i200-w20-c8-n32`    | 26.079 |  271.963 |  324.014 |  344.435 |  274.450 |        0 |
| `collaborator-cycle-i200-w20-c32-n64`   | 25.212 | 1152.323 | 1270.122 | 1358.383 | 1145.848 |        0 |
| `collaborator-cycle-i200-w20-c64-n64`   | 24.452 | 2248.555 | 2550.367 | 2796.433 | 2226.522 |        0 |
| `collaborator-cycle-i1000-w100-c32-n64` | 27.105 | 1050.041 | 1216.510 | 1499.361 | 1069.184 |        0 |

## Interpretation

- The cycle workload is stable at `0` failures even under sustained c32 and c64
  mutation pressure.
- Throughput barely improves beyond c8. This is a strong sign that the write
  path is bottlenecked on serialized or database-bound work, not on client-side
  parallelism.
- Latency rises sharply with concurrency:
  - c1 `p99`: about `101 ms`
  - c8 `p99`: about `344 ms`
  - c32 long-run `p99`: about `1499 ms`
  - c64 `p99`: about `2796 ms`

This makes mutation-side collaborator management one of the more expensive
control-plane paths measured so far.

## Phase 1 Regression Gates

These are local guardrails for the current combined remove-plus-direct-add
mutation path.

Primary gate:

- `collaborator-cycle-i1000-w100-c32-n64`
  - failures must stay at `0`
  - `p99` should stay at or below `1800 ms`
  - throughput should stay at or above `24 ops/s`

Secondary gates:

- `collaborator-cycle-i200-w20-c8-n32`
  - failures must stay at `0`
  - `p99` should stay at or below `425 ms`
- `collaborator-cycle-i200-w20-c64-n64`
  - failures must stay at `0`
  - `p99` should stay at or below `3200 ms`

As with the read baselines, more than about `20%` throughput loss or more than
about `30%` `p99` regression should be treated as a likely Phase 1 performance
regression until explained.

## What This Does Not Cover Yet

- isolated remove-only latency
- isolated direct-add latency
- invite-based collaborator mutations
- changefeed / projection lag after collaborator mutation
- browser-visible end-to-end latency from mutation to updated lists
- cross-bay collaborator mutation once inter-bay routing exists

Those should be measured later. For Phase 0, this note gives us a practical and
repeatable mutation baseline that restores state after every sample.
