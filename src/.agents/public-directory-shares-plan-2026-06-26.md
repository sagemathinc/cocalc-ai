# Public Directory Shares Migration Plan

Date: 2026-06-26

## Context

Cambridge University Press depends heavily on the old cocalc.com share server.
They have hundreds of `public_paths` records, including URLs such as:

- `https://cocalc.com/cambridge`
- `https://cocalc.com/Cambridge/9781009209090/Code`

There are also many non-CUP `public_paths` records created by ordinary users
over the years. Those shares should not disappear just because they are outside
the CUP migration. The first migration should import all viable public share
metadata, while clearly marking shares whose backing project files are not yet
available.

The old share server implementation under `/home/user/cocalc/src/packages/next/pages/share`
is not implemented in cocalc-ai. Reimplementing it is not the right target:

- it duplicates project files into a separate publication system;
- it creates two sources of truth for file content;
- it historically used server-side notebook rendering that was expensive and
  did not provide enough SEO value to justify the operational risk;
- anonymous rendering is a CPU and egress abuse surface;
- CUP's real requirement is durable URL-based read access to directories, plus
  the ability for readers to inspect notebooks before copying content into
  their own projects.

The better replacement is **signed-in public directory viewers**: a project
owner can mark a directory public, and any signed-in user with the URL can view
that directory read-only through the existing project viewer filesystem path.

## Goals

- Preserve CUP's legacy URLs through redirects to stable cocalc-ai share URLs.
- Import and support non-CUP historical public shares where the backing project
  can be mapped.
- Avoid reimplementing the old share server publication pipeline.
- Use live project files as the source of truth.
- Require sign-in before reading shared content.
- Count file reads and copy egress against the signed-in viewer account.
- Reuse existing cocalc-ai project viewer/read-policy machinery wherever
  possible.
- Support viewing notebooks, markdown, code, data files, directories, and
  copying a shared directory into a user's own project.
- Support legacy visibility modes: listed, unlisted, private/disabled.
- Make this generally useful beyond CUP as "make this project directory visible
  to signed-in users with a link."

## Non-Goals

- Do not support anonymous project file reads in the first implementation.
- Do not server-side render notebooks for SEO.
- Do not support vhost static websites in the first implementation.
- Do not support old share-server Jupyter API execution.
- Do not duplicate files into an NFS/R2 publication store.
- Do not add every viewer as a project collaborator.
- Do not expose full project metadata or paths outside the public directory
  read policy.

## Existing Building Blocks

### Old cocalc.com schema

The old `public_paths` table includes:

- `id`: sha1 hash derived from `project_id` and `path`
- `project_id`
- `path`
- `name`
- `description`
- `disabled`
- `unlisted`
- `authenticated`
- `license`
- `created`
- `last_edited`
- `last_saved`
- `counter`
- `vhost`
- `auth`
- `token`
- `compute_image`
- `site_license_id`
- `url`
- `image`
- `redirect`
- `jupyter_api`

For CUP migration, the important fields are `project_id`, `path`, `name`,
`description`, `disabled`, `unlisted`, `authenticated`, `license`, `url`,
`redirect`, and timestamps. `vhost`, `auth`, `jupyter_api`, and legacy
publication counters can be imported as metadata but should not block the first
implementation.

### cocalc-ai viewer access

cocalc-ai already has:

- `ProjectViewerReadPolicy` in `@cocalc/util/project-access`;
- path allow/deny checks via `viewerReadPolicyAllowsPath` and
  `viewerReadPolicyMayAllowDescendant`;
- a project-host viewer filesystem service that uses read-only scoped subjects;
- frontend project viewer modes with read-only file listing and copy-out UX.

The new feature should extend this access model. It should not create a second
public file-serving path through the hub.

## Proposed Product Model

Introduce **public directory shares**.

A public directory share is a database record that grants any signed-in user
read-only viewer access to one project path, without making them a project
collaborator.

The user-facing URL is a durable slug, not the project path:

```text
https://cocalc.ai/share/Cambridge/9781009209090/Code
```

The backing data is:

```text
project_id = <migrated CUP project id>
path       = <directory inside that project>
```

This separation is important. CUP needs URL stability; project owners need to
be able to organize files normally.

## Pivot: Viewer-Based Public Shares with Temporary Grants

Date: 2026-06-28

### Summary

The first implementation attempted to make `/share/<slug...>` render a
share-only project context with custom `fs-share` file access. That approach
proved brittle in practice:

- it had to emulate enough of the normal project page to open notebooks,
  markdown, code files, directory listings, selections, copy actions, and
  navigation;
- it created a second frontend pathway for functionality that already works in
  project viewer mode;
- it made browser/project-host routing hard to reason about;
- it obscured a security issue where path-restricted project viewers could
  temporarily retain unrestricted project access through stale authorization
  caches after being demoted from collaborator.

The new target is simpler:

1. Make **project viewer mode** the polished, secure, path-restricted read-only
   UX for shared content.
2. Make `/share/<slug...>` an entry point that grants a **temporary
   path-restricted viewer access record** and then routes the user into normal
   project viewer mode.

This should replace the custom public-share explorer/embed code. The public
share system becomes a URL, policy, audit, and grant-management layer over the
normal project viewer experience.

### Product Semantics

A public directory share means:

- the owner publishes a project directory at a durable URL;
- any signed-in user with the URL may receive temporary viewer access scoped to
  that directory;
- the user views the content through the normal project page in viewer mode;
- all file reads go through the existing project-host viewer filesystem;
- copy actions use existing viewer copy-out behavior, plus public-share
  metadata for default destination, rootfs selection, and optional membership
  grant-on-copy;
- no terminal, runtime, secrets, settings, collaborator management, snapshots,
  or unrestricted file APIs are exposed.

This is intentionally "project viewer with an automatically managed temporary
viewer grant", not "old share server v2".

### Whole-Project Sharing

Whole-project sharing is a first-class use case.

In this feature, "share the entire project" means share the project HOME
directory, normally `/home/user`. It must never mean sharing the filesystem root
`/`, `/tmp`, mounted secrets, project-host implementation directories, or the
rootfs image as a filesystem tree.

Implementation rules:

- UI should offer an explicit "Share entire project" action in addition to
  "Share this folder".
- Store the share path as the project home path or a normalized sentinel such
  as `.` that resolves to project HOME. Do not store `/` for this use case.
- The viewer root for a whole-project share should be displayed as the project
  root, not as `/home/user`.
- Navigation in viewer mode must not offer any route above project HOME.
- "Copy" and "Copy all" for a whole-project share copy the project HOME
  contents subject to the same safety exclusions as file reads.
- Legacy imports whose public path maps to project HOME should become
  whole-project shares, not disabled or special-cased records.

Whole-project shares still use the same temporary viewer grant flow as directory
shares. The effective read policy is "HOME and descendants, minus global safety
exclusions".

Required global exclusions for both directory and whole-project shares:

- `.ssh`
- project secrets mount paths
- `.local/share/cocalc` and other CoCalc internal state directories
- snapshots/backups implementation paths unless they are explicitly supported as
  a separate audited feature
- any host/runtime path outside HOME

These exclusions must be enforced by the project-host viewer filesystem service,
not just hidden in the frontend.

### Security Invariants

These are release-blocking:

- A path-restricted viewer must not list, open, download, preview, copy, or
  otherwise fetch files outside the granted read policy through either UI or
  direct file APIs.
- Changing a user from collaborator to viewer, or changing a viewer read policy,
  must take effect immediately for file access. Positive project-access cache
  entries must not keep `fs.project-*` or other unrestricted project subjects
  open.
- Viewer reads must use account-scoped `fs-viewer.project-<project_id>.account-<account_id>`
  subjects, or an equivalent project-host service with the same narrow
  semantics.
- Unrestricted `fs.project-<project_id>` remains collaborator-only.
- A temporary public-share viewer grant must never silently upgrade an existing
  project access role. Owners/collaborators keep their normal role; existing
  viewers get the union of explicit non-public viewer policy and active
  temporary share policy only if that union is intentional and audited.
- The project host remains the final file-path enforcement point. The hub may
  authorize and route, but it must not proxy steady-state file reads.
- Frontend checks, hidden buttons, route guards, and UI root restrictions are
  usability aids only. They are not security boundaries. Every list, read,
  download, preview, copy, syncdoc, and editor data-plane request must be
  authorized by backend/project-host policy at the time of the request.
- Public shares require sign-in in the first release.
- Disabling a share, whether by owner or admin, must prevent new temporary
  grants immediately.
- Existing temporary viewer grants for a disabled share must stop granting file
  access in a reasonable amount of time, measured in minutes rather than days.
  For security/admin takedowns, revoke them immediately and invalidate relevant
  project-access generations or auth caches.
- Disabling a share cannot recall content that a viewer already downloaded or
  copied. Owner/admin UI must state this clearly.
- Public-share viewing must be treated as an XSS-sensitive path. Reusing normal
  CoCalc editors/viewers is preferred because they already contain file-type
  specific sanitization and iframe isolation decisions. Any remaining fallback
  renderer must be audited for HTML, markdown, notebook output, SVG, embedded
  media, and link handling before release.

### Authorization Cache Policy

The P0 viewer bug showed that mutable access decisions cannot be cached without
a precise invalidation story.

Policy:

- Do not cache positive authorization for project data-plane subjects such as
  `fs.project-*`, `project.<id>.*`, `hub.project.<id>.*`,
  `file-server.<id>.*`, `fs-viewer.*`, or `fs-share.*` unless the cache key is
  backed by a versioned access token or an access-generation number.
- It is acceptable to cache stable subject parsing, route lookup, and negative
  non-project decisions.
- If performance becomes an issue, add an explicit `project_access_generation`
  or `project_users_updated_at` value to the project/user projection and include
  it in the authorization cache key.
- Alternative invalidation is acceptable only if every mutation path that
  changes `projects.users`, viewer read policies, public-share grants, disabled
  state, or temporary grant expiry reliably clears hub and project-host auth
  caches across bays and hosts.
- Until that exists, no caching is the safer default for project access
  authorization. The expected performance cost should be small compared with
  file operations, because the hot path after authorization is direct
  project-host file service traffic.

### Data Model Changes

Keep `public_project_paths` as the authoritative share metadata table. Add a
separate temporary grant model rather than overloading ordinary collaborators
without metadata.

Recommended table:

```sql
CREATE TABLE public_project_path_viewer_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_project_path_id UUID NOT NULL,
  project_id UUID NOT NULL,
  account_id UUID NOT NULL,
  read_policy JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  grant_reason TEXT NOT NULL DEFAULT 'share-url',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  revoked_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(public_project_path_id, account_id)
);
```

Indexes:

```sql
CREATE INDEX public_project_path_viewer_grants_project_account_idx
  ON public_project_path_viewer_grants (project_id, account_id)
  WHERE status = 'active';

CREATE INDEX public_project_path_viewer_grants_expiry_idx
  ON public_project_path_viewer_grants (expires_at)
  WHERE status = 'active';
```

Grant duration should be configurable by site setting, with a short default
such as 24 hours or 7 days. Re-visiting the share URL can extend `expires_at`
idempotently.

Do not count these grants against the owner's ordinary collaborator/viewer
limit. Enforce a separate public-share temporary viewer limit:

- max active temporary viewers per share;
- max active temporary viewers per source project;
- max active temporary share grants per account;
- optional per-share total grant cap;
- admin override for CUP and support.

### Project Access Resolution

Project access should resolve in this order:

1. Admin/owner/collaborator access from `projects.users`.
2. Explicit viewer access from `projects.users`.
3. Active temporary public-share viewer grants for `(project_id, account_id)`.
4. No access.

If multiple viewer grants apply, combine read policies by allowing any path
included by any active grant, while still applying global safety exclusions
such as `.ssh`, `.snapshots`, and `.local/share/cocalc`.

Important implementation detail:

- project-host `getViewerReadPolicy(project_id, account_id)` must be able to
  resolve both ordinary viewer policy and active temporary public-share viewer
  policy;
- hub `resolveProjectAccessAllowRemote` should return `role: "viewer"` with the
  effective read policy when temporary grants are active;
- frontend project context should not need to know whether viewer access came
  from `projects.users` or from a temporary public-share grant.

### Share Entry Flow

`/share/<slug...>` should become a thin entry route:

1. Wait for auth state. While auth is unknown, show loading; do not flash
   "Sign in to view this published folder" for users who are already signed in.
2. If not signed in, show sign-in and preserve the exact share URL as the
   return URL.
3. Resolve the slug through the share API.
4. If enabled and available, call
   `publicDirectoryShares.grantTemporaryViewerAccess({ slug })`.
5. The grant API creates or refreshes an active temporary viewer grant with the
   share read policy.
6. Redirect or route the user to the normal project viewer URL rooted at the
   shared path, for example:

```text
/projects/<project_id>/files/<shared-path>?viewer=1&share=<share_id>
```

7. The normal project page renders in viewer mode and uses the existing file
   explorer/editor/notebook stack.

The share URL should remain copyable and durable. The project URL can be an
implementation detail after access is granted.

### Viewer UX Improvements Needed

Before relying on project viewer mode as the public-share UI, improve viewer UX
so it works well for both explicit viewers and temporary share viewers:

- use the real CoCalc frame editors/viewers in read-only mode for opened files,
  including text/code, markdown, notebooks, images, PDFs, boards, and other
  supported file types. Do not build a parallel public-share renderer stack for
  these types;
- treat the current custom read-only preview path as temporary scaffolding. It
  can remain only long enough to keep testing moving, but the target
  implementation deletes it or limits it to a narrow unsupported-file fallback;
- show a top banner: "You are viewing a published folder" or "You have
  read-only access to this project";
- when access came from a share, show share title, description, license, and a
  "Copy" primary button;
- make the visible root feel like the shared folder, not the whole project, for
  path-restricted viewers;
- prevent "go above shared root" UI navigation for path-restricted viewers;
- make directory navigation client-side within the project page, not a full
  page reload;
- ensure notebook, markdown, text/code, images, PDFs, and arbitrary files open
  read-only without runtime access;
- ensure real read-only editors cannot save, execute, spawn kernels/terminals,
  mutate project state, or fetch paths outside the effective viewer read policy;
- ensure checkboxes/select-all work for path-restricted viewer listings;
- keep "Copy selected" and "Copy all" actions available;
- make refresh a neutral/manual refresh button unless there is a real watcher
  event indicating stale data;
- hide or disable runtime-only actions, terminals, secrets, snapshots/backups,
  settings, and collaborator UI;
- if the root listing is empty because the policy only allows a descendant,
  show the allowed descendant directory rather than an empty project root.
- for whole-project shares, label the visible root as the project root and omit
  `/home/user` implementation details unless needed for diagnostics;
- the publish dialog should make the choice explicit: "Share this folder" vs
  "Share entire project";
- the share management UI should show whether a share targets a folder or the
  entire project;
- whole-project shares should still show the same read-only banner and primary
  "Copy" action as folder shares.

This work benefits both public shares and normal project viewers.

### Publication Awareness UI

Before the feature is considered complete, owners and collaborators must have a
clear way to see what is published from the normal project file explorer. It
should not be necessary to remember share URLs or open a separate admin page to
know which folders are public.

Use `public_project_paths` / `public_directory_shares` as the authoritative
source of truth. For fast frontend display, maintain generated project labels as
an autosynced, non-authoritative UI index:

- generate one reserved label per active share, e.g. `system:public-share` or
  `public-share:<share_id>`;
- label payload should include at least `share_id`, `path`, `slug`, `title`,
  `visibility`, `disabled`, `requires_auth`, `updated_at`, and whether the
  share is a whole-project share;
- labels are written only by server share create/update/disable/delete paths;
- the UI must never treat labels as security state, and users must not edit
  these labels directly;
- a periodic repair job should be able to rebuild the generated labels from the
  authoritative share table;
- if labels are missing or stale, security is unchanged. The worst acceptable
  result is missing or stale UI decoration, not incorrect file access.

Explorer behavior:

- show a compact blue `Published` pill or globe indicator on the exact row whose
  path is a published share root;
- if a directory contains published descendants, show a quieter `Contains
published` indicator or an outline globe, not a full badge on every child;
- when browsing inside a published subtree, show a small banner or breadcrumb
  note such as `Inside published share: <slug>` with `Copy link` and `Manage`
  actions;
- if multiple shares overlap, the direct row indicator should expose a popover
  listing the relevant shares and whether each is direct, an ancestor, or a
  descendant;
- whole-project shares should be indicated at the project HOME/root level, with
  wording that makes the global safety exclusions clear.

Management behavior:

- clicking a direct `Published` indicator in the file explorer should open the
  existing publish configuration dialog for that share/path;
- add a project-level "Published items" view or panel listing all shares in path
  order with slug, title, visibility, status, copy URL, edit, and disable
  actions;
- the publish dialog should warn when the selected path is already published,
  is inside a broader published share, or contains nested published shares;
- disabling a share updates the authoritative share row first, then updates the
  generated label, and temporary access revocation must not depend on label
  propagation;
- for unlisted shares, owner/collaborator UI may show recent viewer identity by
  display name and account id, but not email by default.

Publication metadata and theming:

- add share-level presentation metadata modeled on the RootFS image manifest
  theme controls where practical;
- support at least color, accent color, icon, and image fields for a published
  share;
- reuse the existing generic theme editor instead of building a separate custom
  theme editor if the data shape can be aligned;
- store this metadata in the authoritative public share row/metadata, not only
  in generated project labels;
- generated labels may include a small subset of presentation metadata only for
  fast owner/collaborator explorer decoration;
- viewer/share pages should use the configured presentation metadata for
  banners, landing/listing headers, and copy dialogs without affecting
  authorization.

Documentation:

- add a publishing guide under `src/packages/docs`;
- link to that guide from the publish configuration dialog;
- document folder shares, whole-project shares, safety exclusions, unlisted URL
  behavior, temporary viewer access, copy-to-project, and grant-on-copy
  behavior;
- explicitly state that disabling a share stops future access within the
  configured revocation window, but previously copied/downloaded content cannot
  be recalled.

### Copy UX

The default public-share action should be **Copy**.

Behavior:

- open a confirm modal explaining that CoCalc will create a new project and copy
  the published files;
- create the new project near the source project when allowed by host admission
  and user tier;
- prefer matching the source rootfs because shared files may depend on that
  environment;
- copy all files in the shared root using backend project-to-project copy;
- fall back to normal placement if the source host or rootfs is unavailable;
- after creation, open the destination project immediately and show copy LRO
  progress there.

The modal should also offer "Copy to existing project" as a secondary action.
That path should use the same backend copy authorization and read policy.

For selected files:

- if files are selected in the viewer listing, "Copy selected" copies only
  those paths;
- if nothing is selected, "Copy" copies the shared root.
- for whole-project shares, the shared root is project HOME; copy operations
  must apply the global safety exclusions and should not copy `.ssh`, internal
  CoCalc state, secrets, snapshots/backups implementation paths, or anything
  outside HOME.

### Site License / Membership Grant on Copy

Keep the existing grant-on-copy model, but attach it to the copy operation after
temporary viewer access has been granted.

Rules:

- viewing a share does not grant compute membership;
- copying may grant a temporary membership to the destination project;
- if the license pool is exhausted or the grant fails, copying should still be
  allowed when `site_license_copy_requires_grant=false`;
- if the grant is required, block before copying and show a clear explanation;
- allow copying even when the license is used up, because the free tier is still
  useful and CUP explicitly requested this behavior;
- record grant provenance with source share id, source project id, destination
  project id, account id, tier, duration, legacy public path id, package id,
  and the exact membership assignment id that was minted.
- disabling a share must block new grant-on-copy operations immediately;
- if a copy operation has not started yet, disabling the source share should
  cancel or fail it before any membership grant is minted;
- if a membership grant has already been minted because of a copied share,
  disabling the share revokes that grant in a reasonable amount of time
  (minutes, not days);
- revocation must be assignment-aware: record the assignment id at grant time,
  and on disable only revoke if that same assignment is still active. Do not
  blindly revoke by package/account if the user later received an unrelated
  assignment for the same membership package;
- revocation of an already-minted membership grant does not remove files that
  were already copied into the viewer's project, and the UI/admin notes must not
  imply that copied content can be recalled.

### Backend API Plan

Add or adjust Conat hub APIs:

```ts
resolvePublicDirectoryShare({ slug }): Promise<ShareSummary>;

grantTemporaryViewerAccess({
  slug: string;
}): Promise<{
  project_id: string;
  share_id: string;
  path: string;
  read_policy: ProjectViewerReadPolicy;
  expires_at: string;
  project_url: string;
}>;

revokeTemporaryViewerAccess({
  public_project_path_id: string;
  account_id: string;
}): Promise<{ revoked: boolean }>;

listTemporaryViewerGrants({
  public_project_path_id?: string;
  project_id?: string;
  account_id?: string;
  active?: boolean;
}): Promise<TemporaryViewerGrantSummary[]>;
```

Project access APIs:

- update `resolveProjectAccessAllowRemote` and local access helpers so active
  temporary grants can resolve to viewer access;
- update project-host viewer read-policy lookup to include active temporary
  grants;
- update project projections if needed so the viewer UI can load project title
  and basic metadata without pretending the user is a normal collaborator.

Copy APIs:

- keep `copyPublicDirectoryShareToNewProject` or equivalent as the high-level
  default copy path;
- internally reuse `copyPathBetweenProjects` with `src_read_policy`;
- ensure source paths are checked against the effective viewer read policy
  before the LRO starts and inside the worker before copying.

### Temporary Grant Expiry and Cleanup

Implement expiry as defense-in-depth:

- active grants have a durable `expires_at`;
- access resolution ignores expired grants even before cleanup runs;
- a periodic job marks expired grants as `expired`;
- project-host auth should not cache a grant past its expiry;
- revisiting a share URL refreshes the grant idempotently;
- disabling a share marks active grants as `revoked` or `disabled` and makes
  access resolution ignore them;
- ordinary owner disable should revoke active temporary viewer grants within
  minutes and prevent refresh;
- security or admin takedown should revoke active temporary viewer grants
  immediately and trigger any available cross-bay/project-host cache
  invalidation.

### Audit and Owner Visibility

Owners/admins should be able to see:

- public share URL;
- active temporary viewer count;
- total viewers over time;
- last viewed time;
- grant-on-copy counts and failures;
- emergency disable state.

Because unlisted shares are distributed explicitly, it is acceptable for owner
UI to show recent/active viewer identities by display name and account id. Owner
UI should not expose viewer email addresses by default. Admin UI should expose
account ids/emails for support and abuse response.

### Implementation Phases for the Pivot

#### Phase A: Security Baseline

- Ensure path-restricted project viewers cannot use unrestricted project-host
  file subjects.
- Remove or version mutable project-access auth caches.
- Add backend tests for collaborator-to-viewer demotion taking effect
  immediately.
- Add backend tests for viewer filesystem read policy enforcement outside the
  allowed path.
- Add browser smoke test with a user who was previously a collaborator and is
  now a path-restricted viewer.

#### Phase B: Viewer UX Foundation

- (done) Fix normal project viewer mode so a path-restricted viewer can list only
  allowed directories and open files without page reloads.
- (done) Fix checkbox selection and copy selected/all for read-only viewers.
- Add viewer/share banner and hide write/runtime-only UI.
- Add tests for root listing, subdirectory listing, direct file URL, notebook
  open, selected copy, and blocked outside-path access.
- Add tests for whole-project viewer roots: HOME listing has no parent escape,
  `/tmp` and `/` navigation are unavailable, and safety exclusions are not
  listed or fetchable.
- Add generated public-share project labels and explorer decorations so
  owners/collaborators can see direct published paths, containing directories,
  overlapping shares, and whole-project shares from the normal file explorer.

#### Phase C: Temporary Grant Backend

- Add `public_project_path_viewer_grants` table and migration.
- Add grant/refresh/revoke/list APIs.
- Integrate temporary grants into local and remote project access resolution.
- Integrate temporary grants into project-host viewer read-policy lookup.
- Add expiry cleanup and immediate disable/revoke behavior.
- Add limits independent of ordinary collaborator/viewer limits.
- Add tests that disabling a share blocks new grants immediately and makes
  existing temporary viewer grants ineffective within the configured revocation
  window.

#### Phase D: Share Entry Route

- Replace custom share-project embed with thin `/share/<slug...>` entry flow.
- Resolve slug, grant temporary viewer access, then route to normal project
  viewer.
- Remove or quarantine obsolete custom share listing/open-file code after the
  new route is validated.
- Keep unavailable/restoring/share-disabled states in the entry route.
- Support both folder-share and whole-project-share slugs through the same entry
  route and temporary grant API.
- When a share is disabled while a viewer has the project open, viewer file
  access should fail cleanly on the next authorization/read refresh with a
  clear "This share is no longer available" message.

#### Phase E: Copy and Membership

- Make "Copy" the primary public-share action.
- Create a new project with matching rootfs/host when available, then copy via
  backend LRO.
- Keep "Copy to existing project" as a secondary path.
- Apply optional site-license/membership grant-on-copy with idempotent grant
  metadata and graceful exhaustion behavior.
- Revoke tracked grant-on-copy memberships when the source share is disabled,
  with assignment-id checks to avoid revoking unrelated later grants.
- Ensure whole-project copy uses the same backend authorization checks and
  safety exclusions as whole-project file reads.

#### Phase F: Migration and Redirects

- Import CUP and non-CUP `public_paths` into `public_project_paths`.
- Generate validation reports.
- Enable exact legacy URL redirects only after sample share URLs pass viewer,
  copy, and license-on-copy tests.

### Deletion / Simplification Targets

After the pivot works:

- systematically audit all commits and diffs made during the public-directory
  sharing implementation work, identify code that only supported the abandoned
  custom share-project embed path, and delete it if the temporary-viewer design
  no longer needs it;
- include backend, frontend, CLI, project-host, auth, copy, and routing changes
  in that audit rather than only searching for obvious `share` filenames;
- preserve only code that remains part of one of these supported paths:
  public share metadata management, temporary viewer grant resolution, normal
  project viewer mode, CLI/direct share APIs that still have a product role, and
  legacy URL migration/redirect support;
- remove custom frontend public-share `ProjectPage` projection hacks;
- remove duplicate share-only file listing/opening UI that is not needed for
  normal viewer mode;
- delete `ViewerFilePreview`, `PublicViewerFileContents` usage from project
  viewer mode, and any custom read-only preview/rendering code introduced only
  to make public shares display file contents. Replace with normal frame-editor
  read-only openings, keeping only a deliberately small unsupported-file
  fallback if the normal editor registry has no safe viewer;
- keep `fs-share` only if it remains useful for CLI/direct share APIs, or
  replace it with temporary viewer grant plus `fs-viewer`;
- delete any code that assumes public-share access means synthetic project
  collaborator state.

## Schema

Add a server-owned Postgres table, for example `public_project_paths`.

```sql
CREATE TABLE public_project_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  path TEXT NOT NULL,
  slug TEXT NOT NULL,
  visibility VARCHAR(16) NOT NULL DEFAULT 'unlisted',
  requires_auth BOOLEAN NOT NULL DEFAULT TRUE,
  title TEXT,
  description TEXT,
  license TEXT,
  image TEXT,
  redirect TEXT,
  site_license_id UUID,
  site_license_pool_id UUID,
  site_license_membership_tier_id TEXT,
  site_license_duration_days INTEGER,
  site_license_grant_on_copy BOOLEAN NOT NULL DEFAULT FALSE,
  site_license_copy_requires_grant BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  legacy_public_path_id TEXT,
  legacy_url TEXT,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_edited TIMESTAMP,
  disabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX public_project_paths_slug_unique
  ON public_project_paths (lower(slug))
  WHERE disabled IS FALSE;

CREATE INDEX public_project_paths_project_path_idx
  ON public_project_paths (project_id, path);

CREATE INDEX public_project_paths_visibility_idx
  ON public_project_paths (visibility)
  WHERE disabled IS FALSE;

CREATE INDEX public_project_paths_legacy_public_path_id_idx
  ON public_project_paths (legacy_public_path_id)
  WHERE legacy_public_path_id IS NOT NULL;

CREATE INDEX public_project_paths_site_license_id_idx
  ON public_project_paths (site_license_id)
  WHERE site_license_id IS NOT NULL;
```

Valid `visibility` values:

- `listed`: appears on collection/listing pages such as `/share/Cambridge`;
- `unlisted`: resolves for users with the exact URL, but does not appear in
  listings;
- `private`: only project collaborators/admins can resolve it;
- `disabled`: record is retained but does not resolve.

Use `disabled` as an explicit boolean as well because the old schema had this
field and it is operationally useful for emergency takedowns. Treat either
`visibility='disabled'` or `disabled=true` as disabled.

### Global Slug Directory

In the multibay architecture, the authoritative `public_project_paths` row
belongs with the project on the project owning bay. However, resolving a URL
like `/share/Cambridge/9781009209090/Code` starts with a slug and does not yet
know the owning bay.

Use a small seed/global directory table for slug routing:

```sql
CREATE TABLE public_project_path_slugs (
  slug_lower TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  owning_bay_id TEXT NOT NULL,
  public_project_path_id UUID NOT NULL,
  project_id UUID NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

Resolution flow:

1. Normalize the requested slug.
2. Look up `lower(slug)` in the seed/global directory.
3. Route to `owning_bay_id`.
4. Resolve and authorize against the authoritative `public_project_paths` row
   on the owning bay.

For current one-bay lite/launchpad deployments, the directory and authoritative
row are local. This avoids premature distributed machinery while keeping the API
shape compatible with Rocket.

### Slug Rules

Slug rules should be strict enough to avoid routing/security surprises but
permissive enough for legacy CUP paths:

- normalize leading/trailing slashes away;
- reject empty slugs except for explicitly reserved collection roots;
- reject `.` and `..` segments;
- reject duplicate slashes after normalization;
- reject control characters;
- preserve case for display and redirects, but enforce uniqueness by
  `lower(slug)`;
- reserve prefixes that conflict with app routes if this ever moves outside
  `/share`.

Examples:

- `Cambridge/9781009209090/Code`
- `cambridge`
- `Cambridge/books/some-title`

## Access Flow

### Resolve Share

Add a Conat hub API:

```ts
resolvePublicProjectPath({ slug }): Promise<{
  id: string;
  project_id: string;
  path: string;
  title?: string;
  description?: string;
  license?: string;
  visibility: "listed" | "unlisted" | "private";
  read_policy: ProjectViewerReadPolicy;
}>
```

Rules:

- require a signed-in account unless `requires_auth=false`, which should not be
  enabled for CUP initially;
- route resolution to the owning bay for the project;
- return 404 for disabled/private records when the user is not allowed;
- return a read policy that includes exactly the shared path and descendants,
  plus standard exclusions.

Generated read policy:

```ts
{
  rules: [
    { action: "include", path: "<path>" },
    { action: "include", path: "<path>/**" },
    { action: "exclude", path: ".snapshots" },
    { action: "exclude", path: ".snapshots/**" },
    { action: "exclude", path: ".ssh" },
    { action: "exclude", path: ".ssh/**" },
    { action: "exclude", path: ".local/share/cocalc" },
    { action: "exclude", path: ".local/share/cocalc/**" },
  ];
}
```

For a shared root path, use the existing full-read viewer policy but keep the
standard exclusions.

### Project-Host Authorization

Do not put every public viewer into `projects.users`.

Instead, add a new scoped project-host subject or extend viewer subject
authorization to include public-share grants:

```text
fs-public-viewer.project-<project_id>.share-<share_id>.account-<account_id>
```

The project host authorization check should verify:

- the subject account matches the signed-in account;
- the public share exists and is enabled;
- the project id matches;
- the resolved read policy is attached to the subject or can be fetched from
  hub/owner bay with a short cache TTL.

Preferred first implementation:

- hub resolves the share and issues a short-lived project-host access token or
  subject metadata containing `share_id`, `account_id`, `project_id`, and the
  read policy;
- browser connects directly to the project host viewer file service;
- project-host enforces the read policy locally.

Avoid hub-mediated file reads. The hub should authorize and route, not proxy
files.

### Egress Accounting

File reads should be attributed to the signed-in viewer account, not the project
owner. This aligns with the stated requirement that viewing counts against the
reader's egress quota.

Implementation detail:

- ensure public-share viewer filesystem requests carry `account_id`;
- use the same egress accounting path used by project viewer read-only file
  access;
- if egress accounting currently assumes project collaborator/viewer membership,
  factor the accounting check to accept a resolved public-share access grant.

## Frontend UX

### Route

Add SPA route support:

```text
/share/<slug...>
```

The page should:

- require sign-in if not authenticated;
- after sign-in, return to the same share URL;
- resolve the share through the hub API;
- render a read-only project explorer rooted at the share path;
- show title/description/license metadata;
- show a clear "Copy to My Project" action;
- when a share has a license-on-copy policy, explain that copying may also
  grant temporary access to the associated course/book resources;
- show a small "Provided by <project/account/title>" attribution if available;
- avoid exposing unrelated project folders.
- if the share metadata exists but the backing project/files are not available
  yet, show a clear unavailable/pending message instead of 404.

### Directory Viewer

Reuse the existing project viewer file listing where possible:

- set project id from the resolved share;
- force viewer mode;
- set the root/current path to the shared path;
- hide or disable actions that require write/runtime access;
- keep existing file preview behavior for notebooks, markdown, code, images,
  PDFs, etc.;
- keep copy-out actions.

The viewer should visually feel like a read-only project folder, not a separate
old share-server site.

### Copy to Project

Copying should be a backend operation, not a client-side loop over files:

```ts
copyPublicProjectPathToProject({
  slug: string;
  destination_project_id?: string;
  destination_path?: string;
  rootfs_image?: string;
  host_id?: string;
}): Promise<{
  destination_project_id: string;
  copy_operation_id: string;
  site_license_grant?: {
    granted: boolean;
    expires_at?: string;
    message?: string;
  };
}>
```

Behavior:

- if `destination_project_id` is omitted, show the standard project creation
  modal and create a project first;
- start a durable copy operation and open the destination project immediately;
- show copy progress in the destination project, similar to legacy restore LROs;
- if the share has `site_license_grant_on_copy=true`, apply the site-license
  policy during the same server-side copy request;
- if the license grant fails and `site_license_copy_requires_grant=false`,
  allow the copy and show a warning;
- if the license grant fails and `site_license_copy_requires_grant=true`, block
  the copy before moving files so the user gets a clear explanation.

### Collection Pages

Collection routes by prefix are not shutdown-critical:

```text
/share/Cambridge
```

If implemented later, exact slug wins. Otherwise, listed shares under a prefix
can be shown with:

```ts
listPublicProjectPaths({ prefix: "Cambridge", visibility: "listed" });
```

CUP does not require a public `/share/Cambridge` collection page for shutdown.
Their `/cambridge` page was effectively internal/unlisted. The required owner
view is an account/project settings page listing all public shares they own.

### Manage UI

First pass:

- admin/import scripts can create records;
- project owners can see public shares for a project in project settings;
- owners can enable/disable, set visibility, title, description, and slug.
- disabling UI must explain: new viewers are blocked immediately, active viewer
  access will stop within minutes, and already downloaded/copied content cannot
  be recalled.

Later:

- add right-click "Make directory public" from the file explorer;
- add conflict warnings for slug collisions;
- add per-share analytics.
- add an account settings page that lists all public shares owned by the user's
  projects, including slug, visibility, availability, and license policy.

## Site License Claim Integration

CUP's old workflow associated a cocalc.com license with a share. When a reader
copied the share into a project, that project temporarily received the license.
We should preserve that behavior for CUP without requiring CUP to build a new
technical integration immediately.

The practical replacement is **site-license grant on copy**:

- a public directory share may reference a cocalc-ai site license, pool, and
  membership tier;
- when a signed-in reader copies the share into a destination project, the
  backend grants temporary membership for that destination project;
- the grant uses the same underlying membership/package machinery as
  site-license external claims, but the reader does not see or handle a token;
- the grant is explicitly attributed to the share copy with durable metadata.

This keeps the data plane simple:

- viewing the share only grants read-only access to the source directory;
- copying creates or uses the reader's project;
- the temporary site-license membership applies to the reader's destination
  project, not the source CUP project;
- file egress during viewing/copying is still charged to the reader account.

### Grant Metadata

Use the existing membership package metadata model and add a distinct grant
source such as:

```json
{
  "grant_source": "public-directory-share-copy",
  "public_project_path_id": "...",
  "legacy_public_path_id": "...",
  "legacy_site_license_id": "...",
  "site_license_id": "...",
  "site_license_pool_id": "...",
  "source_project_id": "...",
  "destination_project_id": "..."
}
```

This is intentionally similar to `site-license-external-claim`, but distinct
enough for audit reports, revocation, and support.

### Abuse and Capacity Controls

The copy grant path must have explicit limits:

- one active grant per `(public_project_path_id, account_id,
destination_project_id)` unless an admin override is used;
- optional max total consumptions per share;
- optional max active grants per account from the same share or site license;
- optional email-domain allowlist if CUP ever wants to restrict claims;
- site-license pool exhaustion must be visible in the UI and admin reports;
- all grants must have an expiration, e.g. 30, 90, or 180 days depending on the
  CUP agreement;
- disabling a share should stop new grants but not automatically revoke already
  copied projects unless an admin explicitly chooses that.

Use a durable consumption table if the existing site-license claim consumption
records cannot naturally represent this source:

```sql
CREATE TABLE public_project_path_site_license_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_project_path_id UUID NOT NULL,
  account_id UUID NOT NULL,
  destination_project_id UUID NOT NULL,
  site_license_id UUID NOT NULL,
  site_license_pool_id UUID,
  membership_package_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'granted',
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP,
  UNIQUE(public_project_path_id, account_id, destination_project_id)
);
```

If the existing site-license external-claim tables can cleanly store
non-token-based consumption, prefer extending them with `grant_source` instead
of adding a parallel table. The important invariant is idempotency: retrying a
copy must not create unlimited temporary memberships.

### Admin UI

Extend `admin/site-license-claims` or add a related "Public Share Claims" panel
so admins can:

- pick the site license, pool, tier, and duration used by a share or slug
  prefix;
- see counts of successful, failed, active, and expired grants;
- disable grant-on-copy for a specific share or prefix;
- export CUP reports showing share URL, license policy, consumption count, and
  failures.

For CUP migration, this can start as import-script configuration plus an admin
report. Full per-share editing can come after the shutdown-critical path.

## Backend APIs

Add `src/packages/conat/hub/api/public-project-paths.ts` with:

```ts
type PublicProjectPathVisibility =
  | "listed"
  | "unlisted"
  | "private"
  | "disabled";

resolvePublicProjectPath(opts: { slug: string }): Promise<ResolvedPublicProjectPath>;

listPublicProjectPaths(opts: {
  prefix?: string;
  limit?: number;
  offset?: number;
}): Promise<PublicProjectPathSummary[]>;

listProjectPublicPaths(opts: {
  project_id: string;
}): Promise<PublicProjectPathSummary[]>;

createPublicProjectPath(opts: {
  project_id: string;
  path: string;
  slug?: string;
  visibility?: PublicProjectPathVisibility;
  title?: string;
  description?: string;
  license?: string;
}): Promise<PublicProjectPathSummary>;

updatePublicProjectPath(opts: {
  id: string;
  visibility?: PublicProjectPathVisibility;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  slug?: string;
  disabled?: boolean;
  site_license_id?: string | null;
  site_license_pool_id?: string | null;
  site_license_membership_tier_id?: string | null;
  site_license_duration_days?: number | null;
  site_license_grant_on_copy?: boolean;
  site_license_copy_requires_grant?: boolean;
}): Promise<PublicProjectPathSummary>;

copyPublicProjectPathToProject(opts: {
  slug: string;
  destination_project_id?: string;
  destination_path?: string;
  rootfs_image?: string;
  host_id?: string;
}): Promise<PublicProjectPathCopyResult>;
```

Permission rules:

- `resolvePublicProjectPath` requires signed-in account for CUP records;
- `listPublicProjectPaths` returns only listed, enabled records;
- `listProjectPublicPaths`, `create`, and `update` require project owner/admin;
- site-license policy fields require admin or a site-license manager role;
- private records resolve only for project owner/collaborator/admin;
- admins can override for migration/support.

Bay routing:

- slug lookup can happen in the home bay if `public_project_paths` is replicated
  or global;
- project access authorization must be checked by the owning bay;
- project-host file access must route to the project owning bay/host.

For the first one-bay launchpad/lite implementation, keep it local but design
the API boundary so it can become owning-bay routed.

## Migration

### Data Export from cocalc.com

Add old-database export support for:

```sql
SELECT
  id,
  project_id,
  path,
  name,
  description,
  disabled,
  unlisted,
  authenticated,
  license,
  created,
  last_edited,
  last_saved,
  counter,
  url,
  image,
  redirect,
  site_license_id,
  compute_image,
  jupyter_api,
  vhost
FROM public_paths
WHERE project_id IN (<migrated project ids>)
   OR lower(url) LIKE 'cambridge/%'
   OR lower(name) LIKE 'cambridge%'
   OR lower(description) LIKE '%cambridge%';
```

For the broad final export, dump all `public_paths` rows. Import metadata for
rows whose project can be mapped even if the backing files are not yet restored.
Those rows should resolve to a signed-in "not available yet" page until the
project and path are available.

### Import Mapping

For each old `public_paths` row:

1. Map `project_id` to the new project id. For migrated projects, this should be
   identical once legacy project id preservation is live.
2. Normalize the old public URL:
   - prefer `url` if present and if it maps to a path-style CUP URL;
   - otherwise derive from account/project/path/name legacy URL metadata if
     available;
   - for CUP, explicitly map rows to `Cambridge/...` slugs.
3. Set `visibility`:
   - `disabled=true` -&gt; `disabled`;
   - `unlisted=true` -&gt; `unlisted`;
   - otherwise -&gt; `listed`;
   - legacy private/non-public rows should import as `private` or be skipped.
4. Set `requires_auth=true` for CUP.
5. Preserve legacy metadata in `metadata`, including:
   - old `counter`;
   - old `authenticated`;
   - old `site_license_id`;
   - old `compute_image`;
   - old `jupyter_api`;
   - old `vhost`;
   - old `image`.
6. Store `legacy_public_path_id=id` and `legacy_url`.
7. If `site_license_id` is present, map it through an explicit CUP migration
   map:
   - old `site_license_id` -&gt; new `site_license_id`;
   - optional pool id;
   - membership tier id;
   - grant duration;
   - whether copy requires the grant or merely warns on failure.

Do not infer license mappings silently. Produce a report of old public paths
with unmapped `site_license_id` values so CUP can verify coverage before
redirects go live.

### CUP Validation Report

Before enabling redirects, generate a report:

- total CUP `public_paths` rows imported;
- rows skipped because project is not migrated;
- slug collisions;
- rows with missing paths;
- rows with disabled/private status;
- top-level slug summary under `Cambridge`;
- sample of 20 generated old URL -> new URL redirects.
- rows with legacy `site_license_id`, mapped new site license policy, and
  unmapped/disabled license policies.

### General Public Share Validation Report

Also generate a non-CUP report:

- total historical `public_paths` rows imported;
- rows skipped because the project id cannot be mapped;
- rows imported but not yet available because the project/files are not
  restored;
- rows with slug collisions;
- rows that are disabled/private/unlisted/listed;
- sampled old URL -> new URL redirects for non-CUP shares.

## Redirect Strategy

On cocalc.com shutdown site:

- redirect known CUP legacy URLs to cocalc-ai share URLs;
- redirect other known legacy public share URLs when a slug mapping exists;
- preserve path suffixes when possible;
- do not keep the old share server running;
- show a migration/sign-in landing page if the user is not signed in on
  cocalc-ai.

Examples:

```text
https://cocalc.com/Cambridge/9781009209090/Code
  -> https://cocalc.ai/share/Cambridge/9781009209090/Code

https://cocalc.com/cambridge
  -> https://cocalc.ai/share/Cambridge
```

Case handling:

- preserve canonical case in generated cocalc-ai URLs;
- accept case-insensitive lookup for legacy redirects;
- store canonical slug display in `public_project_paths.slug`.

## Security Considerations

- Require sign-in by default.
- Never serve arbitrary project files without a read policy.
- Enforce path normalization and reject `..` traversal.
- Keep `.ssh`, `.snapshots`, and `.local/share/cocalc` excluded by default.
- Do not expose project secrets, runtime, terminals, SSH, or project settings.
- Avoid server-side notebook execution or rendering.
- Rate limit share resolution and listing APIs.
- Attribute file egress to the reader account.
- Add audit logging for create/update/disable public path records.
- Audit site-license grants created from public share copy operations.
- Include an admin emergency disable path for a share or an entire slug prefix.
- Treat public shares as read-only data-plane access, not collaborator
  membership.
- Site-license grant-on-copy must be idempotent and rate limited so reloading or
  retrying a copy cannot mint unlimited memberships.

## Implementation Phases

### Phase 1: Minimal CUP-Capable Backend

- Add `public_project_paths` table and schema ownership metadata.
- Add slug normalization utilities and tests.
- Add hub Conat API for `resolvePublicProjectPath` and
  `listPublicProjectPaths`.
- Add project-host public viewer auth subject or token plumbing.
- Reuse `ProjectViewerReadPolicy` for path-scoped access.
- Add tests for path traversal, disabled shares, unlisted resolution, listed
  listing, and read-policy construction.
- Add tests that disabling a share revokes active temporary viewer access and
  blocks new grant-on-copy attempts.

### Phase 2: Frontend Viewer

- Add `/share/<slug...>` route.
- Build a public share page that resolves the slug and renders the read-only
  project explorer rooted at the shared path.
- Require sign-in and return to the share URL after auth.
- Show title, description, license, and copy-to-project action.
- Add collection listing for `/share/Cambridge`.
- Smoke test `.ipynb`, `.md`, images, code files, and directories.

### Phase 3: Migration Scripts

- Add old cocalc.com public-path export support.
- Add cocalc-ai import script for public paths.
- Add CUP-specific slug mapping rules.
- Add CUP-specific legacy `site_license_id` to cocalc-ai site-license mapping
  support.
- Generate validation report.
- Import into lite4b for testing.
- Fix project/path mismatches discovered in real data.

### Phase 3.5: CUP License on Copy

- Add share-level site-license policy fields or metadata.
- Implement `copyPublicProjectPathToProject` as a durable backend operation.
- Integrate temporary site-license membership grant on copy.
- Add idempotent consumption tracking.
- Add admin/CUP report for grants, failures, and unmapped legacy licenses.
- Test copy with a real CUP share and a temporary site-license tier.

### Phase 4: Redirect and Production Cutover

- Add cocalc.com shutdown-site redirect rules for CUP paths.
- Deploy public share APIs and frontend behind site setting
  `public_directory_shares_enabled`.
- Import CUP records in production.
- Enable redirects for a small allowlist.
- Test live CUP links with real migrated projects.
- Enable all CUP redirects.

### Phase 5: Owner UI

- Add project settings panel for public directory shares.
- Add create/edit/disable controls for owners.
- Add file-explorer "Make directory public" action.
- Add copyable URL display.
- Add admin prefix disable and collision management.

## Tests

Backend:

- slug normalization rejects traversal/control characters;
- duplicate slug conflict returns a clear error;
- listed shares appear in prefix listing;
- unlisted shares resolve directly but do not appear in listing;
- disabled shares return not found;
- private shares require collaborator/owner/admin access;
- generated read policy allows only the shared path and descendants;
- generated read policy excludes `.ssh`, `.snapshots`, and
  `.local/share/cocalc`;
- public share viewer subject cannot use normal project filesystem subjects;
- egress attribution uses viewer account id.

Frontend:

- unauthenticated visitor is sent to sign-in and returns to the same share URL;
- signed-in visitor sees directory listing rooted at shared path;
- navigating above shared root is blocked or visually impossible;
- notebook preview works without starting the project runtime;
- markdown preview works;
- copy-to-project works;
- copy-to-project with a share license policy grants temporary membership to
  the destination project;
- duplicate/retried copy does not create unlimited site-license grants;
- share license pool exhaustion produces a clear warning or blocking error
  according to `site_license_copy_requires_grant`;
- copied project grant metadata includes public share id, source project id,
  destination project id, and legacy public path id;
- listed collection page works for `/share/Cambridge`;
- unlisted share is not listed but direct URL works.

Migration:

- CUP row count matches expected old `public_paths` count;
- every imported row has a valid project id;
- every imported row has a normalized slug;
- collision report is empty or explicitly resolved;
- sampled old URLs redirect to correct cocalc-ai URLs;
- sampled shares open and preview files.
- sampled CUP shares with old `site_license_id` create the expected temporary
  destination-project license on copy.

## Operational Notes

- The feature should be disabled by default via site setting for self-hosted
  sites until owner UI is ready.
- CUP migration can be enabled with imported records before general UI exists.
- Non-CUP public share metadata should also be imported; unavailable shares
  should show a clear "not available yet" state instead of disappearing.
- CUP license-on-copy can initially be configured by import scripts and admin
  reports instead of polished owner-facing UI.
- If a migrated project restore is still pending, the share page should show a
  clear "project files are still being restored" status rather than a blank
  directory.
- If a project is not migrated yet, the share should show "not available yet"
  for signed-in users and should be visible in the CUP validation report.
- For long-term cleanup, this feature can replace most old share-server use
  cases without ever reintroducing anonymous publication.

## Decisions

- Do not support anonymous `requires_auth=false` records in the first release.
  All public directory shares require sign-in.
- Import non-CUP historical public shares too. If the share metadata exists but
  the backing project/files are not available yet, show a signed-in "not
  available yet" page instead of hiding the share.
- Do not build a shutdown-critical public `/share/Cambridge` collection page.
  Exact share URLs matter. CUP owners instead need an account/project settings
  page that lists all public shares they control.
- Configure CUP grant-on-copy through an ordinary cocalc-ai site license named
  `cambridge` and a tier/pool such as `readers`. Each imported CUP public path
  with legacy `site_license_id` should be mapped to explicit
  `site_license_id`, tier/pool, duration, and grant-on-copy fields.
- Site-license grant failure should warn and still allow copy. Most content
  remains usable on the free tier.
- Per-account/per-share consumption limits should be configured by site admins
  on the site license or share policy, not hardcoded globally.
- CUP's backing content is expected to be in two restored projects, so CUP
  redirects should only be enabled after those projects are restored and
  validated.
- Store authoritative public path records on the project owning bay. Store a
  small seed/global slug directory mapping `lower(slug)` to owning bay, public
  path id, and project id so `/share/...` can route correctly in future
  multibay deployments.
