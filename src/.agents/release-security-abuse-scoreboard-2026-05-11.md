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

Current score after the 2026-05-17 SEC-SCAN rootfs-trust narrowing:

- `done`: 7 findings.
- `guarded`: 7 findings.
- `blocked`: 0 findings.

## Summary

| ID              | Surface                                      | Status  | Severity | Current Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Next Action                                                                                                                                                                               |
| --------------- | -------------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-ACP-001     | ACP Conat handler admission                  | done    | high     | Added a bounded pending-request guard before work enters the `p-limit` queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Revisit defaults after load testing.                                                                                                                                                      |
| SEC-ACP-002     | Codex/ACP durable turn scheduling            | guarded | critical | Project-host-local admission now bounds queued, created, and running ACP jobs before normal enqueue/claim. Project-host now overlays cached project-owner membership/admin limits, records central denial events, and exposes an admin/CLI denial report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Add actor-account limit cache if collaborator caps must differ from owner caps.                                                                                                           |
| SEC-ACP-003     | ACP automation scheduling                    | guarded | high     | Manual/scheduled automation runs now use the same local ACP admission helper, count against ACP turn caps, and are also bounded by `acp_max_active_automations_per_project`. Denied automations are paused and surfaced in thread automation state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Add broader abuse/account usage reporting if central ACP denial telemetry and CLI reporting are not sufficient.                                                                           |
| SEC-WS-001      | General hub/project-host websocket admission | done    | critical | Websocket/Conat admission now has admin-configurable limits for hub API dispatch, generic/typed Conat service handlers, Conat websocket connection caps, raw Conat socket event windows, app-proxy websockets, and project exec streams. Denials and throttled near-limit events are centrally recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Revisit default values after production telemetry and add dashboards if central-log reporting is not enough.                                                                              |
| SEC-BROWSER-001 | Browser exec/session automation              | done    | critical | Browser-session async exec history was bounded, but active raw/QuickJS exec and typed action work per browser tab was not. Local per-tab caps now fast-fail excess work, `browser_raw_exec_policy` gates raw JS by admin setting, the browser-session service exposes a local allow/deny audit stream, and high-risk raw-exec/async/QuickJS-denial events are centrally persisted with metadata-only values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Continue QuickJS typed-action capability review as normal hardening; no known launch-blocking browser automation audit gap remains.                                                       |
| SEC-CLI-001     | `cocalc-cli` authority classes               | done    | high     | First-pass authority matrix completed. CLI auth config and daemon runtime storage now force private local permissions; ambient env auth can be disabled per invocation. Second-pass dangerous-operation audit completed in `src/.agents/cli-api-key-dangerous-operation-audit-2026-05-14.md`; CLI freshness transport exists via forwarded `auth_session_hash` and `cocalc auth elevate`. Fresh-auth implementation now gates account delete/rehome/drain/repair, admin membership/entitlement mutation, organization create/member/admin mutation, host delete/deprovision, host RootFS mutation, host SSH authorized-key mutation, RootFS catalog/release admin mutation, project hard delete, project move/rehome, backup delete/restore, and snapshot delete/restore with the shared dangerous-session helper. Host SSH authorized-key operations now route to authoritative host bays; project move checks freshness on the caller bay before inter-bay forwarding. Legacy `auth_tokens` and org token CLI/API surfaces were removed. A dangerous-RPC decision registry plus static regression test now requires new destructive/admin-looking hub RPC exports to declare a fresh-auth decision. | Add central audit events for hub-password account bootstrap and CLI browser/session automation if product launch telemetry needs them.                                                    |
| SEC-KEY-001     | Account/project API keys                     | done    | high     | Legacy project-scoped CoCalc API-key management, auth, schema, UI, and project-rehome portability were removed. Account API keys now require explicit capabilities and project allowlists; API-key websocket hub RPC fails closed and HTTP Conat bridges deny unreviewed RPCs by default. Second-pass dangerous-operation audit found no API-key path that can directly call dangerous hub/admin/project metadata RPCs. Central audit events now cover account API-key create, delete, successful local/directory use, invalid/expired/mismatched auth denial, HTTP Conat policy denial, and websocket subject/collaborator denial without logging raw key material.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Propagate auth method through websocket hub dispatch only if API-key hub RPC support is intentionally expanded. Expand reviewed API-key capabilities only for concrete product workflows. |
| SEC-REG-001     | Registration-token signup policy             | done    | high     | Public signup without a registration token is explicit opt-in via `public_signup_without_registration_token`, default `no`. Deleting/disabling all tokens blocks signup, failed token attempts are throttled, and the admin page shows the effective policy. Signup no longer signs in existing accounts, accepts signup tags, accepts signup reason, or returns account-specific errors before token validation. Normal token rows are encrypted for admin redisplay; bootstrap-admin token rows are hash-only, hidden from admin token listing, and deleted after successful use. Focused PGlite regression coverage now verifies encrypted normal tokens, hash-only hidden bootstrap-admin tokens, and opportunistic legacy plaintext protection.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Watch token-table size; current table-scan lookup is accepted for the expected small admin-managed token set. SSO signup policy is tracked under `SEC-SSO-001`.                           |
| SEC-SSO-001     | SSO signup/sign-in policy                    | guarded | high     | Shared account-creation policy now covers password signup and legacy Passport SSO account creation. Public SSO creation on token-gated sites no longer bypasses registration tokens; admin-configured exclusive/domain SSO can act as the signup gate for matching domains. SSO-created accounts require verified/trusted email before creation and before marking the email verified. Google is now the only built-in public SSO provider; Facebook, GitHub, and Twitter implementations/dependencies were removed. Public sign-in now queries domain SSO policy from the email field. Google SSO client configuration is now admin-managed with encrypted secret storage, optional domain restriction/routing, explicit account-creation mode, and direct OIDC runtime validation. First-class `sso_providers` and `sso_domain_policies` tables/admin UI now exist. Enabled `sso_required` policies feed sign-in routing/runtime metadata, domain `signup_mode` is enforced for password and SSO account creation, and domain `require_cocalc_2fa` blocks password/SSO sign-in unless a CoCalc second factor is active and verified.                                                                | Treat remaining non-Google organization Passport paths and SAML/OIDC admin UI polish as deferred unless a launch customer requires them.                                                  |
| SEC-ROOTFS-001  | Root filesystem count/storage quotas         | guarded | critical | Rootfs creation/storage is now guarded by membership-tier caps for active count, total storage, per-rootfs storage, and arbitrary remote OCI-image usage. Denials are logged as `rootfs_quota_denied`, admins can report top users/near-limit accounts via cluster-aggregated `cocalc admin rootfs-quotas` output with per-row `bay_id`, clone creation validates the actual current RootFS state before copying files, and account deletion retires owned RootFS catalog entries before marking the account deleted. A follow-up edge audit covered durable RootFS save/publish/select/delete/account-deletion behavior and added regression coverage for replacement growth, deleted-entry reuse, and metadata-only updates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Add user-facing current-usage display if needed for launch; decide whether exact concurrent create/publish serialization is warranted beyond current admission checks.                    |
| SEC-SCAN-001    | Official RootFS vulnerability trust scanning | guarded | high     | Narrowed to an admin-only launch trust control for official/shared RootFS images. Existing RootFS release/catalog data already has scan placeholders; the first product goal is to show vulnerability scan status in the RootFS image list and project settings, preserve scanner/tool/timestamp/findings/admin-exception metadata, and block ordinary users from selecting official images with unresolved critical vulnerabilities. Trivy is still the likely first scanner, but the implementation should validate that choice against credible free alternatives before standardizing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Design the RootFS-only scan pipeline and UI policy: admin-triggered scans, release-tied immutable results, exception notes, selection blocking for critical findings, and SOC-2 evidence. |
| SEC-MASTER-001  | Master-key storage/unlock                    | guarded | high     | Secret-settings encryption and project-backup repo password encryption now derive purpose-specific keys from one local `site-master-key`; the raw site key is not used directly for AES-GCM payload encryption. Local admin CLI lifecycle commands can initialize, status-check, passphrase-export, restore, doctor-check, and offline-migrate the single key. Legacy `server-settings-key` and `backup-master-key` files are read only as migration fallbacks. Production bay systemd units load `/etc/cocalc/site-master-key` through `LoadCredential=` and set `COCALC_REQUIRE_SITE_MASTER_KEY=1`, so startup fails closed instead of creating a fresh key on a production bay. CLI smoke validation covered isolated init, encrypted export, restore to a clean data dir, checksum match, file permissions, files-only doctor, and fail-closed required-key behavior. Production runbook exists at `docs/security/site-master-key-production-runbook.md`.                                                                                                                                                                                                                                         | Smoke-test the production runbook on one disposable production-like VM or bay instance. Later consider KMS/TPM envelope unseal.                                                           |
| SEC-START-001   | Simultaneous running project admission       | done    | critical | Sponsored runtime slots are implemented. Runtime admission uses `max_sponsored_running_projects`, durable `project_runtime_slots`, runtime sponsors, inter-bay sponsor-home admission, start/restart enforcement, autostart policy, collaborator-start controls, central slot event logs, admin reporting, and `cocalc project runtime-slots`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Deeper course/team dashboards and bulk classroom operations are follow-up product polish, not a release-security blocker.                                                                 |
| SEC-DEP-001     | Dependency advisory reconciliation           | guarded | critical | Local remediation removed `sanitize-html` from npm dependencies and replaced reachable frontend/server sanitization with explicit allowlist sanitizers plus advisory regression tests. `pnpm audit` now reports no known vulnerabilities. Python `uv.lock` now resolves only patched `urllib3`, `pytest`, `requests`, and `Pygments` versions after dropping Python 3.9 support for the unreleased `cocalc-api` package; the previous open Dependabot alerts were caused by vulnerable Python 3.9 lock branches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | After push/merge, verify GitHub Dependabot open alerts close or document any remaining non-production/unreachable residual alerts by manifest and path.                                   |

## Big-Picture Remaining Launch Priorities

This scoreboard now has no known release-blocking item, but the highest-value
remaining work is not all equal.

To reduce the chance of being compromised at launch:

1. Keep external authority surfaces narrow: browser cookies, CLI auth, account
   API keys, SSO, project-host bootstrap tokens, and admin/bay credentials
   should all have explicit capability boundaries and audit trails.
2. Preserve fresh-auth requirements for destructive/admin operations and add a
   regression guard so new dangerous RPCs cannot silently ship as ordinary
   `authFirst` methods.
3. Treat production secret material as an operational release gate: site master
   key runbook smoke test, off-host encrypted backup, fail-closed startup, and
   backup restore validation.
4. Keep dependency and supply-chain checks explicit across npm and Python
   manifests, with every remaining alert fixed or documented by reachability.
5. Keep central audit events for high-risk credential paths, especially API-key
   create/delete/use/deny and metadata-only browser automation raw-exec and
   denial events.

To reduce intentional or accidental abuse at launch:

1. Make resource admission tunable at runtime by admins, not only environment
   variables: websocket/Conat active handlers, raw protocol message rates,
   app-proxy websockets, ACP queues, browser automation, runtime slots, and
   rootfs quotas.
2. Turn denials into operator signals: central logs, admin/CLI reports,
   near-limit reports, and alert thresholds for repeated denials by account,
   project, host, browser session, API key, and IP/identity.
3. Keep expensive work behind cheap admission checks: project starts, Codex/ACP
   turns, automations, rootfs import/publish/grow, archive/delete/backup
   operations, file streams, terminal/exec streams, and browser automation.
4. Give users safe self-service recovery paths when admission blocks them: stop
   sponsored projects, change runtime sponsor, archive projects, clean up
   storage, and understand which quota was hit.
5. Add official RootFS vulnerability scanning as a trust signal and release
   gate for shared images; keep broad user-project scanning as future scope
   unless a concrete SOC-2 or operations requirement demands it.
6. Run launch with conservative defaults and short feedback loops; then relax
   limits from telemetry instead of discovering runaway behavior after the
   fact.

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

Status: `done`.

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
- `acp_max_active_automations_per_project` is now a first-class membership
  usage limit and entitlement override.
- Enabling scheduled automations is admitted against the active automation cap
  for the project, and denials are recorded through the ACP admission denial
  path.
- Existing unattended-run protection remains in place via
  `pause_after_unacknowledged_runs`.

Remaining release gap:

- Central ACP denial telemetry and the CLI/admin denial report exist, but there
  is not yet a broader in-product abuse/account usage dashboard.

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
  - `COCALC_CONAT_MAX_INBOUND_EVENTS_PER_SOCKET_WINDOW`, default `10000`.
  - `COCALC_CONAT_MAX_INBOUND_EVENTS_PER_IDENTITY_WINDOW`, default `50000`.
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

- This pass now bounds active handler count, websocket counts, and high-rate raw
  Conat socket messages both per connection and per authenticated identity
  across multiple simultaneous sockets. These are local process budgets, not
  global cross-cluster budgets.
- Admin settings now cover hub API dispatch, generic/typed service handler
  concurrency, Conat total/per-user/per-hub-user websocket counts, Conat
  inbound event windows/block times, app-proxy websocket totals/per-target caps,
  project exec-stream concurrency, near-limit threshold percent, and near-limit
  log interval.
- Denials record `service_admission_denied` central-log events; near-limit
  crossings record throttled `service_admission_near_limit` central-log events.
- Defaults are intentionally broad and should be tuned with production load
  testing and observability.

Suggested next audit steps:

1. Decide whether any Conat protocol budgets need cross-cluster aggregation
   after production telemetry is available.
2. Add dashboards/alerts if central-log reports for `service_admission_denied`
   and `service_admission_near_limit` are not operationally visible enough.

### SEC-BROWSER-001: Browser Exec/Session Automation Needs Per-Tab Admission and Policy Audit

Status: `done`.

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
- High-risk browser automation audit events are also forwarded to `central_log`
  with metadata-only values:
  - raw JavaScript execution allowed
  - raw JavaScript execution denied
  - async browser execution denied
  - QuickJS sandbox host-action denied
- The central audit normalizer intentionally drops script/code text, action
  payloads, full page URLs, DOM content, and screenshots. It keeps only
  account/browser/project ids, action kind, decision, posture, mode, action
  name, reason, source, and origin.

Residual risk:

- This is a local browser-tab stability guard, not a full authorization policy.
- The audit still needs to classify browser-session access by credential type:
  ordinary account sessions, project-scoped agent auth, explicit
  `browser_session` agent scope, and spawned Playwright sessions.
- The QuickJS sandbox and typed action API still need continued review, since
  disabling raw JS shifts non-admin automation into that path.

Suggested next audit steps:

1. Review the QuickJS typed-action sandbox for data exfiltration and UI
   mutation risks under non-admin credentials.
2. Audit session spawn/list/use behavior under account auth versus agent auth
   beyond the existing agent-auth explicit-target protections.

### SEC-CLI-001: cocalc-cli Authority Classes Needed First-Pass Audit

Status: `done`.

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

Second-pass audit:

- Added `src/.agents/cli-api-key-dangerous-operation-audit-2026-05-14.md`.
- Confirmed CLI hub transport forwards `auth_session_hash`, and
  `cocalc auth elevate` provides the browser-approved fresh-auth flow needed by
  server-side dangerous-action gates.
- Confirmed existing fresh-auth coverage for membership purchases, cloud host
  create/start/configuration, host manager grants, host RAM/spend caps, and
  admin impersonation grants.
- Added a shared Conat dangerous-session helper and applied it to account
  delete/rehome/drain/repair and admin membership/entitlement mutation. Admin
  and account-rehome/entitlement paths require active plus recent 2FA; self
  account delete requires a fresh authenticated session.
- Applied the same helper to host delete/deprovision, self-host connector
  removal, host RootFS image pull/delete/GC, and host SSH authorized-key
  add/remove. Host SSH authorized-key list/add/remove now route through the
  host-connection inter-bay API for remote-owned hosts.
- Applied the same helper to project soft delete/undelete, project hard delete,
  project move/rehome, backup delete/restore/finalize-restore-staging, and
  snapshot delete/restore. Project move checks freshness on the caller bay
  before inter-bay forwarding to the owning bay.
- Applied the same helper to organization create/metadata mutation, member
  add/remove, admin grant/revoke, and account creation into an organization.
- The reviewed destructive/admin endpoint families now have endpoint-level
  freshness gates.
- Added `dangerous-rpc-registry.ts` plus a static regression test that scans
  public hub API modules for destructive/admin-looking exported RPC names. New
  matching exports now fail tests until they are added to the registry with an
  explicit fresh-auth decision.

Residual risk:

- The registry is a naming-pattern regression guard, not a formal verifier that
  every implementation calls the exact expected helper. It is intended to make
  future risky endpoint additions visible during review.
- Hub-password account bootstrap and CLI browser/session automation can still
  benefit from central audit events if launch telemetry requires them.

Suggested next audit steps:

1. Add focused tests for any freshness-gated endpoint family that gets changed.
2. Consider central audit events for hub-password account bootstrap and CLI
   browser/session automation.

### SEC-KEY-001: Account and Project API Key Scope Audit

Status: `done`.

Severity: high.

Evidence:

- User-managed v2 CoCalc API keys used one table for account-wide keys and
  legacy project-scoped keys.
- Legacy project-scoped CoCalc API keys authenticated directly as
  `{project_id}`, which meant generic API-key auth helpers and bridge/proxy
  paths had to handle account and project principals together.
- Account API keys still authenticate as broad account credentials with no
  capability list or allowed-project list.

Implemented first guard/removal:

- Added `src/.agents/api-key-scope-audit-2026-05-12.md`.
- Added `src/.agents/cli-api-key-dangerous-operation-audit-2026-05-14.md` as a
  second pass over dangerous-operation API-key exposure.
- Project-scoped CoCalc API-key management paths, schema column, project
  settings UI, and project rehome portability were removed.
- Project-scoped CoCalc API-key authentication was removed; API-key auth returns
  account principals only.
- Cluster account API-key directory fallback is account-key-only; the temporary
  project-key scope discriminator was removed with the project-key model.
- The HTTP Conat project bridge now requires an account API key plus explicit
  `project_id`, then applies normal collaborator authorization.
- Account API-key creation/editing now requires explicit capabilities and
  explicit project allowlists for project, file, Codex, and exec access.
- API-key websocket auth denies hub/account RPC subjects because function-level
  API-key policy is not yet available there; allowed project subjects require
  `project:exec` and a matching project allowlist.
- HTTP Conat hub/project bridges enforce a small reviewed capability allowlist
  and fail closed for unreviewed RPCs.
- The second pass did not find an account API-key path that can directly call
  dangerous hub/admin/project metadata RPCs such as account delete, host delete,
  membership override, rootfs catalog mutation, or project hard delete.
- Added central audit events for account API-key creation, deletion,
  successful local/directory authentication, invalid/expired/mismatched
  authentication denials, HTTP Conat policy denials, and websocket
  subject/collaborator denials. Audit values include account/key IDs, source,
  capability/project/RPC/subject context, and denial codes, but never raw API
  key secrets.
- Added focused regression coverage for API-key management/auth audit events,
  HTTP Conat policy-denial audit events, and websocket API-key denial audit
  events.

Residual risk:

- Hub Conat API dispatch does not yet propagate whether an account principal
  came from a browser cookie, account API key, or agent bearer token into
  endpoint transforms. Websocket API-key hub RPCs are therefore denied rather
  than scoped at function granularity.
- Additional reviewed API-key capabilities should only be added for concrete
  product workflows with their own policy tests.

Suggested next audit steps:

1. Propagate auth method through hub dispatch only if websocket API-key hub RPCs
   are intentionally expanded.
2. Expand reviewed API-key capabilities only for concrete product workflows.

### SEC-SSO-001: SSO Signup and Sign-In Policy

Status: `guarded`.

Severity: high.

Evidence:

- Legacy SSO is still Passport.js based and historically supported Google,
  Facebook, GitHub, Twitter, and manually configured organization providers.
- `cocalc-ai` only wants Google as the built-in public provider plus explicit
  organization SSO later.
- SSO account creation must share the same signup policy as password signup:
  no existing-account sign-in through signup, no public signup unless explicitly
  allowed, registration-token policy applies consistently, and SSO-created
  accounts require verified or trusted email.

Implemented first guard:

- Added a shared `evaluateAccountCreationPolicy` helper with explicit decisions
  for:
  - `allow_create`
  - `deny_existing_account`
  - `deny_registration_token_required`
  - `deny_email_unverified`
  - `deny_use_sso`
- Password signup now uses the shared policy for SSO-required-domain denial and
  existing-account denial.
- Focused tests cover registration-token requirements, trusted
  registration-token signup, existing-account denial, SSO-required domain
  denial, and unverified SSO email denial.
- Google is now the only built-in public SSO provider. Facebook, GitHub, and
  Twitter strategy implementations, frontend primary-provider treatment, and
  package dependencies were removed.
- Legacy `facebook`, `github`, and `twitter` `passport_settings` rows are
  ignored instead of being treated as custom organization providers.
- Legacy Passport SSO account creation now calls the shared policy before
  creating an account.
- Public SSO account creation on token-gated sites is denied unless the SSO
  provider is configured as the exclusive/domain gate for the returned email.
- SSO-created accounts require a verified/trusted email signal before account
  creation, and the email is only marked verified when that trust signal is
  present.
- Added `auth/sign-in-method`, a public email-first domain-policy query that
  reports whether password sign-in is allowed or a configured domain SSO
  strategy is required. It reads only SSO strategy policy, not account rows, so
  it does not reveal whether the email has an account.
- The public sign-in form now calls `auth/sign-in-method` for valid emails and
  shows a direct SSO provider link when the domain requires SSO, disabling
  password submission for that email. Password submission also rechecks the
  method server-side before posting credentials.
- Google SSO client configuration is now available through admin site settings:
  enabled flag, client ID, encrypted client secret, allowed domains, and
  account-creation mode.
- Legacy DB-only Google rows in `passport_settings` are ignored. Custom
  organization providers still use `passport_settings` until the first-class
  provider model exists.
- Google allowed domains are enforced against verified SSO email addresses and
  also feed the existing domain SSO routing policy. If no domains are listed,
  Google can be shown as a public provider when enabled/configured.
- Google SSO account creation now has an explicit mode:
  `disabled`, `registration_token_required`, or `public_allowed`.
- Google sign-in now uses a direct OIDC code flow instead of the Google Passport
  strategies. The runtime validates state, nonce, issuer, audience, expiration,
  `sub`, `email`, `email_verified`, and the RS256 signature against Google's
  JWKS.
- The old Google Passport strategy implementations and package dependencies
  were removed.
- Added first-class `sso_providers` and `sso_domain_policies` admin-managed
  tables plus an Administration panel. Enabled `sso_required` domain policies
  now feed both public sign-in routing and SSO runtime metadata.
- Domain `signup_mode` now overrides global/provider account-creation behavior
  for matching domains. `disabled` blocks creation, `public_allowed` permits
  creation without a registration token, and `registration_token_required`
  requires token-based password signup before SSO linking.
- Domain `require_cocalc_2fa` now prevents password sign-in without an active
  CoCalc second factor and sends SSO users through the public second-factor
  challenge route before setting sign-in cookies. New password/SSO account
  creation is fail-closed for matching domains because a new account cannot
  already satisfy the CoCalc 2FA requirement.
- Organization SAML now uses admin-managed `sso_providers` rows with direct
  node-saml runtime routing instead of Passport strategy routing. The admin SSO
  panel has structured SAML fields, copyable SP metadata/ACS URLs, IdP metadata
  parsing, and avoids storing raw pasted metadata XML.

Residual risk:

- Passport dependencies and legacy organization-provider machinery still exist
  for non-Google non-SAML organization providers until those are deleted or a
  concrete direct OIDC replacement is required.

Suggested next audit steps:

1. Add SSO audit events for provider/domain-policy mutations and SSO allow/deny
   outcomes without logging assertions, authorization codes, or provider
   secrets.

### SEC-REG-001: Registration-Token Signup Policy

Status: `done`.

Severity: high.

Evidence:

- The old signup policy inferred "registration token required" from whether any
  active registration tokens existed.
- That made an empty or all-disabled token table a fail-open state: registration
  tokens were intended to restrict signup, but removing every token could make
  signup public.

Implemented guard:

- Added the explicit admin setting
  `public_signup_without_registration_token`, default `no`.
- Server auth token checks now require registration tokens unless that setting
  is explicitly enabled.
- Hub webapp configuration now reports "registration token required" from the
  explicit setting instead of active-token existence.
- The admin registration-token page now has a visible public-signup toggle and
  warns that no active tokens means email signup is blocked when public signup
  is disabled.
- Failed registration-token redemption attempts are throttled per email and IP,
  so token guessing does not depend only on reCAPTCHA being configured.
- The unfinished registration-token "disable collaborators" and "disable AI"
  account customization UI was removed, and token customization metadata is no
  longer propagated into newly created accounts.
- The signup endpoint no longer signs in existing accounts when submitted
  credentials match, closing a 2FA bypass.
- The public signup API no longer accepts caller-provided signup tags.
- The public signup API no longer accepts caller-provided signup reason.
- Token-gated signup validates the registration token before returning
  account-specific errors, so invalid-token attempts cannot enumerate existing
  accounts.
- Registration-token attempts are pre-throttled even when the submitted token is
  missing.
- Valid tokens are not consumed until cheap pre-create checks, including account
  availability, have passed.
- Account creation failures are logged server-side and returned as a generic
  signup failure.
- Normal registration-token values are stored encrypted at rest so admins can
  redisplay them without leaving cleartext in database backups.
- Bootstrap-admin registration tokens are stored hash-only, skipped by admin
  token listing, and deleted after successful bootstrap signup. If a stale
  hash-only bootstrap row is encountered after process restart, it is deleted
  and replaced with a fresh one instead of being displayed.
- Added focused tests for the server and hub policy helpers.
- Added focused PGlite regression coverage for encrypted normal tokens,
  hash-only hidden bootstrap-admin tokens, and opportunistic encryption of
  legacy plaintext token rows during validation.

Residual risk:

- The registration-token database column remains the primary key, so lookup is
  currently table-scan based for protected values. This is accepted for the
  expected small admin-managed token set; revisit only if token-table size grows
  enough for lookup cost to matter.
- SSO account-creation behavior is tracked separately under `SEC-SSO-001`.

### SEC-ROOTFS-001: Root Filesystem Count and Storage Quotas

Status: `guarded`.

Severity: critical.

Evidence before this pass:

- Root filesystems are durable, user-created storage resources.
- Current audit notes indicate users may be able to create an unlimited number
  of root filesystems with unbounded total storage.
- This is a direct hosted storage-cost risk and can also amplify image
  build/pull/distribution, backup, snapshot, and project-start load.

Required release policy:

- Add admin-editable membership-tier limits:
  - `rootfs_count`
  - `rootfs_total_storage_gb`
  - `rootfs_max_storage_gb`
  - `rootfs_oci_images`
- Enforce limits server-side before create, clone, import, and grow operations.
- Preserve or re-check limits on ownership transfer, delete, restore, and
  concurrent operations.
- Show effective limits and current usage in user/admin UI.
- Emit quota-denial telemetry with account, tier, effective limit, current
  usage, operation, and requested size.

Implemented default policy:

| Tier     | `rootfs_count` | `rootfs_total_storage_gb` | `rootfs_max_storage_gb` | `rootfs_oci_images` |
| -------- | -------------- | ------------------------- | ----------------------- | ------------------- |
| free     | 0              | 0                         | 0                       | false               |
| student  | 0              | 0                         | 0                       | false               |
| standard | 20             | 25                        | 10                      | false               |
| pro      | 250            | 250                       | 30                      | true                |

Current result:

- Added membership usage-limit schema/defaults, admin override fields, CLI
  override documentation, and account membership display for rootfs limits.
- Added server-side quota admission for catalog save, project rootfs publish,
  project rootfs image selection, and project creation with a selected/cloned
  rootfs image.
- Rootfs publish now materializes the project filesystem first, checks quota
  against the measured artifact size, then uploads/registers the durable
  release artifact.
- Remote arbitrary OCI-backed rootfs images are disabled unless the effective
  membership tier explicitly enables `rootfs_oci_images`; built-in, managed, and
  trusted catalog images remain selectable.
- Rootfs quota denials are logged centrally as `rootfs_quota_denied`.
- Added admin/system quota reporting for top rootfs users, near-limit accounts,
  and recent grouped denial events. The CLI exposes this as
  `cocalc admin rootfs-quotas`, with Prometheus text output for alert scraping.
- The RootFS quota, ACP admission-denial, service admission-denial, and project
  runtime-slot admin reports are cluster-aggregated across configured bays and
  include per-row `bay_id` plus bay success/error status so admins do not get a
  silently local report from whichever bay their CLI happened to connect to.
- Project clone creation now validates the source project's actual
  `project_rootfs_states.current` binding before any filesystem clone side
  effect, and stores that current RootFS binding on the destination project row
  instead of trusting a stale legacy `projects.rootfs_image` value.
- Account deletion now retires all active RootFS catalog entries owned by the
  deleted account before marking the account deleted. Existing release blocker
  and GC logic decides whether artifacts can be removed immediately or must
  remain while still referenced by projects/catalog entries.
- Follow-up edge audit covered durable RootFS save/publish/select/delete and
  account-deletion ownership behavior. The durable RootFS quota surface is
  concentrated in catalog save, project publish, project image selection, and
  account deletion retirement; host disk grow/resize is a separate host storage
  operation, not a durable user-owned RootFS catalog quota path.
- Added regression coverage for replacement growth over total storage quota,
  deleted RootFS IDs counting as new entries, and metadata-only updates to
  existing owned RootFS entries on zero-storage tiers.

Remaining audit steps:

1. Add user-facing current-usage display next to the effective rootfs limits.
2. Decide whether exact concurrent create/publish serialization is warranted
   beyond the current admission checks.

### SEC-SCAN-001: Official RootFS Vulnerability Trust Scanning

Status: `guarded`.

Severity: high.

Motivation:

- Official/shared RootFS images are a trust boundary. Admins can accidentally
  publish an image with known vulnerable OS or language packages, and many users
  may then inherit that risk.
- RootFS releases are immutable. If a critical vulnerability is discovered after
  publication, users must switch to a newer image, upgrade their own copy, or
  make an explicit exception.
- The product already has RootFS catalog/release scan placeholders
  (`scan_status`, `scan_tool`, `scanned_at`, `scan_summary`). The first useful
  release feature should fill and enforce those fields, not build a general
  arbitrary-project scanner.
- This is a SOC-2-style evidence control: it proves shared base images are
  checked, records what scanner/database produced the result, and preserves
  admin exception/remediation decisions.

Required release policy:

- Scope the first implementation to admin-only scanning and policy for
  RootFS catalog entries/releases, especially official images and images shared
  broadly enough to appear in user selection flows.
- Show scan state directly in:
  - the RootFS image list,
  - the selected-image details pane,
  - and project settings where users choose or review their RootFS image.
- Record at least: scanner name/version, vulnerability database version or
  timestamp, target release/content identifier, requested/completed timestamps,
  status, severity counts, report location or compact report payload, admin
  notes, false-positive/accepted-risk notes, and remediation target when known.
- Gate new selections of official/shared images with unresolved critical
  findings. Existing projects should not be forcibly changed by the scanner
  alone, but project settings should clearly warn and encourage switching.
- Keep policy admin-controlled: severity threshold, stale-scan age, whether
  unscanned images are selectable, and whether admin-only bypasses are allowed.
- Treat scan results as trust/evidence metadata. They should block only the
  narrow RootFS image-selection path defined above; they should not delete
  images or scan/inspect arbitrary user project files.

Current tool candidate:

- Trivy remains the likely first candidate because it can scan filesystem/rootfs
  and image-style targets with machine-readable output, vulnerability metadata,
  SBOM/license modes, and offline database/cache support.
- Before implementation, compare Trivy with Syft/Grype, OSV-Scanner, and any
  other credible free option specifically for RootFS image trust, not for broad
  arbitrary user-project scanning.

Required tool-selection step:

- Compare Trivy with other credible free/open-source options before committing
  to an implementation. At minimum evaluate:
  - vulnerability database coverage and update model,
  - filesystem/rootfs/image scanning support,
  - OS package and language package lockfile coverage inside RootFS images,
  - SBOM/license support,
  - offline/cache behavior for private deployments,
  - resource limits and sandboxability,
  - JSON/SARIF output quality,
  - operational maturity, release cadence, and maintenance health.
- Document why the chosen scanner is the best free option for official RootFS
  trust scanning and list accepted gaps.

Suggested implementation sequence:

1. Write a short RootFS-specific scanner comparison note and pick the default
   scanner.
2. Extend the existing RootFS scan fields or add a normalized
   `rootfs_release_scan_runs` table if historical runs/admin exception history
   should be first-class instead of only latest-state metadata.
3. Add admin settings for enablement, severity threshold, stale-scan age,
   max concurrency, timeout, max target size, and unscanned-image policy.
4. Add a bounded admin-triggered scan job for a specific immutable RootFS
   release/content key, with read-only target access and scanner binary/database
   version capture.
5. Render concise scan status in the RootFS list and project settings, with a
   drill-down panel for findings, scanner metadata, and admin notes.
6. Enforce selection blocking for official/shared images with unresolved
   critical findings, while allowing admin bypass only with an explicit note.
7. Add regression tests for scan-state rendering, stale/unscanned policy,
   critical-finding selection blocking, admin bypass notes, report parsing, and
   job failure states.

Future scope:

- Broad project-file, archived-project, project-host filesystem, secret, and
  malware scanning may still be valuable, but it is not the launch requirement
  for this item. Keep that as a separate workstream after official RootFS trust
  scanning works end-to-end.

### SEC-MASTER-001: Site Master Key Storage and Recovery

Status: `guarded`.

Severity: high.

Evidence before this pass:

- Secret-settings encryption and project backup repository secrets originally
  had separate local master-key files.
- For hosted production, losing the key makes encrypted backup material
  unusable, while accidentally creating a fresh key on a bay would make existing
  encrypted data unreadable.
- Multiple keys are operationally confusing for launch, recovery, and
  multi-bay provisioning.

Implemented policy:

- CoCalc now has exactly one local `site-master-key`.
- Encryption users derive purpose-specific keys from that site key:
  `secret-settings:v1`, `project-backup-repo-secrets:v1`, and
  `project-secrets:v1`.
- The raw site key is not directly used as an AES-GCM payload encryption key.
- Local admin CLI supports:
  - `cocalc admin master-key status`
  - `cocalc admin master-key init`
  - `cocalc admin master-key export <path>`
  - `cocalc admin master-key import <path>`
  - `cocalc admin master-key doctor`
  - `cocalc admin master-key migrate`
- Encrypted export uses a passphrase-protected backup file. Restore verifies
  the backup checksum before writing the local key.
- Production bay systemd units use `LoadCredential=site-master-key:/etc/cocalc/site-master-key`
  and set `COCALC_REQUIRE_SITE_MASTER_KEY=1`, so production startup fails
  closed instead of auto-creating a new key.
- Legacy `server-settings-key` and `backup-master-key` are read only as
  migration fallbacks.

CLI smoke validation, 2026-05-14:

- Used isolated temporary `COCALC_DATA_DIR` directories, not the live dev data
  directory.
- `cocalc admin master-key status` on a clean data dir reported a missing key,
  `needs_initialization=true`, and no backup requirement.
- `cocalc admin master-key init` created
  `secrets/site-master-key` with mode `0600`, a valid 32-byte value, and
  `backup_required=true`.
- `cocalc admin master-key export <backup> --passphrase-file <file>` produced
  an encrypted backup with mode `0600`; the backup JSON had `encrypted=true`
  and no plaintext `key` field.
- `cocalc admin master-key import <backup> --passphrase-file <file>` restored
  the key into a clean data dir. The restored key SHA-256 matched the source
  key SHA-256 and had mode `0600`.
- `cocalc admin master-key doctor --files-only` reported `ok=true`, key
  present/readable/private, no legacy key files, and expected warnings that
  software cannot prove off-host backup exists and production-required mode was
  not enabled in the temp dev dir.
- `COCALC_REQUIRE_SITE_MASTER_KEY=1 cocalc admin master-key init` in a clean
  data dir exited nonzero and reported `site master key is required but
missing`.

Residual risk:

- This validates the CLI lifecycle mechanics, not the human runbook.
- A production operator still needs to create and store an off-host encrypted
  backup, provision the same key to every bay, verify all systemd units see the
  credential, and test disaster restore from a backup set.
- KMS/TPM envelope unseal remains a future hardening improvement, not a first
  release blocker.

### SEC-START-001: Simultaneous Running Project Admission

Status: `done`.

Severity: critical.

Evidence from 2026-05-14 pass before the fix:

- Project start/restart was routed through project ownership and host placement,
  but there was no explicit simultaneous-running-project cap by owner,
  `usage_account_id`, host, or bay.
- This left course/team patterns where one high-entitlement account could
  implicitly sponsor many free collaborators' simultaneously running projects
  without a clear purchased runtime-slot model.

Risk:

- One high-entitlement account can own or sponsor many projects with free
  collaborators and allow many of them to run at the same time.
- A classroom/course workflow can unintentionally become "one instructor
  membership sponsors 100 free users' active runtime" unless there is an
  explicit sponsored-runtime-slot model.
- A project-host-local cap would reduce blast radius, but it would not fully
  solve the economic/policy issue because projects can be spread across hosts
  and bays.

Implemented release policy:

- Added `max_sponsored_running_projects` to membership tier templates,
  entitlement overrides, admin UI, and effective usage limits.
- Added durable `project_runtime_slots` on the sponsor home bay, with reserve,
  deny, heartbeat, release, expire, and admin-report flows.
- Added `runtime_sponsor_account_id` as explicit project metadata for runtime
  admission, priority, and RAM-limit attribution. Existing `usage_account_id`
  remains the fallback sponsor before the owner.
- Start/restart reserves a sponsored runtime slot before project-host
  placement/start. Inter-bay start/restart routes to the sponsor home bay for
  slot admission instead of relying on local counters.
- Project-host heartbeats keep runtime slots alive while projects are
  starting/running, and stale slots expire.
- Slot denial propagates as a structured LRO result with visible running
  projects, stop actions, sponsor upgrade routing, and CLI rendering.
- Project owners, runtime sponsors, and admins can disable ordinary
  collaborator starts that would consume the sponsor's slots.
- Collaborators can explicitly switch a project to use their membership as the
  runtime sponsor when allowed.
- Autostart calls from frontend Codex, Jupyter, terminal, project-host SSH,
  project-host HTTP proxy, and project-host Codex runtime wake paths are marked
  as autostarts and denied before expensive start work when policy or slot
  admission blocks the start.
- Runtime slot reserve/deny/release/expire events are written to `central_log`.
  Admins can query an active-slot report through the hub system API, and the CLI
  exposes `cocalc project runtime-slots`.

Follow-up polish:

- Deeper course/team dashboards and bulk classroom slot-management operations
  remain useful product polish, but the release security blocker is closed.

### SEC-DEP-001: Dependency Advisory Reconciliation

Status: `guarded`.

Severity: critical.

Evidence from 2026-05-14 pass:

- `cd src/packages && pnpm audit` currently reports one critical npm advisory:
  `sanitize-html` via `frontend>sanitize-html`, `GHSA-rpr9-rxv7-x643`.
- The advisory reports vulnerable versions `<=2.17.3` and no upstream patched
  version in the audit metadata.
- `gh api repos/sagemathinc/cocalc-ai/dependabot/alerts --paginate` is
  accessible from this workspace and reported 8 open alerts during the initial
  pass:
  - critical: `sanitize-html` in `src/packages/pnpm-lock.yaml`
  - high: four `urllib3` alerts in `src/python/cocalc-api/uv.lock`
  - medium: `pytest` and `requests` in `src/python/cocalc-api/uv.lock`
  - low: `Pygments` in `src/python/cocalc-api/uv.lock`

Risk:

- `pnpm audit` alone misses Python lockfile advisories surfaced by Dependabot.
- Dependabot includes historical/fixed alerts and multiple manifests, so the
  release gate needs an explicit open-alert reconciliation step instead of
  relying on a single scanner.
- `sanitize-html` has no patched upstream version listed, so a normal package
  upgrade may not be possible; reachable uses must be locally mitigated,
  removed, or explicitly proven non-exploitable.

Required release behavior:

- High/critical production alerts must be fixed, locally mitigated, or
  documented as non-exploitable with a package path and reachability reason.
- Python lockfile alerts must be updated when patched versions exist or
  explicitly deferred if the package is dev-only/unshipped.
- The final release checklist must include both package-manager audit output and
  Dependabot open-alert output.

Implemented local remediation, 2026-05-14:

- Removed `sanitize-html` from frontend and server package dependencies.
- Replaced frontend SSR HTML sanitization with explicit tag/attribute allowlist
  filtering during `html-react-parser` rendering.
- Replaced server email-body sanitization with a small allowlist parser using
  `htmlparser2@8.0.2`, avoiding the vulnerable `sanitize-html` dependency.
- Added regression tests for the `xmp` raw-text sanitizer bypass payload on both
  frontend SSR HTML and server email HTML.
- Updated `src/python/cocalc-api/uv.lock` so current Python resolves:
  - `urllib3 2.7.0`
  - `requests 2.34.2`
  - `Pygments 2.20.0`
  - `pytest 9.0.3`
- `cd src/packages && pnpm audit` now reports no known vulnerabilities.
- `uv lock --check` succeeds and `uv run python` imports the patched Python
  versions above.

Follow-up remediation, 2026-05-17:

- Rechecked Dependabot via GitHub API. Only four open Python alerts remained:
  two `urllib3`, one `requests`, and one `pytest`, all in
  `src/python/cocalc-api/uv.lock`.
- The remaining alerts were caused by Python 3.9 resolution branches in the uv
  lockfile:
  - `urllib3 2.6.3` for `python_full_version < '3.10'`
  - `requests 2.32.5` for `python_full_version < '3.10'`
  - `pytest 8.4.2` for `python_full_version < '3.10'`
- Since `cocalc-api` has never been released as part of `cocalc-ai`, the package
  now requires Python `>=3.10`.
- Regenerated `uv.lock`; it now contains only:
  - `urllib3 2.7.0`
  - `requests 2.34.2`
  - `pytest 9.0.3`
  - `Pygments 2.20.0`

Suggested next actions:

1. After the branch is pushed or merged, re-run the GitHub Dependabot open-alert
   query and verify the old npm/Python alerts close.
2. Record any remaining accepted residual risks with manifest path and
   production reachability.

Suggested next audit steps:

1. Smoke-test `docs/security/site-master-key-production-runbook.md` on one
   disposable bay VM or launchpad-style instance.
2. For the three pre-release dogfood/dev sites, run the offline migration once,
   restart immediately after, then delete the migration code later if it is
   truly one-time scaffolding.
