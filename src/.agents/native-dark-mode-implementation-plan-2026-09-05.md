# Native Dark Mode Implementation Plan

Date: 2026-09-05

Status: Implementation authorized on 2026-09-05 and in progress. Checked items
below have been implemented and locally validated; rollout and live acceptance
remain pending until their corresponding gates pass.

Implementation evidence so far:

- Shared preference/cache resolution, external store, semantic palettes, and
  generated prepaint support live in `src/packages/util/appearance*.ts`.
- The util package build and focused appearance tests pass. The bootstrap tests
  compare initial painting with runtime resolution across modes, cookies,
  legacy preferences, and blocked storage; palette tests check text/status contrast.
- The shared controller is now connected to main-account preferences and the
  main/public Ant Design providers, with native selectors in account settings
  and public desktop/mobile navigation. New accounts explicitly default to
  System; existing accounts retain the documented legacy fallback.
- Essential now shares the preference/cache/bootstrap/controller while keeping
  its local palette and lightweight dependency boundary. Its existing auth
  bootstrap carries the home-bay appearance preference; explicit saves use a
  lazy-loaded, appearance-only account query on the authoritative home bay.
- Public palettes, syntax colors, shared docs surfaces, and standalone docs
  export have initial native support. The cookie-consent overlay uses its
  library's CSS variables, not DOM rewriting.
- `pnpm static` completed and the resulting public frontend was exercised on
  lite2b in Chromium at 1440px and 390px. Fourteen initial dark route/viewport
  probes had no page exceptions. Visual inspection found cookie-dialog,
  selected-nav, inline-code/link, and mobile docs-action overflow defects;
  corrections are in progress and require a repeated browser audit.
- Initial local evidence is under `src/.local/dark-mode/`: public baseline
  accessibility reports (landing/features/docs, all passed), build log, and
  screenshots/inspection JSON. These are working artifacts, not final rollout
  acceptance evidence.
- Dark Reader and its frontend dependency have been removed. PDF inversion is
  now an explicit per-view choice that does not rerender the PDF canvas, and
  scratchpad uses the shared appearance controller.
- Follow application appearance is available for editor and terminal settings,
  with new-account defaults and conservative handling of existing named themes.
  Focused tests verify terminal theme updates without reset/reconnect and live
  notebook/editor option updates. A static notebook renderer's shared-style
  mutation was also fixed so a default cell cannot leak a white background into
  subsequent dark-themed cells.
- Main shell, project tabs/toolbars, shared panels, Codex activity, and initial
  classic/Studio notebook surfaces use semantic colors. These are incremental
  conversions, not a completed main-app audit. The main toolbar has a compact
  System/Light/Dark selector in addition to Appearance settings.
- `scripts/appearance/audit-public.mjs` now provides repeatable anonymous
  Chromium/axe audits, screenshots, overflow checks, explicit toggles, and live
  system-theme changes. The first expanded pass covered 15 routes at 1440px and
  320px in both themes (60 probes), including consent dialogs. No page exceptions
  were observed. It found inline-link, badge, and long-button issues; source
  corrections and targeted repeat audits are in progress. Artifacts are in
  `src/.local/dark-mode/public-expanded` and `public-corrections`.
- The static frontend has been rebuilt repeatedly on lite2b. A dedicated
  authenticated browser session is now available through the local hub for
  main-app verification. Use a named CLI profile with explicit loopback API and
  cookie-backed dev elevation; ambient master-host credentials caused misleading
  authentication failures during the initial attempts.
- Latest validation: all 22 public frontend test suites (290 tests), 10 focused
  classic/Studio notebook suites (57 tests), and four appearance/shared-panel
  suites (10 tests) pass. The static build and frontend lint pass. Targeted
  Chromium repeats clear the findings in the Python/Jupyter feature pages and
  image catalog.
- Signed-in native screenshots now work with `browser screenshot --fullpage`:
  the app's body has zero height despite its visible positioned children, so
  element capture waits for visibility and blocks the daemon queue. Full-page
  capture avoids that wait. No raw-execution policy change or new user auth was
  needed. Typed `type` actions now support enabled single-select values so the
  appearance selector can be exercised without raw browser code.
- Signed-in project-list and settings captures exposed fixed-white surfaces and
  fixed-dark text. Project-list backgrounds/search popups/mobile cards and
  settings headings/navigation/health/runtime-sponsor surfaces now use paired
  semantic tokens. Chromium before/after captures are in
  `src/.local/dark-mode/settings-{dark-before,dark-after,light-after}.png`;
  the project-list dark capture is `projects-dark.png`. The settings headings,
  navigation and runtime status text are now visibly readable. The static build,
  frontend lint and 31 focused tests pass, including native-select validation,
  heading tokens and keyboard navigation. This is sampled visual evidence,
  not a completed signed-in accessibility audit. Dim preset badges/icons and
  the file-browser loading surface remain known follow-up findings.
- Remaining acceptance work includes complete owned-surface conversion and
  signed-in workflow screenshots; direct signed-in docs preference saving;
  signup/alternate-account-creation preference handling; translation coverage;
  complete route, state, contrast and performance coverage; and final Essential
  bundle/behavior verification. Do not treat the new toggle or the sampled
  screenshots as proof that the full migration is complete.

## 1. Goal And Scope

Replace Dark Reader with native, fast, consistent **System / Light / Dark**
appearance throughout CoCalc. A first-time visitor reading the website is as
important as a signed-in user editing a notebook.

The finished product must include:

- The main application, its shared controls, dialogs, editors, and viewers.
- **The entire public website in `src/packages/frontend/public`: landing,
  features, products, pricing, documentation, guides, news, authentication,
  policies, support, and the remaining public routes.** Public dark mode is a
  release requirement, not a later polish task.
- Shared documentation components, public previews, startup/loading/error
  surfaces, and standalone documentation downloads.
- The existing Essential frontend, preserving its lightweight architecture and
  existing light/dark behavior. This work must not launch, advertise, or add
  public navigation to the currently unlaunched `/essential` application.
- Immediate appearance changes without a page reload, project restart, editor
  restart, DOM-wide color rewriting, or background polling.
- System appearance by default for anonymous visitors and newly created
  accounts; deliberate compatibility for existing account and editor settings.
- Readable initial HTML before the main JavaScript bundles or account data load.

Brightness, contrast, and sepia sliders are not part of the replacement. This is
not a public-site redesign, a new component library, or a rewrite of the editors.
Preserve existing branding, layout, and the quality of the light appearance.

### What "Full Support" Means For Content

CoCalc owns the appearance of its interface. It does not own the intended colors
of every image, PDF, plot, slide, HTML output, or third-party application a user
opens. Theme the surrounding controls and theme-aware renderers; preserve
authored artifacts by default. An intentionally light document page inside a
dark viewer is acceptable. An accidentally light settings dialog is not.

Track these intentional content boundaries explicitly during the audit. Do not
use them to excuse unconverted first-party interface components.

## 2. Current Implementation And Constraints

These observations describe the checkout inspected on 2026-09-05. Recheck the
inventory against the implementation branch before editing.

| Area                     | Current implementation                                                                                                                                                                                                                                                             | Consequence                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy dark mode         | `frontend/account/dark-mode.ts` listens to account-store changes through a 1,000 ms trailing debounce, then dynamically imports and enables/disables `darkreader`.                                                                                                                 | Account activity can delay appearance updates; asynchronous work can race with a later choice. This is not a native theme system.              |
| Preferences              | `frontend/account/account-preferences-appearance.tsx`, `frontend/account/types.ts`, and `util/db-schema/accounts.ts` expose a boolean and brightness/contrast/sepia settings. Account query defaults materialize `dark_mode: false`.                                               | Missing/false is not reliable evidence of an explicit opt-out from system appearance. Migration needs a documented policy.                     |
| Main Ant Design provider | `frontend/app/localize.tsx`, `app/context.tsx`, and `app/antd-base-theme.ts` already centralize parts of the Ant Design configuration.                                                                                                                                             | Extend these providers while retaining compact mode, branding, locale, and motion settings. Fixed token overrides also need review.            |
| Shared colors            | `util/theme.ts` provides literal `COLORS`; `frontend/update-color-scheme.js` generates fixed CSS variables in `frontend/styles/colors.css`.                                                                                                                                        | Literal colors are shared beyond DOM styling. They cannot simply be redefined as theme-dependent CSS strings.                                  |
| Public website           | `frontend/public/theme.ts` centralizes `PUBLIC_COLORS`, but the palette and elevation values are fixed for light pages. `public/layout/shell.tsx` has its own Ant Design provider and styling.                                                                                     | Main-app provider changes alone will not theme the public site.                                                                                |
| Public color processing  | `public/theme.ts` has an `alpha()` helper that parses literal hex colors. `PUBLIC_ELEVATION` is computed from those colors. `PUBLIC_DARK` is currently a fixed palette for illustrative code/terminal mockups.                                                                     | A blind replacement of hex strings with `var(...)` breaks color processing. Mockup palettes and application appearance need distinct meanings. |
| Public tests             | Some home-page tests explicitly require light panels.                                                                                                                                                                                                                              | Replace light-only assumptions with paired light/dark contracts, preserving their original layout/branding protections.                        |
| Documentation            | `frontend/public/docs/app.tsx` uses shared `frontend/docs/browser.tsx` and `browser.css`; code blocks also use `public/code-block.css`. `docs/download-html.tsx` generates a standalone document with a white page.                                                                | Theme the shared reader, syntax colors, public context, and exported HTML independently of account/editor initialization.                      |
| Initial HTML             | `static/src/app.html` and `static/src/plugins/app-template.ts` build entry HTML. `hub/servers/app/public-shell.ts` and `public-prerender.ts` also generate public responses.                                                                                                       | First paint and prerendered content must be addressed before React starts, not just in an effect.                                              |
| Essential                | `essential-frontend/src/theme.ts` and `theme-context.tsx` already implement System/Light/Dark, local persistence, OS changes, cross-tab updates, and `--ul-*` tokens. `static/src/ultralite.html` already has a small early color-scheme script and system-color loading surfaces. | Reuse and align this existing approach; do not replace it with the full application's dependency graph.                                        |
| Editors and terminals    | Workspace editor/terminal helpers already establish setting precedence; terminal themes contain concrete palettes.                                                                                                                                                                 | Add a follow-appearance choice without silently replacing explicit account/workspace themes or recreating live instances.                      |
| Legacy consumers         | `inDarkMode()`, direct `dark_mode` reads, PDF filters, scratchpad-local preferences, and Dark Reader-specific styling/icon workarounds exist outside the preference form.                                                                                                          | Removal requires an inventory and behavior changes, not just deleting the package import.                                                      |

Paths in this table are under `src/packages`; repeated frontend subpaths are
abbreviated within some rows.

## 3. Product Decisions

### 3.1 One Understandable Preference

Use a three-way preference: `system`, `light`, or `dark`. Separately expose the
resolved appearance: `light` or `dark`. Do not store the current OS result as the
user's preference; System must continue following OS changes.

Provide:

- A compact appearance control in the public desktop and mobile navigation,
  available without signing in, accepting cookies, or opening account settings.
- A readily accessible control in the main application shell and the same
  choices in account Appearance settings.
- Essential's existing control, with the same terminology and resolution rules.

Use the existing icon library's system/sun/moon icons with accessible labels and
tooltips. A menu or segmented control must show the selected preference, not
just whether the page currently looks dark. For example, System may resolve to
Dark without becoming an explicit Dark selection. Do not use a two-state toggle
with a hidden third state.

No color transition animation is needed. Respect reduced motion, keyboard
navigation, focus visibility, forced-colors mode, and the existing account
Animations setting. Appearance changes must not alter focus or scroll position.

### 3.2 Conservative Compatibility

Recommended policy for approval:

- New anonymous visitor: System.
- New account: explicitly initialize the new preference to System, or retain an
  explicit appearance chosen during that sign-up flow.
- Existing account without the new field: legacy `dark_mode: true` becomes Dark;
  legacy false/missing becomes Light. This preserves the effective appearance
  instead of guessing whether a materialized old default was intentional.
- Existing explicit editor and terminal themes remain in effect. New profiles
  use Follow application appearance; existing users can opt into that choice.
- Discard the old slider effects when switching to native dark mode. Preserve
  stored legacy fields temporarily for compatibility/rollback, but stop
  presenting or applying those adjustments in the native UI.

This means not every existing account will automatically switch to System. That
is intentional. Offer the choice clearly rather than silently changing a user's
working environment. If we prefer a universal switch to System instead, decide
that explicitly before implementing the migration.

## 4. Shared Architecture

### 4.1 Small Pure Foundation

Introduce a narrowly imported module such as `@cocalc/util/appearance` containing
the preference/resolved types, allowlist parsers, pure resolution and migration
helpers, and any truly shared token definitions. Exact names are proposed, not
an instruction to add a new package.

The module must not import React, Ant Design, Redux, Immutable.js, account
schemas, DOM globals, storage, or either frontend package. It must be safe to
import from a server or a small browser entry. Use direct module imports rather
than a broad barrel that brings unrelated dependencies into Essential/public.

Keep browser subscriptions and persistence in small adapters. Keep the main
app's account-store integration in the main frontend. Essential and anonymous
public pages must not need that integration to choose or display an appearance.
Normalize Immutable account settings at this boundary.

Share small React/browser helpers only if doing so preserves those dependency
boundaries. Avoid creating a general theming framework to eliminate a few lines
of straightforward provider code.

### 4.2 Preference Storage And Authority

Proposed account field: `other_settings.appearance_theme`. It accepts only the
three preference values and is optional during migration. Do not add a query
default of System that masks the absence of the field before reading the legacy
setting. Update all new-account creation paths to set the new preference
explicitly; an older server creating an unmigrated account safely follows the
legacy fallback until updated.

Use a small, versioned, same-origin local-storage representation for immediate
startup. Store an explicit `system` value: deleting the key cannot mean both
"follow system" and "please import an old preference again."

Define and test these rules:

1. Before authentication/account data are available, resolve locally with no
   network dependency. Use a recognized cached preference or System.
2. Keep the anonymous/browser choice distinct from an authenticated account's
   cache. Associate an account cache with that account, not whichever account
   happened to use the browser last. Do not invent a new auth request solely to
   decide which cached theme to paint.
3. Once authenticated preferences load, the new account field is authoritative;
   otherwise use the legacy mapping above. Route account writes through the
   existing home-bay-aware settings mechanism, not direct local database access.
4. An explicit click applies synchronously in the browser. Save asynchronously
   through the normal account path when signed in, or locally when anonymous.
   Surface a save failure without making the control unusable or silently
   claiming cross-device persistence.
5. A stale account fetch/save completion must not undo a newer local click.
   Serialize or revision-guard writes using the existing account update model.
   Distinguish incoming remote changes from a stale echo of a local change.
6. OS changes update only the resolved appearance when the preference is System.
   They do not write account settings or trigger synchronization loops.
7. Synchronize explicit same-origin changes across tabs using storage events or
   the existing settings stream. Do not echo each storage event back as another
   write. Separate accounts must not overwrite each other's choices.
8. Logout/account switching clears the active account cache association and
   selects the appropriate visitor/account preference. Do not migrate the old
   account's settings into the next account.
9. Blocked storage, malformed values, unavailable `matchMedia`, offline startup,
   and server-side imports all have safe fallbacks. Appearance remains usable
   in memory if persistence is unavailable.

A newly changed account preference on another device cannot be known before
account data arrive. Promise correct first paint for the locally known
preference, with prompt reconciliation afterward, not impossible cross-device
foreknowledge.

Audit actual writers of `other_settings`, including older-client full-object
saves, before choosing how to persist migration. A new field name alone does
not protect it from a stale full-object replacement. Preserve unrelated fields,
make migration idempotent, and test the rolling-deployment behavior. If old
clients can erase unknown fields, land the preservation/update-path fix before
enabling the new preference rather than accepting silent resets.

Legacy Essential and scratchpad preferences may be imported only when there is
no unified explicit preference. Do not let an old local key override an account
preference. Define deterministic precedence if both legacy browser keys exist:
prefer the current entry's explicit legacy setting, then System. Record the
migration so navigating to a different entry does not repeat it.

### 4.3 Native Semantic Tokens

Use a root resolved-theme attribute, for example
`data-cocalc-theme="light|dark"`, and CSS custom properties for owned UI:

- Page, surface, elevated surface, inset/control background, and overlay scrim.
- Primary, secondary, muted, disabled, inverse, and placeholder text.
- Border, separator, hover, pressed, selected, and focus-ring colors.
- Links and hover/visited states where supported.
- Success, warning, error, and information foreground/background/border pairs.
- Code, diff, search-match, and selection colors, with renderer-specific syntax
  palettes where necessary.
- Chart/grid colors for first-party administrative/operational charts.

Keep the underlying literal palette in `@cocalc/util/theme` or a small sibling
theme module, following the repository's color convention. Add semantic
light/dark mappings rather than changing the meaning of `COLORS.WHITE`, brand
colors, or literal exported CSS variables globally. Shared literals also serve
color parsing, canvas drawing, exports, and server-side code.

Provide concrete resolved values for consumers that require them, notably
Ant Design's color algorithms, xterm, canvas/WebGL, and color manipulation.
DOM styles should normally use CSS variables so toggling does not require
rerendering every notebook cell or chat message.

Keep CSS variables and concrete palettes derived from one definition or add
parity tests. Do not maintain unrelated copies that slowly diverge. Specify
which stylesheet is generated and extend the existing generator deliberately;
do not hand-edit a generated file as the source of truth.

Audit literal-processing helpers such as `public/theme.ts:alpha()` and cookie
consent color conversion. Compute alpha colors from resolved literals, use
explicit semantic translucent tokens, or use supported CSS color operations.
Never pass unresolved CSS variable expressions to a hex parser.

Choose dark colors by role and contrast, not RGB inversion. Preserve brand
identity without making every dark surface a different shade of blue. Avoid
blanket `!important` overrides, wildcard recoloring, and `filter: invert(...)`
on the application or public page.

### 4.4 Initial Paint And Entry Points

Extend the existing static HTML generation with a tiny synchronous appearance
bootstrap before visible content. Reuse the same preference parser/resolution
contract; test the generated bootstrap against the runtime resolver to prevent
drift. Essential's current early script is a useful starting point.

The bootstrap sets the resolved root attribute and `color-scheme`. Ship the
minimal page/text/loading styles early, with a System media-query fallback for
no-script/blocked-script cases. Invalid or unavailable storage must not prevent
the OS preference from being considered.

Cover `app.html`, the public entry, `ultralite.html`, scratchpad, and the actual
standalone viewer entries found during inventory. Also cover hub fallback HTML
and prerendered public feature content. Do not put the only fix in a React
`useEffect`, after a bright page has already painted.

Keep server-rendered/prerendered HTML theme-neutral through semantic styles and
the early client choice. Preserve public caching, metadata, canonical URLs, and
SEO behavior; do not add account-specific data or a per-visitor cache variation
solely for appearance. Existing server modules must not import frontend providers.

Honor the existing Content Security Policy using the supported nonce/hash or
static bootstrap mechanism. Do not weaken CSP to allow a new inline script.
Include native controls, autofill, scrollbars where supported, startup/crash
banners, and appropriate browser `theme-color` metadata. First paint must not
wait for customization, cookie consent, auth initialization, or the large app
bundle. No theme fetch on every navigation.

### 4.5 React And Ant Design Integration

Expose a small reactive appearance context with preference, resolved mode, and
a setter. It reads the bootstrapped value initially rather than painting Light
and correcting itself later. Have one owner of document-level appearance per
entry; nested providers must not compete to update the root.

Use Ant Design's supported default/dark algorithms and retain compact settings.
Audit fixed overrides in `app/antd-base-theme.ts`, main provider composition,
and the separate public provider; overrides can defeat the dark algorithm.
Keep the public palette visually appropriate to the public site rather than
forcing the entire app and website to be pixel-identical.

Dialogs, tooltips, menus, dropdowns, drawers, notifications, and portals outside
the page's content wrapper must receive the same theme. Root CSS variables help
but do not solve Ant Design context by themselves. Migrate static
`message.*`, `notification.*`, and `Modal.*` usage as needed to provider-aware
hooks/`App` APIs, or a verified existing context-aware bridge. Do not create a
second notification system. See the
[Ant Design theme documentation](https://ant.design/docs/react/customize-theme/).

Do not remount the application or change editor keys on theme changes. Keep
providers stable, memoize resolved token objects, and subscribe non-CSS
renderers only to the values they actually need.

## 5. Public Website And Documentation Workstream

This workstream is required before native mode is considered releasable, even
if the signed-in app already looks good. Verify it in a **fresh anonymous
browser context**, not just an account that has enabled dark mode.

### 5.1 Public Palette And Navigation

Refactor `public/theme.ts` into stable public design tokens with paired semantic
light/dark palettes. Preserve the current light design unless correcting an
actual accessibility defect. Review background bands, cards, typography,
outlines, gradients, shadows, accent buttons, and the existing dark footer
together. Changing only pageBackground will leave unreadable content.

Separate deliberately styled demo/terminal palettes from the page's resolved
appearance. Replace the assertion that dark colors are reserved exclusively
for mockups with explicit scopes for page UI and illustrative content. Retain
legitimate layout and branding tests in both themes.

Place the appearance control in `public/layout/top-nav.tsx` for desktop and
mobile. Ensure overflow menus/drawers and account/auth controls work together.
It must be discoverable without adding a large explanatory section or asking
visitors to sign in. Public-to-app and app-to-public navigation should preserve
the appropriate preference without a light interstitial.

### 5.2 Required Route Inventory

Build the authoritative checklist from `public/app.tsx`, `public/routes.ts`,
feature registries, and accessibility route fixtures. Do not assume the home
page represents every route or reduce the test set to the examples below.

| Surface                                        | Required review                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Home/landing                                   | First viewport, complete scroll, hero assets, demo panels, CTAs, badges, footer, mobile navigation.                                  |
| Feature index and **every feature detail**     | Interactive examples, comparison/teaching tables, screenshots, embedded code, secondary navigation, related links.                   |
| Products, pricing, rootfs/software pages       | Tables, prices, filters, selected options, availability/status labels, popovers, empty/loading/error states.                         |
| About, guides, news, language/localized routes | Long-form prose, headings, images/captions, lists, links, translated control widths, code/math where present.                        |
| Public docs index and article routes           | Search, navigation, table of contents, long articles, anchors, code, tables, callouts, math, copy controls, and responsive layout.   |
| Authentication                                 | Sign-in/up, recovery, invitations, fresh-auth and other routed states; form labels, autofill, validation, disabled/loading controls. |
| Support, policies, not-found/error pages       | Long-form readability, forms, fallback HTML, links, and empty/error states.                                                          |
| Shared public overlays                         | Cookie consent/preferences, dialogs, dropdowns, tooltips, notifications, search results, and mobile drawers.                         |
| Public/shared file viewers and scratchpad      | Owned chrome follows appearance; document content follows the policy in section 6.                                                   |

### 5.3 Documentation Is A Reading Experience

Audit the shared docs reader in both public and signed-in contexts, including
private-note/star panels where available. Cover body text, muted text, headings,
inline code, fenced code/syntax highlighting, copy feedback, links, lists,
tables, borders, blockquotes, callouts, search highlights, navigation selection,
and math. Long reading sessions must be comfortable, not merely technically
visible.

Ensure public syntax tokens are defined without a signed-in editor theme.
`public/code-block.css` cannot rely on an account or CodeMirror initialization
to make its fallback colors readable. Reuse suitable code palettes while
keeping the public entry's dependency budget intact. Keep `@cocalc/docs` content
and headless functionality independent of frontend theming.

Extend `docs/download-html.tsx` so downloaded documentation includes the styles
it needs to read independently in light/dark/System, with no CoCalc session or
network requirement. Include a small accessible local appearance control if
the downloaded HTML supports scripting; without it, follow the OS. Do not
export unresolved CSS variables or depend on styles injected into the live app.

Print/print-preview must deliberately use clean light paper, dark text, and
readable code/table/callout styling regardless of the on-screen mode. Cover the
print popup as well as printing the live reader. Do not modify exported user
documents merely because the UI is dark.

### 5.4 Assets And Embedded Content

Review logos/wordmarks, transparent illustrations, screenshots, video posters,
badges, and partner marks against both backgrounds. Use existing appropriate
variants or a deliberate backing surface where needed; never invert photos or
product screenshots. Record any new asset variant with its source and purpose.

Theme first-party live examples through the same tokens. An intentionally fixed
demo theme needs a clearly bounded scope so surrounding captions and controls
still follow the page. Cross-origin apps/embeds can use a documented appearance
API if one exists, but arbitrary embedded pages are not recolored by CoCalc.

## 6. Main App, Editors, And User Content

### 6.1 Owned Application Surfaces

Convert shared surfaces first: application top/side bars, project/file tabs,
panes, file lists, toolbars, form controls, alerts, tables, empty states, loading
states, dialogs, and menus. Then audit complete workflows:

- Project listing, creation, files/search, collaborators, settings, secrets,
  rootfs/software, app launchers, backups, and activity.
- Account settings, memberships, billing/payment forms, and administration.
- Course management, student lists, seat management, and shared secrets.
- Chat/Codex, Markdown/math/code messages, composers, full activity drawers,
  approval/question panels, notifications, and long running turns.
- Notebook controls, cells, outputs, completion menus, inspectors, and errors.
- Text/Markdown editors, terminals, LaTeX/PDF tools, TimeTravel/diffs, boards,
  slides, tables, and other registered first-party editor/viewer surfaces.

Inventory legacy Bootstrap styling and hardcoded inline colors as well as Ant
Design components. Search results are an audit queue, not a safe global
replacement list: many literal colors represent data, branding, or content.

### 6.2 Editor And Terminal Preferences

Introduce an explicit Follow application appearance option where editor or
terminal theme selection currently expects a named palette. Preserve existing
precedence: workspace override, then account choice, then the new-profile
default. Resolve Follow to a tested light/dark palette appropriate to that
renderer. Keep existing explicit theme identifiers and custom terminal values.

Use the existing effective-theme helpers under `project/workspaces` rather
than resolving the same precedence independently in every editor. Existing
materialized defaults do not prove a theme was explicitly chosen; preserve
effective legacy choices rather than guessing and resetting them.

Update CodeMirror, Slate code blocks, syntax renderers, and xterm through their
supported live theme/options mechanisms. Essential's CodeMirror 6 integration
can share palette values without sharing the full editor implementation.
Verify cursors, gutters, selections, autocomplete, diagnostics, diff colors,
ANSI foreground/background colors, and contrast, not just editor backgrounds.

Theme changes must preserve unsaved text, undo/redo, selection, terminal
scrollback/scroll position, focus, and kernel/terminal connection state. They
must not change shared document content or another collaborator's appearance.

### 6.3 Renderer Policy

| Renderer/content                                      | Policy                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain text, Markdown, code, math                      | Follow the effective UI/editor palette, including syntax and selection states.                                                                                                            |
| First-party notebook tables, tracebacks, and controls | Theme owned markup and default unstyled output surfaces with scoped rules.                                                                                                                |
| User HTML/explicitly styled notebook output           | Preserve authored styling. Provide a coherent content boundary; do not inject broad wildcard recoloring.                                                                                  |
| Plots, images, SVG artifacts, canvas/WebGL output     | Preserve data and authored colors. Re-theme only first-party visualizations whose renderer supports it explicitly.                                                                        |
| PDF                                                   | Dark viewer/toolbars; original page appearance by default. Keep any dark-page viewing feature a separate explicit per-view choice, not automatic Dark Reader brightness/sepia processing. |
| Boards/slides                                         | Theme editor chrome, not persisted canvas/page backgrounds or authored object colors.                                                                                                     |
| External app iframes                                  | Theme the surrounding CoCalc UI; use supported embedded-app settings only where deliberately integrated.                                                                                  |

Migrate PDF reads of legacy dark-mode fields and per-frame overrides carefully.
Retain a user's explicit content-view choice where its meaning is known; do not
treat the mere existence of old default fields as consent to invert documents.
Use scoped light content tokens and `color-scheme: light` where an intentionally
light artifact contains controls, so inherited native dark controls do not
break it. Test print/export and copy/paste for unintended presentation changes.

## 7. Essential Integration

Treat Essential as an existing consumer with useful prior work, not a blank
slate. Its `theme.ts`, provider, early static script, syntax colors, and terminal
palettes are reference implementations to compare and reuse.

Share preference types, parsing, resolution, migration tests, and compatible
literal/semantic palette values. Keep Essential's provider, `--ul-*` adapter,
styling, and UI controls locally owned. It need not become visually identical
to the public site or main application.

Do not import `@cocalc/frontend`, Ant Design, Redux, Immutable.js, the full i18n
runtime, or editor registries into Essential to get theme support. Do not
introduce a theme service, polling, or an account fetch on otherwise lightweight
public startup. Integrate any Essential account persistence only through its
existing lightweight account path.

Align Essential's early script and runtime with the shared preference, migrate
`cocalc-essential-theme` once, and preserve its behavior if storage is blocked.
Check the clean `/essential/...` routes and the historical static entry. Run
Essential tests and production entry/bundle budgets after extracting shared
code. A tiny-looking util import can still pull in a large dependency graph.

## 8. Implementation Sequence And Gates

Use reviewable changesets by ownership boundary. Keep a route/surface checklist
and update it with screenshots, tests, and intentional content exceptions as
each phase completes. Do not claim completion by counting replaced literals.

### Phase 0: Baseline And Inventory

- [ ] Record all current theme settings, readers/writers, entry points, providers,
      public routes, editor/viewer types, and Dark Reader-specific workarounds.
- [ ] Capture representative light/Dark Reader screenshots and performance
      traces in dedicated test sessions, including anonymous public/docs pages.
- [ ] Record light-mode accessibility defects separately from migration regressions.
- [ ] Establish paired palette samples and agree on the migration policy.
- [ ] Optional separate interim fix: remove the 1-second delay for legacy on/off
      changes, retaining debouncing only for sliders. Guard asynchronous imports
      against stale toggles and unsubscribe correctly. Test rapid toggles and
      unrelated account changes. Skip this throwaway change if native rollout
      will immediately supersede it.

Exit: concrete inventory and fixtures; no assumption that Dark Reader's current
output is a correct dark-mode design specification.

### Phase 1: Preference, Tokens, And Startup

- [x] Add pure resolution/migration helpers and tests.
- [ ] Implement account/local adapters with explicit authority and race behavior.
- [ ] Add semantic paired palettes and concrete-color adapters.
- [ ] Add/test prepaint resolution in every relevant static/public entry.
- [ ] Wire stable main/public providers and accessible appearance controls.
- [ ] Make native mode available for controlled internal testing; never enable
      Dark Reader and native dark styling simultaneously in one document.

Exit: correct preference and first-paint matrix; no lost unrelated settings,
duplicate listeners, hydration/initial-render mismatch, or required network wait.

### Phase 2: Public Website And Docs

- [ ] Convert public theme helpers, shell, overlays, and every route family.
- [ ] Convert shared docs, public syntax highlighting, downloaded HTML, and print.
- [ ] Review public assets and fix light-only test assumptions appropriately.
- [ ] Validate complete anonymous navigation, mobile menus, cold loads, and
      account handoffs on lite2b in both resolved appearances and System.

Exit: the public site is independently usable and readable in native dark mode.
No need to open the main application first to initialize its styles.

### Phase 3: Main Application

- [ ] Convert shared components and provider-aware transient UI.
- [ ] Convert workflow-specific surfaces from section 6, including admin/course
      dialogs and Codex activity/attention surfaces.
- [ ] Audit nested providers, legacy CSS, custom inline styles, and alternate
      editor/viewer entry points; document deliberate authored-content boundaries.

Exit: everyday and less common owned workflows pass paired visual/interaction
checks; switching appearance preserves application state.

### Phase 4: Editors, Content, And Essential

- [ ] Add Follow application appearance while preserving existing overrides.
- [ ] Implement/test live renderer palette updates and content policies.
- [ ] Align Essential's small shared foundation and early bootstrap.
- [ ] Pass Essential dependency guards and editor-state preservation tests.

Exit: realistic long notebooks/chats and running terminals switch without a
reload, destructive reinitialization, or altered document content.

### Phase 5: Verification And Dark Reader Removal

- [ ] Complete the full validation matrix in section 9 and resolve regressions.
- [ ] Remove the legacy hook, imports, package dependencies, slider UI, obsolete
      tests, and Dark Reader-specific icon/style workarounds after checking each.
- [ ] Replace every remaining legacy boolean reader with resolved appearance or
      an explicit content-view setting. Keep only intentional migration readers.
- [ ] Update workspace lockfiles and aligned dependencies; check built bundles
      and lazy chunks as well as source for any remaining Dark Reader code.
- [ ] Remove temporary migration/rollout scaffolding that is no longer needed;
      retain only documented, tested legacy preference compatibility.
- [ ] Update appearance help/docs and record final screenshots/performance results.

Exit: full acceptance criteria below, not just a functioning toggle.

## 9. Validation Plan

### 9.1 Automated Behavior Tests

Add focused tests in the packages that own the behavior, including:

- Pure preference parsing/resolution; valid/invalid/missing new and legacy
  fields; explicit System versus absent migration marker; new versus old accounts.
- Plain/Immutable account values; updates preserving unrelated settings; old
  writers and mixed-version migration behavior; home-bay settings routing.
- Initial cached preference, asynchronous account hydration, rapid clicks,
  out-of-order save completions, rejected saves, logout, and account switching.
- System media-query changes, cross-tab events, blocked storage, unavailable
  APIs, subscription cleanup, and no persistence feedback loops.
- Generated early script/runtime parity, public HTML/fallback rendering, cached
  HTML, standalone docs styles, and light print output.
- Main/public/Essential controls using accessible roles/names and keyboard
  selection; portal/modal/notification appearance after toggling while open.
- Workspace/account editor precedence, explicit themes, Follow behavior, live
  terminal palette changes, and retained editor state.
- Paired public component tests, syntax/output color rules, and source/bundle
  guards preventing Dark Reader's accidental reintroduction.

Test public appearance with authentication and account-store initialization
absent. Test owned CSS and behavior, not only whether a theme data attribute or
an Ant Design algorithm is present.

### 9.2 Browser Environment And Build Workflow

Use the installed Chromium through the existing CoCalc browser automation or
Playwright workflows. The primary integration target is
**https://lite2b.cocalc.ai/**, served from this checkout by the local **3-bay hub**.
The hostname containing "lite" does not mean this instance uses the standalone
Lite API environment.

For an already built checkout, rebuild the static frontend:

```sh
pnpm -C src static
```

For a fresh worktree or missing workspace outputs, install dependencies and use
`pnpm -C src build:dev` as documented in `AGENTS.md`; otherwise keep checks and
builds package-local where possible. If account schema or hub HTML code changes
require rebuilt/restarted services, use the existing dev upgrade workflow and
refresh the environment afterward. Do not restart projects just for appearance.

Before local browser/control-plane commands, in a shell working in `src`:

```sh
eval "$(pnpm -s dev:hub:env)"
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" browser --help
```

Use that environment's exact project/browser targets; do not reuse stale
credentials from a prior hub run. For example, when inspecting an existing
scoped session:

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" browser files \
  --project-id "$COCALC_PROJECT_ID" --browser "$COCALC_BROWSER_ID"
```

Follow `docs/browser-debugging.md` and
`src/.agents/lite4b-setup-notes-2026-05-05.md` for dedicated sessions and local
fresh-auth recovery if needed. Do not request pasted credentials or manipulate
the user's active work to create test fixtures. Confirm the served asset hashes
are from the rebuild before interpreting screenshots. A page reload with an old
cached bundle is not validation of the new code.

### 9.3 Browser Matrix

Use separate anonymous, signed-in, and Essential contexts. Maintain a systematic
route checklist; capture every public route in both light and dark at desktop
and mobile sizes, with deeper interaction tests on representative shared
components. Cover complete articles/pages, not only the top viewport.

| Dimension     | Cases                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Preference    | Explicit Light, explicit Dark, System with light OS, System with dark OS, OS change while open.                                   |
| Startup       | Cold cache, warm cache, slow bundles/account responses, direct deep links, blocked storage, no-script prerender where supported.  |
| Session       | New anonymous visitor, returning visitor, migrated account, new account, login/logout, account switch, multiple tabs.             |
| Navigation    | Public landing to features/docs/auth/app and back; direct docs article; app and Essential deep links.                             |
| Viewport      | Wide desktop, ordinary laptop, phone portrait/landscape; 320 CSS px width and 200% zoom reflow checks.                            |
| State         | Loading, empty, populated, hover, focus, selected, disabled, validation error, open popovers/modals, reconnect/error banners.     |
| Content       | Long docs/code/math/tables, long chat, large notebook, mixed styled outputs, PDF/image, terminal with ANSI colors and scrollback. |
| Accessibility | Keyboard-only operation, reduced motion, forced colors, text/non-text contrast, screen-reader names and selected state.           |
| Output        | Screen, print preview, downloaded documentation opened independently, unchanged authored exports.                                 |

Chromium is the repeatable local gate, not proof of every browser. Before broad
rollout, smoke-test supported Firefox and Safari/WebKit, especially OS changes,
native controls, color-scheme handling, and first paint. Record any browser
testing not available locally rather than implying it was performed.

Extend the existing accessibility audit fixtures in
`src/scripts/accessibility/pages.json` and `scenarios.json` to exercise both
resolved modes, docs detail pages, and appearance controls. Follow
`src/.agents/accessibility.md` for focused component coverage and run:

```sh
pnpm -C src lint:frontend
pnpm -C src accessibility:test
pnpm -C src accessibility:audit:public
pnpm -C src accessibility:audit:interactive
```

Use the audit tool's documented targeting/configuration options for lite2b and
the dedicated test projects; inspect its help/README rather than assuming a
default points at the correct site. Run focused package tests and typechecks
for all changed owners, plus Essential/static entry and bundle guards when
shared modules or bootstrap code change.

Automated contrast checks need manual review of screenshots, charts, translucent
overlays, syntax colors, and all interaction states. Target WCAG 2.2 AA: normal
text at least 4.5:1, large text at least 3:1, and applicable control/focus
boundaries at least 3:1. Do not communicate status or selection solely by color.
See the W3C guidance on
[text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

### 9.4 Performance And State-Preservation Gates

Capture comparable before/after Chromium traces on the same machine, routes,
fixtures, viewport, and cache conditions. Include a throttled CPU run and
Essential's existing cold-load budget profile.

Measure:

- Click/OS-change to next correctly themed paint, including an open dialog.
- Cold/warm public and app startup, early painted backgrounds, transferred and
  parsed JavaScript/CSS, long tasks, and repeated-toggle heap growth.
- A long notebook/chat and running terminal, not only the settings page.
- Main-thread idle behavior after toggling; no theme-driven DOM observers,
  polling, repeated style regeneration, or accumulating subscriptions.

Provisional warm-toggle target: p95 under 100 ms on representative desktop
fixtures, with no artificial delay. Establish and record the baseline before
finalizing device-specific budgets. Report large-document and throttled results
separately rather than hiding them in a small-page average. Preserve existing
startup/entry budgets and investigate any regressions.

Verify no lost text/undo history, changed document hashes, restarted kernels or
terminals, reset scroll positions, or disconnected collaboration during toggles.
Exercise an actively streaming Codex/chat view without forcing a replay of its
entire history. Use dedicated fixtures and supported live document APIs for
any notebook edits/execution, not direct edits of live `.ipynb` JSON.

Retain representative screenshots, traces, route checklist, accessibility
reports, and bundle comparisons under the existing local artifact conventions.
Commit only appropriate reproducible fixtures and a concise evidence summary,
not private account/project contents or large ad hoc browser captures.

## 10. Rollout And Risk Management

Native appearance can be developed behind an internal opt-in while conversion
is incomplete. The engine choice must be mutually exclusive: disable and
dispose Dark Reader before enabling native dark styling, and guard outstanding
legacy imports so they cannot re-enable it afterward. This coexistence is
temporary implementation scaffolding, not the final architecture.

Use hashed static assets and verify HTML/CSS/bootstrap consistency across the
3-bay setup and public front. Account preference authority remains the account's
home bay. Theme changes must not add project configuration, project-host RPCs,
or data-plane traffic.

Release only after the public/docs and main-app gates pass, using lite2b for
maintainer review before broader deployment. Retain a previous deployable
artifact for rollback. Preserve the new preference during rollback; do not
perform destructive migration of unrelated settings to make old clients work.
The final native build must not ship Dark Reader as a hidden fallback.

Principal risks to review explicitly:

- A nested provider or static modal keeps light tokens while its parent is dark.
- Public initial/prerendered HTML flashes bright even though React later looks correct.
- A legacy/default setting overwrites an explicit choice after account hydration.
- A CSS-variable replacement breaks a color parser, canvas renderer, or export.
- A global selector recolors authored content, figures, or third-party widgets.
- Theme changes recreate expensive editors or repeatedly render a large chat.
- Shared code imports bloat anonymous public pages or Essential.
- Light-mode visual/contrast regressions are missed while attention is on dark.

Mitigate these through the corresponding tests and route evidence above rather
than adding a catch-all CSS filter. The toggle/provider portion is relatively
small; complete surface migration and verification are the substantial work.
Ship reviewable phases, but do not label a partially converted dark mode complete.

## 11. Acceptance Checklist

- [ ] Main app, all public route families, shared docs, and Essential use native
      appearance with no Dark Reader in source imports or built runtime chunks.
- [ ] Anonymous visitors get readable System appearance on the first painted
      page and can choose Light/Dark/System without signing in.
- [ ] Public landing/feature/docs pages pass complete desktop/mobile review;
      no unexamined light-only pages, overlays, or fallback states remain.
- [ ] Existing account/editor/workspace preferences migrate as specified;
      new choices persist without stale-response or cross-account resets.
- [ ] Startup, OS changes, cross-tab updates, login/logout, and app/public
      navigation have consistent, tested appearance behavior.
- [ ] All owned controls, dialogs, syntax colors, status states, and focus
      indicators are accessible and readable in both modes.
- [ ] Editor/terminal changes happen in place; authored content and exports are
      preserved, with documented intentional light content surfaces.
- [ ] Downloaded documentation works independently; print is clean light paper.
- [ ] Essential retains its dependency/performance boundaries and is not
      inadvertently launched or promoted by this work.
- [ ] Focused tests/typechecks, frontend lint, accessibility audits, entry/bundle
      guards, and recorded Chromium performance/state checks pass.
- [ ] Remaining supported-browser checks and any intentional exceptions are
      explicitly recorded; no unconverted first-party UI gaps are hidden by a filter.
- [ ] Maintainer has reviewed the live result on lite2b and approved rollout.

## 12. Working References

- [Repository guidance](../../AGENTS.md)
- [Accessibility requirements](accessibility.md)
- [Multibay architecture](scalable-architecture.md)
- [Local dev-site operational notes](lite4b-setup-notes-2026-05-05.md)
- [Browser debugging](../../docs/browser-debugging.md)
- [Accessibility audit tooling](../scripts/accessibility/README.md)
- [Current Dark Reader hook](../packages/frontend/account/dark-mode.ts)
- [Main Ant Design configuration](../packages/frontend/app/context.tsx)
- [Public palette](../packages/frontend/public/theme.ts)
- [Public shell](../packages/frontend/public/layout/shell.tsx)
- [Public routes](../packages/frontend/public/routes.ts)
- [Shared docs reader](../packages/frontend/docs/browser.tsx)
- [Standalone docs generation](../packages/frontend/docs/download-html.tsx)
- [Essential theme](../packages/essential-frontend/src/theme.ts)
- [Essential provider](../packages/essential-frontend/src/theme-context.tsx)
- [Essential architecture and budgets](../packages/essential-frontend/README.md)
- [Static entry template](../packages/static/src/app.html)
- [Essential early entry](../packages/static/src/ultralite.html)
- [Public server shell](../packages/hub/servers/app/public-shell.ts)
