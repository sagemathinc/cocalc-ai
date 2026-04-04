Phase 2 projection-backed read benchmark on local Launchpad, recorded on 2026-04-04.

Environment:
- local hub daemon on `http://127.0.0.1:13004`
- one-bay local deployment on a developer laptop
- per-case hub restart after updating `.local/hub-daemon.env`
- startup log checked for the effective projection-backed read mode
- benchmark CLI run from this branch's built CLI

Method:
- for each benchmark family, set only the relevant guarded mode to `off`, `prefer`, or `only`
- leave the other two guarded read modes at `off`
- restart the hub
- confirm the effective mode in the hub startup log
- run a 500-iteration load test with 50 warmup iterations and concurrency 16

Commands:
- `load projects --json --iterations 500 --warmup 50 --concurrency 16 --limit 2000`
- `load my-collaborators --json --iterations 500 --warmup 50 --concurrency 16 --limit 2000`
- `load mentions --json --iterations 500 --warmup 50 --concurrency 16 --limit 500`

Fixture state before the benchmark:
- rebuilt `account_project_index` for the active account
- rebuilt `account_collaborator_index` for the active account
- rebuilt `account_notification_index` for the active account
- all three projection status commands reported zero backlog before measurement

Headline results:
- project-list reads improved meaningfully with projection-backed membership:
  - `off`: `136.317 ops/s`, `p95 129.382 ms`, `p99 137.479 ms`
  - `prefer`: `149.113 ops/s`, `p95 104.079 ms`, `p99 190.107 ms`
  - `only`: `176.899 ops/s`, `p95 99.008 ms`, `p99 127.446 ms`
- collaborator-list reads also improved:
  - `off`: `364.644 ops/s`, `p95 64.429 ms`, `p99 92.276 ms`
  - `prefer`: `423.586 ops/s`, `p95 51.654 ms`, `p99 59.645 ms`
  - `only`: `412.356 ops/s`, `p95 54.740 ms`, `p99 60.012 ms`
- mentions reads are not ready for `prefer`:
  - `off`: `969.805 ops/s`, `p95 28.475 ms`, `p99 33.137 ms`, `0` failures
  - `prefer`: `767.761 ops/s`, `p95 22.949 ms`, `p99 24.529 ms`, `500` failures
  - `only`: `1009.327 ops/s`, `p95 22.492 ms`, `p99 29.135 ms`, `0` failures

Correctness checks:
- project-list cardinality matched across all three modes in this benchmark:
  - `project_count: 1047`
- collaborator-list cardinality matched across all three modes:
  - `collaborator_count: 506`
- collaborator shared-project counts did not match:
  - legacy `off` reported `first_shared_projects: 4`
  - projection-backed `prefer` and `only` reported `first_shared_projects: 3`
- mentions cardinality did not match:
  - legacy `off` reported `mention_count: 3`
  - projection-backed `only` reported `mention_count: 1`
- mentions `prefer` failed on every sample with:
  - `postgresql error: syntax error at or near "$"`

Interpretation:
- `account_project_index` looks promising enough for continued guarded use and further read-path cutover work
- `account_collaborator_index` is also promising on latency/throughput, but the shared-project count mismatch means it should not be treated as semantically identical yet
- `account_notification_index` is not ready for broad guarded rollout:
  - `prefer` has a real SQL bug
  - `only` returns a different count than the legacy path for this account

Recommended next steps:
- fix the `mentions` `prefer` SQL bug first
- audit the semantic mismatch between legacy and projected mention counts
- audit the collaborator shared-project count mismatch before enabling collaborator reads more broadly
- after those fixes, rerun this exact benchmark matrix and compare against this file
