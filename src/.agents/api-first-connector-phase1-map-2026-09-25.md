# API-First Connector: Phase 1 Implementation Map

This implements the contract in [the API-first connector plan](https://github.com/sagemathinc/cocalc-ai/pull/696). The release target is one ordinary account-owned API key model. ACP only issues, renews, and revokes a managed instance of that model.

## Existing paths

| Boundary              | Current path                                                                                               | Required change                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key owner and storage | `server/api/manage.ts`, `api_keys`                                                                         | Add a versioned scope and revision; adapt existing capability/allowlist rows without widening them.                                                                                                      |
| Cluster key lookup    | `server/accounts/cluster-directory.ts`                                                                     | Carry the same scope, revision, and expiry; stale replicas must fail closed.                                                                                                                             |
| Hub HTTP              | `http-api/pages/api/conat/hub.ts`, `server/api/http-api-key-policy.ts`                                     | Allow only classified RPCs and retain the authenticated principal.                                                                                                                                       |
| Hub Conat             | `server/conat/socketio/auth.ts`                                                                            | Keep the Hub account subject closed to API keys until method-level authorization can inspect the principal.                                                                                              |
| Project list          | `server/projects/list-account-window.ts`, `database/postgres/account-project-index.ts`, CLI `project list` | Add a small public API projection and bounded search; the existing window includes users, labels, theme, and internal state. The CLI currently uses `db.userQuery`, which API keys cannot call.          |
| Host exchange         | `server/conat/api/hosts-connection-auth.ts`, `conat/auth/project-host-token.ts`                            | Bind the parent key, revision, exact project, host placement, capabilities, viewer policy, service subjects, reply namespace, and expiry. Ordinary account host tokens cannot stand in for a scoped key. |
| Host enforcement      | `project-host/conat-auth.ts`, viewer file service                                                          | Admit only signed, correctly placed scoped-key subjects. Revalidate the parent and membership during long-lived sessions.                                                                                |
| API Keys UI           | `frontend/components/api-keys.tsx`                                                                         | Extract one scope editor/summary used by manual keys and the CoCalc connector.                                                                                                                           |
| ACP turn              | `project-host/codex/codex-project.ts` and trusted run state                                                | Issue only from a verified live native turn binding; renewal requires the same lease; revocation remains possible after the lease ends.                                                                  |

## Canonical scope and compatibility

Store `scope: { version: 1, account: capability[], projects: grant[] }` and a monotonically increasing `scope_revision`. Each project grant has one exact project ID, explicit capabilities, and optionally a read-only viewer policy. Reject duplicate grants, unknown fields/capabilities, invalid combinations, missing/ambiguous policies, and over-limit scopes. Sort canonical sets so equivalent input has one representation. A project grant never grants account-wide discovery, and a full-runtime preset expands to reviewed data-plane capabilities only.

Rows with no `scope` retain their current meaning: account capabilities stay account-wide, and each existing project capability applies to each ID in the old allowlist. All evaluators consume the adapted canonical scope. No new mixed scope is flattened into the legacy columns. A service that does not understand scope version 1 rejects the key. Editing or deleting a key increments or invalidates its revision before any new derived credential is issued.

## Auth and lifecycle decisions

The account home bay is authoritative for key status. Project owning bay determines current membership; host bay issues host-bound access. A cached positive authorization expires at most 30 seconds after validation began, is clamped to credential expiry and placement generation, and is not extended by traffic or failure to refresh. Every new logical command requires admission. Continuous terminal, Jupyter, sync, preview, and proxy traffic loses credential-backed access within that bound after revocation; a detached process may continue under the established full-runtime trust model.

The derived host token is a distinct version accepted only by the narrow project-host verifier. Its signed claims or immutable server reference bind parent key ID/revision, owner, project, host and placement generation, exact capability set, viewer-policy hash, allowed service subjects/reply namespace, and expiry. It cannot authenticate on Hub/account subjects or fall back to ordinary account host-token behavior. Host migration requires a new exchange. An unavailable authority denies new admission and cannot extend existing sessions.

Managed issuance is bound server-side to `(human, native agent, source project, live run/turn, configuration ID+revision, key ID)`. Idempotency uses the whole verified tuple. Agent input cannot select another identity, run, configuration, or key. Manual keys use the same resource authorization and can be used by external clients. Management actions use separate scopes and the shared exact-action human approval path; selecting such a scope permits a request, never self-approval.

## Delivery order and evidence

1. Prove list, per-project full/viewer grants, budgets, host exchange, and revocation with manually issued keys through raw API and the ordinary CLI.
2. Mount the shared editor in API Keys settings; verify round-trip, keyboard/focus, mobile width, light/dark theme, and revocation.
3. Add the single CoCalc connector as configuration plus trusted turn-key lifecycle. Repeat the manual-key authorization matrix with turn-issued keys.

Test all changes against source A, full B, viewer C, and absent D on different hosts/bays. For viewer C, cover traversal, symlinks, protected namespaces, special files, archives, snapshots, search, previews, and races. For managed keys, cover substitutions, renewal/crash/finalization, copied keys, and session revocation under continuous traffic. Keep the plan's proposed limits finite and adjust only with measured evidence.
