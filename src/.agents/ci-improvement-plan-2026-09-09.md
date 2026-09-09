# CI build and test improvement plan

Date: 2026-09-09. Scope: measured investigation and staged implementation.

Implementation follow-up (2026-09-09): `58f60b3a57` adds branch/PR concurrency,
shallow checkout for full plans, and a tracked-input Jest digest computed once
before installation (about 35ms locally). Planner/cache-key tests now run in
static checks. Per-attempt report retention and seven-day CI artifacts are also
implemented, with unbuffered Python build logs. Runner tests, mypy, and a real
notebook-package invocation validate local reporting behavior. Hosted timing
validation, further test lifecycle optimizations, and build deduplication remain
outstanding; sharding is now implemented locally as described below. The targets
below are not yet achieved.

The committed collaborators optimization (`5db6c45a47`) takes a different route
from the initial diagnostic: retain per-test module resets and all real policy/SQL
orchestration, but block unused storage/inter-bay transport dependencies. Its 62
tests now take 5.329s locally (5.730s randomized without cache), versus the 95.787s
baseline. All 89 collaborators/project-limit/project-usage tests pass together.
A parallel run reported a worker-exit warning; an in-band `--detectOpenHandles`
run passed and exited without reporting outstanding handles.

Bay-backup similarly retains module resets and the local archive/restore logic.
Mocking admin-alert delivery and the unused Google Compute SDK reduced its 24
tests from 37.581s to 2.373s; health-check alert dispatch gained explicit coverage.
All three bay-backup suites (38 tests), including the unchanged disposable cloud
restore tests, passed randomized with no transform cache in 4.619s. Server
TypeScript builds pass. Neither optimization deletes tests or changes production
behavior; whole-CI savings still require a hosted run.

Frontend teardown now disconnects only clients already present in Jest's module
cache, instead of loading the full application in every suite. A regression test
checks that an unused client stays unloaded, a loaded client is disconnected only
once through its two exports, and the global teardown hook still runs cleanup.
All 972 frontend suites (5,295 tests) pass locally in 196.021s. This is validation,
not a whole-suite A/B measurement: there is no matching local full-suite baseline,
and the TypeScript build overlapped part of the run. The same three-test pure
markdown-to-speech probe takes 0.814s, versus the original warm 1.990s. Frontend
lint, the TypeScript build, and the focused `--detectOpenHandles` run pass. The
full run emitted listener-count warnings but exited successfully.

The first changes are published for standard-runner validation in
[PR 513](https://github.com/sagemathinc/cocalc-ai/pull/513). Run 34403505423 built
successfully and started all three test lanes. Its separate checks job reported
`music-metadata` as unused because depcheck cannot inspect the native dynamic
import in `server/ai/chat-speech.ts`; a narrow depcheck exception fixes that
locally. Hosted before/after timings remain pending. The frontend teardown change
and depcheck exception are held for the next push so this measurement is not
cancelled by the new concurrency policy.

Server sharding is now implemented as `server-1` and `server-2` matrix lanes,
each running four Jest workers. `workspaces.py test --shard=INDEX/COUNT` requires
exactly one Jest-backed package. Retries with a usable report run all failed paths
without reapplying the shard; retries without a report keep the original shard.
Local reports are placed in shard-specific directories; CI artifact and cache
names use the distinct lane names. Unsharded local commands are unchanged.

Both actual workspace-runner invocations passed with retries disabled: shard 1
took 159.224s and shard 2 took 144.468s. The saved reports cover exactly the 469
discovered server suites, without overlap: 3,544 tests passed and the 14 existing
skips (including one skipped suite) remain. Shard 2 emitted a worker-exit warning.
Fourteen runner tests, nine planner/cache tests, mypy, and all static checks pass.
These are local validation times, not a hosted speedup claim.

The first hosted frontend lane passed 971 suites / 5,294 tests in 394.249s of
package time (before the teardown optimization). Its cache restore and post-save
steps now take about 0-1s each, versus roughly 30s each previously. The rest lane
also passed; per-package reports identify database (113.8s) and backend (69.2s) as
the largest components of its 399s test step. Those two packages account for about
46% of the remaining-package test time and provide a measured partition boundary
for a future separate lane.

The first hosted server lane eventually passed after retrying two failures
(`inter-bay/accounts-ban.test.ts` and `conat/api/workspace-chat-store.test.ts`).
Its first attempt took 745.589s of package time and the retry 23.517s; Jest itself
reported 742.472s initially. Collaborators is confirmed at 10.670s versus the
earlier 156.386s, but the whole run still took about 21 minutes. Do not claim an
overall speedup from this batch: the cache namespace was cold, the test set grew
from 465 to 469 server suites, and several other suites ran longer. The reports
preserve both attempts instead of hiding that variability. This run predates
frontend cleanup, server sharding, and build cleanup below.

Sequential workspace builds now clean selected non-static `dist` directories
and their matching `tsconfig.tsbuildinfo` files before any package builds, rather
than deleting outputs package by package after references may have built them.
Package hooks/order are unchanged, as are unselected/static outputs and the
existing parallel-mode cleanup policy. A real two-project TypeScript fixture
checks obsolete-file removal and verifies that a later dependency build reuses
the output emitted by an earlier consumer build. Sixteen runner tests and mypy
pass. A full clean hosted build remains the integration gate for this change.

## Recommendation

Keep standard GitHub-hosted runners. First remove repeated module initialization,
unnecessary checkout/cache work, and repeated compilation. Then rebalance the test
lanes. Selectively replace database-backed orchestration/policy tests with mocks,
while retaining real SQL tests for persistence, transactions, and concurrency.

Test deletion is reasonable, but removing cheap assertions is not the main
performance opportunity. There is measured avoidable work without losing tests.

Target a first milestone of roughly 15-17 minutes for full CI, then 10-12 minutes
after build and test-harness improvements. These are planning targets, not measured
results or a promise of sub-10-minute runs on standard runners.

## Evidence and limitations

- Inspected the current workflow, workspace planner/orchestrator, package build
  scripts, TypeScript solution/references, test setup, and representative slow tests.
- Downloaded raw build/server/frontend/rest job logs for
  [run 34378665764](https://github.com/sagemathinc/cocalc-ai/actions/runs/34378665764),
  the successful main run created at 16:44:59 UTC (09:44 Pacific).
- Compared job timings with two other successful September 9 main runs.
- Ran focused local benchmarks at `f8b90b0b82`. Temporary Jest transformers/configs
  under `/tmp/ci-study-*` changed source only in memory; repository tests and
  production code were not edited. No tests were deleted, disabled, or pushed.
- Local environment: Node 26.8.1, Jest 30.4.2, ts-jest 29.4.9, 16 available CPUs,
  about 63 GiB host RAM. CI uses Node 24.20.0 and pnpm 11.5.2. Local timings are
  diagnostic evidence, not directly comparable to CI elapsed time.
- An initial site-license run found a stale util build. Building util with
  `pnpm exec tsc --build` fixed module resolution; subsequent benchmarks passed.
  The first local pnpm invocation also refreshed dependencies; install time is not
  included in the reported Jest durations.
- The earlier [September 8 study](ci-optimization-study-2026-09-08.md) used a
  16-CPU/62-GiB VM. Its parallel-build and worker-count results are useful leads,
  not measurements of the standard GitHub runner. Its external raw benchmark
  directory was not available in this checkout.

GitHub documents public-repository `ubuntu-24.04` as 4 CPUs/16 GB RAM, with standard
runner use free for public repositories. Private repositories have different
limits. More matrix jobs are viable here without buying Blacksmith capacity,
although they consume concurrency, setup work, and aggregate runner time.
[Runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Where the 21 minutes go

Run 34378665764 completed in **21m34s**. Jobs started promptly: queueing is not the
primary explanation for this run.

| Job      | Wall time | Important detail                                |
| -------- | --------: | ----------------------------------------------- |
| Plan     |     1m39s | Full-history checkout alone took 92s            |
| Build    |     5m57s | `pnpm build` took 5m29s, including installation |
| Checks   |     1m54s | Parallel with build; not on critical path       |
| Server   |    13m49s | Test step 11m36s; slowest lane                  |
| Frontend |     8m04s | Test step 6m15s; Jest itself 6m08s              |
| Rest     |     8m51s | Test step 6m08s; packages run serially          |

The dependency chain is **plan -> build -> slowest test lane**. Improving checks
or frontend alone will not shorten this run until server stops dominating.

| Other successful main run                                                        |  Total | Build | Server lane |
| -------------------------------------------------------------------------------- | -----: | ----: | ----------: |
| [34319526305](https://github.com/sagemathinc/cocalc-ai/actions/runs/34319526305) | 19m51s | 6m01s |      13m00s |
| [34317145546](https://github.com/sagemathinc/cocalc-ai/actions/runs/34317145546) | 19m38s | 6m09s |      12m39s |

Thus the bottleneck is repeatable, not just one unlucky runner. These are three
successful runs, not a complete distribution of all pushes and failed runs.

### Duplicate runs

[34400256420](https://github.com/sagemathinc/cocalc-ai/actions/runs/34400256420) and
[34400256696](https://github.com/sagemathinc/cocalc-ai/actions/runs/34400256696)
both reference `7e74f0b`, `main`, event `push`, attempt 1, the same workflow ID/path,
and the same actor. Their creation times differ by one second and their check
suite IDs differ. This is not the usual push-plus-PR pair or a manual rerun.

The workflow uses `github.head_ref || github.run_id` for concurrency. On pushes,
the unique run ID makes every run a different group, so neither duplicates nor
superseded main pushes cancel each other. Use workflow + event + PR number/ref
instead. Group by SHA only if the desired policy is duplicate suppression while
still completing every older main commit. My recommendation is newest-main-wins
for this test workflow, with intentional historical runs available manually.

Run metadata does not establish why GitHub received/created two push runs. Record
safe event identifiers on future runs, without uploading entire credential-bearing
environments or payloads. Fixing concurrency contains the waste independently of
that unanswered question. Do not cancel unrelated deployment workflows.

## 1. Remove repeated module initialization

The slowest server test files in the measured CI run were:

| Suite                                              | CI seconds | Initial direction                                 |
| -------------------------------------------------- | ---------: | ------------------------------------------------- |
| `projects/collaborators.test.ts`                   |      156.4 | Already mocks DB; per-test module reload          |
| `conat/api/projects.start.test.ts`                 |       68.6 | Mocked RPC/orchestration; repeated imports        |
| `project-host/control.start.test.ts`               |       59.9 | Inspect module reload and startup fixtures        |
| `bay-backup/index.test.ts`                         |       57.1 | Mocks DB/process/storage; per-test module reload  |
| `conat/api/hosts.create.test.ts`                   |       56.0 | Narrow RPC dependencies and lifecycle             |
| `projects/create.clone.test.ts`                    |       53.8 | Narrow orchestration dependencies                 |
| `membership/allocation-analytics-fixtures.test.ts` |       46.7 | Mixed pure logic and real DB                      |
| `membership/site-licenses.test.ts`                 |       46.1 | Real DB workflows; selective fixture/mocking work |

There are 151 server test files containing `resetModules`. Matching CI's timed
passing suites to current source found 43 such files accounting for **1,212s of
summed suite elapsed time**. That is not CPU time or an additive wall-time saving:
four workers overlap, and not all reloads can be removed. It does identify a
substantial group to profile rather than blaming all slowness on PGlite.

### Collaborators experiment

All variants ran the same 62 tests in band:

| Variant                                                                                                      | Jest seconds | Result    |
| ------------------------------------------------------------------------------------------------------------ | -----------: | --------- |
| Existing `jest.resetModules()` before each test                                                              |       95.787 | 62 passed |
| Diagnostic: replace with `jest.clearAllMocks()`                                                              |        3.438 | 62 passed |
| Clear mocks and explicitly reset the two schema-ready promises; randomized seed 20260909, no transform cache |        3.519 | 62 passed |

The last experiment reset `projectCollabInviteEmailTokenSchemaReady` and
`projectAccessRequestSchemaReady` through a function injected only by the temporary
transformer. This checks more than simply letting schema initialization stay warm.
It does not prove that every transitive dependency and environment-dependent cache
is isolated correctly. One passing random seed is not sufficient validation.

Implementation: keep stable dependency mocks/imports for ordinary cases, explicitly
reset mutable fixture state, and isolate only cases that actually test cold module
initialization. Prefer a small existing lifecycle/reset boundary or an injected
schema-initialization dependency over exposing arbitrary production internals.
Keep separate coverage for initialization success, failure/retry, and concurrency.
Check mock implementations/one-shot queues, captured function references, environment
variables, pending promises, timers, and teardown, not just mock call counts.

Apply the pattern first to collaborators and bay-backup, then the slow RPC suites.
Do not mechanically replace all `resetModules` calls. Replacing it with a broad
`isolateModules` block that reloads the same tree can retain most of the cost.

## 2. Use mocks where database fidelity is not the subject

The user's original PostgreSQL integration suite, now running against WASM
PostgreSQL, remains a genuine optimization opportunity. Keep three explicit layers:

1. Pure policy/state calculations: table-driven unit tests, no database or client.
2. Service orchestration: mock repository/RPC/notification boundaries, assert the
   intended operation, arguments, routing, rejection, and retry behavior.
3. Persistence contracts: real SQL for joins, constraints, transaction rollback,
   idempotency, locks, pagination, and concurrent seat allocation.

Do not turn query tests into a mock SQL parser that duplicates production logic.
Do not globally mock `getPool` in integration tests and retain their names as if
they still exercised persistence. Keep representative end-to-end workflows to
verify that the layers compose.

### Concrete starting points

- `membership/site-licenses.test.ts`: 29 tests passed locally in 28.372s. Individual
  test durations sum to 16.240s; the balance includes imports/hooks/cleanup. A
  second instrumented run took 29.514s and measured database initialization plus
  schema synchronization at **3.499s**. These costs must not all be attributed to
  database startup. Extract affiliation/grace/role decisions into focused policy
  tests; use smaller fixtures or mock unrelated notifications/routing when those
  effects are not asserted. Retain real seat claim/revoke/release, domain ownership,
  approval, history, and cross-bay persistence cases.
- `membership/allocation-analytics-fixtures.test.ts`: pure export validation and
  deterministic generation share a file with DB replacement. Keep the replacement
  test real: it checks that non-fixture rows survive. Separating concerns allows
  the pure tests to avoid DB setup, but merely splitting the file saves little on
  a full run that still executes the integration case.
- `server/test/index.ts`: `noConat: true` avoids starting Conat, but its imports
  still load Conat setup/client modules. A database-only helper can avoid this
  dependency tree. Measure import, schema creation, test bodies, and teardown
  separately before choosing which boundary to mock.
- `database/postgres/account-collaborator-index.test.ts`: real multi-table fixture,
  joins, home-bay projection, and cleanup. Preserve query coverage. Batch fixture
  inserts and reduce repeated broad truncation where a safe transaction/fixture
  boundary exists. Pool-using code must actually share the transaction connection;
  wrapping the test in a transaction on an unrelated connection is not isolation.
- `database/postgres/schema/introspection.test.ts`: several tests independently
  fetch the same table list to check array shape, known table names, and nonempty
  strings. Consolidate into one meaningful contract test. Preserve real schema
  synchronization/idempotency tests; mocks would miss broken SQL.

### PGlite lifecycle

`initEphemeralDatabase()` synchronizes the schema; instances are module-local.
Jest isolates modules between files, so a singleton does not imply one database
for the whole worker. Explore a pristine initialized database snapshot only after
measuring startup across the lane. Each suite must get an independent clone, keyed
by PGlite version, schema/bootstrap inputs, and initialization options. Schema
migration tests must still exercise a fresh database, not only the snapshot.

An alternative experiment is native PostgreSQL with a prepared template and a
separate database per suite/worker. Benchmark it rather than assuming WASM is
faster. Preserve production-PostgreSQL coverage for locks, connections, extensions,
and behavior PGlite cannot faithfully reproduce. Neither alternative is a first
step compared with the measured import-reload waste.

The shared account fixture supplies the same password repeatedly, but its hashing
helper already caches identical passwords. Removing password hashing is therefore
not a credible large saving here without additional measurements.

## 3. Frontend setup and rendering costs

`frontend/test/setup.js` unconditionally attempts to require `webapp-client` in
`afterAll`, then disconnects it. This can initialize the full client solely to
clean up a pure utility suite that never used it.

For `chat/audio/markdown-to-speech.test.ts` (three tests): existing setup took
3.730s initially and 1.990s on a warm repeat; replacing only the teardown with a
temporary setup took 0.925s. Test bodies themselves totaled about 10ms. Cache
warmth/configuration differ, so this is evidence of overhead, not a precise
per-file saving to multiply by every frontend test.

Production approach: register cleanup when a real test client is created, or
provide opt-in client teardown for suites that use it. Retain connection cleanup;
do not simply delete it globally. Run client lifecycle/leak tests and check that
Jest exits without new open handles. Give explicitly identified pure tests a Node
environment and lightweight setup; `.ts` alone does not mean a test is DOM-free.

Other targets: receivables detail 44.5s, Cloudflare wizard 42.7s, public features
33.3s, public docs 26.8s. Mock costly editor/markdown children where the parent test
is about navigation/forms, retaining focused renderer tests and one integrated
smoke path. Use fake clocks/deferred promises for debounce/polling tests instead
of real waits. Keep user-visible interaction and accessibility assertions.

The frontend's 512MB worker recycling limit protects smaller local environments,
but may repeatedly discard warmed workers on CI. Benchmark 4 workers with 512MB,
1GB, and 2GB limits on the actual 4-CPU/16-GB runner; record restarts and peak RSS.
Do not transplant the prior 16-CPU VM's 6-8 worker settings to CI. Both packages
already use isolated-module TypeScript transformation; suggesting that as a new
optimization would not address the current setup.

## 4. Build once, without bypassing build hooks

Current build orchestration deletes package `dist` directories and serially calls
package scripts, many invoking recursive `tsc --build`. Several additionally use
`--force` or delete build-info files. Forcing a project-reference build also
rebuilds referenced projects, repeating work across package invocations.

There is already `packages/tsconfig.solution.json` and `tsc:build`; use that as a
starting point rather than inventing a second compiler scheduler. A dry-run
confirmed the existing solution resolves a build order. However, it is not proof
of a correct clean build: `sync` imports document-build while its declared
references only include util, and the dry-run orders sync before document-build.
The earlier study found this missing prerequisite too. Runtime workspace cycles
and TypeScript build prerequisites are not interchangeable graphs.

Recommended sequence:

1. Inventory pre/post-build hooks and generated outputs; make prerequisite edges
   explicit, especially document-build. Preserve intentional cycle handling.
2. Run preparation once, TypeScript solution build once, and required post-build
   asset/binary generation once. Avoid package scripts that recursively restart
   the compiler after the solution build.
3. Preserve i18n compilation, CSS copying, CDN assets, static bundling, OpenAPI
   patches, sandbox tools, CLI recipes/bin links/shebangs, and canonical skills.
   The earlier missing-CSS failures are exactly why `tsc` alone is insufficient.
4. Split static bundling from the shared TypeScript artifact when possible, so
   server tests need not wait for unrelated bundles. Keep bundle budgets gated on
   the correct bundle output. Python API docs took only about 4s in this run;
   moving them is tidy but not a major speed improvement.
5. Only then evaluate bounded parallel independent build hooks and incremental
   artifacts. The old `workspaces.py --parallel` is unsafe for this: global
   `os.chdir` and overlapping recursive compilers can race.

Build logs currently buffer Python package command announcements until the end.
Add unbuffered timestamped start/end records to get reliable per-package costs.
Frontend compilation occupies roughly a minute of this build, but package-level
numbers must be measured explicitly rather than inferred from buffered lines.

Validate clean checkout, warm no-change rebuild, modified dependency, deleted or
renamed source, and new workspace package. Compare emitted file inventories and
non-bundle JS/declarations; account for intentional build timestamps/hashes.
Test outputs must not contain stale deleted modules. Exercise CSS/i18n/static
entrypoints and run focused tests from an extracted artifact on a fresh runner.

The CLI currently rebuilds its package and compiles test output during `pnpm test`:
37s for its rest-lane command versus 16s reported by the Node test runner. Provide
an explicit build-tests/run-built-tests split for CI while keeping local `pnpm
test` self-contained. Include all required build-info/generated files if relying
on incremental artifacts; the current tar includes dist trees, not every root-level
build-info file. Do not claim this saves the whole 37 seconds.

## 5. Workflow overhead, cache keys, and lane balance

### Low-risk overhead

- Full-history checkout is unnecessary for `--full` main planning. Use a shallow
  checkout there. For PRs fetch the base/merge-base history actually needed, with
  bounded deepening and a conservative full-plan fallback when unavailable.
  Saving the observed 92s is not a universal estimate: other plan jobs took 41s.
- Jest caches already hit. Server restored 16MB, frontend 25MB, rest 27MB; pnpm
  restored about 575MB. This is not simply a cold-cache problem.
- Server cache restore step: 16:53:46-16:54:17, but the cache action starts logging
  at 16:54:15. Its transfer/extraction takes about 2s. Post-cache step takes 34s,
  but tar/save happen near its end. Similar gaps occur in the other lanes.
  Repeated `hashFiles('src/packages/**/jest.config.*', ...tsconfig.test.json)`
  after installation is a strong suspect, not yet a proven profile result.
  Compute one deterministic digest from a sorted tracked configuration file list
  before installation (including shared transform/config inputs), then reuse it.
  Do not traverse installed dependencies/generated output or hash twice per step.
  Measure this directly; potential saving is about a minute per lane, not minutes
  of cache download bandwidth.
- The pip cache key references missing `src/requirements.txt`; logs show
  `pip-Linux-py3-` with no digest. Key it to an actual pinned CI requirements file
  and Python version. This is correctness/reproducibility work, not a major win.
- Scope apt/Jupyter setup to lanes actually requiring them. Preserve backend
  filesystem/kernel integration prerequisites.

### Rebalance without multiplying worker counts

Start with two server shards, four workers per runner, retaining frontend and rest
lanes. Jest supports `--shard=1/2` and `--shard=2/2`.
[Jest sharding](https://jestjs.io/docs/cli#--shard).

Teach `workspaces.py` to forward sharding only to the intended Jest invocation.
Retry explicit failed file paths without reapplying the shard filter, or some
failures can disappear from the retry. Preserve zero-test handling and failure
exit codes. Use unique report/artifact/cache keys per shard and verify that shard
file sets are disjoint and their union equals the full suite. Start with built-in
sharding; add historical-duration balancing only if measurements show imbalance.

Halving server test work ideally saves about 5-6m in that lane, but rest then
becomes the bottleneck. With the existing build, total runtime bottoms out around
16-17m, not 10m. Extra setup adds a modest number of aggregate runner minutes;
it does not double all build/test work. Optimize CPU waste as well as wall time.

The rest lane's 6m08s test step includes database ~111s command wall time, backend
~64s, CLI ~37s, and 28 other package invocations. Once it becomes critical, split
by measured duration and setup requirements, not alphabetically. Avoid a separate
job for every tiny package: many spend more time starting pnpm/Jest than testing.
Evaluate in-band execution for small suites rather than a universal worker count.

Do not enable Python thread-level package parallelism in the existing runner:
cwd, environment, and temporary-directory handling are process-global. If a local
parallel orchestrator is added, use subprocess-local cwd/env, independent temporary
directories/ports/databases, and a shared CPU budget across child Jest processes.

## 6. Tests that need not live forever

Review by enduring contract and measured cost, not author or age. Named candidates:

| Candidate                                                       | Proposed treatment                                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/public/home/__tests__/visual-quality.test.tsx`        | Remove historical absent-class assertions and brittle exact grid/card-copy prescriptions; retain meaningful links/headings/accessibility. JSDOM CSS strings do not prove responsive layout.                       |
| `frontend/public/__tests__/overpromise.test.tsx`                | Consolidate repeated full-page renders with existing page tests or test catalog copy directly; retain deliberate capability/compliance claim guardrails. Rendering every page solely to ban wording is expensive. |
| `frontend/editors/slate/elements/blockquote-appearance.test.ts` | Consolidate implementation-string checks where palette/renderer tests cover the contract; retain actual contrast/theme behavior coverage.                                                                         |
| `database/postgres/schema/introspection.test.ts`                | Combine redundant shape/known-table assertions over the same result; keep SQL introspection and schema-update behavior.                                                                                           |

These are review candidates, not approved blanket deletions. Examples such as an
assertion that `.cocalc-public-home-path-grid` remains absent constrain historical
implementation rather than a durable product contract. Document the surviving
test for each removal. A handful of browser layout checks may be more meaningful
than many CSS-string checks, but adding a large browser suite would defeat the
performance goal.

Do not delete fresh-auth RPC inventories, dependency/build graph guards, ownership
and permission checks, billing/idempotency tests, archive traversal tests, or
failure/retry cases merely because they inspect source or use mocks. Source scans
can enforce valuable cross-cutting constraints. Avoid global test-count or
coverage-percentage targets; require a behavior-to-test explanation for removals.

## 7. Measurement and rollout

The successful server run initially failed `projects/create.start-lro.test.ts` and
`conat/api/workspace-chat-store.test.ts`; retrying just those files passed. Retry
overhead was about 12s, not the main 21-minute explanation. Still fix real-time
waits/races with deterministic signals or clocks, not only larger timeouts.

Before tuning further, persist every Jest JSON attempt, Node test-runner summaries,
package wall times, build-hook times, runner CPU/RAM, peak RSS, worker restarts,
cache hit/size/timing, and queue duration. Current `workspaces.py` cleans successful
temporary results, including results preceding a successful retry, and CI uploads
only the build artifact. Reuse `test-audit.mjs` for analysis rather than introducing
another slow test pass. Keep short-retention timing artifacts, including failures.

Recommended independently reviewable changes:

1. **Telemetry and orchestration hygiene:** reports, timestamped builds, correct
   concurrency grouping, shallow full-plan checkout, one precomputed cache digest.
2. **Server import lifecycle:** collaborators first, then bay-backup and slow RPC
   suites. Retain all assertions initially; validate repeated/random-order runs.
3. **Frontend cleanup:** avoid eager client creation in teardown, preserve explicit
   disconnect coverage, then benchmark CI memory recycling limits.
4. **Server sharding:** two shards with tested selection/retry/aggregation plumbing.
5. **Build deduplication:** complete prerequisites, single solution compilation,
   explicit hooks/artifacts; compare clean outputs before switching default CI.
6. **DB fixture/mocking pilot:** site-license policy/orchestration plus shared
   database-only setup; retain persistence contracts and measure aggregate savings.
7. **Rest balance and test retirement:** partition based on updated timings, prune
   agreed low-value cases, and only then consider database snapshots/native PG.

Stages 2 and 3 have local experimental evidence; stages 4 and 5 need CI validation.
Run A/B tests on the same pinned revision and runner class, with both cold and warm
caches. Record median and slowest runs from at least three repeats, first-attempt
pass rate, total runner minutes, and wall-clock completion. Larger samples are
needed before claiming a stable p95. Do not add the separate estimates together:
as server improves, rest/frontend/build become the critical path.

Keep full coverage on main and conservative dependency-aware PR selection.
Add `test:ci-plan` to routine checks; it currently is not in `test:checks`. Before
expanding selection, cover deleted files (direct git diff currently uses ACMR),
renames, lock/config changes, new packages, cycles, transitive consumers, generated
inputs, and an unavailable comparison base. Do not arbitrarily skip integration
tests on PRs to achieve the target. Retain a manual full/clean validation path.

## Local experiment reproduction

Baseline commands, from the appropriate package:

```sh
# server
NODE_NO_WARNINGS=1 COCALC_TEST_USE_PGLITE=1 NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  pnpm exec jest projects/collaborators.test.ts --runInBand --json --outputFile=/tmp/collaborators.json
NODE_NO_WARNINGS=1 COCALC_TEST_USE_PGLITE=1 NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  pnpm exec jest membership/site-licenses.test.ts --runInBand --json --outputFile=/tmp/site-licenses.json
# frontend
pnpm exec jest chat/audio/markdown-to-speech.test.ts --runInBand --json --outputFile=/tmp/speech.json
```

The collaborators diagnostic transformer replaced its one `jest.resetModules()`
with `jest.clearAllMocks(); require('./collaborators').__studyReset();`, and appended
an experimental export to collaborators that sets both schema-ready promises to
undefined. It then ran with `--no-cache --randomize --seed=20260909`. This describes
the experiment, not a proposed public production API.

The frontend diagnostic used the existing setup without the final `afterAll`
block, retaining other setup and mocks. The database diagnostic timed only
`await initEphemeralDatabase()` inside the existing server test helper.

Raw local results: `/tmp/ci-study-collaborators-{baseline,no-reset,isolated}.json`,
`/tmp/ci-study-site-licenses-{baseline,profile}.json`, and
`/tmp/ci-study-frontend-pure-{baseline,baseline-repeat,no-cleanup}.json`.
They are temporary, not archival; the measurements and transformations above are
recorded here so the findings do not depend on those files surviving.
