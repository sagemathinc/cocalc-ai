# CoCalc-ai Docs and Actions Release Plan

Status: launchable beta; production hardening remains
Date: 2026-06-01

## Purpose

CoCalc-ai now has integrated documentation that is versioned with the running
product, searchable by humans and agents, and connected to safe UI actions. This
replaces links to the legacy `https://doc.cocalc.com/` documentation, which
describes the previous generation of CoCalc and is misleading for CoCalc-ai.

The system supports three surfaces:

- Public human docs at `/docs`, available without sign-in.
- Signed-in docs at `/app-docs` and in the project flyout.
- Agent-readable docs and safe UI actions through `cocalc docs ...`,
  `cocalc browser action docs ...`, and the CoCalc docs Codex skill.

## Release Readiness

This is ready for a first production release as a beta. The core product surface
exists, static release gates are green, and every executable docs action has a
live verification scenario.

Current static docs verification:

- Entries: 61.
- Actions: 53.
- Live scenarios: 53.
- Legacy `doc.cocalc.com` links: 0.
- `/app-docs` links: 27.
- Categories without chapters: 0.
- Pages without actions: 0.
- Pages without asserted live verification: 0.
- Pages with stale `lastReviewed`: 0.
- Intentionally actionless pages: 13.

The intentionally actionless pages are reference, troubleshooting, or
context-dependent workflows where a single safe UI destination would be
misleading. For example, course assignment creation requires choosing a
specific `.course` file, and a project may contain many courses or none.

## Implemented Surface

- `src/packages/docs` owns docs entries, topic-split content, chapter metadata,
  search, action metadata, and static/live verification.
- Public `/docs` does not require sign-in.
- In-app `/app-docs` has refresh-safe routing, persisted selected page, and a
  global navbar tab.
- Project flyout docs can preselect the current project for project-scoped
  actions.
- Public and in-app docs share the same source content but use separate routes.
- Lite/cocalc-plus filtering hides or adapts pages that do not apply to the
  single-user local desktop model.
- The docs browser includes image-backed cards, chapter landing cards, table of
  contents, linear next/previous navigation, next/previous chapter navigation,
  explicit learned progress, viewed link coloring, private notes, stars, and
  JSON import/export.
- Print-friendly docs exist for public and in-app contexts.
- In-app docs can open a standalone print/download window and can download a
  self-contained HTML file with embedded images.
- `cocalc docs list/search/show/actions/action/verify/skill-context` exists for
  bundled docs.
- `cocalc browser action docs-list` and `cocalc browser action docs <id>` expose
  live action availability and execution in a target browser session.
- The docs action registry supports project parameters and project-host
  parameters.
- Project-host docs cover access/RAM, moving projects, lifecycle, spot
  recovery, change rules, reliability, software and daemon lifecycle, storage,
  shared `/scratch`, backups, snapshots, logs, and host selection.
- Admin docs are modeled with admin visibility and are hidden from public docs.
- Legacy docs links are blocked by static verification.

## Verification Commands

Run static verification:

```sh
pnpm -C src/packages/docs verify
```

Run the docs gap report:

```sh
pnpm -C src/packages/docs gaps
```

The root `src` test command also runs the static docs checks:

```sh
pnpm -C src test
```

Run live verification against the active browser session:

```sh
cd src && eval "$(pnpm -s dev:hub:env)"
cocalc docs verify --live --project-id "$COCALC_PROJECT_ID"
```

Run live verification with a dedicated spawned Chromium session:

```sh
cd src && eval "$(pnpm -s dev:hub:env)"
cocalc docs verify --live --spawn-browser \
  --project-id "$COCALC_PROJECT_ID" \
  --host-id "$COCALC_DOCS_VERIFY_HOST_ID"
```

Keep the spawned browser alive for debugging:

```sh
cocalc docs verify --live --spawn-browser --keep-browser \
  --project-id "$COCALC_PROJECT_ID"
```

Before using live hub, project-host, or browser automation commands, refresh the
matching dev environment:

```sh
cd src && eval "$(pnpm -s dev:hub:env)"
```

For local dev operations requiring fresh auth:

```sh
cocalc auth elevate --dev
```

## Action Design

Docs actions are stable product-level UI actions. They are not CSS selectors and
not arbitrary browser JavaScript.

Current implementation:

- Frontend action registry:
  `src/packages/frontend/project/docs-actions.ts`
- Docs action metadata:
  `src/packages/docs/src/entries/*`
- Docs types:
  `src/packages/docs/src/types.ts`
- Browser-session action support:
  `src/packages/frontend/conat/browser-session`

Rules:

- Action ids are stable and semantic.
- Actions may open UI, focus panels, expand flyouts, or open modals.
- Actions should not directly mutate dangerous state.
- Destructive or credential-sensitive actions require normal UI confirmation.
- Ambiguous actions should remain documented workflows until the action target
  includes the missing context.
- Every executable action should have static metadata validation and a live
  browser-session scenario.

### Acknowledgement Protocol

Some destinations require switching project tabs, opening a flyout, expanding a
settings section, and signaling a nested component. Use the generic
open-parent/signal-child pattern:

1. Open the parent component that should receive the signal.
2. Send a typed `CustomEvent` containing action id, relevant id, target surface,
   and request id.
3. The receiving component performs the local UI action and dispatches an
   acknowledgement event with the same request id.
4. The action runner waits up to 1 second for acknowledgement.
5. If no acknowledgement arrives, it sends the signal again.
6. If the second attempt also has no acknowledgement, the action returns
   `opened: true` with a warning instead of claiming full success.

Prefer independent modal entry points only when a modal is genuinely shared
across unrelated surfaces or when parent-surface routing becomes more fragile
than a small centralized wrapper.

## Current Backlog

### Release Hardening

- Wire the root static docs checks into CI/release workflows so production
  deploys fail on broken docs metadata, stale legacy links, or docs gaps.
- Run full live verification regularly against real project and project-host
  parameters.
- Keep improving spawned-browser/fresh-auth reliability for local dev and CI.
- Add focused CLI tests for `cocalc docs` commands.
- Ensure the CoCalc Codex runtime includes or can discover the CoCalc docs
  skill automatically.

### Test Coverage

- Add broader browser/UI checks for in-app private docs state:
  - note editing;
  - import/export;
  - filters;
  - note-aware search;
  - learned progress.
- Add no-side-effects live verification mode for actions that create files or
  terminals.
- Keep expanding post-action DOM/state assertions as actions become more
  specific.

### Content Coverage

- Keep adding account settings, billing, licenses, cocalc-plus/lite caveats,
  and common troubleshooting pages.
- Expand detailed admin user sub-workflows.
- Expand deeper admin project-host operations.
- Add provider-specific project-host bootstrap troubleshooting.
- Add DNS, tunnel, and network-path details for project hosts.
- Add richer related-doc suggestions.
- Add a compact source/reference foldout, visible either always or only to
  admins/developers.

### Future Product Integrations

- Add contextual help buttons in editors and settings panels that open specific
  docs ids.
- Add "Ask Codex about this" from docs pages with doc id and project context.
- Let Codex answers render trusted action buttons from docs metadata or typed
  tool results.
- Consider extracting docs actions into a separate deep-action package once
  other product areas want the same action registry.
- Consider a docs search API or static `/docs/manifest.json` and
  `/docs/search-index.json` for tools that need the running deployment's docs.

## Product Principles

1. Docs are versioned with the product.
2. Docs are structured data, not a separate CMS.
3. Docs are optimized for both humans and agents.
4. Screenshots are optional and rare; stable UI paths, action ids, and source
   references matter more.
5. Docs should be testable.
6. UI actions should be typed and centralized.
7. Source code is context, not the primary support interface.

## Legacy Link Policy

No new `https://doc.cocalc.com/` links should be added to scanned CoCalc-ai
source. Static verification fails on these links.

Use one of these replacements:

- `/docs/...` for public docs.
- `/app-docs/...` for signed-in docs.
- Project flyout docs for project-context help.
- A field guide only when it is accurate for CoCalc-ai and intentionally
  external.

## Codex Skill

The CoCalc docs skill lives at:

```text
src/.agents/skills/cocalc-docs/SKILL.md
```

Expected behavior:

1. Search versioned docs before source code for user-facing CoCalc behavior.
2. Use `cocalc docs search` and `cocalc docs show`.
3. Use `cocalc docs action` or browser-session docs actions for safe UI
   navigation when the user asks to open a destination.
4. Fall back to source-code search only when docs are missing or ambiguous.
5. Report missing docs and propose a new task doc when appropriate.

Useful commands:

```sh
cocalc docs search "project secrets"
cocalc docs show projects.project-secrets
cocalc docs action settings.environment.secrets --project-id "$COCALC_PROJECT_ID"
cocalc docs skill-context --query "project hosts" --limit 8
```

## Open Decisions

- How much docs content should ship in the CLI bundle long term? Current
  recommendation: title, summary, headings, actions, and compact body text for
  all current docs.
- Should Codex execute safe docs actions automatically? Current recommendation:
  direct execution is acceptable for safe navigation/open-panel actions when the
  user explicitly asks; otherwise render a button or ask confirmation.
- Should source references be visible to all users or only admins/developers?
  Current recommendation: keep them compact and available, but not visually
  dominant.
