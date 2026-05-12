# Release Security and Abuse Scoreboard

Status: started, 2026-05-11.

This scoreboard tracks concrete findings from
`release-security-abuse-audit-plan-2026-05-11.md`. Each row should converge to a
code fix, a test/smoke check, an accepted residual-risk decision, or a specific
follow-up issue.

Statuses:

- `unknown`: not audited yet.
- `blocked`: release-blocking gap or likely gap.
- `guarded`: partial protection exists, but release policy is incomplete.
- `accepted-risk`: explicitly accepted for first release.
- `done`: implemented and validated enough for release.

## Summary

| ID              | Surface                                      | Status  | Severity | Current Result                                                                                             | Next Action                                                                     |
| --------------- | -------------------------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SEC-ACP-001     | ACP Conat handler admission                  | done    | high     | Added a bounded pending-request guard before work enters the `p-limit` queue.                              | Revisit defaults after load testing.                                            |
| SEC-ACP-002     | Codex/ACP durable turn scheduling            | guarded | critical | Project-host-local admission now bounds queued, created, and running ACP jobs before normal enqueue/claim. | Replace env defaults with periodically cached membership-tier limits.           |
| SEC-ACP-003     | ACP automation scheduling                    | guarded | high     | Manual/scheduled automation runs now use the same local ACP admission helper.                              | Add membership-backed automation-specific caps if needed.                       |
| SEC-WS-001      | General hub/project-host websocket admission | unknown | critical | Not audited in this pass.                                                                                  | Inventory Conat services and socket pending-request limits.                     |
| SEC-BROWSER-001 | Browser exec/session automation              | unknown | critical | Not audited in this pass.                                                                                  | Audit QuickJS sandbox defaults and raw exec production policy.                  |
| SEC-CLI-001     | `cocalc-cli` authority classes               | unknown | high     | Not audited in this pass.                                                                                  | Classify command families by credential type and dangerous-action requirements. |
| SEC-KEY-001     | Account/project API keys                     | unknown | high     | Not audited in this pass.                                                                                  | Inventory project-key consumers and account-key scope checks.                   |
| SEC-REG-001     | Registration-token signup policy             | unknown | high     | Not audited in this pass.                                                                                  | Verify no-token behavior and add explicit public-signup setting.                |
| SEC-MASTER-001  | Master-key storage/unlock                    | unknown | high     | Not audited in this pass.                                                                                  | Inventory master-key read/storage paths and production unlock options.          |

## Findings

### SEC-ACP-001: ACP Conat Handler Pending Queue Was Unbounded

Status: `done`.

Severity: high.

Evidence:

- `src/packages/conat/ai/acp/server.ts` used `p-limit` with
  `COCALC_ACP_MAX_CONCURRENCY`, but every incoming ACP Conat message was
  submitted into the limiter without checking `limiter.pendingCount`.
- This capped concurrently running handlers, but not the number of accepted
  pending handler closures in memory.
- The affected request classes were ACP stream/evaluate, interrupt, steer, fork,
  truncate, control, and automation.

Change:

- Added `COCALC_ACP_MAX_PENDING`, defaulting to
  `4 * COCALC_ACP_MAX_CONCURRENCY`.
- Requests beyond the pending cap are rejected immediately with a cheap Conat
  response instead of being enqueued in memory.
- Stream/evaluate requests receive a normal ACP stream error payload followed by
  stream termination; request/response helpers receive `{ error }`.
- Rejections log the label, active count, pending count, configured limits, and
  subject.

Residual risk:

- This protects the ACP server process from an unbounded in-memory handler
  backlog. It does not solve durable Codex turn queue quotas; see SEC-ACP-002.
- The default pending multiplier should be tuned with load testing. A smaller
  value may be appropriate for production bays.

Validation target:

- Package typecheck for `@cocalc/conat`.
- Focused ACP client/server smoke test if one is added later; no dedicated ACP
  server overload test existed during this pass.

### SEC-ACP-002: Codex/ACP Durable Turn Queue Has No Membership-Backed Admission

Status: `guarded`.

Severity: critical.

Evidence:

- Frontend Codex chat submission calls `processAcpLLM`, then sends either
  `streamAcp` or `steerAcp` with `project_id`, prompt, session config, and chat
  metadata.
- `src/packages/lite/hub/acp/index.ts` receives chat ACP requests in
  `enqueueChatAcpTurn` and immediately calls `enqueueAcpJob(request)`.
- `src/packages/lite/hub/sqlite/acp-jobs.ts` inserts/upserts into `acp_jobs`
  with state `queued`. The only uniqueness guard is
  `UNIQUE(project_id, path, user_message_id)`.
- `claimNextQueuedAcpJobForThread` prevents more than one running job per
  `(project_id, path, thread_id)`, but it does not bound queued jobs.
- `rg` found no membership-tier, quota, 5-hour, 7-day, per-account, per-project,
  or per-thread admission check in the ACP enqueue path.
- `src/packages/conat/ai/acp/server.ts` does validate `account_id` syntax and
  derives `project_id` from the subject, but the current handler comment says
  the account id is not yet used for attribution.

Risk:

- A signed-in account can plausibly create an unbounded number of queued ACP
  turns by sending distinct chat user messages.
- A single thread is serialized at execution time, but queued rows, chat
  projections, worker wake attempts, and retry/recovery work remain resource
  consumers.
- Multi-tab or scripted clients can use many threads/projects to avoid the
  per-thread running-job serialization.

Required release behavior:

- Add a single ACP admission helper used before every durable enqueue.
- Derive actor/account/project from trusted server-side context, not from
  caller-controlled chat metadata alone.
- Enforce admin-editable membership tier limits:
  - per-account queued turns,
  - per-account running turns,
  - per-project running turns,
  - per-thread queued turns,
  - per-account 5-hour created-turn limit,
  - per-account 7-day created-turn limit,
  - per-project 5-hour/7-day worker-start or project wake budget.
- Return structured denial reasons to frontend, CLI, automation, and retry
  paths.
- Record denial events with account, project, thread, tier, effective limit,
  current usage, and source action.

Implemented first guard:

- `acp_jobs` now stores and indexes `account_id`.
- Normal chat sends, manual/scheduled automation runs, resend, recovery
  continuation creation, and worker claim go through a local ACP admission path.
- Recovery continuations bypass fresh creation quota and continue to rely on the
  existing bounded recovery retry controls.
- Default local caps are environment-configurable:
  - `COCALC_ACP_MAX_QUEUED_PER_ACCOUNT=1000`
  - `COCALC_ACP_MAX_QUEUED_PER_THREAD=100`
  - `COCALC_ACP_MAX_CREATED_5H_PER_ACCOUNT=500`
  - `COCALC_ACP_MAX_CREATED_7D_PER_ACCOUNT=2000`
  - `COCALC_ACP_MAX_RUNNING_PER_ACCOUNT=50`
  - `COCALC_ACP_MAX_RUNNING_PER_PROJECT=50`
- These defaults are intentionally broad. They prevent runaway millions-scale
  queue growth without requiring a bay-hub round trip for every project-host
  turn.

Remaining release gap:

- The guard is not yet membership-tier backed. The next step is a periodically
  refreshed project-host-local effective-limit cache, populated from bay/hub
  membership data and admin overrides, so normal turn admission stays local and
  cheap.
- Denial observability is currently structured through error text and local logs,
  not yet a central abuse/account usage feed.

Suggested implementation sequence:

1. Add ACP usage-limit fields to the membership tier model and admin override
   plumbing.
2. Add counting helpers for `acp_jobs` by account, project, thread, state, and
   created time window. If `acp_jobs` cannot reliably answer account-scoped
   questions today, store `account_id` as an indexed column.
3. Add `admitAcpTurnCreation` in the hub/lite ACP layer and call it before
   `enqueueAcpJob`.
4. Apply the helper to normal chat sends, send-immediately fallback, queued
   resend, recovery continuation creation, and automation `run_now`/scheduled
   runs.
5. Add tests proving denial before `acp_jobs` insertion.

### SEC-ACP-003: ACP Automations Share the Same Queue Without Independent Caps

Status: `guarded`.

Severity: high.

Evidence:

- `runAcpAutomationNow` builds an `AcpJobRequest`, calls `enqueueAcpJob`, writes
  queued chat projection state, then starts or kicks a worker.
- Automation records do have `pause_after_unacknowledged_runs` and
  `unacknowledged_runs`, which is useful for runaway unattended jobs, but that
  is not the same as account/project admission for job creation.
- Manual `run_now` and scheduled runs should be treated as Codex/ACP turn
  creation for rate-limit purposes.

Required release behavior:

- Count automation-created turns against the same account/project 5-hour and
  7-day limits as human-created turns.
- Add separate lower caps for unattended automation if needed.
- Deny or pause scheduled automation before writing a new queued job when the
  actor/project is over limit.
- Surface the denial in the thread automation state and operator abuse logs.

Implemented first guard:

- Manual and scheduled automation runs check ACP creation admission before
  writing their queued chat message.
- Denied automations are paused with `paused_reason=acp_admission_denied` and
  the denial message is projected back into thread automation state.
- Automation-created turns count against the same local ACP job caps as human
  turns.

Remaining release gap:

- There is not yet a distinct unattended automation cap separate from human
  Codex turns.
- Central operator observability still needs an abuse/account usage feed.

## Open Questions

- Where should hosted SaaS ACP usage accounting live long-term: `acp_jobs`,
  existing membership usage tables, or a new event ledger? ANS: I don't know. My main concern is that we e don't want to accidentally make things slow or increase load too much during the normal flow usage and checking. This acp stuff is all running on _project hosts,_ not the bay hubs, and these project hosts should be thought of as far away from the hubs (literally), and we don't want them to put too much stress on hubs. So maybe we have a slightly stale project-host level table, which gets periodically sent to the central bay it is connected to, so it can be seen by admins (and users)? Basically, I don't know the answer.
- Should "queued turns" count only pending `acp_jobs`, or also not-yet-acked
  frontend retry attempts? ANS: Not sure, but whichever is easier and puts less load on the system overall; I would rather be a little more lenient than to slow everything down a lot just checking for limits.
- What are the first production default limits per membership tier? ANS: any suggestions? free: 1; standard: 10; pro: 50. I assume this is concurrent turns. This is really meant to prevent out of control issues, abuse, etc., not severely throttle things.
- Should recovery continuation jobs consume fresh quota, or use a bounded
  retry/recovery budget attached to the original turn? ANS: original turn
- Should operator/admin Codex sessions have separate audited emergency limits? That should not be necessary.
