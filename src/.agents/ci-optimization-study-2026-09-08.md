# CI optimization study: 2026-09-08

## Result and scope

A dedicated 16-CPU AMD EPYC 7B13 VM completed checkout, an experimental clean
build, and the full local CI checks/tests in **7m41s**. No TypeScript upgrade,
removed assertions, raised test timeouts, or reduced package coverage was needed.
This is a feasibility result, not a production-ready replacement build system.
Two flaky suites passed retries; their retry time is included.

The most promising gain was eliminating repeated compilation and scheduling
independent packages concurrently. Explicit tmpfs did not improve clean-build
time over ext4 with Linux page cache in these experiments.

This PR records measurements and adds read-only saved-report analysis to the
existing test audit tool. It deliberately does **not** change CI worker defaults,
the compiler, test selection, application behavior, or the default build graph.

Benchmark environment:

- Pinned origin/main: `f115489f5130a8fd0ca53f44bf7fffd9827a2ddd` (PR #493).
- SSH alias `github-runner`; Ubuntu 24.04.4, approximately 62 GiB RAM, no swap.
- Node 24.20.0, pnpm 11.5.2, repository-pinned TypeScript.
- Python venv with ipykernel, requests, yapf, and a registered user kernelspec.
- Full CI plan: frontend, server, and 31 remaining test package groups; checks,
  depcheck, Python API/docs build, and Essential frontend bundle budgets included.
- One VM shared all lanes. Hosted Actions reference jobs used separate machines.
- No GitHub runner registration, production changes, or new cloud machines.
- VM provisioning, queueing, Actions setup, and artifact transfers are excluded.

## Measurements

These are individual observations, not statistically established speedups.
Warm dependencies and warm compiled/Jest outputs are different conditions.

| Experiment                                                         | Elapsed | Outcome                           |
| ------------------------------------------------------------------ | ------: | --------------------------------- |
| Original clean build, cold dependencies, tmpfs                     |   4m56s | Passed                            |
| Original clean build, warm dependencies, tmpfs, cross-mount copies |   4m46s | Passed                            |
| Original clean build, warm dependencies, tmpfs, verified hardlinks |   4m46s | Passed                            |
| Original clean build, warm dependencies, ext4                      |   4m45s | Passed                            |
| Experimental DAG clean build, warm dependencies, tmpfs             |   2m12s | Passed                            |
| Experimental DAG clean build, warm dependencies, ext4              |   2m11s | Passed                            |
| Baseline frontend, 4 workers / 512 MB recycle limit                |   4m55s | Includes lint and retry           |
| Tuned frontend, 8 workers / 2 GB recycle limit                     |   1m57s | Includes lint; first-pass success |
| Baseline server, 4 workers                                         |   6m30s | First-pass success                |
| Initial tuned server, 6 workers                                    |   4m34s | Additional focused retry passed   |

The final clean-output run, **05:13:54-05:21:35 UTC**, used warm dependencies
but fresh Jest caches. Its phase durations overlap:

| Phase                                | Elapsed |
| ------------------------------------ | ------: |
| Build                                |   2m11s |
| All checks/tests together            |   5m23s |
| Frontend, 6 workers / 2 GB recycling |   2m56s |
| Server, 6 workers, including retry   |   5m10s |
| Remaining packages, including retry  |   4m58s |
| Checks                               |     12s |
| Depcheck                             |   1m39s |
| Bundle budgets                       |     24s |

Checkout/setup added seven seconds, giving the observed **7m41s** total.
Frontend passed 910 suites / 4,955 tests. Server passed 457 suites / 3,338 tests,
with its existing one skipped suite / 12 skipped tests preserved.

A same-checkout **warm Jest cache** repeat, 05:43:01-05:47:51 UTC, took
**4m50s for all checks/tests**, versus 5m23s with fresh caches. Frontend took
155s, server 266s, rest 265s; all passed without retries. This does not isolate
cache savings from retry avoidance and run-to-run variance. Combining it with
the earlier build would imply roughly 7m08s, but that is **not** a measured
second end-to-end clean build.

Hosted references, with setup included in job durations:

- [GitHub run](https://github.com/sagemathinc/cocalc-ai/actions/runs/34185868762):
  total 19m02s; build 5m45s, frontend 8m10s, server 12m16s, rest 8m46s.
- [Blacksmith run](https://github.com/sagemathinc/cocalc-ai/actions/runs/34185220452):
  total 8m13s; build 2m49s, frontend 2m29s, server 3m47s, rest 4m18s.

## What worked, and what is not safe to ship yet

The experimental scheduler retained package-specific hooks but changed compiler
steps from recursive `tsc --build` to package-local `tsc --project .`, with up to
four ready packages at a time. It used project references and earlier workspace
dependencies in the existing order. An explicit document-build-before-sync edge
was necessary: the first prototype failed without it. Runtime dependency cycles
mean this heuristic is not a sufficiently validated production build graph.

The successful prototype emitted 16,456 files, matching the baseline count.
Non-static-bundle JavaScript and declarations were byte-for-byte identical.
Ten hashed static filenames changed; no other output paths were missing. Bundle
budgets and full tests passed. This is useful evidence, not proof that arbitrary
future package graph changes are safe.

Do not simply enable `workspaces.py --parallel`: it uses a thread pool with
process-wide `os.chdir`, and concurrent recursive compiler invocations can write
the same dependency outputs. A production scheduler needs subprocess-local cwd,
validated explicit edges, cycle diagnostics, and clean/incremental regression
tests. Some package scripts force dependencies to rebuild or remove build state;
those redundant operations deserve individual review.

Scheduling checks/depcheck independently from the rest lane reduced the first
tuned checks/test schedule from 6m35s to 5m23s. Increasing every worker count is
not equivalent: the VM must share CPU and memory among lanes and native workers.
Keep conservative defaults for ordinary memory-limited developer projects.

## Slow-test audit

The cold-cache eager run's slowest server file was
`server/projects/collaborators.test.ts`: 115.7s across 62 tests. It is heavily
mocked and calls `jest.resetModules()` before each test. Removing the reset is
not a safe mechanical optimization: the implementation has cached schema-ready
promises. Preserve isolation unless a targeted fixture redesign proves equivalent.
Other slow server suites included `conat/api/projects.start.test.ts` (48.2s),
`conat/api/project-backups.test.ts` (47.3s), and
`project-host/control.start.test.ts` (45.9s).

Frontend leaders were `admin/receivables/detail.test.tsx` (39.3s),
`public/features/__tests__/app.test.tsx` (25.7s),
`public/docs/__tests__/app.test.tsx` (21.9s), and
`public/auth/__tests__/app.test.tsx` (21.7s). These exercise current features;
there is no evidence from timing alone that they are obsolete.

Jest assertion durations can include per-test hooks and module imports inside
tests. Subtracting their sum from suite duration does not reliably measure
database or transformer overhead, especially with concurrent tests. Profile
specific suites before attributing their costs or removing fixtures.

Use saved reports without running any tests or deleting output directories:

```sh
pnpm -C src test:audit --report=/path/frontend-results-0.json --report=/path/server-results-0.json
```

Repeat `--report` for retry attempts too. Each stays separate; a passing retry
does not hide the original failed attempt. Missing/invalid reports fail explicitly.
Suite timing spans are not whole-job wall times or CPU utilization measurements.

## Flakes and setup corrections

- Final server run retried `inter-bay/accounts-ban.test.ts` after its existing
  five-second timeout. An earlier tuned run retried
  `conat/api/workspace-chat-store.test.ts` successfully.
- `project-host/raw-network-egress.test.ts` had a mock-call assertion failure in
  both baseline and final tuned experiments; it passed retry. Not a timeout.
- Baseline frontend `admin/receivables/detail.test.tsx` timed out and passed retry.
- Initial rest setup lacked a discoverable Python kernel; exporting VIRTUAL_ENV
  and registering the user kernelspec fixed the environment.
- Document-build tests require controlled temporary output under `/tmp`; moving
  TMPDIR from `/mnt/...` to a `/tmp` bind alias fixed that setup failure.
- Initial tuned server retry was manual, so that harness retained a nonzero
  exit status. Do not describe that experiment as an all-zero CI run.

## Storage and reproducibility

Persistent raw logs, timing files, JSON reports, and prototype scripts are in
`/home/user/ci-benchmark-20260908` on the development host and
`~/ci-bench/results` / `~/cocalc-ci-bench-*` on the benchmark VM. They are not
checked into this PR; the prototype is not a supported build command.

The executable tmpfs is capped at 24 GiB, mounted at `/mnt/ci-ram` with bind
aliases under `~/ci-bench/ram` and `/tmp/cocalc-ci-ram`. The pnpm store and checkout
must use the same mount path for hardlink imports; cross-bind-mount imports fall
back to copies even with the same backing filesystem. pnpm 11 uses
`pnpm_config_store_dir`. One repeat verified matching inodes and link counts.

The storage comparison is ext4 plus normal page cache versus explicit tmpfs,
not uncached physical disk versus RAM. Test scratch remained on tmpfs even for
the ext4 checkout; that does not rule out a benefit for database/test scratch.

## Next experiments

The measured build/check/test processes used approximately 4,585 CPU-seconds.
Dividing by 16 gives 4m47s as a rough perfect-utilization bound for unchanged work,
not an attainable prediction. Dependencies and uneven CPU demand still matter.

1. Repeat controlled warm-cache runs with a shared worker budget and record flakes
   and peak memory, rather than optimizing an isolated lane's stopwatch time.
2. Profile module re-evaluation in the slow mocked suites; retain initialization
   isolation and current-feature coverage.
3. Validate the experimental build DAG and remove redundant rebuilds safely.
4. Balance rest packages using saved timings, respecting shared resource use.
5. Compare trustworthy incremental builds separately from clean-build guarantees.

TypeScript 7 remains a possible separate migration, not a prerequisite. The
[July migration plan](typescript-7-migration-plan-2026-07-15.md) identified module
resolution, package self-import, CommonJS/ESM, and compiler-API consumer blockers.
Its historical probe is not evidence of today's compatibility. A new opt-in
compiler probe should preserve the TS6-based tooling baseline and validate fresh
outputs and runtime behavior before changing the default compiler.
