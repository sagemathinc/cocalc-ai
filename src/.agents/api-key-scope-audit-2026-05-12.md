# SEC-KEY-001: Account and Project API Key Scope Audit

Date: 2026-05-12

Status: guarded.

## Findings

- User-managed v2 CoCalc API keys still share one table for account-wide keys
  and legacy project-scoped keys:
  `api_keys(account_id, project_id, key_id, hash, expire, name, trunc,
last_active)`.
- Account API keys authenticate as the owning account and are currently broad.
  They do not yet carry capability restrictions or an allowed-project list.
- Legacy project-scoped CoCalc API keys authenticated directly as
  `{project_id}`. That special principal shape leaked into generic auth helpers,
  the hub proxy, the Conat socket auth adapter, and the HTTP Conat project
  bridge.
- CLI `account api-key ...` creates account-wide CoCalc API keys only. The
  project Codex API-key commands manage OpenAI external credentials and are not
  CoCalc API keys.
- Project secret-token auth is a separate project-host/project-scoped mechanism.
  This audit did not remove or change project secret tokens.

## Implemented Guard

- Project-scoped CoCalc API-key creation and editing are now rejected server-side
  with a clear message.
- Existing project-scoped CoCalc API keys are still listable and deletable from
  the project settings path so they can be cleaned up.
- Project-scoped CoCalc API keys no longer authenticate. `getAccountWithApiKey`
  returns account principals only.
- Cluster account API-key directory entries now carry explicit `scope="account"`
  metadata. Directory fallback rejects legacy entries without that scope so old
  mirrored project-key rows cannot become broad account keys on another bay.
- Deleting a legacy project-scoped CoCalc API key also deletes its cluster
  directory entry when one exists.
- Generic API-key HTTP auth no longer mixes account IDs and project IDs.
- The HTTP Conat project bridge now requires an account API key plus an explicit
  `project_id`, then checks normal collaborator access.
- Project settings no longer offer creation/editing for project-specific CoCalc
  API keys; the UI explains that account keys should be used until scoped
  account keys land.

## Residual Risk

- Account API keys remain equivalent to broad account credentials. That is too
  powerful for automation, CLI, billing, account security, and admin-adjacent
  operations.
- Hub Conat API dispatch currently derives `account_id` from the request
  subject. After the socket is authorized, endpoint argument transforms do not
  know whether the account principal came from a browser cookie, account API key,
  or agent bearer token. This prevents a clean central "API keys cannot call
  dangerous endpoints" guard until auth method is propagated into dispatch.
- The `api_keys.project_id` column still exists for cleanup and future migration.
  The target model remains account-owned API keys with explicit capabilities and
  allowed-project IDs, as specified in
  `scoped-account-api-keys-contract.md`.
- Existing account API keys whose cluster directory rows predate the new
  `scope` field may not work through directory-only fallback until the key is
  successfully used on its home bay and resynced with `scope="account"`.
- Account API-key creation, deletion, and use on dangerous endpoints still need
  central audit events.

## Recommended Next Work

1. Propagate auth method through Conat hub dispatch, e.g. `auth_method:
"cookie" | "api_key" | "agent" | "project_secret" | "hub_password"`.
2. Add a dangerous-endpoint transform that rejects `auth_method="api_key"` until
   scoped API-key capabilities exist.
3. Extend `api_keys` and the cluster account API-key directory with
   `capabilities` and `allowed_project_ids`.
4. Update account API-key UI/CLI creation to require explicit scopes instead of
   silently creating unrestricted keys.
5. Delete existing `api_keys.project_id IS NOT NULL` rows during the scoped-key
   migration, then remove project-key CRUD/schema branches.
