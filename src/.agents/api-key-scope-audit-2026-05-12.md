# SEC-KEY-001: Account and Project API Key Scope Audit

Date: 2026-05-12

Status: project-key model removed; scoped account-key follow-up remains guarded.

## Findings

- User-managed v2 CoCalc API keys now use one account-owned model:
  `api_keys(account_id, key_id, hash, expire, name, trunc, last_active)`.
- Account API keys authenticate as the owning account and are currently broad.
  They do not yet carry capability restrictions or an allowed-project list.
- Legacy project-scoped CoCalc API keys used to authenticate directly as
  `{project_id}`. That special principal shape leaked into generic auth helpers,
  the hub proxy, the Conat socket auth adapter, and the HTTP Conat project
  bridge.
- CLI `account api-key ...` creates account-wide CoCalc API keys only. The
  project Codex API-key commands manage OpenAI external credentials and are not
  CoCalc API keys.
- Project secret-token auth is a separate project-host/project-scoped mechanism.
  This audit did not remove or change project secret tokens.

## Implemented Removal

- Project-scoped CoCalc API-key creation/list/edit/delete paths were removed.
- The project settings API-key panel was removed.
- The project API-key schema column and DB schema index were removed for fresh
  installs.
- Project rehome portable state no longer copies project-scoped CoCalc API
  keys.
- Project hard-delete no longer carries a project-key cleanup branch.
- Project-scoped CoCalc API keys no longer authenticate. `getAccountWithApiKey`
  returns account principals only.
- Cluster account API-key directory entries are account-key entries only; the
  project-key scope discriminator was removed with the project-key model.
- Generic API-key HTTP auth no longer mixes account IDs and project IDs.
- The HTTP Conat project bridge now requires an account API key plus an explicit
  `project_id`, then checks normal collaborator access.

## Residual Risk

- Account API keys remain equivalent to broad account credentials. That is too
  powerful for automation, CLI, billing, account security, and admin-adjacent
  operations.
- Hub Conat API dispatch currently derives `account_id` from the request
  subject. After the socket is authorized, endpoint argument transforms do not
  know whether the account principal came from a browser cookie, account API key,
  or agent bearer token. This prevents a clean central "API keys cannot call
  dangerous endpoints" guard until auth method is propagated into dispatch.
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
5. Add migration/upgrade handling for installations created before the
   project-key model was removed, if any such database needs to be preserved.
