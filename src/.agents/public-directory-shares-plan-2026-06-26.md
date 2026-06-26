# Public Directory Shares Migration Plan

Date: 2026-06-26

## Context

Cambridge University Press depends heavily on the old cocalc.com share server.
They have hundreds of `public_paths` records, including URLs such as:

- `https://cocalc.com/cambridge`
- `https://cocalc.com/Cambridge/9781009209090/Code`

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
- Avoid reimplementing the old share server publication pipeline.
- Use live project files as the source of truth.
- Require sign-in before reading shared content.
- Count file reads and copy egress against the signed-in viewer account.
- Reuse existing cocalc-ai project viewer/read-policy machinery wherever
  possible.
- Support viewing notebooks, markdown, code, data files, directories, and
  copying a shared directory into a user's own project.
- Support CUP's visibility modes: listed, unlisted, private/disabled.
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
- show a small "Provided by <project/account/title>" attribution if available;
- avoid exposing unrelated project folders.

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

### Collection Pages

Support collection routes by prefix:

```text
/share/Cambridge
```

If an exact slug exists, show that share. Otherwise, show listed shares under
the prefix:

```ts
listPublicProjectPaths({ prefix: "Cambridge", visibility: "listed" });
```

This is useful for CUP's `/cambridge` landing page.

### Manage UI

First pass:

- admin/import scripts can create records;
- project owners can see public shares for a project in project settings;
- owners can enable/disable, set visibility, title, description, and slug.

Later:

- add right-click "Make directory public" from the file explorer;
- add conflict warnings for slug collisions;
- add per-share analytics.

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
}): Promise<PublicProjectPathSummary>;
```

Permission rules:

- `resolvePublicProjectPath` requires signed-in account for CUP records;
- `listPublicProjectPaths` returns only listed, enabled records;
- `listProjectPublicPaths`, `create`, and `update` require project owner/admin;
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

For the broad final export, dump all `public_paths` rows and filter/import only
rows whose projects have been migrated or whose owner/customer is in the
migration allowlist.

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
   - `disabled=true` -> `disabled`;
   - `unlisted=true` -> `unlisted`;
   - otherwise -> `listed`;
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

### CUP Validation Report

Before enabling redirects, generate a report:

- total CUP `public_paths` rows imported;
- rows skipped because project is not migrated;
- slug collisions;
- rows with missing paths;
- rows with disabled/private status;
- top-level slug summary under `Cambridge`;
- sample of 20 generated old URL -> new URL redirects.

## Redirect Strategy

On cocalc.com shutdown site:

- redirect known CUP legacy URLs to cocalc-ai share URLs;
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
- Include an admin emergency disable path for a share or an entire slug prefix.
- Treat public shares as read-only data-plane access, not collaborator
  membership.

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
- Generate validation report.
- Import into lite4b for testing.
- Fix project/path mismatches discovered in real data.

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
- listed collection page works for `/share/Cambridge`;
- unlisted share is not listed but direct URL works.

Migration:

- CUP row count matches expected old `public_paths` count;
- every imported row has a valid project id;
- every imported row has a normalized slug;
- collision report is empty or explicitly resolved;
- sampled old URLs redirect to correct cocalc-ai URLs;
- sampled shares open and preview files.

## Operational Notes

- The feature should be disabled by default via site setting for self-hosted
  sites until owner UI is ready.
- CUP migration can be enabled with imported records before general UI exists.
- If a migrated project restore is still pending, the share page should show a
  clear "project files are still being restored" status rather than a blank
  directory.
- If a project is not migrated yet, the share should show "not available yet"
  for signed-in users and should be visible in the CUP validation report.
- For long-term cleanup, this feature can replace most old share-server use
  cases without ever reintroducing anonymous publication.

## Open Questions

- Should the first release support any `requires_auth=false` records? For CUP,
  no.
- Should `/share/Cambridge` be an exact imported share, a generated collection
  page, or both? Prefer exact share if present; otherwise collection by prefix.
- Should old `site_license_id` grant temporary membership on copy? This can be
  layered on later using the new site-license invite-token work.
- How should we display projects whose files have not yet been restored from
  R2? The share page should have a pending/unavailable state, but details
  depend on legacy migration LRO availability.
- Should slug lookup be global or bay-local in Rocket? First implementation can
  be bay-local, but the API should be written so global slug lookup can route to
  the owning bay later.
