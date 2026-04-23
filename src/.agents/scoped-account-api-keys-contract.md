# Scoped Account API Keys Contract

Date: 2026-04-23

## Decision

CoCalc-ai should have exactly one user-managed API key model:

- **account-owned API keys**

Project API keys should be removed instead of deprecated. This product is not
publicly released yet, and there is no current product need for a separate
project-owned key species.

The replacement for any former "project key" use case is an
**account-owned API key with explicit scope restrictions**, especially a
project allowlist.

## Why

The current split between account-wide keys and project-scoped keys adds
unnecessary complexity:

- separate semantics for create/list/edit/delete
- special auth behavior that may return either `account_id` or `project_id`
- extra rehome portability logic for project keys
- harder-to-explain security model

Account-wide v2 keys are already the right multibay primitive:

- portable lookup by random `key_id`
- cluster directory support
- attached-bay ingress compatibility

Extending that one model with scope is simpler than carrying forward a second
key kind with no clear product role.

## Product Contract

Every API key:

- is owned by exactly one account
- authenticates as that account
- may be restricted by capabilities
- may be restricted to a finite set of projects
- may expire
- is portable across bays

Authentication answers only:

- who owns this key?
- what capabilities and restrictions does this key carry?

Authentication does **not** directly grant project identity. Project access is
an authorization question that combines:

- authenticated `account_id`
- API key capability set
- API key project allowlist
- existing collaborator / ownership / admin checks

## Scope Model

### Required fields

- `owner_account_id`
- `capabilities: text[]`
- `allowed_project_ids: uuid[]`
- `expire`
- `name`
- `key_id`
- `hash`
- `last_active`

### Capability vocabulary, first slice

These should be exact strings, stored in the database:

- `account:read`
- `account:write`
- `project:read`
- `project:write`
- `project:exec`
- `billing:read`
- `billing:write`
- `host:read`
- `host:write`

Reserved for later and not user-creatable in the first slice:

- `admin:*`
- `bay_ops:*`

### Project restriction rule

- If a key includes any `project:*` capability, then `allowed_project_ids`
  must be non-empty.
- If a key includes no `project:*` capability, then `allowed_project_ids`
  must be empty.

This avoids ambiguous "all my projects" semantics and keeps the first version
predictable and least-privilege by default.

## Exact Schema Changes

Current table:

- `api_keys(id, account_id, project_id, expire, created, hash, key_id, name, trunc, last_active)`

Target table:

- keep:
  - `id`
  - `account_id`
  - `expire`
  - `created`
  - `hash`
  - `key_id`
  - `name`
  - `trunc`
  - `last_active`
- add:
  - `capabilities TEXT[] NOT NULL DEFAULT '{}'::TEXT[]`
  - `allowed_project_ids UUID[] NOT NULL DEFAULT '{}'::UUID[]`
- remove:
  - `project_id`

Suggested constraints:

- unique index on `key_id`
- GIN index on `capabilities`
- GIN index on `allowed_project_ids`

Suggested invariant checks in application code:

- `capabilities` must be non-empty
- every capability must be from the allowed vocabulary
- `project:*` implies `allowed_project_ids` non-empty
- no `project:*` implies `allowed_project_ids` empty

Because the product is unreleased, we do **not** need a compatibility layer for
legacy project keys. We can delete them and migrate directly to the new shape.

## Exact Auth Contract Changes

Current auth path:

- API key auth may return either `{ account_id }` or `{ project_id }`

Target auth path:

- API key auth always returns:
  - `account_id`
  - `api_key_id`
  - `capabilities`
  - `allowed_project_ids`

Example TypeScript shape:

```ts
interface ApiKeyPrincipal {
  account_id: string;
  api_key_id: number;
  key_id: string;
  capabilities: string[];
  allowed_project_ids: string[];
}
```

This means:

- remove the `project_id` return path from API-key authentication
- remove project-key-specific wrong-bay auth behavior
- keep account-key cluster-directory portability by `key_id`

Authorization helpers should then answer:

- `keyAllows(capability)`
- `keyAllowsProject(project_id)`

Project authorization becomes:

1. key authenticates as `account_id`
2. key must include the required `project:*` capability
3. key must include the target `project_id` in `allowed_project_ids`
4. account must still have local collaborator/admin access under normal rules

## Exact Manage API Changes

Current manage flow overloads account keys and project keys using optional
`project_id`.

Target manage flow:

- `createApiKey({ account_id, name, expire, capabilities, allowed_project_ids })`
- `listApiKeys({ account_id })`
- `getApiKey({ account_id, id })`
- `updateApiKey({ account_id, id, name, expire, capabilities, allowed_project_ids })`
- `deleteApiKey({ account_id, id })`

Delete support for:

- `project_id` parameter on key management
- project-collaborator creation/deletion/editing of keys for a project

All key management becomes account-owned and account-scoped.

## Multibay Contract

Account-owned scoped keys remain the multibay portability primitive:

- keep the existing random `key_id`
- keep the cluster account API-key directory
- extend the directory payload to include:
  - `capabilities`
  - `allowed_project_ids`

This keeps attached-bay ingress and cross-bay portability working without
reintroducing a second key class.

## UI Contract

Replace separate project-key concepts with one account-key UI that includes:

- name
- expiration
- capabilities picker
- allowed project picker

Suggested presets:

- `Account settings read/write`
- `Single-project automation`
- `Single-project read-only`
- `Billing read-only`

No separate project-key UI should remain.

## Migration Plan

Because CoCalc-ai is unreleased, use the simplest migration:

1. Add `capabilities` and `allowed_project_ids`.
2. Delete all rows where `project_id IS NOT NULL`.
3. Remove `project_id` from auth and manage paths.
4. Drop `project_id` from the schema.
5. Update the cluster account API-key directory to carry scope fields.
6. Update callers to use scoped account-key authorization.

No backward compatibility for project keys is required.

## Non-goals

Not part of this change:

- scoped operator / bay-ops credentials
- replacing browser cookies or bearer auth
- project-host host-scoped auth tokens
- organization-owned API keys
- wildcard "all current and future collaborator projects" semantics

Those can come later if there is a real product need.

## Recommended Next Implementation Order

1. Extend `api_keys` and the cluster account API-key directory with scope data.
2. Change API-key auth to always return account-scoped principals.
3. Update manage API and UI to create/edit scoped account keys only.
4. Delete project-key CRUD/auth branches.
5. Add focused tests for:
   - account-only keys
   - project-allowlisted keys
   - wrong-project rejection
   - attached-bay auth with scoped account keys
   - account rehome preserving scoped key behavior
