# Private agent messaging remediation review handoff

Prepared September 16, 2026. This packet requests independent re-review. It is
**not merge or production approval**. Keep findings and fixes private under
`SECURITY.md`; do not post them to public PR #558 or another public channel.

## Review target

- Private repository: `sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf`.
- Private advisory: `GHSA-rff5-g9ff-7qhf`; private PR #1.
- Remediation branch: `fix/agent-messaging-review-20260916`.
- Fixed comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Previously reviewed deficient head:
  `d38f3399be308a92721e40fdcb56244de3d1974e`.
- Application/test checkpoint before this documentation update: `4590eac669`.
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
  authority. William classifies failure of this boundary as P0.
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

| Commit       | Area                                                              |
| ------------ | ----------------------------------------------------------------- |
| `e3ed056286` | Reject non-binary fragments at bounded Conat receivers            |
| `e6e131fa84` | Recheck external credential expiry after asynchronous guards      |
| `ec8c6d5b4a` | Rebuild agent execution configuration after startup               |
| `d58f268066` | Recheck native registration authority after chat lookup           |
| `b833453029` | Fence durable ACP work and project runtimes on successful stop    |
| `664cab8839` | Shared PostgreSQL admission, aggregate raw receive cap, ownership |
| `d3acb5df63` | Lifecycle recovery, retention/cardinality, attribution, and CSRF  |
| `4590eac669` | Separate-process PostgreSQL admission regression                  |

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

The opt-in `server/agents/admission-state.multiprocess.test.ts` requires an isolated
real PostgreSQL database named `smc_ephemeral_testing_database` and:

```sh
COCALC_AGENT_MULTIPROCESS_POSTGRES=1 COCALC_DB_SKIP_ENSURE_EXISTS=1 pnpm -C src/packages/server jest --runInBand agents/admission-state.multiprocess.test.ts
```

It launches independent Node processes. It passed cross-process permit reads and
release, and an atomic two-process race with exactly one preparation winner.

## Evidence and open verification

The full build and focused regressions passed. See
`agent-messaging-release-progress.md` for counts and exact residual risks. In
particular, focused restart tests pass, but a final-candidate live detached-worker
test combining a real session/turn, queued and recovery work, permission downgrade,
successful stop/start, and proof of no post-restart execution remains unfinished.
Do not infer that result from mocked project-host tests.

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
