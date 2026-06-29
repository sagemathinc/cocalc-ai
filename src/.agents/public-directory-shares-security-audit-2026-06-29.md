# Public Directory Shares Security Audit

Status: first focused audit after implementation

Date: 2026-06-29

## Scope

This audit focused on the paths that can expose project files through public
directory shares:

- share creation and update authorization.
- share resolution and temporary viewer grant creation.
- project-host read-only file service authorization.
- path normalization and symlink/path traversal containment.
- unpublish and viewer-revocation behavior.
- copy-out from a share into another project.
- performance implications of removing broad Conat authorization caching for
  project/viewer/share subjects.

## Findings

### Fixed: read-only share policy cache was too long

The project-host read-only filesystem service cached each subject-specific
filesystem for one hour. For public shares, that filesystem includes the
read-policy fetched from the hub. This meant that disabling a share revoked the
database grant immediately, but an already-open `fs-share` subject could keep
using the old read policy until cache expiry or project-host invalidation.

Change made:

- Reduced the default `fsReadOnlyServer` cache TTL to 60 seconds.
- Added a test that read-only filesystem subjects are rebuilt after TTL expiry.
- Added UI and docs language explaining that already-open viewers may keep
  access for up to about one minute while authorization caches expire.

This is an acceptable first-release tradeoff: revocation is bounded and the hub
is not queried on every file operation.

### No direct path escape found in file reads

The final project-host read-only wrapper calls
`canonicalSyncIdentityPath(path)` before enforcing the viewer read policy. That
means symlink and `..` traversal are checked against the canonical project
identity path, not just the raw requested path.

The share policy allows:

- the shared directory itself.
- descendants of the shared directory.

The share policy excludes sensitive internal paths even for whole-project
shares:

- `.snapshots`
- `.backups`
- `.ssh`
- `.cache`
- `.local`

### Publish requires collaborator access

Share creation requires `assertCollab({ account_id, project_id })`, verifies
the project path is inside `/home/user`, rejects unsafe path segments, rejects
excluded roots, and verifies the shared path is an existing directory.

Share update/unpublish also requires collaborator access on the source project.

### Copy-out is path-scoped

Copying from a share passes `src_read_policy` into the copy LRO. The copy worker
canonicalizes requested source paths and verifies each path against the read
policy before copying. Recursive directory copies avoid blindly trusting a
subtree when the policy contains nested exclusions.

### Share socket authorization is intentionally lightweight

The Conat socket authorization for `fs-share.project-...share-...account-...`
only verifies that the account id in the subject matches the authenticated
account. The actual share existence, disabled status, availability, and read
policy are enforced when the project-host read-only filesystem is created via
`publicDirectoryShares.authorizeRead`.

This split is acceptable only because the read-only filesystem cache TTL is
short. If the cache TTL is increased again, revocation semantics become unsafe.

## Remaining Risks And Follow-Ups

- Add a project-host invalidation path when a share is disabled, so revocation
  can be near-immediate instead of waiting for cache expiry.
- Consider a small positive cache inside `getShareReadPolicy` keyed by
  `(project_id, share_id, account_id)` if hub authorization load becomes high,
  but keep the TTL short and never cache disabled/not-found states for long.
- Add browser/security tests that publish a directory containing symlinks to
  excluded paths and verify the share cannot read them.
- Add a test that an already-created share filesystem loses access after the
  short cache TTL when `authorizeRead` starts returning not found.
- Keep the UI language aligned with the configured read-only filesystem cache
  TTL if that becomes site configurable.

## Operational Note

Removing broad permission caching for mutable project/viewer/share subjects was
the right security default. The current performance compromise is to keep
socket authorization fresh while caching the expensive read-only filesystem and
share read-policy construction for only about one minute.
