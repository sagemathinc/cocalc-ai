# CLI/API-Key Dangerous Operation Audit

Status: 2026-05-14 second-pass audit for `SEC-CLI-001` and `SEC-KEY-001`.

Update: the first fresh-auth implementation tranche is complete. Account
delete/rehome/drain/repair, admin membership/entitlement mutation, and org token
create/expire now use a shared Conat dangerous-session helper. Admin,
account-rehome, entitlement, and org-token creation gates require recent 2FA;
self account delete and org-token expiry require a fresh authenticated session.
The second fresh-auth tranche gates host delete/deprovision, RootFS image
pull/delete/GC, and host SSH authorized-key mutation. Host SSH authorized-key
operations now route to the authoritative host bay instead of using local
host-row shortcuts.
The third fresh-auth tranche gates project soft delete/undelete, hard delete,
move/rehome, backup delete/restore/finalize-restore-staging, and snapshot
delete/restore. Project move checks freshness on the caller bay before routing
to the owning bay; the inter-bay handler uses a non-serializable internal
capability after the caller-bay check.

Scope:

- Dangerous `cocalc-cli` command families that call hub/project-host Conat RPCs.
- Account API-key access to hub and project Conat bridges.
- Browser-session freshness and second-factor enforcement for destructive or
  privilege-escalating operations.
- Multibay routing posture for the audited operations.

## Executive Summary

API-key dangerous-operation exposure is guarded for the currently reviewed
paths:

- Websocket account API-key auth cannot publish/subscribe to hub/account RPC
  subjects. It can only reach project subjects when the key has `project:exec`
  and the project is explicitly allowlisted.
- HTTP Conat hub API-key access is fail-closed and only permits a small reviewed
  allowlist (`system.ping`, `system.getNames`, `projects.createProject`, and a
  few project read/exec RPCs).
- HTTP Conat project API-key access requires `project:exec`, an explicit
  allowed project id, and normal collaborator access.

Fresh-auth coverage is still incomplete but improved:

- CLI transport forwards `auth_session_hash`, and `cocalc auth elevate` exists,
  so the transport can support server-side freshness gates.
- Several high-risk endpoint families now require freshness: membership
  purchase, cloud host create/start/configuration, host access escalation to
  `manager`, host RAM/spend-cap changes, admin impersonation grants, account
  delete/rehome/drain/repair, admin membership/entitlement mutation, and org
  token lifecycle, host delete/deprovision, host RootFS mutation, and host SSH
  authorized-key mutation.
- The remaining destructive/admin gaps are concentrated in rootfs admin
  mutation, organization membership/admin mutation if treated as equivalent to
  token issuance, and legacy token generation.

Conclusion: `SEC-KEY-001` is acceptable as guarded for the first release unless
websocket API-key hub RPC support is intentionally expanded. `SEC-CLI-001`
should remain guarded until the remaining freshness gaps below are either fixed
or explicitly accepted.

## Evidence Reviewed

CLI session/fresh-auth transport:

- `src/packages/cli/src/bin/core/context.ts` forwards the remote user's
  `auth_session_hash` into hub RPC requests.
- `src/packages/conat/hub/api/util.ts` injects `auth_session_hash` into
  `args[0].session_hash` for `authFirst` and `authFirstRequireAccount`
  transforms.
- `src/packages/cli/src/bin/commands/auth.ts` implements `cocalc auth elevate`,
  which starts an approved browser challenge and updates the current session's
  `fresh_auth_until`.
- `src/packages/server/auth/auth-sessions.ts` implements
  `requireFreshAuthForSessionHash`.

API-key guardrails:

- `src/packages/server/conat/socketio/auth.ts` denies API-key hub/account
  subjects and only allows project subjects when the key has `project:exec` for
  the target project.
- `src/packages/http-api/pages/api/conat/hub.ts` requires an account API key and
  calls `assertHttpHubApiKeyAllowed`.
- `src/packages/http-api/pages/api/conat/project.ts` requires an account API
  key, `project:exec`, an allowed project id, and collaborator access.
- `src/packages/server/api/http-api-key-policy.ts` is fail-closed for unreviewed
  hub RPC names.
- `src/packages/server/api/api-key-scope.ts` requires explicit API-key
  capabilities and explicit project allowlists for project/file/exec/Codex
  capabilities.

Existing freshness/2FA checks:

- `src/packages/server/conat/api/system.ts` requires fresh auth plus an active
  second factor for `createImpersonationGrant`.
- `src/packages/server/conat/api/purchases.ts` requires fresh auth for browser
  membership-package purchases.
- `src/packages/server/conat/api/hosts.ts` requires fresh auth for cloud host
  create/start/configuration, host-manager access grants, host project-RAM
  limits, and owner spend caps.
- `src/packages/server/conat/api/dangerous-session-auth.ts` provides the shared
  Conat dangerous-session helper. It requires a fresh session hash, supports
  actor impersonation, and can require active plus recent second-factor
  verification for the account or impersonating actor.
- `src/packages/server/conat/api/system.ts` applies this helper to account
  delete/rehome/drain/repair and admin membership/entitlement mutation.
- `src/packages/server/conat/api/org.ts` applies this helper to org token
  creation and expiry.
- `src/packages/server/conat/api/hosts.ts` applies this helper to host
  delete/deprovision, self-host connector removal, host RootFS image
  pull/delete/GC, and host SSH authorized-key add/remove. Remote host forwarding
  checks freshness before crossing bays, then uses a non-serializable trusted
  inter-bay capability so the authoritative host bay does not need a local copy
  of the caller's auth session.
- Host SSH authorized-key list/add/remove now route through the host-connection
  inter-bay API for remote-owned hosts.
- `src/packages/server/conat/api/hosts.test.ts` has regression coverage for the
  host fresh-auth gates.
- `src/packages/server/conat/api/purchases.test.ts` has regression coverage for
  the membership fresh-auth gate.

## Dangerous Operation Matrix

| Surface                                               | Current Authorization                                                | Fresh/2FA                                                                                 | API-key Exposure                                                                                            | Multibay Posture                                                                                                        | Audit Result                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Admin impersonation grant                             | Site admin                                                           | Fresh auth and active 2FA required                                                        | API-key hub RPC denied                                                                                      | Resolves subject account home bay before creating the grant                                                             | Good                                                                      |
| Membership package purchase                           | Account purchase checks                                              | Fresh browser auth required                                                               | API-key hub RPC denied                                                                                      | Account-home/billing path                                                                                               | Good                                                                      |
| Cloud host create/start/config                        | Owner/host permission/membership                                     | Fresh auth for cloud/self-funded risk paths                                               | API-key hub RPC denied                                                                                      | Resolves remote host bay and forwards through inter-bay host connection                                                 | Good                                                                      |
| Host manager access/RAM/spend caps                    | Host manage/config permission                                        | Fresh auth required                                                                       | API-key hub RPC denied                                                                                      | Resolves remote host bay                                                                                                | Good                                                                      |
| Account delete                                        | Self or site admin for another account                               | Fresh auth required; admin deleting another account also requires active/recent 2FA       | API-key hub RPC denied                                                                                      | Uses cluster account delete routing                                                                                     | Improved                                                                  |
| Account rehome/drain/repair                           | Site-admin/operator checks in rehome helpers                         | Fresh auth plus active/recent 2FA required                                                | API-key hub RPC denied                                                                                      | Uses account home-bay/rehome helpers                                                                                    | Good                                                                      |
| Admin membership assignment and entitlement overrides | Site admin                                                           | Fresh auth plus active/recent 2FA required                                                | API-key hub RPC denied                                                                                      | Entitlement overrides route to account home bay                                                                         | Good                                                                      |
| Org token create/expire                               | Org admin/site admin                                                 | Token create requires fresh auth plus active/recent 2FA; token expire requires fresh auth | API-key hub RPC denied                                                                                      | Legacy single-db organization model                                                                                     | Improved                                                                  |
| Project soft delete/undelete                          | Project collaborator/owner checks via project control                | Fresh auth plus active/recent 2FA required                                                | HTTP hub API-key denied; project API-key with `project:exec` can operate inside allowlisted project runtime | Project control routes to owning bay                                                                                    | Improved                                                                  |
| Project hard delete                                   | `assertHardDeleteProjectPermission`                                  | Fresh auth plus active/recent 2FA required                                                | HTTP hub API-key denied                                                                                     | LRO routed from owning/control bay                                                                                      | Improved                                                                  |
| Project move/rehome                                   | Collaborator/admin checks                                            | Fresh auth plus active/recent 2FA required                                                | HTTP hub API-key denied                                                                                     | Move resolves owning bay and forwards through inter-bay project control after caller-bay freshness check                | Improved                                                                  |
| Backup/snapshot delete/restore                        | Project collaborator checks                                          | Fresh auth plus active/recent 2FA required                                                | HTTP hub API-key denied; project bridge requires `project:exec`                                             | Project/file-server routing is project-aware                                                                            | Improved                                                                  |
| Public app expose/unexpose                            | Project app/project collaborator checks                              | Not required                                                                              | Project API-key with `project:exec` can call project-host app APIs for an allowlisted project               | Project-host routed; same security as project runtime authority                                                         | Acceptable if `project:exec` is treated as full project runtime authority |
| Host delete/deprovision                               | Host owner                                                           | Fresh auth plus active/recent 2FA required                                                | API-key hub RPC denied                                                                                      | Resolves remote host bay before delete; inter-bay handler uses trusted internal auth after caller-bay freshness check   | Good                                                                      |
| Host RootFS image delete/pull                         | Host rootfs-management permission                                    | Fresh auth plus active/recent 2FA required                                                | API-key hub RPC denied                                                                                      | Resolves remote host bay before mutation; inter-bay handler uses trusted internal auth after caller-bay freshness check | Good                                                                      |
| Host SSH authorized key add/remove                    | Host owner                                                           | Fresh auth plus active/recent 2FA required                                                | API-key hub RPC denied                                                                                      | Resolves remote host bay for list/add/remove through host-connection API                                                | Good                                                                      |
| RootFS catalog/admin/release mutation                 | Site admin                                                           | Not required                                                                              | API-key hub RPC denied                                                                                      | Hub/site admin path                                                                                                     | Gap                                                                       |
| `system.generateUserAuthToken`                        | Admin or target password; used by legacy hub-password bootstrap path | Not required                                                                              | API-key hub RPC denied                                                                                      | Token creation logs centrally                                                                                           | Residual legacy path                                                      |

## API-Key Result

No API-key path was found that can directly call dangerous hub/admin/project
metadata RPCs such as account delete, host delete, membership override, rootfs
catalog mutation, or project hard delete.

Important details:

- Websocket API keys are not function-scoped at the hub transform layer, so
  hub/account subjects are denied wholesale. This is the right release posture.
- The HTTP hub bridge has a small positive allowlist and throws
  `api_key_rpc_denied` for everything else.
- Project API-key access intentionally maps `project:exec` to full project
  runtime authority for allowlisted projects. A key with `project:exec` can run
  code in that project, so project-host operations exposed to the project
  runtime should be treated as available to that key.

Recommendation: do not add websocket API-key hub RPC support before launch
unless there is a concrete product workflow. If added later, propagate
`auth_method`/API-key principal data through hub dispatch and require
per-function API-key policy.

## Freshness Result

Fresh-auth transport exists and is used by several endpoint families. A shared
Conat dangerous-session helper now covers the first account/admin/org tranche,
but there is still no central registry that marks dangerous operations. The
remaining issue is that dangerous endpoints are still easy to add or review as
ordinary `authFirst` methods without remembering freshness.

Recommended implementation pattern:

1. Use the shared Conat endpoint helper
   `requireDangerousSessionAuth({ account_id, session_hash, require_second_factor })`.
2. Use it only server-side; CLI and browser callers already forward a session
   hash when authenticated by a remember-me/browser session.
3. Return `fresh_auth_required` or `two_factor_required` consistently so browser
   UI and CLI can route users to existing fresh-auth/elevation flows.
4. Add focused tests per endpoint family.

Suggested next priority for freshness gates:

1. RootFS catalog/admin mutation.
2. Organization membership/admin mutation if treated as equivalent to token
   issuance.
3. Decide whether legacy `system.generateUserAuthToken` should be gated,
   retired, or explicitly accepted for its bootstrap use case.

## Release Decision

Recommended current statuses:

- `SEC-KEY-001`: keep `guarded`; the first-release API-key posture is acceptable
  because dangerous hub RPCs are denied by default. Remaining work is audit
  events and future websocket hub API-key support only if needed.
- `SEC-CLI-001`: keep `guarded`; the endpoint-level audit is complete, but
  several freshness gaps remain after the account/admin/org and host gate
  tranches. Either implement the prioritized gates above or explicitly accept
  the residual risk for first release.
