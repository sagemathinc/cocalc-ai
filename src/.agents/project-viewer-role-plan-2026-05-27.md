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
  read_policy?: ProjectViewerReadPolicy;
  created_by?: string;
  created_at?: string;
}

type ProjectViewerReadRuleAction = "include" | "exclude";

interface ProjectViewerReadRule {
  action: ProjectViewerReadRuleAction;
  path: string;
}

interface ProjectViewerReadPolicy {
  rules: ProjectViewerReadRule[];
}
```

Rule paths are project-root-relative paths. An empty or missing policy means no
file access. Full-project read-only access must be explicit, e.g.
`{ action: "include", path: "." }`.

## Capability Model

Add a central project-access result that all project authorization code can use:

```ts
interface ProjectAccess {
  role: "owner" | "collaborator" | "viewer" | "none";
  read_policy?: ProjectViewerReadPolicy;
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
- viewer read policy configuration.
- all decisions about whether a project operation is allowed.

Home bays may cache or project this information for UI rendering, but the
owning bay must enforce it. Cross-bay project operations must route through the
existing inter-bay/project-access layer instead of directly reading a local DB
copy.

The inter-bay project reference result should include enough access information
to distinguish:

- no access.
- viewer access with `read_policy`.
- collaborator access.
- owner access.

Avoid adding a second path where remote callers only learn "is collaborator".
That would force viewers to be treated either as no access or as full
collaborators, both of which are wrong.

## Server Authorization Refactor

Keep existing collaborator assertions for full access, but add more precise
helpers:

- `getProjectAccess(...)`: returns role, capabilities, and read policy.
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

## Viewer Read Policy

Use an explicit include/exclude rule list, not a flat `read_paths` list.

The pattern syntax should be simple gitignore-style project-relative globs, but
the evaluation model should be deliberately simpler than full gitignore:

- default result is deny.
- a path is allowed only if at least one include rule matches.
- a path is denied if any exclude rule matches.
- deny wins over include for the first milestone.
- no later re-include after an exclude in the first milestone.

This avoids ambiguous "include everything except..." behavior and makes broad
access safe enough to use in the UI.

Examples:

```json
{
  "rules": [
    { "action": "include", "path": "." },
    { "action": "exclude", "path": ".snapshots" },
    { "action": "exclude", "path": ".snapshots/**" },
    { "action": "exclude", "path": ".ssh" },
    { "action": "exclude", "path": ".ssh/**" },
    { "action": "exclude", "path": ".local/share/cocalc" },
    { "action": "exclude", "path": ".local/share/cocalc/**" }
  ]
}
```

```json
{
  "rules": [
    { "action": "include", "path": "public/**" },
    { "action": "include", "path": "README.md" }
  ]
}
```

The UI should offer common presets instead of exposing raw rules first:

- Full project, with sensitive defaults excluded.
- Selected directories only.
- Selected files and directories.

The backend should store the explicit rules generated by those presets so the
security boundary is not a hidden frontend convention.

### Default Excludes

When the owner chooses full-project viewer access, the UI should include these
default deny rules unless the product explicitly supports advanced overrides:

- `.snapshots`
- `.snapshots/**`
- `.ssh`
- `.ssh/**`
- `.local/share/cocalc`
- `.local/share/cocalc/**`

Rationale:

- `.snapshots` exposes historical state and deleted/renamed content.
- `.ssh` often contains private keys, known hosts, config, and deployment
  material.
- `.local/share/cocalc` is the current CoCalc runtime metadata location and
  may contain implementation details or tokens that are not intended as project
  content.

Backups are never exposed through viewer access. Backup APIs remain outside the
viewer capability model even if a backup contains files that would currently
match viewer read rules.

Snapshots are different from backups: if `.snapshots` is included by an
explicit future advanced policy, it is just a path and should go through the
same file-read path enforcement. The first milestone should not provide that
advanced override.

## Path Enforcement

Use the existing openat2-backed sandbox/canonical path machinery for enforcing
viewer read rules. The rule must be based on resolved paths, not raw string
prefixes.

Viewer checks should:

- normalize requested paths as project-root-relative paths.
- resolve through the sandbox/openat2 path mechanism.
- reject path traversal and symlink escapes.
- evaluate include/exclude rules against canonical project-relative paths.
- compare the resolved target against the resolved allowed roots for matched
  include rules.
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
- allow opening readable `.chat` files as ordinary files, which gives viewers
  recent chat content stored in project files.
- do not expose backend sqlite chat archives or chat history APIs to viewers.

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

- add a read-only file API surface for viewers.
- enforce viewer read policies with the existing sandbox/openat2 resolved-path
  boundary.
- add tests for symlink escapes, `..`, absolute paths, allowed subdirectories,
  and denied sibling directories.
- add tests for full-project include with `.snapshots`, `.snapshots/**`,
  `.ssh`, `.ssh/**`, `.local/share/cocalc`, and
  `.local/share/cocalc/**` excluded.
- verify viewer file reads do not start the project runtime.

### Phase 3: UI Support

- add viewer role controls in the People panel.
- add read-policy presets and a selected-files/directories UI.
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
- advanced rule editor for explicit include/exclude policies.

## Resolved Product Decisions

- Full-project read-only access is encoded by an explicit include rule for
  `"."`, not by omitting a policy.
- Viewers cannot download directory archives in the first milestone.
- Viewers can read `.chat` files when those files match the read policy. They
  cannot read backend sqlite chat archives or chat-history APIs.
- Viewer snapshot access is path-policy based, but `.snapshots/**` is excluded
  by the full-project preset. Backups are never visible to viewers.
- Viewers should have a separate product limit, not consume the existing
  collaborator limit.
- Syncdoc read-only collaboration is not part of the first milestone. Read-only
  persist and edit-history visibility are separate security/product decisions.

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
