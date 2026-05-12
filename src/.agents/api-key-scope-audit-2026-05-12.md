# SEC-KEY-001: Account and Project API Key Scope Audit

Date: 2026-05-12

Status: project-key model removed; first scoped account-key guard implemented.

## Findings

- User-managed v2 CoCalc API keys now use one account-owned model:
  `api_keys(account_id, key_id, hash, expire, name, trunc, capabilities,
allowed_project_ids, last_active)`.
- Account API keys authenticate as the owning account plus API-key metadata:
  key id, capabilities, and allowed project IDs.
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
- API-key creation and editing require explicit capabilities. Project, file,
  Codex, and exec capabilities require explicit project allowlists.
- API-key Conat websocket auth now fails closed for hub/account RPC subjects and
  only permits allowed project subjects when the key has `project:exec`.
- The HTTP Conat hub bridge now has a small reviewed allowlist and denies API
  keys by default for unreviewed RPCs.

## Residual Risk

- The Conat hub API dispatch still derives `account_id` from the request subject
  and cannot currently apply per-RPC API-key capability policy for websocket
  callers. The websocket path therefore denies API-key hub/account RPC subjects
  entirely.
- Account API-key creation, deletion, and use on dangerous endpoints still need
  central audit events.
- The reviewed HTTP hub allowlist is intentionally tiny and must be extended
  deliberately as real use cases emerge.

## Recommended Next Work

1. Propagate auth method through Conat hub dispatch, e.g. `auth_method:
"cookie" | "api_key" | "agent" | "project_secret" | "hub_password"`, so
   websocket hub RPCs can eventually use endpoint metadata instead of blanket
   API-key denial.
2. Expand the reviewed API-key HTTP allowlist only for concrete use cases.
3. Add audit events for API-key creation, deletion, denial, and successful use.
4. Add migration/upgrade handling for installations created before the
   project-key model was removed, if any such database needs to be preserved.
