# Private security review: CoCalc PR 558

Reviewed head: `4a1c89014ef6ae1f1a464c37ced960214478a330`

Base: `f84cf8935319aa97e2ba7a2c9cf3610d1bb96295`

This report was intentionally not posted to the public pull request.

## Findings

### P1: Admission permits are process-local but callbacks are load-balanced

`server/agents/rpc.ts` creates the permit in a module-local `Map` in the target-owner process. The recipient host later validates it through the ordinary public hub API. Every hub API process subscribes to that API subject with queue group `0`, so the callback can land in another process, where the permit does not exist. Inter-bay target-owner handlers are similarly queue-balanced.

This causes valid sends to fail nondeterministically on horizontally scaled bays. It is fail-closed, but it makes the advertised multibay path unreliable in the production topology. The integration test hides the defect by invoking `authorizeRpcAdmission` in the same module/process that created the permit.

References:

- `src/packages/server/agents/rpc.ts:126`
- `src/packages/server/agents/rpc.ts:324`
- `src/packages/server/agents/rpc.ts:407`
- `src/packages/server/conat/api/index.ts:183`
- `src/packages/conat/service/service.ts:206`
- `src/packages/server/agents/rpc.integration.test.ts:41`

Use a shared/durable permit store, or a signed short-lived capability that every target-owner process can verify statelessly. Process affinity would also work, but it must be explicit and survive the actual callback route.

### P1: Autostart admits a stale ACP security policy

The host snapshots the thread and calls `prepareChatSend` before starting a stopped project. Startup can consume nearly the whole 30-second deadline. After startup it rereads the thread, but checks only existence and `archived`; it submits the old prepared request.

Consequently, changes made during startup to `sessionMode`, model, payment source, session, working directory, executable, environment, and conversation parent are ignored. A target changed from `full-access` to `read-only` during startup still receives the incoming turn as `full-access`.

References:

- `src/packages/lite/hub/acp/agent-rpc-service.ts:87`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:102`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:120`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:151`
- `src/packages/chat/src/send.ts:66`
- `src/packages/chat/src/send.ts:124`

An isolated review probe mutated `sessionMode` to `read-only` inside `ensureRunning`. It failed with `Expected: read-only; Received: full-access`. Rebuild `prepared` from `latestThread` and `latestRows` after startup, and bind admission to the revalidated revision/config rather than merely checking that the thread still exists.

### P1: Agent credentials are not fenced to current project placement

An identity run stores agent, run, account, token hash, and timestamps, but no host ID, project placement epoch, or recovery generation. Host assignment is checked only when issuing/renewing. Every later socket authorization validates the run and collaborator access, not that the issuing host still owns the project.

After project migration, an old host or a credential stolen there can continue sending through all existing links until the ten-minute lease expires. This contradicts the PR contract that stale-host authority must fail explicitly. The unused legacy `agent_message_project_fences` table does not protect V2 RPC runs.

References:

- `src/packages/util/db-schema/agent-messaging.ts:127`
- `src/packages/server/agents/store.ts:95`
- `src/packages/server/agents/store.ts:124`
- `src/packages/server/conat/socketio/auth.ts:517`
- `src/packages/server/conat/api/project-host-token-auth.ts:122`

Bind every run to the issuing host and authoritative project placement/generation, and revalidate that binding during token authentication and renewal. Moves/restores should revoke or invalidate the old generation immediately.

### P1: Resource controls permit target disk/cost abuse and cross-tenant starvation

The only RPC rate window is keyed by source identity and is process-local. There is no pre-persistence target account, target project, link, or human-principal budget. The receiver writes the full message to chat before ACP admission, so queue or paid-usage denial does not prevent storage consumption.

At the configured 32 KiB and 60 sends/minute, one compromised approved source can persist about 1.9 MiB/minute, or 2.7 GiB/day, in the target chat even when execution admission rejects. Multiple identities multiply this. Accepted calls also spend the target execution account's model/runtime budget.

Separately, each hub process has one global 32-call semaphore and each host has one global 2,000-entry evidence cache. A user with several source identities and slow/offline targets can occupy these shared pools and reject unrelated tenants. There is no fair per-account/per-target partition.

References:

- `src/packages/conat/agents/rpc-attempts.ts:20`
- `src/packages/conat/agents/rpc-attempts.ts:76`
- `src/packages/conat/agents/rpc-attempts.ts:81`
- `src/packages/server/agents/messaging.ts:93`
- `src/packages/server/agents/messaging.ts:108`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:131`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:146`

Add target/link/account limits before chat persistence, sensible byte and execution budgets, and fair keyed admission. The approval UI should explicitly disclose that a link can start the project and consume the recipient's storage, compute, and model budget.

### P1: Six durable tables have no multibay ownership classification

All six new durable tables are absent from `TABLE_OWNERSHIP`. The repository's ownership test fails, matching the public CI failure. This is operationally significant: rehome/drain/reference validation and hard-delete cleanup cannot reason about these records, while several tables hold foreign keys to projects and identities.

Missing tables: `agent_identities`, `agent_identity_runs`, `agent_message_grants`, `agent_message_inbox`, `agent_message_project_fences`, and `agent_rpc_links`.

References:

- `src/packages/util/db-schema/agent-messaging.ts:33`
- `src/packages/util/db-schema/agent-messaging.ts:95`
- `src/packages/util/db-schema/table-ownership.ts:63`
- `src/packages/util/db-schema/table-ownership.test.ts:273`
- `src/packages/util/db-schema/table-ownership.test.ts:336`

Classify every table and add project rehome, drain, restore, and hard-delete tests before merging.

### P2: A transient ten-minute outage permanently wedges identity renewal

The lease generates one `run_id` for its lifetime and reuses it on every three-minute refresh. The database upsert refuses to update an existing run after `expires_at <= now()`. Once connectivity is unavailable for the ten-minute lease duration, all later refreshes use the same expired key and fail forever. The app server must restart to recover, and `setAgentSessionKey` can propagate the refresh failure into later turns.

References:

- `src/packages/project-host/codex/agent-identity-lease.ts:28`
- `src/packages/project-host/codex/agent-identity-lease.ts:63`
- `src/packages/project-host/codex/agent-identity-lease.ts:75`
- `src/packages/server/agents/store.ts:103`
- `src/packages/server/agents/store.ts:105`

On expiry, atomically end the old run and establish a new run ID with current host/placement authority. Preserve account-revocation semantics when doing so.

### P2: Any collaborator can permanently squat or brick a thread identity

Registration requires only collaborator access to an existing ACP thread. On uniqueness conflict it returns the preexisting identity regardless of registrant. Only `created_by` can disable it, and disabled rows retain the unique `(project_id,path,thread_id)` key. There is no enable, delete, reassignment, or project-owner recovery operation.

A malicious collaborator can register another user's thread first and optionally disable it. A benign registrant leaving the project creates the same permanent outage because all use checks continue to require that registrant's collaboration.

References:

- `src/packages/server/agents/api.ts:55`
- `src/packages/server/agents/api.ts:65`
- `src/packages/server/agents/api.ts:77`
- `src/packages/server/agents/api.ts:253`
- `src/packages/util/db-schema/agent-messaging.ts:107`

Define project-owner recovery/reassignment semantics and make registration conflicts explicit rather than silently returning another account's identity.

### P2: The durable transcript misattributes remote agent content to the target human

The incoming prompt is prepared with `accountId = envelope.account_id`, so the persisted chat row's `sender_id` is the target execution account. Trusted `agent_rpc` metadata is attached, but no frontend renderer consumes it. The visible/auditable message therefore appears authored by the target human, although its content came from a remote agent.

References:

- `src/packages/lite/hub/acp/agent-rpc-service.ts:100`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:102`
- `src/packages/lite/hub/acp/agent-rpc-service.ts:132`
- `src/packages/chat/src/send.ts:88`
- `src/packages/frontend/chat/agent-communication.tsx:191`

Keep the target account as execution/billing authority, but render and retain the authenticated source agent as message provenance. The approval copy should not describe this merely as "messages, not project access" without explaining delegated tool execution and spend.

### P2: Durable control-plane records have no retention or cardinality limits

Each app-server incarnation leaves an `agent_identity_runs` row forever, and every approval can create another `agent_rpc_links` row for the same endpoints. No production cleanup path deletes expired runs or links. Fresh auth limits who can create these records, but not how many; a single account controlling two projects can grow indexed PostgreSQL state without bound.

References:

- `src/packages/util/db-schema/agent-messaging.ts:33`
- `src/packages/util/db-schema/agent-messaging.ts:126`
- `src/packages/server/agents/rpc.ts:191`
- `src/packages/server/agents/store.ts:101`

Add uniqueness/idempotency where appropriate, per-account cardinality limits, and a tested retention job for expired/revoked rows.

## Validation

- Full `pnpm -C src build:dev`: passed.
- Existing focused Conat/server/database/lite/project-host/frontend suites: 179 distinct focused test cases passed in the final grouped runs.
- `db-schema/table-ownership.test.ts`: 2 failures, reproducing all six missing classifications.
- Review-only stale-policy probe: failed with `Expected: read-only; Received: full-access` as described above, then was deleted.
- Review worktree was clean after the probe was removed.
- GitHub still reported PR head `4a1c89014ef6ae1f1a464c37ced960214478a330` at the end of review.

## Recommendation

Do not merge this head. The opt-in/default-off gates reduce immediate exposure, but the multiprocess permit defect, stale policy admission, stale-host credential window, resource isolation gaps, and missing ownership model are foundation-level issues that should be corrected before a live pilot.
