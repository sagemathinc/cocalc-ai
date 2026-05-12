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

| ID              | Surface                                      | Status  | Severity | Current Result                                                                                                                                                                                                                                                                                                                                                                           | Next Action                                                                                                          |
| --------------- | -------------------------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SEC-ACP-001     | ACP Conat handler admission                  | done    | high     | Added a bounded pending-request guard before work enters the `p-limit` queue.                                                                                                                                                                                                                                                                                                            | Revisit defaults after load testing.                                                                                 |
| SEC-ACP-002     | Codex/ACP durable turn scheduling            | guarded | critical | Project-host-local admission now bounds queued, created, and running ACP jobs before normal enqueue/claim. Project-host now overlays cached project-owner membership/admin limits, records central denial events, and exposes an admin/CLI denial report.                                                                                                                                | Add actor-account limit cache if collaborator caps must differ from owner caps.                                      |
| SEC-ACP-003     | ACP automation scheduling                    | guarded | high     | Manual/scheduled automation runs now use the same local ACP admission helper.                                                                                                                                                                                                                                                                                                            | Add membership-backed automation-specific caps if needed.                                                            |
| SEC-WS-001      | General hub/project-host websocket admission | guarded | critical | First pass found unbounded hub Conat API dispatch, generic parallel Conat services, raw project-host stream/socket services, app proxy websockets, and raw Conat socket events; these now fast-fail above conservative active-request/message caps.                                                                                                                                      | Tune per-identity limits and production alert thresholds from telemetry.                                             |
| SEC-BROWSER-001 | Browser exec/session automation              | guarded | critical | Browser-session async exec history was bounded, but active raw/QuickJS exec and typed action work per browser tab was not. Local per-tab caps now fast-fail excess work, `browser_raw_exec_policy` gates raw JS by admin setting, and the browser-session service now exposes a local allow/deny audit stream for raw exec, async exec, typed actions, and QuickJS sandbox host actions. | Continue QuickJS host-capability review and decide whether browser automation audit events need central persistence. |
| SEC-CLI-001     | `cocalc-cli` authority classes               | guarded | high     | First-pass authority matrix completed. CLI auth config and daemon runtime storage now force private local permissions; ambient env auth can be disabled per invocation.                                                                                                                                                                                                                  | Audit endpoint-level freshness/2FA and API-key scope enforcement for dangerous CLI command families.                 |
| SEC-KEY-001     | Account/project API keys                     | guarded | high     | First-pass audit completed. Legacy project-scoped CoCalc API-key creation/editing and authentication are disabled; existing project keys remain listable/deletable for cleanup. Account API keys remain broad account credentials.                                                                                                                                                       | Propagate auth method through hub dispatch and add scoped account-key capabilities/project allowlists.               |
| SEC-REG-001     | Registration-token signup policy             | unknown | high     | Not audited in this pass.                                                                                                                                                                                                                                                                                                                                                                | Verify no-token behavior and add explicit public-signup setting.                                                     |
| SEC-MASTER-001  | Master-key storage/unlock                    | unknown | high     | Not audited in this pass.                                                                                                                                                                                                                                                                                                                                                                | Inventory master-key read/storage paths and production unlock options.                                               |

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
- ACP turn caps are now first-class `usage_limits` in membership tiers and
  account entitlement overrides:
  - `acp_max_queued_per_account`
  - `acp_max_queued_per_thread`
  - `acp_max_created_5h_per_account`
  - `acp_max_created_7d_per_account`
  - `acp_max_running_per_account`
  - `acp_max_running_per_project`
- Project-host installs a local ACP admission limit provider backed by the
  existing host-only `getProjectOwnerEffectiveLimits` cache. Lite keeps the env
  defaults; hosted project-host overlays project-owner membership/admin limits
  when the bay/hub cache is available.
- ACP admission denials now go through a non-blocking telemetry hook. Hosted
  project-host records them via a host-authenticated hub RPC into `central_log`
  as `acp_admission_denied`, including account, project, thread, limit, current
  usage, effective maximum, source action, and event time.
- Admins can query repeated recent denials via
  `system.getAcpAdmissionDenialReport` or `cocalc admin acp-denials`. The CLI
  also supports `--prometheus` for command-based monitoring integrations.

Remaining release gap:

- Running/queued per-account admission currently uses the project-owner effective
  limit cache on project-host. If collaborator actors need distinct caps, add an
  actor-account effective-limit cache keyed by `account_id`.
- Denial observability is now centralized and queryable, but there is not yet an
  in-product abuse dashboard or automatic alerting on repeated denials.

Suggested implementation sequence:

1. Add an actor-account effective-limit cache if collaborator account limits
   need to differ from project-owner limits.
2. Add an in-product abuse dashboard or automatic alerting for repeated ACP
   admission denials if CLI/Prometheus monitoring is not sufficient.
3. Add per-project 5-hour/7-day worker-start or project wake budget if load
   testing shows running caps are not sufficient.

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

### SEC-WS-001: Hub/Service Conat Dispatch Had Unbounded Parallel Handlers

Status: `guarded`.

Severity: critical.

Evidence:

- `src/packages/server/conat/api/index.ts` subscribes to `hub.*.*.api` and
  intentionally starts `handleApiRequest` without awaiting it. This is the main
  browser-reachable hub RPC surface, so reconnect storms or scripted clients
  could create an unbounded number of active server-side API handlers.
- `src/packages/conat/service/service.ts` supports
  `createConatService({ parallel: true })`, but the parallel path only tracked
  active handler promises and did not bound them.
- `src/packages/server/inter-bay/service.ts` starts many inter-bay handlers with
  `parallel: true`, including account directory, project control, host control,
  and registration-token paths.
- Typed fast-RPC services in `src/packages/conat/service/typed.ts` bypass the
  legacy request transport and therefore needed an explicit active-handler cap
  as well.
- Project-host raw services also had unbounded concurrent work:
  - `src/packages/project/exec-stream.ts` started every execute-stream request
    concurrently.
  - `src/packages/conat/files/read.ts` and
    `src/packages/conat/files/write.ts` started every file stream request
    concurrently.
  - `src/packages/conat/project/jupyter/run-code.ts` accepted unlimited active
    sockets and concurrent notebook runs.
  - `src/packages/conat/project/terminal/index.ts` accepted unlimited active
    sockets and persisted terminal sessions.

Implemented first guard:

- Hub Conat API dispatch now caps active requests with
  `COCALC_HUB_CONAT_API_MAX_ACTIVE`, default `200`. Requests above the cap are
  rejected immediately with a 503-style error instead of being started.
- Generic parallel Conat services now cap active handlers with
  `COCALC_CONAT_SERVICE_MAX_PARALLEL_ACTIVE`, default `128`, and immediately
  return a 503-style busy error above the cap.
- Typed fast-RPC service handlers use the same
  `COCALC_CONAT_SERVICE_MAX_PARALLEL_ACTIVE` default unless a service passes an
  explicit `maxParallelHandlers`.
- Raw project-host service caps now fast-fail above:
  - `COCALC_PROJECT_EXEC_STREAM_MAX_ACTIVE`, default `16`.
  - `COCALC_PROJECT_FILE_READ_MAX_ACTIVE`, default `16`.
  - `COCALC_PROJECT_FILE_WRITE_MAX_ACTIVE`, default `8`.
  - `COCALC_JUPYTER_MAX_ACTIVE_RUNS`, default `8`.
  - `COCALC_JUPYTER_MAX_ACTIVE_SOCKETS`, default `64`.
  - `COCALC_TERMINAL_MAX_ACTIVE_SOCKETS`, default `64`.
  - `COCALC_TERMINAL_MAX_SESSIONS`, default `32`.
- App-server websocket proxying now has local active websocket caps:
  - `COCALC_APP_PROXY_MAX_ACTIVE_WEBSOCKETS_PER_TARGET`, default `64`.
  - `COCALC_APP_PROXY_MAX_ACTIVE_WEBSOCKETS_TOTAL`, default `256`.
- Raw Conat/socket.io protocol events now have sliding-window admission guards
  before publish/RPC/subscription handler work:
  - `COCALC_CONAT_MAX_INBOUND_EVENTS_PER_SOCKET_WINDOW`, default `2000`.
  - `COCALC_CONAT_MAX_INBOUND_EVENTS_PER_IDENTITY_WINDOW`, default `10000`.
  - `COCALC_CONAT_INBOUND_EVENT_WINDOW_MS`, default `10000`.
  - `COCALC_CONAT_INBOUND_EVENT_BLOCK_MS`, default `10000`.
  - Denials return normal 429-style responses for acked events. Per-socket
    denials increment `inbound-deny:count`; per-account/project/hub identity
    denials increment `inbound-identity-deny:count` in Conat usage metrics.
- Busy/admission guard denials now also record centralized
  `service_admission_denied` telemetry in `central_log` for:
  - Hub Conat API active-request cap.
  - Generic Conat service and typed fast-RPC handler caps.
  - Raw Conat/socket.io protocol message caps.
  - Project exec-stream, file read/write, Jupyter, terminal, and app-proxy
    websocket caps.
  - Admins can query grouped events with `system.getServiceAdmissionDenialReport`
    or `cocalc admin service-denials`; `--prometheus` emits command-scrapeable
    metrics.

Residual risk:

- This pass now bounds active handler count and high-rate raw Conat socket
  messages both per connection and per authenticated identity across multiple
  simultaneous sockets. These are local process budgets, not global
  cross-cluster budgets.
- Defaults are intentionally broad and should be tuned with production load
  testing and observability.

Suggested next audit steps:

1. Decide whether any Conat protocol budgets need cross-cluster aggregation
   after production telemetry is available.
2. Add dashboards/alerts once production baselines for
   `service_admission_denied` are known.

### SEC-BROWSER-001: Browser Exec/Session Automation Needs Per-Tab Admission and Policy Audit

Status: `guarded`.

Severity: critical.

Evidence:

- `src/packages/frontend/conat/browser-session/index.ts` publishes a
  per-account/per-browser Conat `browser-session` service that can list/open
  files, read workspace selection, run typed browser actions, and execute
  browser-side JavaScript.
- `exec` runs synchronously; `startExec` stores async operation records with
  `MAX_EXEC_OPS`, `MAX_EXEC_CODE_LENGTH`, and a 24-hour operation TTL.
- Before this pass, `MAX_EXEC_OPS` bounded retained async history only. It did
  not bound concurrently running `exec`/`startExec` work. A scripted caller
  could submit many raw-JS or QuickJS executions to one browser tab and make the
  tab itself the unbounded worker.
- Typed actions are safer than raw JS but still mutate the live browser session
  and can wait, navigate, type, click, reload, and run batches. They also needed
  a local active-work cap.

Implemented first guard:

- Browser session automation now has local per-tab active admission:
  - `MAX_ACTIVE_EXEC_OPS=2` for synchronous `exec` plus async `startExec`
    executions.
  - `MAX_ACTIVE_ACTIONS=8` for typed actions, including actions invoked from
    the QuickJS sandbox API.
- `startExec` claims an execution slot before creating an async operation. If
  the tab is already saturated, the request fails immediately instead of
  creating queued browser-side work.
- Admission counters reset when the browser-session service stops or switches
  account identity, so stale operations cannot leave a tab permanently busy.
- Raw browser JavaScript is now gated by the admin site setting
  `browser_raw_exec_policy`:
  - `disabled`: always use the QuickJS typed-action sandbox. This is the
    default.
  - `admin_only`: allow raw JS only for admin accounts when the caller requests
    raw JS.
  - `enabled`: honor caller posture/policy requests for raw JS.
- Caller-controlled `posture=dev` and `policy.allow_raw_exec` can request raw
  JS, but they can no longer override the deployment-level admin setting.
- Browser-session automation now records a local per-tab allow/deny audit
  stream for:
  - synchronous `exec`
  - async `start_exec`
  - typed `action`
  - QuickJS `sandbox_action` host calls
- `cocalc browser audit list` and `cocalc browser audit clear` expose that
  stream from the CLI.
- `cocalc browser exec-api` now prints the effective raw-exec policy and local
  active-work caps for the targeted session before the declaration.

Residual risk:

- This is a local browser-tab stability guard, not a full authorization policy.
- The audit still needs to classify browser-session access by credential type:
  ordinary account sessions, project-scoped agent auth, explicit
  `browser_session` agent scope, and spawned Playwright sessions.
- The QuickJS sandbox and typed action API still need continued review, since
  disabling raw JS shifts non-admin automation into that path.
- The browser automation audit stream is intentionally local and in-memory. It
  is useful for incident review of the currently targeted browser session, but
  it is not yet a central immutable audit log.

Suggested next audit steps:

1. Review the QuickJS typed-action sandbox for data exfiltration and UI
   mutation risks under non-admin credentials.
2. Decide whether browser automation audit events should also be forwarded to a
   central hub/project-host log for production incident response.
3. Audit session spawn/list/use behavior under account auth versus agent auth
   beyond the existing agent-auth explicit-target protections.

### SEC-CLI-001: cocalc-cli Authority Classes Needed First-Pass Audit

Status: `guarded`.

Severity: high.

Evidence:

- `src/packages/cli/src/bin/main.ts` accepts several credential classes:
  browser-approved cookies, account API keys, bearer/agent tokens,
  project-scoped secrets, and hub passwords.
- Command modules span ordinary account actions, project-local code/file
  execution, browser automation, admin/site operations, host operations, load
  tests, and local daemon acceleration.
- The CLI forwards `auth_session_hash` to hub calls when available, but command
  modules do not centrally declare which operations are dangerous or freshness
  requiring. Release safety therefore depends on endpoint-level policy checks.
- The auth profile config can store cookies, account API keys, bearer tokens,
  and hub passwords. Before this pass, saves did not force private file modes.
- The CLI daemon caches authenticated contexts and accepts project file actions
  over a Unix socket. Before this pass, its runtime directory/socket/pid file
  permissions were not explicitly tightened by the CLI.

Implemented first guard:

- Added `src/.agents/cli-authority-audit-2026-05-12.md`, a first-pass matrix
  classifying command families by credential class, intended authority, and
  dangerous-action risk.
- `saveAuthConfig` now creates the auth config directory with `0700` and forces
  the config file to `0600` on every save.
- The CLI daemon now creates its runtime directory with `0700` and forces the
  daemon socket and pid file to `0600`.
- Added `--disable-env-auth-defaults` so callers can intentionally ignore
  ambient `COCALC_*` auth variables for one invocation.

Residual risk:

- This pass classifies CLI authority and fixes local secret/daemon storage. It
  does not prove that every dangerous hub/project-host endpoint enforces
  freshness/2FA.
- Account API keys are still a broad dependency for many command families; see
  `SEC-KEY-001`.
- Hub-password account bootstrap and `admin user issue-auth-token` should have
  central audit coverage if not already logged server-side.

Suggested next audit steps:

1. Continue `SEC-KEY-001` follow-up: propagate auth method and block broad
   account API keys from dangerous command families.
2. Inventory endpoint-level dangerous-action checks for account deletion/rehome,
   project hard delete/restore/public app exposure, rootfs admin mutation, host
   mutation, membership assignment, org token lifecycle, and CLI-issued auth
   tokens.
3. Consider central audit events for hub-password account bootstrap, admin auth
   token issuance, and CLI browser/session automation.

### SEC-KEY-001: Account and Project API Key Scope Audit

Status: `guarded`.

Severity: high.

Evidence:

- User-managed v2 CoCalc API keys used one table for account-wide keys and
  legacy project-scoped keys.
- Legacy project-scoped CoCalc API keys authenticated directly as
  `{project_id}`, which meant generic API-key auth helpers and bridge/proxy
  paths had to handle account and project principals together.
- Account API keys still authenticate as broad account credentials with no
  capability list or allowed-project list.

Implemented first guard:

- Added `src/.agents/api-key-scope-audit-2026-05-12.md`.
- Project-scoped CoCalc API-key creation and editing now fail server-side.
- Project-scoped CoCalc API-key authentication now fails; API-key auth returns
  account principals only.
- Cluster account API-key directory fallback now requires explicit
  `scope="account"` metadata, so legacy mirrored project-key directory entries
  fail closed.
- Existing project-scoped CoCalc API keys remain listable and deletable from
  project settings for cleanup, but the UI no longer offers create/edit actions.
- The HTTP Conat project bridge now requires an account API key plus explicit
  `project_id`, then applies normal collaborator authorization.

Residual risk:

- Account API keys remain broad account credentials.
- Hub Conat API dispatch does not yet propagate whether an account principal
  came from a browser cookie, account API key, or agent bearer token into
  endpoint transforms. That blocks a central "no API keys for dangerous
  endpoints" policy until auth method is carried through dispatch.
- The `api_keys.project_id` column remains until the scoped account-key schema
  migration removes legacy project keys.
- Legacy account-key directory entries without `scope="account"` may need a
  home-bay key use or resync before they work as cross-bay account keys.

Suggested next audit steps:

1. Propagate auth method through hub dispatch.
2. Reject account API-key auth on dangerous account, billing, admin, host, and
   secret-management endpoints until scoped capabilities exist.
3. Add `capabilities` and `allowed_project_ids` to account API keys and the
   cluster account API-key directory.
