# Private agent messaging remediation review handoff

Prepared September 17, 2026. This packet requests independent re-review. It is
**not merge or production approval**. Keep findings and fixes private under
`SECURITY.md`; do not post them to public PR #558 or another public channel.

## Review target

- Private repository: `sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf`.
- Private advisory: `GHSA-rff5-g9ff-7qhf`; private PR #2.
- Remediation branch: `fix/agent-messaging-review-20260916`.
- Fixed comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Previously reviewed deficient heads:
  `d38f3399be308a92721e40fdcb56244de3d1974e` and
  `2a0ff08783cda555e772c18f17481516f6ba53c7`, with the latest rereview
  performed at `ad63f225d75a9b3fccb043e8fcaa61e3e1af9acc`.
- Current private handoff head before this documentation update: `3ffeb8d759`.
- Latest application remediation commit: `3ffeb8d759`.
- Normative contract: `src/.agents/agent-messaging-release-contract.md`, approved
  by William for review.

Confirm the private PR's exact final head SHA, repository, branch, comparison base,
and contract contents before review. The documentation commit cannot name its own
SHA; the private PR description must pin it after push. Stop if the target differs.
Public PR #558 is an earlier foundation and is not this review target.

## Contract decisions

- Human-scoped messaging authorization remains distinct from project isolation.
  Collaborators share broad authority in one project OS user and are not treated as
  mutually isolated tenants.
- Membership/configuration changes govern later admission decisions but do not
  automatically stop work already running.
- If immediate enforcement is required, the human must explicitly restart the
  project after the change. A successful restart must terminate old project-local
  execution and prevent queued/recovered work or old sessions from restoring former
  CoCalc-managed authority. Restart does not sanitize persistent project files or
  revoke unattributed local credentials such as entries the project owner retains in
  `~/.ssh/authorized_keys`. William explicitly approved this persistent-state
  behavior on September 16, 2026, and classifies failure of the CoCalc-managed
  authority boundary as P0.
- Messaging is single-attempt RPC with accepted/rejected/unknown outcomes. There is
  no outbox, automatic retry, exactly-once guarantee, federation, or response SLA.
- Transcript source rendering is honest best effort in collaborator-editable project
  storage, not a tamper-proof audit record or an authorization source.
- Conservative bounds and clear rejection are required. Perfect fairness, exact
  decoded RSS accounting, and completion of public PR #590 are not requirements.

Review against contract IDs C1-C16 and tasks D1-D3. Classify observations as a
contract violation, implementation/liveness defect, accepted residual risk, or
proposed requirement change. Do not silently substitute stricter product policy.

## Remediation map

Review the full base-to-head diff. Important fix commits after the deficient head:

| Commit       | Area                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `e3ed056286` | Reject non-binary fragments at bounded Conat receivers               |
| `e6e131fa84` | Recheck external credential expiry after asynchronous guards         |
| `ec8c6d5b4a` | Rebuild agent execution configuration after startup                  |
| `d58f268066` | Recheck native registration authority after chat lookup              |
| `b833453029` | Fence durable ACP work and project runtimes on successful stop       |
| `664cab8839` | Shared PostgreSQL admission, aggregate raw receive cap, ownership    |
| `d3acb5df63` | Lifecycle recovery, retention/cardinality, attribution, and CSRF     |
| `4590eac669` | Separate-process PostgreSQL admission regression                     |
| `10a059f943` | Runtime lifecycle fence, authenticated worker fencing, lease retry   |
| `c19bd57f3f` | Atomic authority snapshot and complete authority-mutation fencing    |
| `af3ea3d06a` | Separate restart dedupe, acknowledged stop, forced replacement start |
| `cb1b45960f` | Membership-generation restart dedupe and owner-side revision check   |
| `439417a928` | Atomic trigger install and intent-scoped restart idempotency         |
| `4b75bde488` | Preserve distinct frontend restart intents before RPC submission     |
| `3ffeb8d759` | Keep concurrent frontend restart status ordered by latest intent     |

The lifecycle remediation uses a monotonic owning-bay runtime lifecycle revision.
Stop advances it durably; starts carry it in metadata they already load; and the
project host persists it while serializing the complete per-project start/stop
operation. An older start either finishes before stop or is rejected afterward.
Restart also fences a start that has not yet changed the project state snapshot.
The latest correction reads users and the lifecycle revision in one PostgreSQL
statement, replacing the former two project-row reads with one. Restart advances
the durable revision before host lookup, including when the project has no assigned
host. Host registration, user-map updates, and managed-key updates carry the
revision and run through the same host serializer. Periodic and cross-bay user
synchronization preserve that binding. Ordinary start adds no PostgreSQL query or
host RPC; it now performs one fewer project-row query. The additional durable write
occurs only on stop/restart.

Explicit restart uses a distinct deduplication lane, a monotonic collaborator
authority revision, and a caller-generated idempotency ID for one logical restart
action. Transport retries carrying the same ID and revision share one operation.
Every primary-frontend action invocation assigns its ID before entering the RPC
workflow, so a later invocation reaches the server even while an earlier one is
pending. A later explicit restart therefore has a new ID and cannot join pre-change work, including an
execution-mode change that does not alter collaborator membership. Missing or
malformed IDs fail closed. The revision is returned by the owning bay's existing
admission query, so ordinary project start gains no query or RPC. The owning bay
rechecks the revision before restart admission; missing or stale revisions fail
closed. The database trigger increments for every distinct collaborator-map change,
including ABA changes. Routine schema synchronization replaces the trigger function
without detaching the installed trigger. First installation briefly locks project
row writers and creates the function and trigger in one transaction; failure rolls
the installation back. A restart also cannot join an older ordinary start or restore.
When a project has an assigned host, restart requires a successful routed stop
response; an unavailable host causes restart to fail rather than report an
unestablished boundary. The replacement start ignores only the pre-fence recent
state snapshot and remains bound to the newly advanced lifecycle revision.

Concurrent frontend requests retain their own RPC outcomes, but only the latest
restart UUID may update shared UI state. Older completions cannot replace the
latest token, tracked LRO, error, optimistic lifecycle state, projection repair, or
delayed reconciliation. Projection diagnostics are also request-scoped.

ACP restart fencing now selects only strict executable matches backed by live
host-owned worker registrations. New registrations include the kernel PID start
identity, fence RPCs run concurrently under one timeout window, and process
identity is checked again before signaling. Identity recovery retains and retries
the exact expired/replacement run pair after an ambiguous transport failure.

The implementation uses shared PostgreSQL admission state. Permits remain reusable
for repeated authorization until release/expiry; attachment preparations are
atomically single-use. Initial caps are 1,000 permit/preparation rows per bay, 8/4
per account, and 4/2 per destination project. Bounded subscriptions share 512 MiB
of retained raw fragments per process.

Durable creation caps under advisory locks are 10,000 identities/project, 10,000
runs/identity, 1,000 names/account, 10,000 personal grants/account, 10,000 personal
requests/account, 10,000 retained and 1,000 active external installations/account,
10,000 external identities/account, and 1,000 legacy RPC links/source. Maintenance
uses a database advisory lock and batches of 5,000 every six hours. Expired
admissions are removed immediately; terminal runs and completed/expired requests
after 30 days; revoked/expired grants, installations, links, rejected legacy inbox
rows, and orphan legacy grants after 180 days. Uncertain inbox rows, identities,
external identities, controls, and retired names are intentionally retained.

## Code map

- Restart and execution: `project-host/hub/projects.ts`,
  `project-host/hub/acp/worker-manager.ts`, `project-host/acp-worker.ts`,
  `lite/hub/acp/index.ts`, `lite/hub/sqlite/acp-{jobs,turns,queue}.ts`,
  `lite/hub/acp/agent-delivery-authorization.ts`.
- Routing/admission: `server/agents/rpc.ts`, `admission-state.ts`,
  `conat/core/{client,receive-budget}.ts`.
- Identity/lifecycle: `server/agents/{api,store,personal-store,external-store,
maintenance}.ts`, `project-host/codex/agent-identity-lease.ts`.
- Schema/ownership: `util/db-schema/agent-*.ts`, `table-ownership.ts`.
- Attribution/UI/HTTP: `chat`, `frontend/chat`, `http-api/pages/api/v2/auth/cli/agent`.

## Reproducible verification

Run `pnpm -C src install` and build package references in a fresh checkout. The
complete development build passed:

```sh
pnpm -C src build:dev
```

Focused checks used for this candidate:

```sh
pnpm -C src/packages/conat jest --runInBand core/receive-limits-network.test.ts core/receive-limits.test.ts core/receive-budget.test.ts
NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server jest --runInBand agents/rpc.integration.test.ts agents/personal-store.integration.test.ts agents/external-store.integration.test.ts agents/identity-recovery.integration.test.ts agents/maintenance.integration.test.ts
pnpm -C src/packages/lite jest --runInBand hub/acp/__tests__/acp-jobs.test.ts hub/acp/__tests__/agent-delivery-authorization.test.ts hub/acp/__tests__/agent-rpc-service.test.ts
pnpm -C src/packages/project-host jest --runInBand hub/projects.test.ts acp-worker.test.ts codex/agent-identity-lease.test.ts
pnpm -C src/packages/util jest --runInBand db-schema/table-ownership.test.ts
pnpm -C src lint:frontend
```

Additional rereview regressions:

```sh
pnpm -C src/packages/project-host jest --runInBand runtime-lifecycle.test.ts worker-manager.test.ts sqlite/projects.test.ts
COCALC_TEST_USE_PGLITE=1 NODE_OPTIONS=--experimental-vm-modules pnpm -C src/packages/server jest --runInBand project-host/control.start.test.ts projects/control/base.test.ts conat/api/hosts.test.ts
pnpm -C src/packages/lite jest --runInBand hub/acp/__tests__/acp-workers-sqlite.test.ts hub/acp/__tests__/detached-worker.test.ts
```

Latest authority-fence regression commands:

```sh
pnpm -C src/packages/project-host test hub/projects.test.ts runtime-lifecycle.test.ts --runInBand
pnpm -C src/packages/server test project-host/control.start.test.ts projects/control/base.test.ts projects/control/base.start-rootfs.test.ts conat/api/hosts.test.ts projects/create.start-lro.test.ts projects/create.clone.test.ts
```

Latest explicit-restart regression commands:

```sh
pnpm -C src/packages/server test conat/api/projects.restart.test.ts conat/api/projects.start.test.ts projects/control/base.test.ts projects/control/base.start-rootfs.test.ts project-host/control.test.ts project-host/control.start.test.ts
pnpm -C src lint:frontend
pnpm -C src build:dev
```

Latest authority-generation regression commands:

```sh
COCALC_TEST_USE_PGLITE=1 NODE_OPTIONS=--experimental-vm-modules pnpm -C src/packages/database jest --runInBand postgres/schema/sync.test.ts postgres/schema/column-invariants.test.ts postgres/schema/project-runtime-authority-revision.test.ts
pnpm -C src/packages/server test conat/api/projects.restart.test.ts conat/api/projects.start.test.ts inter-bay/project-control.start-policy.test.ts projects/runtime-sponsor-db.test.ts projects/control/base.test.ts projects/control/base.start-rootfs.test.ts project-host/control.test.ts project-host/control.start.test.ts
```

The opt-in `server/agents/admission-state.multiprocess.test.ts` requires an isolated
real PostgreSQL database named `smc_ephemeral_testing_database` and:

```sh
COCALC_AGENT_MULTIPROCESS_POSTGRES=1 COCALC_DB_SKIP_ENSURE_EXISTS=1 pnpm -C src/packages/server jest --runInBand agents/admission-state.multiprocess.test.ts
```

It launches independent Node processes. It passed cross-process permit reads and
release, and an atomic two-process race with exactly one preparation winner.

## Evidence and open verification

At application commit `3ffeb8d759`, the focused frontend project-actions suite
passed 29 tests. The overlap regressions cover newer-success/older-success,
newer-failure/older-success, and newer-success/older-failure completion orderings
and verify that the newest token, LRO, error, and optimistic status remain
authoritative. Frontend package typecheck and repository frontend lint passed. No
deployment was performed.

At application commit `4b75bde488`, the focused frontend project-actions suite
passed 27 tests, including an overlap regression that holds one restart RPC open
and proves a second action submits a distinct UUID and RPC. Frontend package
typecheck and repository frontend lint passed. No deployment was performed.

At application commit `439417a928`, eight expanded server suites passed 99 tests;
the final restart-only rerun passed six tests. Three schema suites passed 20 tests
with one PostgreSQL-only concurrency test skipped on PGlite, then all 21 tests on
an isolated PostgreSQL 18 server. The PostgreSQL test observes a concurrent
project-row writer blocked during first installation and verifies its collaborator
change advances the revision after commit; an injected trigger-creation failure
verifies transactional rollback. Database, Conat, server, frontend, CLI, and essential-frontend package
typechecks passed. Frontend lint and the complete 39-workspace development build
passed. No deployment was performed for this application commit.

At application commit `cb1b45960f`, eight expanded server suites passed 97 tests.
Three database PGlite schema suites passed 19 tests, including monotonic ABA
revision behavior and schema convergence. Conat, database, and server package
typechecks passed, and the complete 39-workspace `pnpm -C src build:dev` passed.
The focused tests cover same-revision duplicate coalescing, a held pre-change
restart followed by a separate post-change restart, missing-revision failure, and
an owning-bay stale-revision rejection before slot reservation or restart. A real
PostgreSQL rerun was attempted but the expected local test socket was unavailable;
this is an explicit remaining environment qualification, not recorded as a pass.
No deployment was performed for this application commit.

The full build and focused regressions passed after `af3ea3d06a`. Six focused
server suites passed 82 tests, and the final restart-only rerun passed 44 tests.
The tests cover separate restart deduplication, duplicate restart coalescing,
assigned-host failure, replacement-start snapshot bypass, both lifecycle race
orderings, durable revision propagation, atomic user/revision loading, hostless
restart, stale user/key/registration rejection, unregistered/fake worker
exclusion, PID-incarnation mismatch, and lost-reply lease recovery. See
`agent-messaging-release-progress.md` for counts, artifact hashes, operation IDs,
and exact residual risks. An earlier candidate also passed a live detached-worker
restart probe with an existing app-server session, a foreground 180-second turn,
and an accepted queued turn: successful restart disposed the runtime, neither old
marker appeared immediately or after the old deadline, and a new post-restart turn
completed normally. This is real dev-host evidence, not inferred from mocks, but it
is not exact-head evidence for `af3ea3d06a`.

The live probes predate `af3ea3d06a` and did not combine a separately authenticated
second human's actual membership downgrade/removal or an explicitly manufactured
recovery child. Those paths have focused authorization/recovery tests, but report
the remaining live distinction rather than treating the single probe as every D3
permutation. No dev or production deployment of `af3ea3d06a` was performed as
part of this correction.

The exact handoff head produced and deployed dev-only host build
`20260916T061335Z-c855b662e444`, SHA-256
`8d48288b3926b48e8fc0fb5a37b390b66f31e64765c61ec271346b53a29552a2`. Direct
inspection found all four managed host components aligned and healthy. Using the
exact private server control package against the dev database and that host, a
real overlapping start/stop/replacement-start preserved ordering and advanced the
durable fence from revision 2 to 3. A forced old-revision host start was then
rejected in 239 ms, and the replacement runtime executed normally. This did not
include a separately authenticated human membership mutation or pause a prepared
start before dispatch; do not inflate it into that remaining qualification.

Also unfinished: matched-fleet project movement/cross-bay qualification,
current-version external enrollment/send, and production-like load/RSS measurement.
The 512 MiB aggregate is a raw-fragment bound, not a bound on decoded object size.
The public structured-decoding work may improve this later but is not automatically
a release prerequisite.

## Requested response

First state the exact head/base/contract reviewed. Reassess every prior finding on
this head, including whether its prerequisites and severity still apply. Separate
confirmed fixes, remaining findings, accepted residual risk, inaccessible live
checks, and new issues. Do not implement fixes or publish details. Recommend merge
or release only after the declared restart boundary and remaining required live
qualification have evidence on a pinned matched candidate.
