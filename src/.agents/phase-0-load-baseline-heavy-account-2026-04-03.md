# Phase 0 Load Baseline: Heavy Account, 2026-04-03

Status: local one-bay Launchpad / Lite benchmark for a heavier project-list
shape after adding about `1000` projects to the same account used in
[phase-0-load-baseline-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-2026-04-03.md).

This note exists to capture the scaling penalty of a larger account before the
Phase 1 projection rewrite. It is still a local-machine regression baseline,
not a production capacity claim.

Raw results are in
[phase-0-load-baseline-heavy-account-2026-04-03.jsonl](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-heavy-account-2026-04-03.jsonl).

## Environment

- Date: `2026-04-03T00:54:08-07:00`
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
  `up 1 day, 4:05, load average: 1.68, 2.22, 2.04`

## Dataset

- Authenticated account had `1044` visible projects.
- `load projects` used `--limit 2000`, so the result set was not truncated.
- This still does not model the `10000+` project persona, but it is much closer
  to the heavy-user shape than the earlier `39`-project baseline.

## Commands

The benchmark matrix was run from `src/` after:

```bash
eval "$(pnpm -s dev:env:hub)"
```

Commands:

```bash
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 1 --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 8 --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 32 --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 200 --warmup 20 --concurrency 64 --limit 2000
node /home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js \
  load projects --json --iterations 1000 --warmup 100 --concurrency 32 --limit 2000
```

## Results

| label                           |   ops/s |  p50 ms |  p95 ms |  p99 ms |  avg ms | failures |
| ------------------------------- | ------: | ------: | ------: | ------: | ------: | -------: |
| `projects-i200-w20-c1-l2000`    |  72.974 |  11.777 |  14.885 |  20.009 |  12.443 |        0 |
| `projects-i200-w20-c8-l2000`    | 175.176 |  39.865 |  46.931 |  54.683 |  40.016 |        0 |
| `projects-i200-w20-c32-l2000`   | 170.777 | 155.459 | 243.221 | 276.780 | 167.843 |        0 |
| `projects-i200-w20-c64-l2000`   | 169.459 | 323.077 | 468.699 | 506.040 | 330.002 |        0 |
| `projects-i1000-w100-c32-l2000` | 184.351 | 149.257 | 211.447 | 227.431 | 155.899 |        0 |

## Comparison To The Small-Account Baseline

Compared to the `39`-project baseline from
[phase-0-load-baseline-2026-04-03.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-0-load-baseline-2026-04-03.md):

| label                       | throughput ratio | p99 ratio |
| --------------------------- | ---------------: | --------: |
| `projects-i200-w20-c1-*`    |           0.237x |    4.080x |
| `projects-i200-w20-c8-*`    |           0.257x |    2.536x |
| `projects-i200-w20-c32-*`   |           0.211x |    5.941x |
| `projects-i200-w20-c64-*`   |           0.233x |    5.287x |
| `projects-i1000-w100-c32-*` |           0.226x |    4.161x |

Practical reading:

- moving from `39` visible projects to `1044` visible projects cut throughput
  to roughly `21%` to `26%` of the earlier value
- `p99` latency got about `2.5x` worse at concurrency `8`
- `p99` latency got about `4x` to `6x` worse at concurrency `32` and `64`

This is the clearest current evidence that project-list scaling is a real Phase
1 concern and that the projection rewrite is justified.

## Heavy-Account Regression Gates

These are local guardrails for future Phase 1 work on the heavy-account shape.

Primary gate:

- `projects-i1000-w100-c32-l2000`
  - failures must stay at `0`
  - `p99` should stay at or below `275 ms`
  - throughput should stay at or above `160 ops/s`

Secondary gates:

- `projects-i200-w20-c32-l2000`
  - failures must stay at `0`
  - `p99` should stay at or below `325 ms`
- `projects-i200-w20-c64-l2000`
  - failures must stay at `0`
  - `p99` should stay at or below `575 ms`

If later Phase 1 work improves these materially, the gates should be tightened
and the baseline note updated. For now they are meant to detect regressions,
not to define the final desired architecture outcome.

## What This Still Does Not Cover

- collaborator-list or collaborator-change workloads
- project rename latency
- project start / route-to-host latency
- browser-tab fanout and long-lived websocket pressure
- inter-bay replication lag
- multi-bay routing cost
- extreme `10000+` project accounts

Those should be benchmarked next, but this heavy-account baseline already
captures the current project-list scaling penalty well enough to track Phase 1
progress.
