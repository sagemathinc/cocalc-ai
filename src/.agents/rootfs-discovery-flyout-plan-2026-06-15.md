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
- Create a generic content manifest model for managed rootfs images.
- Add a new in-project `Rootfs` flyout panel.
- Move the project Runtime Image card from Settings > Environment into the new
  Rootfs flyout.
- Keep trust/scan/version details admin-only until that UI is more polished.
- Support CUP as the first publisher without making the feature CUP-specific.
- Preserve the multibay architecture: rootfs catalog state remains seed-global,
  project actions route to the owning bay/project host.

## Non-Goals

- Do not execute commands from publisher-provided manifests.
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

## Rootfs Content Manifest

Add a first-class manifest format. It can come from:

- A canonical file inside the rootfs, e.g. `/.cocalc/rootfs-content.json`.
- Rootfs catalog metadata, edited by admins or publishers.

At publish/catalog-save time, CoCalc should extract, validate, sanitize, and
store a normalized copy in the rootfs catalog. The browser should not need to
start a project or inspect `/` just to render the landing page.

### Suggested Manifest Shape

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

### Manifest Rules

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

Admin UI can initially expose this as JSON editing plus validation. A polished
publisher editor can come later.

## Rootfs Manifest Extraction

At rootfs publish time:

1. Inspect the project/rootfs snapshot for `/.cocalc/rootfs-content.json`.
2. Validate and normalize it.
3. Store the normalized content metadata in the catalog entry.
4. Store validation warnings in admin-only metadata.
5. Do not fail the entire publish unless the publisher explicitly marks the
   manifest as required.

For catalog entries created around existing OCI images, allow admins to paste
content metadata directly.

## Public Landing Page

Route shape can be decided during implementation, but it should support stable
links such as:

- `/rootfs/<image_id>`
- `/publishers/<publisher_slug>/<publication_slug>`

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
- Manifest validation warnings.
- Catalog management shortcuts.

The existing Settings > Environment Runtime Image card should move into this
flyout. Settings > Environment can keep a small link saying runtime image moved
to Rootfs, or the settings section can continue to expose project secrets and
environment variables only.

## Safe Action Semantics

### `open`

- Opens a file by absolute rootfs path if the project host can expose it.
- If direct rootfs file open is not already supported, first implementation may
  copy the file to HOME and open the copy, but the UI must say that.

### `browse`

- Opens the file explorer at an absolute rootfs directory if supported.
- If the existing explorer is HOME-centered only, open a read-only rootfs
  browser view or defer to copy-to-HOME for MVP.

### `copy-to-home`

- Server/project-host copies rootfs content into HOME.
- Target is relative to HOME.
- Existing target behavior must be explicit: fail, merge, or create a numbered
  copy. MVP should default to fail with a clear message unless user confirms.
- Progress should be visible in the flyout and survive panel close/reopen if
  practical.

### `external-link`

- Open HTTPS publisher docs in a new tab.

## Project-Host API Needs

The Rootfs flyout needs safe project-host operations:

- Check whether a rootfs path exists.
- Copy a file/directory from rootfs lower filesystem to HOME.
- Return progress for a copy operation.
- Possibly open/browse read-only rootfs paths.

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

### Phase 1: Manifest Types and Validation

- Define `RootfsContentManifest` in `@cocalc/util/rootfs-images`.
- Add validation/sanitization helpers with tests.
- Extend rootfs catalog entry types with normalized content metadata.
- Add admin-only validation warning storage.

### Phase 2: Catalog Storage and Admin Editing

- Extend rootfs save/publish APIs to accept content metadata.
- Add schema/migration support if current `rootfs_images` storage needs a new
  column.
- Add JSON editor/preview in admin rootfs management.
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
- Add read-only open/browse support if feasible; otherwise use clear copy-first
  behavior for MVP.
- Add tests for path sanitization, copy target handling, and unsupported action
  kinds.

### Phase 5: Public Landing Page and Create Project Flow

- Add rootfs landing route.
- Render publisher/title/description/highlights/actions preview.
- Integrate sign-in/sign-up continuation.
- Integrate optional token redemption as an entitlement step.
- Create project with selected rootfs image id.
- Redirect to the new project Rootfs flyout after creation so the user sees the
  content immediately.

### Phase 6: CUP Pilot

- Create one CUP sample rootfs content manifest.
- Create or configure one CUP rootfs catalog entry.
- Exercise landing page, claim, project creation, flyout content discovery, and
  copy-to-HOME.
- Write publisher-facing instructions for authoring
  `/.cocalc/rootfs-content.json`.

## Acceptance Criteria

- A rootfs catalog entry can advertise publisher content without starting a
  project.
- A project using that rootfs shows a Rootfs flyout with the current runtime
  image and publisher content actions.
- Runtime image management works from the Rootfs flyout.
- Trust/scan/version details are visible to admins only.
- A user can one-click copy an advertised example directory into HOME with
  clear progress and result state.
- A public landing page can create a project using a stable rootfs image id.
- The implementation works with seed-global catalog authority and project-owned
  bay routing.

## Open Decisions

- Exact landing URL shape.
- Whether `rootfs_images` needs a dedicated `content` column or can initially
  use existing metadata storage.
- Whether the MVP supports read-only browsing of `/` or only copy-to-HOME.
- Initial overwrite policy for copy-to-HOME.
- Publisher slug/publication slug ownership and uniqueness rules.
- Whether rootfs manifest extraction should run during all publishes or only
  when requested.
