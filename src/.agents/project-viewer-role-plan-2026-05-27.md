# Project Viewer Role Plan

Date: 2026-05-27

Status: design plan.

## Goal

Add a distinct project role, tentatively named `viewer`, for users who can read
selected project files without getting normal collaborator power.

The first version should be deliberately narrow:

- read files and directories through the controlled file API.
- optionally restrict access to an explicit list of directories.
- do not start or use project runtimes.
- do not write files.
- do not get terminal, Jupyter kernel, SSH, app-server, secrets, backup,
  snapshot, collaborator-management, or project-settings access.

This is not a weaker collaborator role. It is a separate capability class with
explicit checks at each boundary.

## Product Model

Project users can have one of these roles:

- `owner`: full project control, including collaborator management.
- `collaborator`: current normal project access.
- `viewer`: read-only file access, optionally path-scoped.

Use a single role field rather than several booleans. Capability checks should
derive from the role and optional viewer configuration.

Suggested project user shape:

```ts
type ProjectUserRole = "owner" | "collaborator" | "viewer";

interface ProjectViewerConfig {
  role: "viewer";
  read_paths?: string[];
  created_by?: string;
  created_at?: string;
}
```

`read_paths` are project-root-relative paths. An empty or missing list should
not silently mean unlimited access unless the UI and API explicitly encode that
policy. Prefer an explicit `"."` entry for full-project read-only access.

## Capability Model

Add a central project-access result that all project authorization code can use:

```ts
interface ProjectAccess {
  role: "owner" | "collaborator" | "viewer" | "none";
  read_paths?: string[];
  capabilities: {
    readProjectMetadata: boolean;
    readProjectFiles: boolean;
    writeProjectFiles: boolean;
    useProjectRuntime: boolean;
    useTerminal: boolean;
    useSsh: boolean;
    useProjectSecrets: boolean;
    manageCollaborators: boolean;
    manageProjectSettings: boolean;
    manageSnapshotsBackups: boolean;
  };
}
```

Initial mapping:

- owners get every capability.
- collaborators get the current normal collaborator capabilities, except any
  existing owner-only policy still applies.
- viewers get `readProjectMetadata` and `readProjectFiles` only.

Do not infer write/runtime access from `readProjectFiles`. These are separate
capabilities because they are enforced by different systems.

## Multibay Authority

The project owning bay is authoritative for:

- project user role.
- viewer read path configuration.
- all decisions about whether a project operation is allowed.

Home bays may cache or project this information for UI rendering, but the
owning bay must enforce it. Cross-bay project operations must route through the
existing inter-bay/project-access layer instead of directly reading a local DB
copy.

The inter-bay project reference result should include enough access information
to distinguish:

- no access.
- viewer access with `read_paths`.
- collaborator access.
- owner access.

Avoid adding a second path where remote callers only learn "is collaborator".
That would force viewers to be treated either as no access or as full
collaborators, both of which are wrong.

## Server Authorization Refactor

Keep existing collaborator assertions for full access, but add more precise
helpers:

- `getProjectAccess(...)`: returns role, capabilities, and read paths.
- `assertProjectFileReadAccess(...)`: allows viewers, collaborators, owners.
- `assertProjectFileWriteAccess(...)`: allows collaborators and owners only.
- `assertProjectRuntimeAccess(...)`: allows collaborators and owners only.
- `assertProjectManageUsersAccess(...)`: owner-only when
  `manage_users_owner_only` is true; otherwise owners/collaborators as today.
- `assertProjectOwnerAccess(...)`: owner only.

Then audit all project-facing endpoints and replace broad collaborator checks
with the narrowest capability check that matches the operation.

Important rule: do not change an existing write/runtime path to accept viewers
just because it previously called a generic collaborator helper. Viewer support
must be opt-in per capability.

## File Access Design

The first implementation should expose a read-only file surface for viewers.

Allowed operations should be limited to read-style operations such as:

- list directory.
- stat/lstat.
- read file.
- read symlink only when the resolved target is allowed.
- download a single allowed file.
- preview/render file content where rendering does not execute project code.

Do not initially allow:

- write, rename, delete, mkdir, copy, upload, chmod, chown, or touch.
- archive creation.
- git operations.
- terminal commands.
- Jupyter execution.
- project-host browser tokens that imply normal collaborator access.
- syncdoc write subjects.

Search and recursive listing can be added later, but only with rate limits and
the same path restrictions.

## Path Enforcement

Use the existing openat2-backed sandbox/canonical path machinery for enforcing
viewer read paths. The rule must be based on resolved paths, not raw string
prefixes.

Viewer checks should:

- normalize requested paths as project-root-relative paths.
- resolve through the sandbox/openat2 path mechanism.
- reject path traversal and symlink escapes.
- compare the resolved target against the resolved allowed directory roots.
- fail closed on any path resolution error.

Do not duplicate a weaker path-prefix check in TypeScript as the security
boundary. TypeScript can do UI validation and early rejection, but the final
boundary should be the same hardened file sandbox used elsewhere.

## Runtime Boundary

Viewer access must not start a project.

That means viewers must not be able to reach project-start paths indirectly
through:

- opening a file.
- proxy/app-server routes.
- terminal/Jupyter/codex/autostart routes.
- syncdoc wakeups.
- scheduled automations.
- SSH setup or SSH login.
- project-host auth-token issuance.

If a file preview needs runtime execution, it is not part of the first viewer
milestone.

## UI Plan

People panel:

- add `Viewer` as a role in the collaborator role UI.
- add an optional read-path editor for viewer entries.
- explain that viewers can read allowed files but cannot run code, edit files,
  use SSH, or manage the project.
- preserve the current self-removal UI for every non-owner, including viewers.

Project list and header:

- show a `Read-only` badge for viewer projects.
- hide or disable start/runtime actions with a direct explanation.
- make restricted actions explain the policy instead of failing with a raw RPC
  error.

File UI:

- show file browser and read-only preview/download for allowed paths.
- show a clear denied state for disallowed paths.
- disable drag/drop upload, save, rename, delete, new file, terminal, and
  runtime-dependent actions.

Do not rely on hidden buttons as the security mechanism. The backend capability
checks are the authority.

## API Key And SSH Policy

Initial viewer support should not grant project API keys or SSH access.

If API-key support is added later, split file capabilities explicitly:

- `file:read`
- `file:write`

A viewer API key could receive `file:read` for the same read paths, but never
`file:write` or `project:exec`.

SSH should remain unavailable to viewers. A shell cannot be made read-only in a
shared project runtime without a much larger isolation design.

## Security Audit Checklist

Before shipping viewer access, audit every project access path that currently
uses these concepts:

- `assertLocalProjectCollaborator`.
- `assertProjectCollaboratorAccessAllowRemote`.
- `isCollaborator`.
- direct checks of `projects.users[account_id].group`.
- direct SQL checks for `owner` or `collaborator`.
- project-host auth-token issuance.
- file-server subject authorization.
- proxy/app-server autostart.
- terminal, Jupyter, Codex, SSH, and scheduled automation starts.
- project settings, secrets, snapshots, backups, copy, move, clone, and delete.
- collaborator invitations and invite links.

For each endpoint, classify it as one of:

- metadata read.
- file read.
- file write.
- runtime use.
- project administration.
- owner-only.

Then enforce the corresponding capability, not a generic "has project access"
check.

## Implementation Phases

### Phase 1: Shared Types And Access Helpers

- add `viewer` to shared project user role types.
- add central capability derivation.
- add local and remote `getProjectAccess` helpers.
- keep old collaborator assertions, but make them explicitly mean
  collaborator-or-owner.
- add unit tests proving viewers are not collaborators.

### Phase 2: Read-Only File API

- add a read-only file path for viewers.
- enforce viewer read paths with the existing sandbox/openat2 resolved-path
  boundary.
- add tests for symlink escapes, `..`, absolute paths, allowed subdirectories,
  and denied sibling directories.
- verify viewer file reads do not start the project runtime.

### Phase 3: UI Support

- add viewer role controls in the People panel.
- add read-path configuration.
- add read-only project/file UI mode.
- add clear denied/restricted messages for runtime and write actions.

### Phase 4: Endpoint Audit

- audit project RPCs and project-host subjects.
- convert broad collaborator checks to capability-specific checks.
- add regression tests for each indirect runtime/write path found.

### Phase 5: Optional Extensions

- read-only API keys with `file:read`.
- read-only share links backed by the same capability machinery.
- viewer-specific project list filters.
- directory presets such as `docs/`, `public/`, or full project read-only.

## Open Questions

- Should full-project read-only access be encoded as `read_paths: ["."]`, or
  should omitted `read_paths` mean full-project read-only? The explicit form is
  safer and clearer.
- Should viewers be able to download a directory archive? Default answer should
  be no until archive generation is path-scoped, rate-limited, and tested.
- Should viewers see chat? Default answer should be no unless chat gets its own
  `readProjectChat` capability.
- Should viewers see snapshots/backups? Default answer should be no because
  those can expose historical files outside the current allowed path set.
- Should viewers count against collaborator limits? Probably yes initially,
  unless a separate product limit is added.
- Should syncdoc read-only collaboration be part of the first milestone? No.
  Start with the file API and add syncdoc read-only later only after its write
  subjects and wakeup paths are audited.

## Non-Goals For The First Milestone

- read-only shell access.
- read-only Jupyter kernels.
- partial runtime access.
- per-file ACLs stored outside the project user role.
- making existing collaborators partially read-only.
- public anonymous read-only project access.

The first milestone should prove the access-control boundary with the smallest
useful feature: authenticated users can read explicitly allowed project files
without being able to write or run anything.
