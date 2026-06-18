# Rootfs Discovery and Flyout Plan

Date: 2026-06-15

Status: implementation plan for CUP content delivery and reusable rootfs
discovery UX

## Context

Cambridge University Press needs to publish computational content associated
with papers and books. The cocalc.com migration plan recommends replacing the
old CUP secret-URL flow with rootfs-backed landing pages plus signed
site-license claim tokens.

The missing product piece is discovery. A rootfs may contain notebooks,
datasets, examples, kernels, and installed packages under `/`, but a user who
opens a new project sees `/home/user` and may never discover the content. CUP
and similar publishers need a polished way to advertise what is in the rootfs
and give users safe one-click actions.

## Goals

- Make published rootfs content discoverable before and after project creation.
- Create a generic discovery config model for managed rootfs images.
- Add a new in-project `Rootfs` flyout panel.
- Move the project Runtime Image card from Settings > Environment into the new
  Rootfs flyout.
- Keep trust/scan/version details admin-only until that UI is more polished.
- Support CUP as the first publisher without making the feature CUP-specific.
- Preserve the multibay architecture: rootfs catalog state remains seed-global,
  project actions route to the owning bay/project host.

## Non-Goals

- Do not execute commands from publisher-provided discovery configs.
- Do not auto-copy all publication content into `/home/user`.
- Do not require a signed site-license token to use rootfs discovery. Claims are
  an optional entitlement step.
- Do not expose unfinished trust/scan/version UX to ordinary users.
- Do not make rootfs catalog metadata mutable from inside an ordinary project
  unless the existing publish/manage permissions allow it.

## Product Shape

There are two separate user surfaces.

### Public Rootfs Landing Page

Purpose:

- Explain the content, publisher, runtime image, and membership requirement.
- Let a user sign in or sign up.
- Optionally redeem a site-license claim token.
- Create a project using the rootfs.

This page is for users before they have a project.

### In-Project Rootfs Flyout

Purpose:

- Show the current runtime image.
- Advertise content inside the rootfs.
- Provide safe one-click links/actions such as opening notebooks or browsing
  directories.
- Let users copy examples into HOME when appropriate.
- Let users change/upgrade the runtime image from a dedicated place.

This panel is for users after they have a project.

## Rootfs Discovery Config

Add a first-class discovery config format. The definitive copy lives in rootfs
catalog metadata. Portable JSON files are import/export bundles for authors,
publishers, CLI users, and agents; they are not authoritative after import.

- Rootfs catalog metadata, edited by admins or publishers.
- Portable RootFS config JSON exported from the UI or authored for the CLI.

At publish/catalog-save time, CoCalc validates and stores a normalized copy in
the rootfs catalog. The browser should not need to start a project or inspect
`/` just to render the landing page.

### Suggested Discovery Shape

```json
{
  "version": 1,
  "publisher": {
    "name": "Cambridge University Press",
    "url": "https://www.cambridge.org/"
  },
  "title": "PyTorch examples for Example Book",
  "subtitle": "Interactive notebooks and a ready-to-use Python environment",
  "description": "A short plain-text or markdown description.",
  "license": {
    "label": "Publisher content license",
    "url": "https://example.com/license"
  },
  "highlights": [
    "Python 3.12",
    "PyTorch",
    "Jupyter notebooks",
    "Sample datasets"
  ],
  "actions": [
    {
      "id": "open-intro",
      "label": "Open introduction notebook",
      "kind": "open",
      "path": "/opt/cup/examples/introduction.ipynb"
    },
    {
      "id": "browse-examples",
      "label": "Browse examples",
      "kind": "browse",
      "path": "/opt/cup/examples"
    },
    {
      "id": "copy-examples",
      "label": "Copy examples to HOME",
      "kind": "copy-to-home",
      "source_path": "/opt/cup/examples",
      "target_path": "cup-examples"
    },
    {
      "id": "publisher-docs",
      "label": "Publisher documentation",
      "kind": "external-link",
      "url": "https://example.com/docs"
    }
  ]
}
```

### Discovery Config Rules

- Plain JSON only.
- Markdown description is allowed only if rendered through existing safe
  markdown rendering.
- No raw HTML.
- No shell commands.
- No arbitrary JavaScript.
- Paths must be absolute rootfs paths for `open`, `browse`, and source paths.
- Copy targets must be relative to project HOME and sanitized.
- External links must be `https://`.
- Limit total size, action count, string lengths, and markdown length.
- Unknown action kinds are ignored with an admin-visible validation warning.

## Catalog Metadata Extension

Extend `RootfsImageEntry` and save/publish bodies with an optional
`content_manifest` or `content` field.

Suggested normalized field:

- `content?: RootfsContentManifest`

The normalized content should live with the rootfs catalog entry so:

- Landing pages can render without project startup.
- Search/filter can include publisher/title/highlights later.
- Rootfs flyout can render quickly from catalog metadata.

Use dedicated catalog storage for this rather than overloading visual theme
metadata:

- `content?: RootfsContentManifest` as public normalized metadata.
- `content_warnings?: RootfsContentValidationWarning[]` or equivalent
  admin-only validation metadata.

Admin UI can initially expose this as JSON editing plus validation. A polished
publisher editor can come later.

## Rootfs Config Import / Export

The RootFS catalog entry is the single source of truth. JSON files are only a
portable authoring format.

The portable config bundle should include:

- catalog metadata such as label, description, version, visibility, and tags;
- theme metadata;
- normalized discovery content, including open, browse, copy-to-HOME, external
  link, and project app launch actions.

The UI should support export/import of this bundle from catalog management. The
CLI should support the same bundle for `rootfs save` and `rootfs publish`, with
explicit CLI flags overriding config-file values. This lets an agent publish a
fully described rootfs without browser-only steps.

## Public Landing Page

Route shape can be decided during implementation, but it should support stable
links such as:

- `/rootfs/<slug>`
- `/rootfs/id/<image_id>` or another explicit image-id fallback route
- `/publishers/<publisher_slug>/<publication_slug>`

The public/shareable URL should not expose a long hash by default. Each rootfs
catalog entry should get a short globally unique slug, generated automatically
when the user does not choose one. Publisher/admin users may optionally choose a
slug if the UI cost stays low. User-selected slugs should follow the same
general constraints as names in `src/packages/util/db-schema/name-rules.ts`:
short, URL-safe, no UUID-looking names, no reserved words, and no consecutive
hyphens. Slugs must have a unique database constraint.

Current implementation note:

- The landing page route exists and works, including `/rootfs/<slug>` and
  `/rootfs/id/<image_id>`.
- The catalog-management RootFS config UI shows the public landing URL, with
  open/copy actions, and exposes a public slug field.
- Backend save/publish auto-generates a short globally unique slug when none is
  provided, validates user-provided slugs, and rejects duplicates.
- Remaining slug polish: make slug editing more self-explanatory, add
  client-side validation/normalization, provide an easy generated suggestion,
  and consider a lightweight availability check before save.

Initial page contents:

- Publisher and title.
- Rootfs theme artwork if present.
- Description and highlights.
- Required membership or claim-token state if configured.
- Sign-in/sign-up prompt when needed.
- Create project button.
- Optional claim-token redemption step.

Project creation requirements:

- Use stable rootfs image id/release, not a loose image string.
- Apply rootfs image and image id to the new project.
- Respect normal project placement and owning-bay routing.
- If a claim token is involved, membership claim must complete before creating
  a project that requires that membership.

## Rootfs Flyout

Add a new left-rail flyout named `Rootfs`.

Initial ordinary-user content:

- Current runtime image card.
- Publisher/content summary when available.
- Highlights/tags.
- Safe content actions.
- Copy-to-HOME actions with progress and clear overwrite behavior.
- Runtime image switch/upgrade controls.

Admin-only content:

- Scan status.
- Trust/version/release details.
- Raw image reference.
- Release/artifact identifiers.
- Discovery config validation warnings.
- Catalog management shortcuts.

The existing Settings > Environment Runtime Image card should move into this
flyout. Settings > Environment can keep a small link saying runtime image moved
to Rootfs, or the settings section can continue to expose project secrets and
environment variables only.

## Safe Action Semantics

### `open`

- Opens a file by absolute rootfs path.
- CoCalc projects already support access to paths outside HOME, including
  read-only and read-write rootfs paths depending on how the image was
  published. The MVP should use that directly when possible.
- If a path is outside HOME and writeability is ambiguous, the UI should make
  it clear that edits may live in the overlay and may stop being visible after
  changing the runtime image. Offer an obvious copy-to-HOME action.

### `browse`

- Opens the file explorer at an absolute rootfs directory.
- Browsing outside HOME should be a generic file-explorer capability, not only
  a Rootfs flyout special case.
- Whenever the user is browsing a directory outside HOME, the UI should make it
  easy to copy selected files/directories into HOME.

### `copy-to-home`

- Server/project-host copies rootfs content into HOME.
- Target is relative to HOME.
- Existing target behavior must be explicit: fail, merge, or create a numbered
  copy.
- MVP should default to not overwriting existing files. A later iteration may
  add an explicit overwrite checkbox, but it should not be checked by default.
- Progress should be visible in the flyout and survive panel close/reopen if
  practical.
- The same copy-to-HOME operation should be usable from the generic file
  explorer when the source is outside HOME.
- For the RootFS action UI, provide both a fast default copy and a chooser flow:
  a clean "Copy to HOME" path for the configured target, plus a "Copy..."
  option that opens a small directory selector modal. The modal should reuse
  the simple HOME / parent / choose directory selector style from the New/Find
  flows, allow typing a directory name under HOME, and copy without overwriting
  existing content by default.

### `external-link`

- Open HTTPS publisher docs in a new tab.

## Project-Host API Needs

The Rootfs flyout needs safe project-host operations:

- Check whether a rootfs path exists.
- Copy a file/directory from rootfs lower filesystem to HOME.
- Return progress for a copy operation.
- Open/browse rootfs paths outside HOME using existing project filesystem
  access semantics.
- Support a generic "copy this non-HOME path into HOME" operation that can be
  used by both the Rootfs flyout and the file explorer.

Do not route steady-state file copy or path probing through the hub unless
there is a documented reason. The hub/control plane should authorize and issue
project-host access; the project host should perform project filesystem work.

## Multibay Requirements

- Rootfs catalog and release metadata are seed-global.
- Project creation from a landing page must route through account home bay and
  chosen project owning bay.
- Project runtime image changes must route to the project owning bay.
- Rootfs content file operations happen on the project host.
- Browser code must not assume a local/default Conat client is authoritative
  for seed-global catalog or project-owned state.

## Relationship To Token Authority

Rootfs discovery may consume token-authority output:

- A landing page may receive a claim token.
- A token may include `rootfs_id`.
- A successful claim may redirect to a rootfs landing or project creation flow.

Rootfs discovery should not:

- Verify claim signatures.
- Consume `jti` values.
- Assign memberships.
- Depend on token authority to render public content metadata.

This separation lets CUP launch with combined UX while preserving independent
security and content subsystems.

## Implementation Phases

### Phase 1: Discovery Types and Validation

- Define `RootfsContentManifest` in `@cocalc/util/rootfs-images`.
- Add validation/sanitization helpers with tests.
- Extend rootfs catalog entry types with normalized content metadata.
- Add admin-only validation warning storage.
- Define slug validation, generated-slug format, and uniqueness rules.

### Phase 2: Catalog Storage and Admin Editing

- Extend rootfs save/publish APIs to accept content metadata.
- Add schema/migration support for dedicated `rootfs_images.content`,
  admin-only validation warnings, and public slug storage.
- Add a discovery config builder, preview, and JSON import/export in admin or
  publisher rootfs management.
- Add CLI support for the same portable config JSON on `rootfs save` and
  `rootfs publish`.
- Allow users with manage permission to accept an auto-generated slug or choose
  a valid unique slug. Initial support exists; remaining work is polish around
  generated suggestions, validation messaging, and uniqueness feedback.
- Link to the public landing page from the catalog-management/config UI so the
  share page is discoverable while authors are editing RootFS metadata. Initial
  link/copy/open support exists.
- Hide trust/scan/version UI from ordinary users for now.

### Phase 3: Rootfs Flyout Skeleton

- Add `Rootfs` rail item and flyout body.
- Move Runtime Image UI into the Rootfs flyout.
- Keep Settings > Environment compatibility links/docs actions working.
- Render current image and content summary from catalog metadata.
- Add tests for rail visibility, moved runtime-image entry point, and admin-only
  details.

### Phase 4: Content Actions

- Implement safe action rendering.
- Implement project-host copy-to-HOME operation.
- Add progress and success/failure UX.
- Add direct open/browse support for rootfs paths outside HOME.
- Add generic file-explorer copy-to-HOME affordance for non-HOME source paths.
- As an MVP compromise before the generic file-explorer affordance, add a
  RootFS copy destination chooser so users can pick or type the HOME-relative
  destination at copy time.
- Add tests for path sanitization, copy target handling, and unsupported action
  kinds.

### Phase 5: Public Landing Page and Create Project Flow

- Add rootfs landing route by slug, plus an image-id fallback route.
- Render publisher/title/description/highlights/actions preview.
- Integrate sign-in/sign-up continuation.
- Integrate optional token redemption as an entitlement step.
- Create project with selected rootfs image id.
- Redirect to the new project Rootfs flyout after creation so the user sees the
  content immediately.
- Make the landing page URL easy to find from RootFS catalog management and
  config authoring UI.

### Phase 6: CUP Pilot

- Create one CUP sample rootfs discovery config.
- Create or configure one CUP rootfs catalog entry.
- Exercise landing page, claim, project creation, flyout content discovery, and
  copy-to-HOME.
- Write publisher-facing instructions for authoring and importing/exporting
  RootFS config JSON.
- Token/claim integration is being implemented in parallel via
  `site-license-token-authority-plan-2026-06-15.md`; RootFS discovery should
  stay compatible with that flow without blocking on it.

### Phase 8: Publisher and Agent Documentation

- Add pages under `src/packages/docs` that explain RootFS publishing,
  catalog/config metadata, public landing pages, slugs, JSON import/export,
  app actions, and testing.
- Link from the RootFS catalog/config UI to these docs.
- Link from the docs back to the RootFS management/config entry points where
  possible.

### Phase 7: CLI / Agent Parity Pilot

- Ensure `cocalc rootfs publish --config-file ... --switch-project --wait` can
  publish catalog metadata, theme, discovery actions, and project app launch
  actions.
- Use the CLI and project automation to create a Pluto/Julia rootfs with a
  copyable example directory, a hello-world Pluto notebook, and a Pluto project
  app action.
- Create a new project from the public landing page and verify that copy,
  browse/open, and app-launch actions work without browser-only catalog editing.

## Acceptance Criteria

- A rootfs catalog entry can advertise publisher content without starting a
  project.
- A public landing page renders from catalog metadata alone; it does not require
  starting a project or inspecting `/`.
- A project using that rootfs shows a Rootfs flyout with the current runtime
  image and publisher content actions.
- Runtime image management works from the Rootfs flyout.
- Trust/scan/version details are visible to admins only.
- A user can directly open/browse advertised rootfs paths when permitted.
- A user can one-click copy an advertised example directory, or any browsed
  non-HOME path, into HOME with clear progress and result state.
- Copy-to-HOME does not overwrite existing files by default.
- A public landing page can create a project using a stable rootfs image id,
  reached through a short rootfs slug.
- The public landing URL is shown in RootFS config/catalog management and can be
  copied/opened by authors.
- Authors can leave slug blank for backend generation or choose a user-facing
  slug with immediate validation feedback.
- The implementation works with seed-global catalog authority and project-owned
  bay routing.

## Open Decisions

- Exact landing URL shape.
  - Current direction: `/rootfs/<slug>` for human/shareable links, with an
    explicit image-id fallback route. Generate short unique slugs by default.
    Optionally allow user-selected slugs using the existing name-rule style.
- Exact slug schema fields and whether publisher/publication aliases are
  separate tables or initially stored directly on `rootfs_images`.
- `rootfs_images` should get dedicated content storage rather than using
  `theme`.
- Whether the MVP supports read-only browsing of `/` or only copy-to-HOME.
  - Current direction: support direct open/browse because CoCalc projects
    already support read-only and read-write access to `/` and other non-HOME
    paths. Copy-to-HOME is still important, but not the only discovery path.
- Initial overwrite policy for copy-to-HOME.
  - Current direction: do not overwrite by default. Consider an explicit
    overwrite checkbox later, unchecked by default.
- Publisher slug/publication slug ownership and uniqueness rules.
  - Current direction: auto-generate short random globally unique slugs, but
    optionally allow user-selected slugs if validation and uniqueness are
    straightforward.
- Whether rootfs config should ever be embedded in the immutable rootfs.
  - Current direction: no. Catalog metadata is the source of truth. Portable
    JSON files are import/export bundles only.
