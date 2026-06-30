# Project Migration Between CoCalc-AI Sites, 2026-06-30

Status: implementation plan.

## Goal

Provide an admin-only `cocalc-cli` workflow to copy one project from CoCalc-AI
site A into CoCalc-AI site B efficiently and robustly.

The target use case is trusted administration of two sites that we operate, for
example moving large projects from `alpha.cocalc.ai` or `delta.cocalc.ai` into
`cocalc.ai`.

The desired data plane is:

1. Site B creates a destination project and assigns it a normal project-backup
   rustic repository.
2. Site A's project-host backs up the source project HOME directly into site
   B's project-backup repository.
3. Site B records the resulting rustic snapshot as a backup of the destination
   project.
4. The destination project remains archived until restored or started normally.

This avoids the expensive path:

- create a huge tarball,
- upload it,
- download and extract it,
- immediately upload the full extracted tree again as a normal backup.

For a 60 GB project, the intended steady-state cost is one upload into the
destination backup repo, not an upload/download/reupload cycle.

## Non-Goals

- Do not migrate root filesystem state.
- Do not migrate `.local/share/cocalc/rootfs`.
- Do not migrate overlayfs upperdirs, lowerdir references, rootfs hashes,
  runtime image selections, system packages, kernels, or container state.
- Do not migrate billing, memberships, or collaborators in v1.
- Do not implement arbitrary non-admin user self-service migration in v1.
- Do not require direct network connectivity from project-host A to
  project-host B.
- Do not proxy project data through the hub/control plane.

The v1 contract is intentionally simple:

> Copy the source project's HOME directory contents into a destination project's
> backup repository. The destination project uses the destination site's normal
> rootfs defaults when restored or started.

## Command UX

Primary command:

```sh
cocalc migrate A:<project_id> B --owner <email-or-account-id>
```

Recommended explicit form, if we want subcommands:

```sh
cocalc migrate project A:<project_id> B --owner <email-or-account-id>
```

`A` and `B` are existing CLI auth profiles. Both must authenticate as admins.

Default behavior should be `archive-only`: create the destination project and
an available backup snapshot, but do not restore it immediately.

Common examples:

```sh
cocalc migrate alpha:dc174776-a5f1-4465-89c9-c723ef069ed6 prod \
  --owner wstein@gmail.com
```

```sh
cocalc migrate project alpha:dc174776-a5f1-4465-89c9-c723ef069ed6 prod \
  --owner wstein@gmail.com \
  --title "wstein.org" \
  --restore
```

Dry run:

```sh
cocalc migrate alpha:<project_id> prod --owner wstein@gmail.com --dry-run
```

Useful options:

- `--owner <email-or-account-id>`: required destination owner.
- `--title <title>`: destination project title override.
- `--description <text>`: destination project description override.
- `--archive-only`: default; create backup but do not restore.
- `--restore`: after finalizing the backup, restore it into the destination.
- `--stop-source`: stop the source project before snapshotting.
- `--no-stop-source`: allow btrfs snapshot while source is running; default for
  v1 unless we decide otherwise.
- `--require-source-stopped`: fail if the source project is running.
- `--disk-mb <n>`: destination project disk quota/override.
- `--disk-mb auto`: default for admin migration; set an admin project disk
  override from source usage plus a safety margin.
- `--json`: machine-readable progress/final result.
- `--wait`: wait for source backup and optional destination restore.
- `--timeout <duration>`: CLI wait timeout.
- `--yes`: required for non-interactive execution because site B exposes
  backup-write credentials to site A.

Initial warning text should be explicit:

```text
This migrates project HOME files only.
Root filesystem state and .local/share/cocalc/rootfs are excluded.
The destination project will use the destination site's default rootfs.
Site B will issue backup-write credentials that site A can use for this
migration. Use this only between sites you administer and trust.
```

## Architecture Fit

This follows the multibay rule:

- site A's owning bay remains authoritative for reading the source project;
- site B's owning bay becomes authoritative for the destination project;
- heavy project data moves directly between a project-host and object storage;
- hubs coordinate and authorize but do not carry project data.

This also fits the existing project backup model:

- destination project gets a normal `backup_repo_id`;
- backup data is written to a normal project backup rustic repo;
- destination restore uses the normal backup restore path;
- later backups on B should dedupe against the migrated backup because they use
  the same destination repo.

## Data Model

Add a destination-side migration record table. This is useful for idempotency,
auditing, failure recovery, and CLI status.

Proposed table: `project_site_migrations`.

Columns:

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `source_site TEXT NOT NULL`
- `source_project_id UUID NOT NULL`
- `destination_project_id UUID NOT NULL`
- `destination_owner_account_id UUID NOT NULL`
- `destination_backup_repo_id UUID`
- `status TEXT NOT NULL`
- `source_backup_op_id UUID`
- `destination_restore_op_id UUID`
- `snapshot_id TEXT`
- `backup_index_key TEXT`
- `source_project_title TEXT`
- `source_project_description TEXT`
- `source_usage_bytes BIGINT`
- `backup_summary JSONB NOT NULL DEFAULT '{}'::jsonb`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- `error TEXT`
- `created_by UUID`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `completed_at TIMESTAMPTZ`

Suggested statuses:

- `prepared`
- `source-backup-running`
- `source-backup-failed`
- `backup-written`
- `finalized`
- `restore-running`
- `restored`
- `failed`
- `cancelled`

Add indexes:

- `(source_site, source_project_id)`
- `(destination_project_id)`
- `(status)`
- `(created_at)`

Do not add source-side durable state in v1 beyond the source backup LRO. The
destination migration record is enough to resume/finalize from the CLI.

## Destination Project Semantics

The destination project should be created as an archived/unprovisioned project
with a backup repo assignment.

Concrete target:

- `projects.backup_repo_id` is assigned.
- `projects.provisioned=false` until restored/started.
- project title/description come from source unless CLI overrides.
- owner is the required `--owner` account.
- rootfs/runtime fields are destination defaults only.
- no source rootfs metadata is copied.
- if `--disk-mb auto`, create an admin project disk entitlement override of
  `ceil(source_usage_bytes / MiB) + 1024`, or a configurable margin.

The backup created by migration should appear in the destination project's
normal backup browser with metadata that clearly identifies it:

- source site
- source project id
- migration id
- backup time
- "project migration" tag

## RPC Contract

Use admin-only Conat hub RPCs. They must be classified in the dangerous RPC
registry and require fresh auth for CLI admin sessions.

### Destination: Prepare Incoming Migration

RPC:

```ts
projects.prepareIncomingProjectBackupMigration({
  source_site: string;
  source_project_id: string;
  owner: string;              // email or account_id
  title?: string;
  description?: string;
  disk_mb?: number | "auto";
  restore_after_finalize?: boolean;
})
```

Responsibilities on site B:

1. Assert caller is admin with fresh auth.
2. Resolve `owner` to a destination account.
3. Create a destination project row, or resume an existing prepared migration
   when an idempotency key is supplied later.
4. Assign a normal project backup repo using the existing project backup shard
   allocator.
5. Build a backup-write config for that exact repo:
   - rustic TOML,
   - repo id,
   - index-store config if needed,
   - short TTL metadata, even if v1 credentials are not truly short-lived.
6. Create `project_site_migrations` row with `status='prepared'`.
7. Return destination project metadata and the secret backup-write config.

Return shape:

```ts
{
  migration_id: string;
  destination_project_id: string;
  destination_backup_repo_id: string;
  destination_project_url?: string;
  rustic_repo_toml: string;
  backup_index_store?: ProjectBackupIndexStoreConfig;
  expires_at: string;
  warnings: string[];
}
```

Security note: v1 can expose broad R2 credentials because this is admin-only and
between trusted sites. The API and CLI must still avoid logging TOML or secrets.

Later hardening:

- issue scoped Cloudflare R2 credentials for one repo prefix;
- use one-time migration write tokens;
- make the destination repo reject non-migration tags from external writers.

### Source: Backup Project To External Repository

RPC:

```ts
projects.backupProjectToExternalRepository({
  project_id: string;
  destination_site: string;
  destination_project_id: string;
  migration_id: string;
  rustic_repo_toml: string;
  backup_index_store?: ProjectBackupIndexStoreConfig;
  exclude_rootfs_state: true;
  stop_source?: boolean;
  require_source_stopped?: boolean;
  tags?: string[];
})
```

Responsibilities on site A:

1. Assert caller is admin with fresh auth.
2. Resolve source project to its owning bay and project-host.
3. Queue an LRO, routed to the owning bay/project-host if needed.
4. On the source project-host:
   - create an isolated btrfs snapshot/clone of the project HOME;
   - remove `.local/share/cocalc/rootfs` from the clone;
   - write a temporary repo profile from `rustic_repo_toml` with mode `0600`;
   - run rustic backup from the clone into site B's repo;
   - generate/upload the backup index for `destination_project_id`, not
     `source_project_id`;
   - delete the temporary clone and repo profile.
5. Return the rustic snapshot id, summary, index key, and source usage
   estimates.

Return shape:

```ts
{
  op_id: string;
  scope_type: "project";
  scope_id: string; // source project id
  service: string;
  stream_name: string;
}
```

The LRO result should include:

```ts
{
  migration_id: string;
  destination_project_id: string;
  snapshot_id: string;
  backup_index_key?: string;
  backup_summary: {
    files_new?: number;
    files_changed?: number;
    bytes_added?: number;
    total_bytes?: number;
  };
}
```

### Destination: Finalize Incoming Migration

RPC:

```ts
projects.finalizeIncomingProjectBackupMigration({
  migration_id: string;
  destination_project_id: string;
  snapshot_id: string;
  backup_index_key?: string;
  source_backup_result: object;
  restore?: boolean;
})
```

Responsibilities on site B:

1. Assert caller is admin with fresh auth.
2. Load and validate the migration row.
3. Verify that the destination project and backup repo still match.
4. Optionally verify that the snapshot exists in the destination repo:
   - `rustic snapshots --json <snapshot_id>` or equivalent helper.
5. Record/import the backup index metadata so the snapshot appears in normal
   backup listings.
6. Set migration `status='finalized'`.
7. If `restore=true`, queue the normal destination restore path using the
   migrated backup id/snapshot.

Return shape:

```ts
{
  migration_id: string;
  destination_project_id: string;
  snapshot_id: string;
  status: "finalized" | "restore-running" | "restored";
  restore_op_id?: string;
}
```

## Project-Host Snapshot Strategy

The source host should not rely on rustic exclude rules alone for rootfs state.
The safer v1 implementation is:

1. Create a temporary read-write btrfs snapshot/clone of the project HOME.
2. Delete `.local/share/cocalc/rootfs` from the temporary clone.
3. Back up the temporary clone.
4. Delete the temporary clone.

Reasons:

- the backup input tree is exactly what we intend to migrate;
- accidental rustic include/exclude bugs are less likely to leak rootfs state;
- the clone gives an atomic view even if the source project keeps running;
- future excludes can be implemented as ordinary filesystem cleanup of the
  clone.

Expected temp path:

```text
/var/lib/cocalc/star/project-host/<n>/migration-tmp/<migration_id>/home
```

Required cleanup:

- always delete clone on success/failure;
- startup/reconcile should garbage collect stale `migration-tmp` clones older
  than a safe threshold;
- temp clones should bypass normal project quota bookkeeping, like other
  host-local temporary rootfs/rustic staging clones.

Minimum rootfs deletion:

```text
.local/share/cocalc/rootfs
```

Do not delete all of `.local/share/cocalc` in v1. Time-travel and other user
project state may live under hidden project directories, and we want this to be
a HOME migration, not a cleanup tool.

If btrfs snapshot creation is unavailable, v1 should fail clearly:

```text
project migration requires btrfs snapshot support on the source project host
```

Do not silently fall back to tar/rsync staging for v1.

## Storage Wrapper Changes

The privileged wrapper `/usr/local/sbin/cocalc-runtime-storage` likely needs a
new narrowly-scoped command rather than expanding the existing generic rustic
backup command too much.

Proposed command:

```text
cocalc-runtime-storage project-migration-rustic-backup \
  --source-project-home <path> \
  --migration-id <uuid> \
  --destination-project-id <uuid> \
  --repo-profile <path> \
  --host <host-label>
```

Responsibilities:

- validate all paths are under the project-host data root;
- create/delete temp btrfs clone;
- remove `.local/share/cocalc/rootfs` inside the clone;
- invoke rustic with migration tags;
- output JSON summary with snapshot id.

Alternative: implement clone/delete in TypeScript and reuse
`project-rustic-backup`. This is acceptable only if the wrapper already safely
supports the needed btrfs operations. The security boundary should stay inside
the wrapper for path validation.

Tags to attach to the rustic snapshot:

- `cocalc-project-migration`
- `migration:<migration_id>`
- `source-site:<site>`
- `source-project:<source_project_id>`
- `destination-project:<destination_project_id>`

## Backup Index Handling

The migrated snapshot must be visible to site B's normal backup browser and
restore flow.

There are two possible implementation paths:

### Preferred

Source host writes the normal backup index into site B's index store using the
`backup_index_store` config returned by `prepare`.

Important: the index must be keyed by `destination_project_id`, not source
project id.

### Simpler Fallback

Source returns enough manifest/summary data to site B, and site B writes a
minimal backup index record during `finalize`.

This may be easier if the current backup index writer is deeply coupled to the
source project's hub. The tradeoff is that destination backup browsing may show
less detail until a later sync.

The plan should start by reusing the existing project-backup index writer if it
can accept:

- explicit `project_id`,
- explicit `snapshot_id`,
- explicit index-store config.

If not, implement the fallback first and improve later.

## CLI Orchestration

The CLI should not move bytes. It should only coordinate RPCs and stream LRO
progress.

Algorithm:

1. Parse source spec `A:<project_id>` and destination profile `B`.
2. Load auth config for profile A and B.
3. Verify both profiles are admin and fresh-authenticated.
4. Resolve source project metadata on A:
   - title,
   - description,
   - approximate disk usage,
   - running state,
   - host/region if available.
5. Resolve destination owner on B.
6. Print warnings and require confirmation unless `--yes`.
7. Call B `prepareIncomingProjectBackupMigration`.
8. Call A `backupProjectToExternalRepository`.
9. Stream/poll source backup LRO.
10. Call B `finalizeIncomingProjectBackupMigration`.
11. If `--restore`, stream/poll destination restore LRO.
12. Print final destination project id and URL.

Failure behavior:

- If prepare succeeds but source backup fails, leave destination project and
  migration record in failed/prepared state. CLI should print a cleanup command.
- If source backup succeeds but finalize fails, CLI should be retryable using
  `--migration-id`.
- If CLI dies mid-run, `cocalc migrate status B:<migration_id>` should show
  destination status and source op id if known.

Add related commands:

```sh
cocalc migrate status B:<migration_id>
cocalc migrate finalize B:<migration_id> --snapshot-id <snapshot_id>
cocalc migrate cancel B:<migration_id>
```

Only `status` is required for v1; `finalize` and `cancel` can be operator-only
follow-ups if implementation time is tight.

## Restore Behavior

Archive-only should be the default.

In archive-only mode:

- destination project exists in project list;
- destination project is not provisioned/running;
- backup is available;
- first explicit restore/start uses normal destination site restore behavior.

With `--restore`:

- after finalize, call normal destination restore with the migrated backup id;
- destination rootfs stays default;
- source rootfs state remains absent.

Starting a not-yet-restored destination project should use the existing
`backup_repo_id + provisioned=false` auto-restore path if available. If that
path only restores the most recent backup and the migrated backup is not marked
latest, finalize must mark it as the canonical initial backup.

## Quota And Storage

The source side only needs temporary local space for the btrfs clone metadata;
because btrfs snapshots are copy-on-write, this should be small unless rootfs
deletion causes large metadata churn. Deleting `.local/share/cocalc/rootfs`
inside the clone should be safe and should not delete from the source.

Destination side needs:

- enough object storage in the project-backup bucket;
- enough future project disk quota if the user restores.

For admin migrations, default `--disk-mb auto` should set a project-specific
admin disk override on B based on source usage plus margin. This prevents a
large migrated project from being immediately unrestorable due to a smaller
destination membership quota.

Suggested default:

```text
disk_override_mb = ceil(source_usage_bytes / MiB) + 1024
```

If source usage is unavailable, either require `--disk-mb` or skip the override
with a warning.

## Security Model

V1 assumes both sites are administered by the operator running the command.

Controls required even for v1:

- admin-only RPCs;
- fresh-auth required;
- dangerous RPC registry entries;
- do not log rustic TOML, R2 keys, repo passwords, or index-store secrets;
- temp credential/profile files are mode `0600`;
- temp credential/profile files are deleted after use;
- migration records record who initiated the operation;
- source host logs should show migration id and project ids, not secrets.

Known v1 weakness:

- site B may expose broad project-backup bucket credentials to site A.

Acceptable because:

- this is admin-only;
- intended use is between sites we operate;
- it unblocks urgent operational migration.

Future hardening:

- create migration-specific R2 credentials scoped to one repo prefix;
- use a dedicated migration bucket with lifecycle cleanup;
- add one-time write token validated by destination finalize;
- require source snapshot id to carry expected migration tags;
- make destination finalization verify no unexpected projects were written.

## Concurrency And Load Control

Use existing project-backup LRO worker/admission patterns where possible.

New operation should have a separate worker kind only if needed:

- `project-site-migration-backup`

However, since the operation is a project backup into an external repo, it can
probably reuse the `project-backup` worker cap initially, with tags and an
egress override:

- managed egress category: `backup-upload`;
- override reason: `admin-site-migration`;
- do not charge this to ordinary user backup egress limits.

CLI should default to one project at a time. Batch migration can come later:

```sh
cocalc migrate batch projects.txt B --owner ...
```

## Observability

LRO progress should include phases:

- `prepared-destination`
- `snapshot-source`
- `prune-rootfs-state`
- `backup-to-destination-repo`
- `write-backup-index`
- `finalize-destination`
- `restore-destination` when applicable
- `cleanup`

Metrics/log fields:

- migration id;
- source site;
- source project id;
- destination site;
- destination project id;
- destination backup repo id;
- source host id;
- snapshot id;
- bytes added;
- files processed;
- duration by phase.

The CLI should print both:

- human-readable progress by default;
- full JSON with `--json`.

## Idempotency And Recovery

Prepare should accept or internally create an idempotency key:

```text
source_site + source_project_id + owner + title override + created_by
```

For v1, safer behavior is to create a new destination project per invocation,
but expose `--migration-id` for retry.

Retry cases:

- Source backup failed before snapshot id: rerun backup for same migration.
- Source backup succeeded, finalize failed: rerun finalize with same migration.
- Finalize succeeded, restore failed: rerun normal destination restore.

Cleanup cases:

- `prepared` older than N days and no snapshot id: admin cleanup can delete
  destination project and migration row.
- temp btrfs clone older than N hours: project-host reconcile removes it.
- migration repo profile older than N hours: project-host reconcile removes it.

## Tests

### CLI Unit Tests

- parses `A:<project_id> B`;
- rejects missing `--owner`;
- rejects non-UUID project id;
- prints rootfs exclusion warning;
- requires `--yes` in non-interactive mode;
- routes source and destination profiles separately;
- supports `--dry-run`.

### Server Unit Tests

Destination prepare:

- requires admin/fresh auth;
- resolves owner by email/account id;
- creates destination project with no source rootfs metadata;
- assigns `backup_repo_id`;
- returns repo config without logging secrets;
- records migration row.

Source backup:

- requires admin/fresh auth;
- routes to project owning bay;
- queues LRO;
- passes destination project id into backup/index logic;
- sets migration tags;
- excludes rootfs state.

Destination finalize:

- requires admin/fresh auth;
- verifies migration/project/repo consistency;
- records snapshot id;
- records/indexes backup;
- optionally queues restore;
- is safe to retry.

### Project-Host Tests

Mock storage wrapper:

- creates temp btrfs clone;
- deletes `.local/share/cocalc/rootfs` from clone;
- does not delete source rootfs path;
- writes repo profile with mode `0600`;
- removes temp repo profile after backup;
- removes temp clone on success and failure;
- reports rustic progress to LRO.

### Integration Smoke

Use two staging profiles:

1. Create source project with:
   - ordinary files;
   - hidden files;
   - time-travel data if easy;
   - `.local/share/cocalc/rootfs/SHOULD_NOT_COPY`;
   - a large sparse/non-sparse file.
2. Run:

   ```sh
   cocalc migrate staging-a:<project_id> staging-b --owner ...
   ```

3. Verify on B:
   - destination project exists;
   - backup appears;
   - `.local/share/cocalc/rootfs/SHOULD_NOT_COPY` is absent after restore;
   - ordinary files are present;
   - project starts with default destination rootfs;
   - later backup dedup does not re-upload the full project.

## Implementation Phases

### Phase 1: Destination Prepare/Finalize Skeleton

- Add migration table.
- Add admin RPCs:
  - `prepareIncomingProjectBackupMigration`
  - `finalizeIncomingProjectBackupMigration`
  - `getProjectSiteMigrationStatus`
- Create destination project and backup repo assignment.
- Return existing project backup repo TOML/config.
- No source backup yet.

### Phase 2: Source External Backup LRO

- Add source admin RPC `backupProjectToExternalRepository`.
- Add project-host backup path using temp repo profile.
- Add btrfs clone/prune-rootfs-state behavior.
- Return rustic snapshot id and backup summary.

### Phase 3: Backup Index Integration

- Make source write destination backup index directly, or make destination
  finalize write enough index metadata.
- Verify backup appears in existing backup browser and restore APIs.

### Phase 4: CLI

- Add `src/packages/cli/src/bin/commands/migrate.ts`.
- Register `cocalc migrate`.
- Implement two-profile auth loading.
- Implement progress polling and `--json`.
- Add tests.

### Phase 5: Restore Option And Quota Override

- Add `--restore`.
- Add `--disk-mb auto` project entitlement override on B.
- Ensure restored project starts with destination default rootfs.

### Phase 6: Live Smoke And Hardening

- Test with small staging projects.
- Test with one 10 GB plus project.
- Test with a 50-60 GB project.
- Add stale temp cleanup.
- Add operator docs.

## Open Questions

- Does the current project backup index writer already support writing an index
  for a different `project_id` using explicit external index-store config?
- Should source projects be stopped by default? The btrfs snapshot is
  filesystem-consistent, but not necessarily application-consistent for running
  databases.
- Should `--disk-mb auto` be default, or should the CLI require explicit
  confirmation before creating a destination admin disk override?
- Should v1 use a dedicated destination migration bucket instead of the normal
  project-backup bucket, even though that loses immediate dedup with future
  destination backups?
- Should archive-only destination projects be visible in the normal project
  list immediately, or only after restore?

## Recommendation

Implement archive-only migration first, using the destination project's normal
project-backup repo as the transfer target.

Use the read-write btrfs snapshot plus rootfs deletion approach, not rustic
exclude rules alone. It gives a clearer correctness boundary:

- the source HOME snapshot is the migration input;
- rootfs state is physically absent from that input;
- the resulting rustic snapshot is directly usable by destination restore.

Keep the first CLI admin-only and intentionally narrow. Once this works for our
own large projects, we can decide whether to harden credentials and expose a
safer user-facing variant.
