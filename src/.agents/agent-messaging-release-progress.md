# Agent messaging controlled release progress

Updated September 17, 2026. Status: **private remediation candidate; not approved
for merge or production**. No production deployment or production flag change has
been performed.

## Pinned source

- Private advisory repository: `sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf`.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Independently reviewed deficient head: `d38f3399be308a92721e40fdcb56244de3d1974e`.
- Remediation branch: `fix/agent-messaging-review-20260916`.
- Application and test checkpoint before this documentation update:
  `4590eac669`.
- Latest independently reviewed head: `ad63f225d7`.
- Latest application remediation commit: `3ffeb8d759`.
- Current private reviewer/deployment handoff before this documentation update:
  `3ffeb8d759`.
- Normative requirements: `agent-messaging-release-contract.md`, approved for
  review. William's successful-project-restart boundary remains release blocking.

The final documentation commit cannot contain its own SHA. The private PR must pin
the exact final branch head after push. A reviewer must confirm that SHA, this base,
and private repository before relying on this packet.

## Confirmed remediation

- Routine schema synchronization no longer drops the collaborator-authority
  trigger. It atomically replaces the attached function. First installation briefly
  blocks project-row writers and creates the function and trigger in one transaction;
  an error rolls back both, so no committed trigger-free interval is exposed.
- Every logical restart action now carries a required idempotency UUID. Transport
  retries of that action coalesce under the same UUID. Each primary-frontend action
  invocation assigns a new UUID before entering its RPC workflow, so a later
  explicit restart cannot be absorbed while an earlier frontend action remains
  pending. A later explicit restart cannot join an earlier restart even
  when collaborator membership is unchanged, so execution-mode changes receive a
  new host stop boundary. Missing or malformed IDs fail closed, and all first-party
  frontend, essential-frontend, CLI, development, and course callers supply them.
- Concurrent primary-frontend restart calls preserve independent RPC outcomes, but
  only the latest action UUID may update shared UI status. Older completions cannot
  replace the latest token, tracked LRO, error, optimistic lifecycle state,
  projection repair, or delayed reconciliation. Projection diagnostic identifiers
  include the action UUID.
- Project collaborator-map changes now advance a monotonic authority revision in
  PostgreSQL. Explicit restarts coalesce only when that revision is unchanged, so
  a restart requested after a committed removal or downgrade cannot join an active
  pre-change restart. The owning bay rechecks the revision before restart admission,
  and missing or stale revisions fail closed. The admission response carries the
  revision in its existing project-row query, so normal project start adds no query
  or RPC. The trigger covers ABA collaborator changes.
- Explicit restarts no longer share the ordinary `project-start` deduplication
  lane. Retries carrying one logical action UUID still coalesce, but separate action
  invocations remain distinct. A restart
  cannot be swallowed by an active start or restore. Assigned-host restarts now
  require the host to acknowledge the stop fence and fail honestly if routing or
  host contact fails. The replacement start ignores a stale pre-fence running or
  starting snapshot and uses the new lifecycle revision. Ordinary start behavior
  and cost are unchanged.
- The contract now limits the restart guarantee to CoCalc-managed authority.
  Persistent project content and unattributed project-local credentials remain
  shared owner-controlled state. Collaborator removal/downgrade UI says that
  restart does not sanitize this state and links directly to
  `~/.ssh/authorized_keys` for review. William explicitly approved project-local
  SSH keys surviving restart on September 16, 2026.

- Project users and their lifecycle revision are now read in one PostgreSQL
  statement. Restart advances the durable revision before host lookup, including
  hostless/pre-placement projects. Registration, user-map synchronization, and
  managed-key synchronization carry that revision and share the host lifecycle
  serializer, so delayed older authority cannot cross a successful restart.
  Ordinary start now performs one project-row query instead of two.

- Project stop now advances a durable owning-bay runtime lifecycle revision.
  Starts carry the revision in existing metadata and the project host serializes
  complete start/stop operations. A stale start cannot cross a successful stop,
  and restart fences in-flight starts even before they report `starting`. Ordinary
  start gains no PostgreSQL query or host RPC; only stop/restart adds a durable
  write.
- Restart fencing accepts only executable-conformant ACP workers with matching
  host-owned registrations. Current registrations bind PID to kernel start
  identity, all worker fence calls share one concurrent timeout window, and PID
  identity is rechecked before termination.
- Ambiguous identity recovery retains and retries the exact old/new run pair, so a
  reply lost after commit does not wedge the worker. The review handoff now names
  private PR #2 correctly.

- Bounded Conat receivers reject non-binary fragments before accounting or
  retention. Real loopback transport tests cover forged structured bodies,
  malformed MsgPack, fragment floods, abandoned fragments, overflow, and recovery.
- Native execution configuration is reconstructed from the current thread after
  startup. External expiry and native registration authority are rechecked after
  awaited operations.
- Project stop must converge before the project-host fences durable ACP jobs, turn
  leases, and queued payloads. The detached worker disposes project runtimes; a
  worker that does not acknowledge the fence is terminated. Recovery children do
  not resume a restart-fenced job. Current membership, principal, connection,
  placement, and thread configuration are checked before queued RPC execution.
- RPC permits and single-use attachment preparations are in PostgreSQL rather than
  process-local maps. Permits are reusable until explicit release/expiry;
  preparations are atomically consumed once. A real PostgreSQL test launches
  separate Node processes and verifies cross-process visibility and one winner.
- All messaging tables are in the ownership manifest. Account-home, project-owner,
  and bay-local records are distinguished explicitly.
- Shared admission limits are enforced under a PostgreSQL advisory lock across hub
  processes: 1,000 permits and 1,000 preparations per bay; 8/4 per account; 4/2 per
  destination project. Bounded Conat subscriptions also share a 512 MiB raw-fragment
  cap per process. This is an interim raw-byte bound, not an exact decoded-RSS claim;
  the broader structured-decoding work in public PR #590 is separate.
- Durable creation caps are 10,000 identities/project, 10,000 runs/identity,
  1,000 names/account, 10,000 personal grants/account, 10,000 personal
  requests/account, 10,000 retained and 1,000 active external
  installations/account, 10,000 external identities/account, and 1,000 legacy RPC
  links/source. Maintenance is serialized per database, runs every six hours in
  batches of 5,000, removes
  expired admissions immediately, terminal runs/requests after 30 days, and
  revoked/expired grants, installations, links, rejected inbox rows, and orphan
  legacy grants after 180 days. It preserves uncertain inbox work, identity rows,
  controls, retired names, and external identities.
- Expired native leases recover only with a fresh run ID and current issuance
  authority; explicit termination is not revived. Project owners can replace an
  abandoned/disabled native identity with a new UUID without transferring personal
  names or grants.
- Remote transcript messages render an authenticated source-agent badge separately
  from the target execution principal. This is honest best-effort attribution in
  collaborator-editable project storage, not a tamper-proof audit record.
- Cookie-backed external approval and revocation mutations enforce same-origin /
  Fetch Metadata checks in addition to their existing authentication requirements.

## Verification completed

- At `3ffeb8d759`, the focused frontend project-actions suite passed 29 tests. The
  overlap regressions cover all material older/newer success and failure orderings
  and assert that only the newest intent controls shared restart status. Frontend
  package typecheck and repository frontend lint passed. No deployment was
  performed.
- At `4b75bde488`, the focused frontend project-actions suite passed 27 tests. Its
  overlap regression holds the first restart RPC unresolved, invokes restart again,
  and verifies two RPCs with distinct request UUIDs. Frontend package typecheck and
  repository frontend lint passed. No deployment was performed.
- At `439417a928`, eight expanded server suites passed 99 tests, followed by a
  six-test restart-only rerun. Three schema suites passed 20 tests plus one skipped
  PostgreSQL-only concurrency case on PGlite, and all 21 tests on an isolated
  PostgreSQL 18 server. The real PostgreSQL checks cover a blocked concurrent
  project-row writer making a collaborator change and rollback after injected
  trigger-creation failure.
  Database, Conat, server, frontend, CLI, and essential-frontend package typechecks
  passed. Frontend lint and the full 39-workspace build passed. The temporary
  PostgreSQL server was stopped, and no deployment was performed.
- At `cb1b45960f`, eight expanded server suites passed 97 tests. Three database
  PGlite schema suites passed 19 tests, including monotonic ABA collaborator
  revisions and schema convergence. Conat, database, and server package typechecks
  passed, and the full 39-workspace `pnpm -C src build:dev` passed. A real
  PostgreSQL schema rerun could not start because the expected local PostgreSQL
  test socket was absent; it is not claimed as passed. No deployment was performed
  for this checkpoint.
- At `af3ea3d06a`, six focused server suites passed 82 tests; the final four-suite
  restart regression rerun passed 44 tests. Server and frontend package
  typechecks passed, frontend lint reported zero findings, and the complete
  39-workspace `pnpm -C src build:dev` passed. Coverage includes separate restart
  deduplication, duplicate restart coalescing, unavailable assigned-host failure,
  hostless restart, and replacement-start snapshot bypass. No deployment was
  performed for this checkpoint.

- At `c19bd57f3f`, the full 39-workspace `pnpm -C src build:dev` passed. Focused
  authority-fence checks passed 62 project-host tests and 186 server tests. They
  cover the atomic startup snapshot, stale registration/user/key rejection,
  hostless restart, local and cross-bay revision propagation, and clone
  registration. No deployment was performed for this checkpoint.

- `pnpm -C src build:dev` passed after `10a059f943` across all 39 workspaces.
- Rereview remediation checks passed: Lite 5 suites/119 tests, project-host 6
  suites/116 tests, server lifecycle 3 suites/155 tests, server messaging 5
  suites/82 tests, and ownership 1 suite/6 tests. Frontend lint passed. Three
  Conat suites reported 27 passing tests but retained a pre-existing open handle;
  the runner was terminated instead of recording its non-exit as a clean command.

- Full `pnpm -C src build:dev` passed at application checkpoint `d3acb5df63` plus
  the subsequently added test-only commit `4590eac669`.
- Server agent and kill-switch suites: 13 suites, 173 tests passed.
- Focused restart checks: Lite 34 tests, server PGlite 23 tests, project-host 59
  tests passed.
- Conat focused checks: 4 suites, 72 tests passed, including real loopback transport.
- Database schema/ownership checks: 3 suites, 15 tests passed; messaging fixtures
  also passed on PostgreSQL.
- Separate-process PostgreSQL admission: 2 tests passed using independent Node
  processes and an isolated PostgreSQL 18 cluster.
- Identity recovery, maintenance, lease recovery, same-origin HTTP, dangerous RPC,
  and package typechecks passed. Frontend lint passed with zero findings.
- Dev-only project-host build `20260916T023414Z-fc9ca3baea3a` was produced from
  clean private head `fc9ca3baea3a3224cf0923e2a73af646e6ba4df2` (83,925,496
  bytes, SHA-256 `806c276cdf4a6ae49fd37ffa7d6d0572c91143ad01c876fc1f45bb2341025f2c`).
  QA host `b96028c9-7d3e-4953-a8c9-52f8a5ce52ca` promoted it with project-host,
  router, persist, and ACP worker aligned and healthy.
- A live detached-worker restart probe ran in receiver project
  `66db94af-0745-4088-b922-879c58942201`. Before restart, a running turn had a
  visible foreground `sleep 180`, a second turn was accepted behind it, and neither
  old durable marker existed. Restart operation
  `4e95ab3b-0b1c-4bcb-9004-732a58f372b7` succeeded. The worker logged runtime
  disposal; immediately after restart and after the original 180-second deadline,
  both old markers and the old process remained absent. A newly accepted control
  turn created only `restart-fence-new-fc9ca3ba` with `new-authority-work`.
- Exact private head `c855b662e444` produced dev-only project-host build
  `20260916T061335Z-c855b662e444` (83,645,580 bytes, SHA-256
  `8d48288b3926b48e8fc0fb5a37b390b66f31e64765c61ec271346b53a29552a2`).
  The QA host upgrade watcher timed out with unknown status for operation
  `f7e8b966-c3e6-4e15-b65e-b503969dfe9a`; it was not retried. Direct deployment
  inspection proved the artifact was promoted healthy and project-host, router,
  persist, and ACP worker were all running and aligned on the exact build.
- The private schema loader converged the additive dev schema, including
  `projects.runtime_lifecycle_revision`. The long-running lite1b hub workers still
  load the older main-worktree server code, so subsequent qualification invoked
  the exact private server control package directly against the dev database and
  upgraded real host. This is deliberate mixed-version qualification, not a claim
  that the full dev hub fleet is on the candidate.
- On receiver project `66db94af-0745-4088-b922-879c58942201`, a cold direct
  stop/start advanced the lifecycle revision to 1; stop took 3,123 ms and start
  took 71,691 ms. The control change adds no start query or host RPC, but this
  observed cold-start duration remains a performance datapoint rather than a
  comparative benchmark.
- A real overlapping start/stop/replacement-start completed in 12,983 ms. The old
  start completed before the serialized stop; stop advanced revision 2 to 3 in
  7,113 ms; and the replacement start completed in 5,769 ms. A direct host request
  then forced revision 2 after revision 3 and was rejected as stale in 239 ms. A
  post-fence project exec returned `restart-fence-c855b662e4`.

## Unresolved risks and unfinished work

- Independent re-review of the private remediation head is required. This work is
  not self-certified secure or releasable.
- Independent re-review must assess `3ffeb8d759`, including the out-of-order
  frontend completion finding reported against `ad63f225d7`. Live
  qualification must then deliberately overlap a stale restart with a real
  second-human downgrade/removal or execution-mode change and the subsequent
  successful restart on a matched build. Earlier live evidence predates this
  correction and is not proof of the repaired races.
- Persistent project-local SSH keys and other owner-retained credentials are an
  explicitly accepted product-policy residual risk, not part of the
  CoCalc-managed-account revocation guarantee. The removal/downgrade flow must keep
  disclosing the need to audit or restore persistent project state when a former
  collaborator is not trusted.
- The exact-head direct-control probe exercises serialized ordering and post-fence
  rejection on the real QA host, but it does not pause a prepared start before
  host dispatch or perform the membership mutation through a separately
  authenticated second human. Deterministic tests cover the former; the combined
  human-boundary scenario remains for independent qualification.
- The exact candidate passed a live detached-worker/session/running/queued restart
  probe. A real second-human membership downgrade/removal and a deliberately
  manufactured recovery child were not combined into that live probe. Their
  authorization/recovery logic has focused regression coverage, but the remaining
  distinction must stay visible to the reviewer.
- Final matched-fleet movement/cross-bay qualification, current-version external
  enrollment/send, and production-like load measurement remain unfinished.
- The 512 MiB bound accounts retained raw binary fragments. Structured decode
  amplification and exact process RSS remain residual risks tracked separately;
  no claim of perfect fairness or exact memory accounting is made.
- UI remains intentionally rough. The experimental account opt-in is default-off,
  and all site gates are default-off. UI polish is not a release-security claim.

## External blockers

- Fresh approval is required for any new external installation or expired native
  connection used in final live qualification. Existing revoked credentials must
  not be revived or copied between bays.
- Production rollout and production flag activation require explicit maintainer
  approval after independent re-review and final qualification.

See `agent-messaging-review-handoff.md` for the reviewer request and
`agent-messaging-operator-handoff.md` for controls and deployment ordering.
