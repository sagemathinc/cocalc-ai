# Agent messaging controlled release progress

Updated September 16, 2026. Status: **private remediation candidate; not approved
for merge or production**. No production deployment or production flag change has
been performed.

## Pinned source

- Private advisory repository: `sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf`.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Independently reviewed deficient head: `d38f3399be308a92721e40fdcb56244de3d1974e`.
- Remediation branch: `fix/agent-messaging-review-20260916`.
- Application and test checkpoint before this documentation update:
  `4590eac669`.
- Latest rereview remediation commit: `10a059f943`.
- Normative requirements: `agent-messaging-release-contract.md`, approved for
  review. William's successful-project-restart boundary remains release blocking.

The final documentation commit cannot contain its own SHA. The private PR must pin
the exact final branch head after push. A reviewer must confirm that SHA, this base,
and private repository before relying on this packet.

## Confirmed remediation

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

## Unresolved risks and unfinished work

- Independent re-review of the private remediation head is required. This work is
  not self-certified secure or releasable.
- Live qualification must deliberately overlap a stale start with a real
  second-human downgrade/removal and the subsequent successful restart on the
  matched `10a059f943` build. The earlier sequential restart evidence predates
  this correction and is not proof of the repaired race.
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
