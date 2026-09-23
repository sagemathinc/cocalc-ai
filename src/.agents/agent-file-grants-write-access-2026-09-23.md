# Read/write File Grants

File Grants now support `read` (the default) and explicit `read-write` access.
Existing grants remain read-only. Permission and root changes rotate the grant
generation, so previously prepared connections cannot retain the old authority.

## User Interface

The existing folder connector opens a project/path/permission summary. Edit
uses the shared project picker, whole-project or specific-directory selection,
and a Read-only / Read & write selector. Saving is an explicit human action;
an agent cannot promote its own grant. Grant settings remain personal to the
human and agent across turns; runtime access requires that human's active run.

## CLI

All commands use `project file grant`, not ordinary account-backed file commands.
They authenticate using the active agent identity and never fall back to account
or project credentials. Reads continue using `show`, `list`, `cat`, and `get`.
Write grants additionally support:

```sh
cocalc project file grant put --project TARGET local-file docs/file
cocalc project file grant mkdir --project TARGET docs/subdir --parents
cocalc project file grant copy --project TARGET docs/file docs/copy
cocalc project file grant rename --project TARGET docs/copy docs/renamed
cocalc project file grant rm --project TARGET docs/renamed
cocalc project file grant rm --project TARGET docs/subdir --recursive
```

`put` creates or overwrites a file; `copy` copies one file, not a directory tree.
No shell execution, chmod, hard-link/symlink creation, archive extraction,
watchers, or unrestricted filesystem RPC methods are exposed by this service.
Recursive mkdir cannot create ancestors outside the authorized roots. Implicit
save-last sibling backups are disabled, including for single-file grants.

## Security Model

The target project-host checks the current grant through the existing
source-project owner-bay route for every operation. Account, source, target,
agent, run, generation, collaborator membership and host audience checks remain
in force. Writes require an explicit current `read-write` result; missing or
unknown authority cannot enable mutation. Files go directly to the project host.

Paths are literal roots, not glob patterns. Snapshots, SSH files, and CoCalc
runtime credentials remain excluded, including whole-project grants. Rename
and copy validate both paths. Recursive deletion and rename reject ancestors
of excluded namespaces. Write paths containing symlink components (including
dangling symlinks) are rejected. Ordinary read behavior is unchanged.

This is ordinary filesystem access, not agent-only process isolation:

- Source-project collaborators/processes may use the runtime credential during
  the run. Settings belonging to another human are not thereby granted.
- Target-project processes can concurrently modify files, links and directories.
  Path checks are not a race-free subtree sandbox against a hostile target
  collaborator. Existing hard links retain ordinary shared-inode semantics.
- Writes can overwrite or delete data, or change code later executed by target
  processes. Their effects persist after revocation or run completion.
- Run completion, revocation and permission changes reject subsequent admission;
  an already-admitted operation may finish. No rollback is promised.
- Grant configuration/revocation is recorded; complete per-file activity logging
  and attribution to an individual source-project process are not provided.
- Existing platform resource-hardening follow-up remains separate; this change
  does not claim new file-size, directory-size, or concurrency guarantees.

No new collaborative-editor overwrite protocol is introduced. CoCalc's normal
filesystem watchers observe these changes just as they observe other processes.

## Rollout

1. Deploy shared types and database/hub code to all relevant bays. Schema sync
   atomically installs `agent_file_grants_mode_v2_check` before dropping the old
   read-only constraint; it is idempotent and does not modify existing rows.
2. Upgrade destination project-hosts with the restricted grant mutation service.
3. Deploy the CLI and frontend. Old grant services lack mutation methods; an old
   authorization response without a mode cannot authorize writes on a new host.
4. Verify writes between two projects, then downgrade/revoke and verify denial.
   Keep a security re-review of the changed mutation boundary before release.

The existing RPC name `authorizeFileGrantRead` is retained for rolling protocol
compatibility; its response now also reports the granted mode. Public-share
and viewer endpoints remain read-only and never expose the new mutations.

Rolling back application code does not revert written data or automatically
change saved modes. Disable/downgrade write grants before rollback if needed;
do not reapply the old read-only SQL constraint while read-write rows exist.

## Validation

Focused coverage exercises real sandboxed filesystem create/overwrite/copy/
rename/remove, new destinations, recursive mkdir, both-path checks, symlinks,
protected namespaces/ancestors, read-only denial, downgrade and run-end denial.
Additional tests cover the RPC allowlist, permission persistence/generation,
UI mode selection, agent context, identity-only CLI mutation dispatch/cleanup,
and an actual PostgreSQL legacy-constraint migration.

Validated on 2026-09-23:

- 26 project-host filesystem tests, including real Conat transport and cached
  connection downgrade/run-end rejection.
- 24 shared protocol and RPC allowlist tests; 4 server authorization tests.
- 16 frontend/context/chat tests; frontend lint and TypeScript checks passed.
- PostgreSQL migration test passed against a legacy constraint, including a
  second migration run; CLI mutation dispatch test passed.
- Full development build, project-host bundle and CLI/tools builds passed.
- Desktop and mobile browser checks passed. A live agent on lite2b used its
  scoped identity to create a directory, upload and read back a 50-byte payload,
  copy, rename, create a subdirectory and remove the contents. Non-recursive
  directory removal correctly failed; recursive removal succeeded. The test
  grant and source/target fixtures were removed afterward.

The live smoke test used two projects on one host/bay, not a live cross-bay
deployment. Cross-bay routing is unchanged. Automated downgrade/run-end tests
do not replace a future live multi-bay rollout check or security re-review.
