# CoCalc-ai Docs and Deep Actions Plan

Status: active implementation plan
Date: 2026-05-24

## Goal

Build a CoCalc-ai documentation system that matches the running product,
answers user and agent questions accurately, and can drive users directly to
the relevant UI state.

This replaces links to the legacy `https://doc.cocalc.com/` documentation,
which describes the previous generation of CoCalc and is misleading for
CoCalc-ai.

The system should support three related surfaces:

- Human docs at `/docs`, served by the same CoCalc-ai instance and therefore
  matching the deployed product version.
- Agent-readable docs and search exposed through `cocalc-cli` and a Codex
  skill.
- Deep actions that let docs and agents open specific CoCalc UI destinations,
  such as `settings.environment.secrets`, without brittle selector automation.

## Current Implementation Snapshot

As of 2026-05-24, the first vertical slice exists and is usable:

- `src/packages/docs` provides versioned docs entries, search, action metadata,
  and `@cocalc/docs`.
- Public `/docs` exists, including direct routing to `/docs` and docs detail
  pages.
- The project app has a Docs flyout/full-page panel.
- Docs font size is adjustable and persisted in local storage.
- In-app docs have a real table of contents grouped by category, plus
  account-private filters for all pages, starred pages, unstarred pages, and
  pages with notes.
- In-app docs private state v1 is implemented:
  - private stars and Markdown notes are account-global, not project-scoped;
  - private note text participates in in-app docs search;
  - matches from private notes are labeled without exposing note text in public
    docs content;
  - export/import supports JSON backup and cross-site transfer, merging without
    duplicate notes;
  - public landing-page docs do not render private notes or stars.
- Account-scoped conat-persist/DKV data now moves during account home-bay
  rehome. This was smoke-tested locally by moving account
  `aedd0458-e4ed-426f-9ecc-67886d097608` from `bay-1` to `bay-0`; the
  `cocalc-docs-private-state-v1.db` store moved, the old bay copy was removed,
  and the frontend still showed the starred doc/note after refresh.
- `cocalc docs list/search/show/actions/action` exists for local bundled docs.
- `cocalc browser action docs-list` lists live action availability in a target
  browser session.
- `cocalc browser action docs <id>` executes implemented docs actions in the
  exact browser session.
- Implemented executable docs actions:
  - `settings.environment.secrets`
  - `project.terminal.open`
  - `project.jupyter.create`
  - `settings.runtime.rootfs`
- A static/live verification harness now exists:
  - `@cocalc/docs/verification`
  - `pnpm -C src/packages/docs verify`
  - `cocalc docs verify`
  - `cocalc docs verify --list-live`
  - `cocalc docs verify --live --project-id <project_id>`
  - `cocalc docs verify --live --spawn-browser --project-id <project_id>`
    creates a dedicated Chromium browser session, runs the live docs actions,
    and destroys the spawned session afterward.
  - Live scenarios include UI assertions, not just action return values. They
    use the browser-session `wait_for_text` action to confirm that the expected
    modal, file tab, terminal, or notebook UI is actually visible.

The remaining work is production hardening: more docs content, more executable
actions, stronger live scenario assertions, Codex skill runtime integration,
and a release gate for legacy docs links.

## Verification Workflow

The docs action system has two verification layers.

Static verification checks bundled docs metadata, links, and action ids:

```sh
cocalc docs verify
```

Live verification checks that executable docs actions still open the expected
UI destinations in a real browser session:

```sh
cd src && eval "$(pnpm -s dev:hub:env)"
cocalc docs verify --live --spawn-browser --project-id "$COCALC_PROJECT_ID"
```

The spawned-browser mode launches a dedicated Chromium session, discovers its
browser id, runs every live scenario through `cocalc browser action docs <id>`,
then destroys the spawned session. This is the preferred manual QA command for
docs actions because it avoids depending on whatever browser tab the developer
happens to have open.

When the local API origin is `localhost` but the signed-in account belongs to
an externally reachable home bay, the verifier asks `/api/v2/auth/bootstrap`
for `home_bay_url` and opens Chromium on that external project URL. This avoids
the localhost-only failure mode where the frontend changes its Conat control
plane to the external home bay before the spawned browser registers.

For debugging, keep the spawned browser alive:

```sh
cocalc docs verify --live --spawn-browser --keep-browser \
  --project-id "$COCALC_PROJECT_ID"
```

## Product Principles

1. Docs are versioned with the product.
2. Docs are structured Markdown, not a separate CMS.
3. Docs are optimized for both humans and agents.
4. Screenshots are optional and rare; stable UI paths, action ids, and source
   references matter more.
5. Docs should be testable. A task doc should eventually have a Playwright or
   browser-session verification scenario.
6. UI actions should be typed and centralized, not arbitrary strings.
7. Source code is context, not the primary support interface. Docs answer what
   users should do; code is a fallback for exact implementation details.

## Current Codebase Facts

Relevant existing pieces:

- Public app routing lives in `src/packages/frontend/public/app.tsx` and
  `src/packages/frontend/public/routes.ts`.
- The public shell and footer are in
  `src/packages/frontend/public/layout/shell.tsx`.
- Public navigation is in `src/packages/frontend/public/layout/top-nav.tsx`.
- Legacy docs links are spread widely. `rg doc.cocalc.com src/packages` finds
  links in public pages, editor help buttons, billing, course UI, Jupyter,
  terminal, markdown, SSH key screens, project warnings, etc.
- `DOC_URL` is currently defined as `https://doc.cocalc.com/` in
  `src/packages/util/theme.ts`.
- Field guides use
  `FIELD_GUIDES_URL = "https://sagemathinc.github.io/cocalc-guides/"`.
- Browser-session automation is already substantial:
  - `src/packages/frontend/conat/browser-session`
  - QuickJS sandbox support in `index.ts`
  - typed browser action engine in `action-engine.ts`
  - CLI support in `src/packages/cli/src/bin/commands/browser.ts`
  - `cocalc browser exec-api`, `browser exec`, `browser files`, screenshot, etc.
- Backend live document access already exists through
  `src/packages/cli/src/bin/commands/exec.ts`, including `api.text`.
- The old docs repo is available at `/home/user/upstream/cocalc-doc`, useful as
  raw source material only. It should not be treated as authoritative for
  CoCalc-ai.

## Architecture Overview

```text
src/packages/docs
  content/*.md
  schema.ts
  manifest.ts
  build-index.ts
  generated/manifest.json
  generated/search-index.json
        |
        +--> public /docs renderer
        +--> cocalc docs search/show/action
        +--> generated Codex skill context
        +--> docs verification scenarios

src/packages/frontend/deep-actions
  registry.ts
  run.ts
  browser-session-action.ts
        |
        +--> docs buttons
        +--> command palette/help UI
        +--> browser-session QuickJS action
        +--> Codex CLI/browser integration
```

## Docs Package

Create a new package:

```text
src/packages/docs
```

This package owns docs content and generated indexes. It should not depend on
React. It should be usable from:

- `@cocalc/frontend` for rendering `/docs`.
- `@cocalc/cli` for local search/show commands.
- tests and future docs verification tooling.

Initial package shape:

```text
src/packages/docs/
  package.json
  tsconfig.json
  src/
    index.ts
    schema.ts
    parse.ts
    search.ts
    actions.ts
    generated/
      manifest.json
      search-index.json
  content/
    index.md
    getting-started/create-project.md
    projects/project-secrets.md
    projects/install-software.md
    projects/ssh.md
    jupyter/durable-notebooks.md
    terminal/collaborative-terminal.md
    teaching/course-workflow.md
    agents/codex-chat.md
```

The first implementation can keep generated JSON checked in. A later build step
can regenerate it automatically.

## Markdown Format

Use plain Markdown plus frontmatter. Avoid MDX initially.

Example:

```md
---
id: projects.project-secrets
slug: /docs/projects/project-secrets
title: Project secrets
summary: Store API keys, SSH keys, and other credentials outside project files.
status: current
audiences:
  - users
  - agents
  - researchers
products:
  - cocalc-cloud
  - launchpad
  - rocket
actions:
  - settings.environment.secrets
source_refs:
  - src/.agents/project-secrets-design-plan-2026-05-13.md
  - src/packages/frontend/project/settings
verification:
  scenario: docs/projects/project-secrets.verify.ts
last_reviewed: 2026-05-24
---

# Project secrets

Use project secrets for API keys, tokens, SSH keys, and other credentials that
should not be committed into files.

```steps
1. Open the project.
2. Open Settings.
3. Choose Environment.
4. Open Secrets.
5. Add a secret or create a project SSH key.
```

```action
settings.environment.secrets
```

```
Supported custom fenced blocks in v1:

- `steps`
- `callout`
- `action`
- `related`
- `source-refs`
- `verify`

The parser should preserve them as structured blocks. The renderer can turn
them into polished UI. The CLI and Codex skill can expose them as plain text.

## Docs Metadata Schema

Recommended TypeScript shape:

```ts
export type DocsAudience =
  | "users"
  | "agents"
  | "students"
  | "instructors"
  | "researchers"
  | "admins"
  | "developers";

export type DocsStatus = "current" | "draft" | "legacy" | "planned";

export type DocsEntry = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: DocsStatus;
  audiences: DocsAudience[];
  products: string[];
  actions?: DeepActionId[];
  source_refs?: string[];
  verification?: {
    scenario?: string;
    last_passed_commit?: string;
    last_passed_at?: string;
  };
  last_reviewed?: string;
  body: string;
  blocks: DocsBlock[];
};
```

Rules:

- `id` is stable and never reused.
- `slug` is the public route.
- `status: legacy` is allowed only for historical compatibility pages that
  explicitly warn the user.
- `actions` must refer to registered deep action ids.
- `source_refs` are source-code or `.agents` references, not external marketing
  links.

## Public `/docs`

Add a docs route to the public app:

- Add `PublicDocsApp` lazy import in `src/packages/frontend/public/app.tsx`.
- Add `docs` to `PublicRoute` and `getPublicRouteFromPath` in
  `src/packages/frontend/public/routes.ts`.
- Add `Docs` to top nav and footer.
- Change `DOC_URL` in `src/packages/util/theme.ts` to an app-relative docs path
  helper or remove it in favor of a `DOCS_PATH` constant.
- Replace public footer `Documentation` link with `/docs`.

The first renderer is implemented and should stay simple:

- Done: index grouped by category.
- Done: main Markdown body.
- Done: action buttons when an action id is available.
- Pending: related docs.
- Pending: source/reference foldout visible to admins/developers or always
  visible in a compact way.

Do not block v1 on full-text search in the browser. A simple index page plus
client-side filtering is enough initially; the in-app version now also searches
account-private note text.

## Legacy Docs Link Migration

Before launch, remove all direct links to `https://doc.cocalc.com/` from the
new CoCalc-ai UI.

Suggested phases:

1. Public pages and footer:
   - `src/packages/frontend/public/layout/shell.tsx`
   - `src/packages/frontend/public/support/*`
   - `src/packages/frontend/public/features/*`
   - `src/packages/frontend/public/features/catalog.ts`
2. Project/editor help buttons:
   - terminal, jupyter, latex, markdown, whiteboard, slides, course editor.
3. Account/project operational links:
   - SSH keys, low memory, OOM, project settings, API keys.
4. Billing/course docs:
   - replace with `/docs` pages only where accurate; otherwise remove or mark
     as pending.

Add a test or script:

```sh
rg "https://doc\\.cocalc\\.com" src/packages
```

This should become a release gate. Exceptions must be explicit and temporary.

## Deep Actions

Deep actions are stable product-level UI actions. They are not CSS selectors and
not arbitrary browser JavaScript.

Create:

```text
src/packages/frontend/deep-actions/
  ids.ts
  registry.ts
  run.ts
  types.ts
```

Example type:

```ts
export type DeepActionId =
  | "settings.environment.secrets"
  | "settings.environment.ssh-key"
  | "project.new-terminal"
  | "project.new-notebook"
  | "course.assignments.create";

export type DeepActionContext = {
  project_id?: string;
  account_id?: string;
  path?: string;
};

export type DeepActionSpec = {
  id: DeepActionId;
  label: string;
  description: string;
  requires: Array<"project" | "account" | "signed-in">;
  run: (context: DeepActionContext) => Promise<void> | void;
};
```

Example registry row:

```ts
{
  id: "settings.environment.secrets",
  label: "Open project secrets",
  description: "Open project settings to Environment -> Secrets.",
  requires: ["signed-in", "project"],
  run: async ({ project_id }) => {
    await openProjectSettings(project_id, {
      tab: "environment",
      panel: "secrets",
    });
  },
}
```

Design rules:

- Action ids are stable and semantic.
- Actions may open UI, focus panels, or open modals.
- Actions should not directly mutate dangerous state in v1.
- Destructive or credential-sensitive actions require normal UI confirmation.
- Every registered action should have a unit test for validation and a minimal
  browser-session smoke test when feasible.

## Browser-Session Integration

Browser-session QuickJS already exposes:

```js
api.action(name, payload)
api.navigate(...)
api.click(...)
api.type(...)
```

Extend the allowed browser action set with a typed action:

```ts
name: "deep_action"
payload: {
  id: DeepActionId;
  context?: DeepActionContext;
}
```

Then QuickJS/Codex can do:

```js
return await api.action("deep_action", {
  id: "settings.environment.secrets",
  context: { project_id: api.projectId },
});
```

Add corresponding TypeScript to `BROWSER_EXEC_API_DECLARATION`, ideally with a
convenience method:

```ts
api.deepAction("settings.environment.secrets", { project_id: api.projectId });
```

Implementation details:

- Add `deep_action` to the browser action type definitions in
  `@cocalc/conat/service/browser-session`.
- Add action policy checks in `exec-utils.ts` or the existing action policy
  location.
- Implement in `action-engine.ts` by importing the deep action runner.
- Audit events should include `action_name: "deep_action"` and the deep action
  id.
- In production posture, only allow registered actions. No raw function names.

## CLI Surface

Add a new top-level command:

```sh
cocalc docs
```

Subcommands:

```sh
cocalc docs search <query>
cocalc docs show <id-or-slug>
cocalc docs list [--audience users|agents|instructors]
cocalc docs actions [id-or-slug]
cocalc docs action <action-id> [--project-id <id>] [--browser <id>]
cocalc docs skill-context [--query <query>] [--limit 8]
```

Behavior:

- `docs search` uses the local generated index by default.
- Later, add `--remote` to query the running site docs API so CLI can target a
  remote deployment version.
- `docs action` uses browser-session automation to run a registered deep action
  in the user’s current browser session.
- `docs skill-context` prints compact Markdown suitable for agent context.

Example:

```sh
cocalc docs search "project secrets"
cocalc docs show projects.project-secrets
cocalc docs action settings.environment.secrets --project-id "$COCALC_PROJECT_ID"
```

## Docs Search AI

Expose a small site-local API so agents and external tools can query docs that
match the running deployment:

```text
GET /api/docs/search?q=project%20secrets
GET /api/docs/show?id=projects.project-secrets
GET /api/docs/actions?id=projects.project-secrets
```

If CoCalc-ai continues to avoid new Next API routes for many domains, this can
instead be a Conat/public hub API. For public documentation, a static JSON
manifest served by the frontend may be enough in v1:

```text
/docs/manifest.json
/docs/search-index.json
```

Prefer static JSON first unless authentication-sensitive docs appear.

## Codex Skill

Create a generated or hand-written skill:

```text
src/.agents/skills/cocalc-docs/SKILL.md
```

The skill should instruct Codex to:

1. Search docs before reading source for user-facing CoCalc behavior.
2. Use `cocalc docs search` and `cocalc docs show`.
3. Use `cocalc docs action` or browser-session `api.deepAction` when the user
   asks to open a specific CoCalc UI.
4. Fall back to source-code search only when docs are missing or ambiguous.
5. Report when docs are missing and propose a new task doc.

Minimal skill body:

```md
# CoCalc Docs

When answering how to use CoCalc-ai, search the versioned CoCalc docs first:

`cocalc docs search "<query>"`

Then read the relevant page:

`cocalc docs show <id>`

If a docs page exposes a deep action and the user asks to open the UI, use:

`cocalc docs action <action-id> --project-id "$COCALC_PROJECT_ID"`

If docs are absent or conflict with visible UI/source, say so and inspect the
repo.
```

This skill can later be installed into user projects or bundled into the
CoCalc Codex runtime.

## In-App Help and Chat Integration

Once docs and deep actions exist, add lightweight app integrations:

- Help menu item opens `/docs`.
- Contextual “Help” buttons in editors open specific docs ids.
- Docs pages include “Ask Codex about this” that opens a chat thread with the
  doc id and current project context.
- Codex answers can render action buttons for allowed deep actions.

The chat renderer should not execute actions automatically from arbitrary model
text. It should render trusted action references only when they come from:

- docs metadata,
- a typed tool result,
- or an explicit structured assistant message field produced by the CoCalc
  integration.

## Verification

Docs should gradually become executable.

For each task doc:

```yaml
verification:
  scenario: docs/projects/project-secrets.verify.ts
```

Scenario types:

- Browser-session QuickJS smoke tests for opening UI panels.
- Playwright tests for longer flows.
- CLI command smoke tests.
- Static lint checks for action ids, source refs, links, and stale
  `doc.cocalc.com` references.

Initial verification gates:

1. All docs frontmatter parses.
2. All `actions` exist in the deep action registry.
3. All `source_refs` exist.
4. All internal links resolve.
5. No `https://doc.cocalc.com/` links remain in public CoCalc-ai surfaces.

Current harness:

- Static checks live in `src/packages/docs/src/verification.ts`.
- The Node entry point is `src/packages/docs/src/verify.ts`.
- Run static checks with:

```sh
pnpm -C src/packages/docs verify
cocalc docs verify
```

- List live browser-session scenarios with:

```sh
cocalc docs verify --list-live
```

- Run live scenarios against the active browser session with:

```sh
cd src && eval "$(pnpm -s dev:hub:env)"
cocalc docs verify --live --project-id "$COCALC_PROJECT_ID"
```

Live verification intentionally uses docs actions instead of CSS selectors:

```sh
cocalc --json browser action docs settings.environment.secrets \
  --project-id "$COCALC_PROJECT_ID"
```

Next verification improvements:

- Add post-action DOM/state assertions for each executable docs action.
- Add a no-side-effects mode that skips actions that create files, such as
  `project.terminal.open` and `project.jupyter.create`.
- Add CI release gates for static docs verification and legacy docs link scans.
- Record scenario metadata back into docs entries once docs content moves from
  inline TypeScript to Markdown/content files.

## Initial Task Docs

Start with a small set that directly matches launch questions:

1. `projects.project-secrets`
2. `projects.create-project`
3. `projects.install-software`
4. `projects.ssh`
5. `projects.rootfs`
6. `terminal.collaborative-terminal`
7. `jupyter.durable-notebooks`
8. `agents.codex-chat`
9. `agents.browser-session`
10. `teaching.course-workflow`
11. `teaching.nbgrader`
12. `latex.build-papers`
13. `python.notebook-script-paper`
14. `self-host.launchpad`
15. `self-host.cocalc-plus`

Use the field guides as narrative source material, but keep task docs short and
operational.

## Implementation Phases

### Phase 0: Inventory and Redirect Strategy

- Add this plan.
- Generate an inventory of all `doc.cocalc.com` links.
- Decide replacements:
  - remove,
  - replace with field guide,
  - replace with new `/docs` task doc,
  - temporarily mark as legacy.

### Phase 1: Docs Package and Static Content

- Done: Create `src/packages/docs`.
- Done: Add typed docs entries and search helpers.
- Done: Add initial docs pages:
  - docs home,
  - project secrets,
  - open terminal,
  - create notebook,
  - runtime image,
  - Codex chat.
- In progress: move inline content to Markdown/content files.
- In progress: add generated manifest/search JSON if static artifacts become
  useful.
- Done: add the first verification harness for schema/action/link checks.

### Phase 2: Public `/docs`

- Done: Add public docs route.
- Done: Add docs renderer.
- Done: Add a category-grouped docs index/table of contents.
- Done: Add nav/footer links to `/docs`.
- Done: Keep public docs free of signed-in private notes/stars UI.
- In progress: replace remaining `doc.cocalc.com` links.

### Phase 3: CLI Docs Search

- Done: Add `cocalc docs search/show/list/actions/action`.
- Done: Package docs with CLI via `@cocalc/docs`.
- Done: Add `cocalc docs verify`.
- Pending: Add `docs skill-context`.
- Pending: Add focused CLI tests for docs commands.

### Phase 4: Deep Action Registry

- Done: Add docs action registry in `src/packages/frontend/project/docs-actions.ts`.
- Done: Implement `settings.environment.secrets`.
- Done: Implement `project.terminal.open`.
- Done: Implement `project.jupyter.create`.
- Done: Implement `settings.runtime.rootfs`.
- Done: Add docs action block renderer.
- Done: Add unit tests for action registry validity.

### Phase 5: Browser-Session Deep Actions

- Done: Add `docs_action` to browser-session action engine.
- Done: Add `cocalc browser action docs-list`.
- Done: Add `cocalc browser action docs <id>`.
- Done: Verify executable docs actions can run in a live browser session.
- Pending: Add a QuickJS convenience wrapper such as `api.docsAction(...)`.
- Pending: Add stronger DOM/state assertions after browser action execution.

### Phase 6: Codex Skill

- Done: Add `src/.agents/skills/cocalc-docs/SKILL.md`.
- Pending: Ensure CoCalc Codex runtime includes or can discover the skill.
- Add examples:
  - “How do I set a project secret?”
  - “Open the project secrets UI.”
  - “How do I install a Python package?”

### Phase 7: Private In-App Docs State

- Done: Add account-private stars and Markdown notes for in-app docs pages.
- Done: Add compact detail-page controls: Star and Add Note, with composer only
  after the user asks to add a note.
- Done: Add all/starred/unstarred/with-notes filters.
- Done: Add note-aware in-app docs search and a "matched your private notes"
  indicator.
- Done: Add JSON export/import for backup and cross-site transfer.
- Done: Implement account conat-persist/DKV move during account rehome.
- Done: Smoke-test account rehome from `bay-1` to `bay-0` with docs private
  state present.
- Pending: Add broader browser/UI checks for note editing, import/export, and
  filter/search behavior.

### Phase 8: Replace Remaining Legacy Links

- Systematically replace or remove all remaining `doc.cocalc.com` links.
- Add a release gate that fails on new legacy docs links except an explicit
  allowlist.

### Phase 9: Admin Docs And Project-Host Guides

Admin docs should be treated as first-class operational docs, not as public
marketing/help pages. They should be visible by default only inside the signed-in
app for site admins, and hidden from public `/docs`, public search, anonymous
docs output, and SEO indexes.

Add explicit docs visibility:

```ts
type DocsVisibility = "public" | "signed-in" | "admin";
```

The first admin slice should include:

- model/render/search support for `visibility: "admin"`;
- in-app docs filtering based on the signed-in account's admin status;
- browser docs actions that open admin destinations, so Codex can guide an
  admin directly to the right UI;
- a few short source-derived admin pages that can later grow into many
  "mini-skill" docs.

Initial admin docs backlog:

- Admin overview and safety model.
- Post system messages and urgent notices.
- Create and edit public news and event items.
- Site settings and configuration workflows.
- User management: search, impersonation, password reset, remove 2FA, ban, and
  membership/purchase-related tools.
- Admin `cocalc-cli` cookbook: fresh auth, bay inspection, account location,
  account rehome, project/host inspection, and smoke-test workflows.

Project-host docs should become their own cluster because both admins and users
interact with them:

- what project hosts are and how they relate to bays/projects;
- user host creation and access controls;
- cloud provider setup and bootstrap lifecycle;
- RAM, disk, billing, and minimum sizing expectations;
- DNS/Cloudflare tunnel behavior;
- failed bootstrap troubleshooting;
- admin host operations, upgrades, and bay/host/project ownership model.

Docs media should support both small icon-like visual hooks and larger workflow
diagrams. Prefer optimized `.webp` assets with short hashes in filenames, plus
stored prompt/source notes when imagegen2 is used, so regenerated assets can be
reviewed and cache-busted intentionally.

## Open Questions

- Should docs content live in `src/packages/docs/content` or `src/docs`? I
  recommend `src/packages/docs` so CLI/frontend can share the parser and
  generated indexes cleanly.
- Should `/docs` be part of public routing only, or should there also be an
  in-app docs panel? I recommend public route first, in-app panel later.
- Should docs search be static JSON or a hub API? I recommend static JSON for
  v1.
- How much docs content should ship in the CLI bundle? I recommend title,
  summary, headings, actions, and compact body text for all current docs.
- Should Codex be allowed to execute deep actions automatically? I recommend
  “show a button or ask confirmation” by default, with direct execution only
  for safe navigation/open-panel actions.

## First Concrete Milestone

The original first concrete milestone is complete enough to use:

1. Done: `src/packages/docs` with `projects.project-secrets`.
2. Done: `/docs/projects/project-secrets` page.
3. Done: `settings.environment.secrets` docs action in frontend.
4. Done: `cocalc docs search project secrets`.
5. Done: `cocalc docs show projects.project-secrets`.
6. Done: `cocalc browser action docs settings.environment.secrets`.
7. Done: Codex skill instruction for using the docs command.
8. In progress: browser-session verification harness. Static checks and live
   action execution exist; detailed DOM/state assertions are next.

If that slice feels good, scale horizontally to the remaining launch-critical
docs.
