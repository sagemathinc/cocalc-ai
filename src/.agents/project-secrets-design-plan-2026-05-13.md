# Project Secrets Design Plan

Date: 2026-05-13

Status: proposal for review.

## Goal

Add first-class per-project secrets for API keys, SSH private keys, service
tokens, site-development master keys, and similar sensitive runtime material.

Project secrets should be safer than putting sensitive values in project files
or project environment variables:

- not stored in the project home directory.
- not included in project file downloads.
- not included in public sharing.
- not included in rootfs publishing.
- not included in project backups, even if the project backup repository
  password leaks.
- encrypted at rest in central Postgres and in any project-host local cache.
- available to the running project as read-only files.

This is defense in depth. It does not protect a secret from code that is already
running inside the project runtime.

## Explicit Security Boundary

Project secrets are project-scoped, not user-scoped.

If a user can execute code in a project, that user can read all mounted project
secrets for that project. This must be stated directly in the UI help popover.

No per-user secret model is planned for this feature. A shared project runtime is
not a real isolation boundary between collaborators.

## User-Facing Model

Project Settings gets a new `Secrets` section separate from existing
`Environment Variables`.

The section supports:

- list secret names and metadata.
- add a secret.
- replace a secret value.
- delete a secret.
- show runtime path for each secret.
- explain that changes require project restart for the first implementation.

The UI does not reveal secret values after save. A user with runtime access can
inspect the mounted file in a terminal if they truly need the value.

Suggested UI help text:

> Secrets are mounted as read-only files into the running project at
> `/run/secrets/cocalc/<name>`. They are encrypted at rest and are not stored in
> project files, backups, rootfs images, downloads, or public shares. Any code or
> collaborator with access to this running project can read these files.

## Runtime Path

Use:

```text
/run/secrets/cocalc/<name>
```

Rationale:

- `/run` is the standard Linux runtime-state location.
- `/run/secrets` is a common convention from container/orchestration tooling.
- it is outside `$HOME`, `/tmp`, and the rootfs publish tree.
- it clearly signals runtime-only material.

Do not use `/tmp/secrets`; `/tmp` has weaker semantics and is frequently used by
tools that scan, copy, or expose temporary files.

Do not add a convenience `/secrets` symlink in the first implementation. One
documented path is better.

## Limits

Add hard limits to avoid abuse and accidental giant runtime mounts.

Initial constants:

```ts
PROJECT_SECRETS_MAX_COUNT = 20;
PROJECT_SECRET_NAME_MAX_LENGTH = 128;
PROJECT_SECRET_VALUE_MAX_BYTES = 64 * 1024;
PROJECT_ENV_MAX_COUNT = 50;
PROJECT_ENV_KEY_MAX_LENGTH = 128;
PROJECT_ENV_VALUE_MAX_BYTES = 16 * 1024;
PROJECT_ENV_TOTAL_MAX_BYTES = 128 * 1024;
```

These are intentionally conservative. They can later become membership-tier
limits if needed.

Existing project environment variables should get caps as part of this work.
Current `setProjectEnv` writes the `projects.env` JSON value directly after
collaborator authorization; no obvious setter-level cap exists. This is a
separate hardening item but should be done in the same implementation window.

## Secret Name Validation

Secret names become filenames, so validation must be strict.

Suggested rule:

```text
^[A-Z0-9_][A-Z0-9_.-]{0,127}$
```

Also reject:

- names containing `/`.
- names containing `..`.
- names equal to `.` or `..`.
- names that differ only by case from an existing secret, unless we make names
  case-sensitive end-to-end. Prefer uppercase names in UI examples.

This rule is intentionally environment-variable-like while allowing dots and
dashes for common secret file naming.

## Central Storage

Use a dedicated Postgres table instead of adding encrypted values to
`projects.env` or `projects.settings`.

Proposed table:

```sql
CREATE TABLE project_secrets (
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_value JSONB NOT NULL,
  value_bytes INTEGER NOT NULL,
  created_by UUID REFERENCES accounts(account_id),
  updated_by UUID REFERENCES accounts(account_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, name)
);

CREATE INDEX project_secrets_project_id_idx ON project_secrets(project_id);
```

Do not expose this table through generic `user_query`.

## Crypto

Derive a purpose key from the site master key:

```ts
deriveSiteMasterKey(siteMasterKey, "project-secrets:v1");
```

Each secret value is encrypted independently using AES-256-GCM. The authenticated
data must bind:

- purpose: `project-secrets:v1`.
- project_id.
- secret name.
- encoding/version.

Suggested encrypted payload shape:

```ts
{
  key_id: "site-master-key-v1",
  purpose: "project-secrets:v1",
  cipher: "aes-256-gcm",
  iv_base64: string,
  tag_base64: string,
  data_base64: string,
  created_at: string
}
```

Do not log plaintext values or decrypted byte lengths beyond the explicit
validated `value_bytes`.

## Central API

Add Conat hub API methods:

- `listProjectSecrets({ account_id, project_id })`
- `setProjectSecret({ account_id, project_id, name, value })`
- `deleteProjectSecret({ account_id, project_id, name })`

Optional later:

- `setProjectSecretsBulk(...)`
- `deleteProjectSecretsBulk(...)`

Permissions:

- require project collaborator for list/set/delete initially.
- consider requiring owner/admin for set/delete before public release if
  collaborator write access is too broad.
- admins may list metadata without project membership only through admin paths.

Return values:

- list returns names and metadata only.
- set/delete return success and updated metadata.
- no API returns plaintext secret values to browsers.

Audit events:

- `project_secret_created`
- `project_secret_updated`
- `project_secret_deleted`
- `project_secret_sync_to_host_failed`
- `project_secret_mount_failed`

Audit payloads include project_id, actor account_id, name, and host_id when
applicable. They never include values.

## Project-Host Cache

The project-host needs to start projects when the central hub is temporarily
unavailable, so it should maintain a local encrypted cache.

Use project-host SQLite:

```sql
CREATE TABLE IF NOT EXISTS project_secrets (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  value_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name)
);
```

Store encrypted payloads, not plaintext. The project-host keeps the
`project-secrets:v1` derived key in memory after receiving it from the hub during
project-host registration/bootstrap.

Project-host local cache update paths:

- project start metadata fetch includes secret metadata/encrypted payloads, or a
  dedicated `hosts.getProjectSecretsForStart` RPC is called during start.
- after `setProjectSecret` or `deleteProjectSecret`, the hub publishes a
  project detail invalidation / host sync event.
- if live sync fails, next project start refreshes from hub.

The cache is useful only with the in-memory derived key. If the project-host
restarts and cannot reach hub to receive the key, it cannot decrypt cached
secrets. That is acceptable for the first implementation and avoids persisting
decryption keys on project-host disk.

## Runtime Materialization

At project start:

1. project-host resolves encrypted secrets from local cache, refreshing from hub
   when available.
2. project-host decrypts values in memory.
3. project-host creates a host-side runtime directory outside project home, e.g.
   `/run/user/<uid>/cocalc-project-secrets/<project_id>/`.
4. project-host writes one file per secret with mode `0400` or `0440`.
5. project-host starts Podman with a read-only bind mount:

```text
host runtime dir -> /run/secrets/cocalc
```

6. after project stop, project-host deletes the host-side runtime directory.

The host-side plaintext directory must be:

- outside project home.
- outside rootfs state.
- outside backup roots.
- deleted on stop and on project-host startup GC.
- private to the runtime user.

Use atomic write into a temporary directory and rename into place to avoid
partially materialized secret sets.

First implementation can require project restart after secret changes. Hot
reload can come later.

## Podman Wiring

Extend runner `Configuration` with an optional mount:

```ts
secrets?: {
  host_path: string;
  container_path: "/run/secrets/cocalc";
}
```

Then in project-runner Podman args:

- add read-only bind mount for `secrets.host_path`.
- never pass secret values via `-e`.
- do not add this mount if there are zero secrets.

The existing project runner already handles read-only mounts and home/tmp
mounts; this should be a small extension.

## Backups, Sharing, Downloads, RootFS

Project secrets should be safe by construction because the runtime mount is
outside project home and rootfs.

Still audit these paths:

- project file archive/download.
- public directory sharing.
- project backup home traversal.
- rootfs publish/clone paths.
- file-server absolute path handling.
- app/public preview paths.
- terminal and Jupyter working directories.

If any code can access arbitrary absolute host paths, ensure it cannot traverse
into the host-side secret materialization directory.

## Environment Variables Hardening

Do not merge secrets and environment variables.

Add validation/caps to `setProjectEnv`:

- at most `PROJECT_ENV_MAX_COUNT` variables.
- key validation, likely stricter than secrets:
  `^[A-Za-z_][A-Za-z0-9_]{0,127}$`.
- value byte length cap.
- total serialized size cap.
- reject keys with `COCALC_` prefix unless explicitly allowed.
- reject or warn on obvious secret-looking names? Do not block automatically at
  first; add UI warning that secrets belong in Project Secrets instead.

This avoids repeating the class of incident where secrets and plain env config
are mixed in the same storage/access path.

## UI Plan

Project Settings:

- keep `Environment Variables` section for non-secret configuration.
- add `Secrets` section nearby but visually distinct.
- include a help popover with the explicit runtime access warning.
- list rows: name, path, updated time, updated by, actions.
- actions: add, replace, delete.
- no reveal button.
- after add/replace/delete, show “restart project to apply”.

Suggested copy:

> Store API keys and private tokens as files mounted at runtime. Secrets are
> encrypted at rest and are not included in project files, backups, public
> shares, rootfs images, or downloads. Any code running in this project can read
> them.

## CLI/API Plan

Optional but useful:

```sh
cocalc project secrets list <project>
cocalc project secrets set <project> NAME --file path
cocalc project secrets set <project> NAME --stdin
cocalc project secrets delete <project> NAME
```

Do not print values.

## Implementation Phases

### Phase 1: Spec Constants and Crypto

- Add project secret constants and validation helpers.
- Add `project-secrets:v1` to `SiteMasterKeyPurpose`.
- Add encrypt/decrypt helpers with authenticated metadata.
- Unit-test validation and crypto tamper failures.

### Phase 2: Central Schema and Hub API

- Add `project_secrets` schema/migration.
- Implement list/set/delete helpers in server/database code.
- Add Conat hub API methods.
- Enforce count and value-size limits transactionally.
- Add audit events.
- Unit-test permissions, count caps, invalid names, and no plaintext returns.

### Phase 3: Environment Variable Caps

- Add validation/caps to `setProjectEnv`.
- Add tests for count, key, value, total-size, and `COCALC_` prefix behavior.
- Update UI error display if needed.

### Phase 4: Project-Host Sync and Cache

- Extend project-host bootstrap/registration to receive the in-memory
  `project-secrets:v1` key from hub.
- Add local SQLite `project_secrets` cache.
- Add sync/fetch method used during project start.
- Add tests that cache stores encrypted blobs and start fails closed or starts
  without secrets according to the chosen policy.

Recommended first policy:

- if project has configured secrets and project-host cannot decrypt/materialize
  them, fail project start with a clear error.
- do not silently start without secrets, since that can cause confusing or
  unsafe application behavior.

### Phase 5: Runtime Mounting

- Add secret materialization directory helper.
- Write decrypted files atomically with private permissions.
- Extend runner `Configuration` and Podman args to read-only mount
  `/run/secrets/cocalc`.
- Clean up materialized directories on stop and project-host startup.
- Add tests for Podman args and cleanup.

### Phase 6: UI

- Add Project Settings `Secrets` section.
- Add help popover.
- Add add/replace/delete flows.
- Ensure no secret value reveal path.
- Show restart-required notice.

### Phase 7: End-to-End Security Audit

- Verify project archive download excludes secrets.
- Verify public sharing cannot access secrets.
- Verify rootfs publish excludes secrets.
- Verify project backups exclude secrets.
- Verify logs and audit events do not include values.
- Verify project restart applies changes.
- Verify central hub outage behavior.

## Open Questions

- Should set/delete require owner/admin instead of any collaborator? Initial
  collaborator access is simple and matches project-scoped runtime access, but
  owner/admin-only reduces accidental secret changes.
- Should secret names be case-insensitive? Prefer case-sensitive storage but
  reject case-collisions in the UI/API to avoid cross-platform confusion.
- Should there be a membership-tier cap later? Start with constants.
- Should project-host receive the derived `project-secrets:v1` key at startup or
  per project-start request? Startup is simpler; per-request reduces exposure
  but adds complexity.
- Should hot reload be supported later? Yes, but restart-required is safer for
  the first release.

## Release Recommendation

This is a valuable security feature, but not a blocker for `cocalc.ai` release
unless we need to store operational secrets inside CoCalc projects for launch.

If implemented before release, keep the first version intentionally strict:

- no reveal.
- restart required.
- hard caps.
- project-scoped only.
- file mounts only, no env injection.
- fail start if configured secrets cannot be materialized.
