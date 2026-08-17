# CoCalc Constrained Web Client Implementation Plan

Date: 2026-08-14

Status: execution plan. The first experimental client is implemented in commit
`f5f5791547` and deployed only to staging at
`https://staging.cocalc.ai/static/ultralite.html`. The prototype established
that a useful CoCalc experience is viable with a cold cache on Chrome's Slow
4G preset. The next work is deliberate product convergence, not incremental
polish of the prototype's independent visual design.

## Executive Decision

### 2026-08-15 Essential Frontend Amendment

The product and package name is now **Essential CoCalc** and
`@cocalc/essential-frontend`. The adjective is the admission rule: a feature
belongs only when it is essential to completing real work, not merely because
it exists in full CoCalc. The historical `/static/ultralite.html`, chunk names,
and telemetry identifiers remain temporarily stable deployment details.

The essential scope is project listing; ordinary code and Markdown file
browsing, viewing, and editing; recent-first human and Codex chat; terminal;
basic Jupyter viewing and execution; dedicated VM control; launching core app
servers; on-demand account notifications; and minimal project identity and
lifecycle controls. Course, admin, full account or project settings,
workspaces, launcher configuration, rich LaTeX tooling, specialized editors,
project-host management, process and activity management, advanced search,
and backup management remain in full CoCalc.

This amendment supersedes the earlier blanket CodeMirror prohibition and the
native-textarea editor design. A measured, minimal CodeMirror 6 editor loads
only after the explicit Edit action, and only its selected language parser is
loaded. Tests with very large documents showed that CodeMirror's bounded
parsing and viewport rendering provide much better _felt_ performance than
smaller Prism-overlay editors. The route budget counts editor core plus the
largest one parser, not every mutually exclusive grammar.

It also supersedes the earlier notification startup exclusion only for the
explicit Notifications surface. Notifications remain absent from startup and
project routes; no permanent poll is allowed. A future unread indicator must
use the bounded account event stream.

Production bundle measurement after the CM6 integration established a
612.2 KiB Brotli worst-case editor route, including the largest 76.1 KiB
language parser. The editor hard budget is therefore amended from 500 KiB to
650 KiB. This is an explicit, editor-only tradeoff for viewport rendering,
bounded parsing, reliable editing of very large files, and a cacheable lazy
chunk; it does not increase shell, project, file-view, chat, or notebook
budgets. The on-demand Notifications surface has a 475 KiB budget because it
shares the safe Markdown renderer; it remains absent from startup.

Chat history is transferred through an authenticated project-host data-plane
service as a bounded recent tail. The browser does not open the complete chat
ImmerDB and then discard old messages. Older history is explicit, activity
updates are bounded diffs, and visible clients keep short-lived sessions alive
without global polling. This protocol is shared infrastructure for web,
mobile, CLI, and agent clients.

Build a constrained web client as a recognizable, focused subset of CoCalc.
Keep React and Rspack, but use an isolated entrypoint and lightweight semantic
HTML and CSS. Reproduce the standard CoCalc visual and interaction contract
without importing the standard frontend runtime.

The governing product goal is:

> A user on a bandwidth- or CPU-constrained device can recognize CoCalc,
> navigate using the same concepts and terminology, and complete the most
> important project workflows without first downloading or evaluating the
> full CoCalc application.

This client is not a new visual product, a native-style web application, or an
eventual second implementation of every CoCalc feature. It may become a useful
focused mode even for users with fast devices, but feature parity is explicitly
not the objective.

## Validated Prototype Baseline

The first implementation includes:

- same-origin signed-in bootstrap;
- account-home-bay project listing;
- direct project-host file listing and bounded file reads;
- safe read-only text and Jupyter notebook views;
- existing Codex session discovery, chat, activity, interrupt, and send; and
- explicit links back to full CoCalc.

The measured production bundles from commit `f5f5791547` are:

| Surface                     | Cumulative Brotli |
| --------------------------- | ----------------- |
| Static shell                | 63.8 KiB          |
| Projects                    | 393.1 KiB         |
| Files and read-only Jupyter | 397.1 KiB         |
| Existing Codex chat         | 466.9 KiB         |

Manual staging validation with caching disabled on Chrome's Slow 4G preset,
approximately 1.4 Mbps downstream, found the client clearly usable. Preserve
this prototype as the performance baseline while replacing its arbitrary
gradient, card layout, typography, marketing copy, and project home design.

## Non-Negotiable Product Constraints

### 1. Standard CoCalc Is The Visual Specification

For each constrained screen, identify the corresponding standard CoCalc
screen and preserve as much of this contract as the reduced functionality
allows:

- visual identity, including standard blue, neutral colors, borders, and
  typography hierarchy;
- top navigation height and structure;
- content width, density, spacing, and row alignment;
- project title, file path, status, and action placement;
- terminology, labels, ordering, and navigation direction;
- table and list structure; and
- desktop and narrow-screen responsive behavior.

The constrained screen omits unsupported controls and information. It does not
replace them with unrelated cards, slogans, decorative gradients, alternate
navigation concepts, or a new design language.

Visual similarity does not mean importing Ant Design or standard CoCalc React
components. Implement the visible subset with small local React components,
semantic HTML, CSS, shared color constants, and a tiny icon set. Screenshots of
the standard and constrained versions at the same viewport are required review
artifacts for every major surface.

### 2. Performance Is A Hard Interface Contract

Budgets are cumulative Brotli bytes required to make the named surface usable
from a cold cache. They include the shell and all JavaScript and CSS loaded on
the route. They do not include user project data, but project-data transfer is
measured and reported separately.

| Surface                                | Hard budget | Initial target |
| -------------------------------------- | ----------- | -------------- |
| Static shell and authentication status | 75 KiB      | 65 KiB         |
| Searchable project list                | 400 KiB     | 300 KiB        |
| Project shell and directory listing    | 425 KiB     | 350 KiB        |
| Text and syntax-highlighted code view  | 450 KiB     | 375 KiB        |
| Text and code editing with save        | 650 KiB     | 600 KiB        |
| Read-only Jupyter notebook             | 500 KiB     | 425 KiB        |
| Executable Jupyter notebook            | 650 KiB     | 550 KiB        |
| Existing Codex chat                    | 550 KiB     | 500 KiB        |
| Codex chat with mathematics            | 700 KiB     | 650 KiB        |
| Existing dedicated VM control          | 450 KiB     | 400 KiB        |
| JupyterLab and VS Code app launch      | 475 KiB     | 425 KiB        |
| CoCalc CLI discovery                   | 425 KiB     | 350 KiB        |
| Terminal                               | 500 KiB     | 475 KiB        |
| On-demand notifications                | 475 KiB     | 450 KiB        |
| Minimal project settings               | 425 KiB     | 400 KiB        |

Rules for changing these budgets:

- CI fails when any hard budget is exceeded.
- A feature may not borrow from an unrelated route's budget.
- A budget increase requires an explicit amendment to this plan, before and
  after measurements, rejected alternatives, and human review.
- Shared chunks count against every route that loads them.
- Optional language grammars, notebook execution, and editor support load only
  when used.
- Raw, gzip, request-count, parse-time, and memory measurements are reported
  even when Brotli is the release gate.

### 3. Deterministic Slow-Network SLOs

Maintain an automated Chromium profile with exact settings recorded in every
result. The initial canonical profile is:

- 1.4 Mbps downstream;
- 750 Kbps upstream;
- 150 ms added round-trip latency;
- cold HTTP cache; and
- a separate run with 4x CPU slowdown.

The deterministic network-only targets are:

| Interaction                                         | Target |
| --------------------------------------------------- | ------ |
| Navigation to interactive signed-in project rows    | <= 5 s |
| Project selection to first useful directory rows    | <= 5 s |
| Directory navigation after host connection          | <= 2 s |
| Text or code file selection to useful content       | <= 3 s |
| Notebook selection to first visible cells           | <= 4 s |
| Existing Codex selection to visible recent messages | <= 5 s |

The corresponding 4x CPU targets are 1.6 times these limits. Backend and
project-host timing must be recorded separately from static transfer and
client execution so a slow server does not get misdiagnosed as bundle growth.
Tests must cover warm cache as a secondary result, never as a substitute for
cold-cache evidence.

### 4. No Hidden Background Cost

- Do not permanently poll project, file, account, billing, or presence state.
- Do not preload code editor, notebook execution, Codex, or optional syntax
  languages.
- A bounded poll is allowed only for an explicit in-progress operation such as
  starting a project. It must stop on completion, timeout, navigation, or
  unmount.
- Realtime subscriptions are limited to a visible active Codex session or
  visible notebook execution state. They close when the surface closes.
- Directory listings are explicit reads. A visible Refresh action replaces a
  filesystem watcher.
- Do not start project compute for project listing, directory browsing, or
  read-only file access.
- Do not load analytics, support widgets, news, notifications, billing,
  presence, or editor registries during startup.

### 5. No Accidental Full-Frontend Dependencies

The constrained graph must reject imports of:

- `@cocalc/frontend` or paths containing `frontend/`;
- Ant Design and `@ant-design/*`;
- Redux and Immutable.js;
- jQuery;
- CodeMirror, Monaco, Ace, Slate, and ProseMirror;
- JupyterLab packages;
- the full editor registration system;
- the full internationalization runtime; and
- third-party fonts or remote UI assets.

Use React, React DOM, narrowly imported CoCalc protocol clients, small local
components, and browser primitives. New third-party dependencies require a
measured route-level cost and security review. A dependency that is small on
npm but pulls a broad transitive graph is not acceptable.

### 6. Security And Data-Integrity Boundaries

- Bootstrap authentication with the existing same-origin account cookie.
- Keep project-host bearer credentials in memory only.
- Never put account cookies, project-host tokens, file contents, prompts, or
  notebook contents in URLs, local storage, telemetry, or logs.
- Resolve account authority through `home_bay_id` and `home_bay_url`.
- Resolve project ownership and host routing explicitly. Never assume the
  current bay is authoritative.
- Send steady-state files, notebook, Codex, and execution traffic directly to
  the owning project host.
- Do not proxy project data through a hub merely to simplify the client.
- Honor viewer and read-only permissions throughout the UI and backend.
- Keep the first file namespace confined to `/home/user`.
- Apply explicit size limits before downloading or rendering files.
- Treat notebook Markdown and rich output as untrusted input.
- Never insert notebook or chat HTML with `innerHTML` or
  `dangerouslySetInnerHTML`.
- Omit unsupported HTML, JavaScript, widgets, and interactive notebook output;
  do not partially execute it.
- Text and notebook saves require optimistic conflict detection. Never silently
  overwrite a server version changed since the client read it.
- One user action produces at most one save, execution request, interrupt, or
  Codex prompt, including across retries and reconnects.

## Product Information Architecture

### Global Shell

Reproduce the standard CoCalc top bar using lightweight markup:

- CoCalc identity on the left;
- current project title when inside a project;
- a small, non-marketing constrained-mode indicator if needed;
- account or connection status only when actionable; and
- an obvious `Open full CoCalc` escape action.

Do not show standard tabs whose destinations do not exist in this client. Do
not invent replacement tabs.

### Projects

Use the standard projects page as the reference. The first constrained version
contains:

- compact project rows rather than large cards;
- project title;
- a restrained description when present;
- runtime or archived status when relevant;
- last-edited time;
- search;
- pagination or `Load more`; and
- a standard-looking empty and error state.

Initially omit create, bulk selection, deleted projects, project log,
collaborator avatars, hashtags, role management, menus, and complex filters.
These may be added only if they are common constrained-device workflows and
fit the route budget.

### Project Shell

Use the standard project workspace as the reference:

- standard top bar with project title;
- narrow left rail or equivalent navigation containing only available
  surfaces;
- Files as the default surface;
- Codex as a first-class surface;
- Terminal as a separately loaded, explicit compute surface;
- Virtual Machines as a first-class gateway to existing dedicated compute;
- Apps as a first-class gateway to JupyterLab and VS Code;
- CLI as a compact discovery surface for project, Jupyter, app, VM, and agent
  automation commands;
- path and active file context in familiar locations; and
- full CoCalc escape without a separate intermediate dashboard.

The first rail should not include inert placeholders for Home, New, Search,
Users, Settings, Workspaces, or other unavailable tools.

The constrained client is a gateway to CoCalc's backend capabilities, not
merely a small file viewer. The first gateway scope includes discovering and
starting existing VMs, and discovering and launching JupyterLab and VS Code.
VM creation, deletion, funding, resize, and advanced configuration remain in
full CoCalc. App views must not start project compute merely by being opened;
Start is an explicit, clearly labeled action.

The CLI surface remains documentation and command discovery rather than
embedding a terminal. A separate lazy Terminal surface may use xterm.js and
the direct project-host PTY service. Merely viewing Terminal must not start
compute or spawn a shell; Connect is the explicit boundary, with confirmation
before starting a stopped project. Terminal is the intentional realtime
exception and must have its own cumulative route budget.

### Files

Use a simplified standard CoCalc file listing:

- breadcrumb path;
- Name, Modified, and Size columns;
- directories first with familiar visual treatment;
- parent navigation;
- refresh;
- download for individual files;
- bounded entry rendering with a clear truncation message; and
- an explicit read-only state when writes are not permitted.

Upload, create file/directory, rename, move, delete, and search are follow-up
features. Each must use existing scoped project-host operations and get
separate confirmation and conflict behavior where appropriate.

## Functional Scope And Phases

### Phase 0: Preserve And Measure The Prototype

Before visual restructuring:

1. Preserve current production bundle reports and screenshots.
2. Add deterministic desktop and narrow-screen browser scripts.
3. Record network request count, transferred bytes, decoded bytes, parse and
   evaluation time, memory, and useful-surface timestamps.
4. Capture standard CoCalc reference screenshots for Projects, project Files,
   text/code, notebook, and Codex at matching viewports.
5. Add a route-level chunk-failure test so a missing optional chunk displays a
   local recovery action instead of breaking the shell.

Exit gate: the current prototype remains functionally usable and every later
phase can be compared against a reproducible baseline.

### Phase 1: Visual And Navigation Convergence

1. Replace the custom white/gradient shell with a lightweight standard CoCalc
   shell.
2. Replace project cards with compact standard-looking project rows.
3. Remove prototype copy such as `Realtime only where it matters`.
4. Remove the project dashboard and go directly to the familiar project Files
   surface.
5. Add the reduced project navigation rail and project title context.
6. Restyle breadcrumbs, file rows, loading, empty, warning, and error states to
   match standard CoCalc.
7. Keep all current protocol and bundle boundaries intact.

Exit gate: side-by-side review identifies the constrained screens as the same
product without needing explanatory text, and all existing budgets still pass.

### Phase 2: Reduce The Project-List Transport Floor

The current Projects closure is approximately 393 KiB Brotli, mostly because
the route loads general Conat and project-host routing machinery before a
project is selected. Investigate this systematically rather than micro-
optimizing CSS.

Compare:

1. a narrower tree-shakeable Conat account RPC client;
2. a dedicated lightweight protocol package with only authentication and the
   project-window RPC;
3. server bootstrap containing the first authorized project window; and
4. a narrow home-bay HTTP read API, only if the Conat approaches cannot meet
   the target and the architecture exception is documented.

Any HTTP option must route to the account's authoritative home bay, preserve
the same authorization and pagination semantics, and remain control-plane
only. It must not become a project data proxy.

Exit gate: Projects remains under the 400 KiB hard limit and makes measurable
progress toward the 300 KiB target without duplicating authorization logic.

### Phase 3: Lightweight Code Viewing

1. Detect a small explicit set of common languages from file extension.
2. Load Prism core only on a code-view route.
3. Load each optional grammar only when that language is displayed.
4. Render escaped tokens into a read-only code surface matching CoCalc's
   standard editor colors and line spacing.
5. Fall back to escaped plain text for unknown languages or grammar failures.
6. Preserve selectable text, wrapping controls, and horizontal scrolling.

Initial language set: Python, JavaScript, TypeScript, JSON, Markdown, LaTeX,
Shell, YAML, HTML, CSS, C/C++, Rust, and SQL. The emitted grammar bytes decide
whether all of these ship initially; rarely used grammars may remain deferred.

Exit gate: syntax highlighting is useful, safe, keyboard accessible, and the
code-view cumulative route is at most 450 KiB Brotli.

### Phase 4: Lightweight Text And Code Editing

The editor is a deliberately narrow CodeMirror 6 configuration, loaded only
after an explicit Edit action:

- viewport rendering and CodeMirror's bounded parsing for responsive large
  files;
- one lazy parser selected from the supported language set;
- monospace text, tabs, configurable wrapping, search, and line/column status;
- explicit Save and Revert;
- standard keyboard save shortcut;
- dirty-state and navigation warning;
- server version or content-hash conflict detection;
- read-only fallback for viewers, oversized files, and unsupported binary
  data; and
- the existing lazy Prism surface for read-only viewing, with no CodeMirror
  transfer before Edit.

Do not implement minimap, language servers, semantic completion,
collaborative cursors, extension loading, broad IDE keymaps, or an editor
plugin system. Those belong in full CoCalc.

Initial limits:

- at most 2 MiB for editable text;
- at most one active editor document;
- manual save, not continuous autosave; and
- no write after a detected conflict until the user reloads or explicitly
  resolves it in full CoCalc.

Exit gate: edit, conflict, retry, read-only, and failed-save tests pass and the
editor route, including its largest one language parser, remains at most
650 KiB Brotli.

### Phase 5: Focused Executable Jupyter

Build notebook execution as a separately loaded layer over direct project-host
Jupyter APIs. Do not import JupyterLab or reuse its frontend packages.

First executable scope:

- notebook metadata and ordered cells;
- Markdown, raw, and code cells;
- edit code and Markdown source;
- add, delete, and move a cell;
- save with conflict protection;
- run selected cell;
- run all cells;
- interrupt kernel;
- visible kernel/execution status;
- text, error, stream, and bounded PNG/JPEG output; and
- a clear full-CoCalc escape for unsupported output or kernel configuration.

Execution constraints:

- browsing or editing a notebook does not start project compute;
- Run is the explicit action that may start the project and kernel;
- prefer the notebook's kernelspec and provide a small explicit fallback when
  unavailable;
- execution subscriptions exist only while the notebook surface is visible;
- output is bounded by cell and notebook limits;
- HTML, JavaScript, widgets, comm targets, iframes, and arbitrary MIME renderers
  are omitted; and
- reconnect converges to server state without duplicate execution.

Explicitly deferred: debugger, variable inspector, interactive widgets,
JupyterLab extensions, real-time collaborator cursors, rich HTML execution,
cell attachments UI, slideshow editing, and broad metadata editing.

Exit gate: notebook save, run, interrupt, reconnect, unsafe-output, and
duplicate-execution tests pass and the executable route is at most 650 KiB
Brotli.

### Phase 6: Codex Convergence

Keep the existing lightweight headless chat protocol, but restyle it as a
focused version of standard CoCalc chat:

- familiar message roles and spacing;
- agent activity and background-command state;
- send, interrupt, continue, and approval links;
- reconnect and catch-up;
- newest-message bounding with an explicit older-history action; and
- project and full-CoCalc context.

Do not add the full agent configuration interface, attachments, reactions,
voice, model catalog, billing controls, or full chat editor. New-thread
creation may be added later as a compact workflow if it stays within budget.

Exit gate: the existing chat integration contract passes under reconnect and
Slow 4G, and cumulative Codex assets stay at most 550 KiB Brotli.

## Shared Lightweight Components

Create only components that are used by at least two constrained surfaces:

- `ConstrainedShell`;
- `TopBar`;
- `ProjectRail`;
- `CompactButton` and `IconButton`;
- `StatusText` and `InlineAlert`;
- `LoadingState`, `EmptyState`, and `ChunkErrorBoundary`;
- `Breadcrumbs`;
- `CompactTable`; and
- a tiny local icon set.

Do not create a general-purpose replacement for Ant Design. Component APIs
should express the constrained client's actual needs, not hypothetical future
features.

## Accessibility Constraints

Every phase must satisfy `src/.agents/accessibility.md`:

- complete keyboard navigation;
- visible focus;
- semantic headings, navigation, tables/lists, labels, and alerts;
- correct disabled and read-only semantics;
- no color-only state indication;
- screen-reader announcements for bounded loading and execution transitions;
- reduced-motion support;
- minimum practical touch targets on narrow screens;
- text zoom and 320 px viewport support without horizontal page overflow; and
- automated accessibility coverage plus manual keyboard smoke testing.

Syntax tokens may use color, but source text and editor meaning cannot depend
on token color.

## Telemetry And Product Evaluation

Telemetry must answer whether constrained CoCalc improves access and task
completion without collecting project content.

Record:

- static build identity and constrained-client version;
- route and navigation type;
- cold/warm cache classification;
- browser-reported network and CPU hints when available;
- transferred script/style bytes and request count;
- shell, project rows, directory rows, file content, editor ready, notebook
  cells, kernel ready, and chat ready timestamps;
- timeout, chunk failure, auth failure, routing failure, save conflict, and
  unsupported-file outcome;
- first successful project open, file open, save, notebook execution, and
  Codex prompt as content-free events; and
- explicit transition to full CoCalc.

Never record project titles, paths, filenames, file contents, notebook source
or output, chat text, tokens, or credentials.

The initial staging URL remains hidden and opt-in. Do not automatically switch
users based on `navigator.connection` or inferred device quality. After the
client is stable, expose an explicit low-bandwidth/focused-mode choice and run
an account-level intent-to-treat experiment that includes abandonment. Do not
claim a retention improvement from completed-load percentiles alone.

## Test Matrix

### Accounts And Routing

- signed out and signed in;
- account home bay equal to and different from entry bay;
- account with 0, 1, 50, and more than 50 projects;
- search and pagination;
- owner, collaborator, viewer, and removed access;
- project with and without an assigned host;
- stopped, starting, running, archived, moving, and unavailable project;
- project host in the same bay and another bay; and
- Launchpad as the one-bay case.

### Files And Editors

- empty, normal, large, and truncated directories;
- Unicode, spaces, punctuation, and long filenames;
- navigation attempts outside `/home/user`;
- missing, changed, binary, oversized, and permission-denied files;
- save success, disconnect, retry, conflict, and viewer mode;
- supported and unsupported Prism languages; and
- chunk failure while opening the viewer or editor.

### Jupyter

- Markdown, raw, and code cells;
- empty, malformed, and oversized notebooks;
- text, stream, error, image, HTML, widget, and unknown MIME output;
- stopped project and missing kernelspec;
- run, run-all, interrupt, reconnect, and duplicate-submit protection;
- server-side change while editing; and
- read-only collaborator.

### Codex

- no indexed sessions and many sessions;
- idle, queued, running, background-command, interrupted, and completed turn;
- send and duplicate-submit prevention;
- interrupt and continue;
- approval link display;
- reconnect and activity catch-up; and
- bounded old history.

### Browser And Performance

- current Chrome, Firefox, and Safari;
- desktop, 768 px, 390 px, and 320 px widths;
- cold and warm cache;
- canonical Slow 4G;
- 4x CPU slowdown;
- offline transition and reconnect;
- static deployment while an old tab is open; and
- reduced motion, keyboard-only, and screen reader smoke tests.

## Release Gates

No phase advances from staging unless:

1. its cumulative Brotli budget passes from a clean production build;
2. forbidden-import guards pass;
3. deterministic Slow 4G and CPU profiles meet their SLOs;
4. standard and constrained screenshot comparisons are reviewed;
5. focused unit, contract, accessibility, and browser tests pass;
6. multibay routing and direct project-host traffic are verified;
7. no permanent polling or hidden subscriptions appear in a browser trace;
8. credentials and user content are absent from logs and telemetry;
9. standard CoCalc static entries show no bundle or behavior regression; and
10. staging hub and project-host health remain normal after deployment.

Production rollout is initially a new, undiscoverable static route. It must not
replace the standard application or become automatic. Retain the previous
static and hub releases for immediate rollback.

## Implementation Discipline

- Make one coherent phase or subphase per commit.
- Update the measured budget table whenever chunk topology changes.
- Include the standard-screen reference and constrained screenshot in the
  review summary.
- Treat bytes, interaction latency, accessibility, and direct routing as
  correctness, not polish.
- Remove a low-value feature rather than weakening a hard budget.
- Prefer explicit omission and a full-CoCalc escape over a partial unsafe
  implementation.
- Never use `temporary` as justification for bypassing authorization,
  conflict protection, output sanitization, or multibay routing.

## Definition Of Success

The implementation is successful when a user can, on a cold Slow 4G
connection:

1. recognize the page immediately as CoCalc;
2. find and open a project;
3. browse files without starting compute;
4. read and edit a normal source file safely;
5. inspect and execute a normal Jupyter notebook;
6. continue an existing Codex session;
7. understand clearly when a capability requires full CoCalc; and
8. complete those workflows without any route exceeding its hard byte or
   latency budget.

The implementation is not successful merely because it is smaller than full
CoCalc, or because completed page loads are fast. It must preserve user trust,
task completion, and a coherent transition between constrained and standard
CoCalc.

## Staging Validation, 2026-08-15

The completed constrained client was deployed only to staging as hub and
static artifact
`20260815T071520Z-8d3a528a-ultralite-constrained-release`. The preceding
`ultralite-f5f5791547` hub and static releases remain available for rollback.
The staged hub migration and rolling restart completed with four healthy
workers, healthy frontdoor routing, and successful hub and static smoke tests.

Authenticated canonical Slow 4G measurements passed the hard SLOs:

- desktop, unthrottled CPU: projects cold 1.84 s, files cold 4.84 s, and warm
  navigation 18-20 ms, against a 5 s limit;
- 320 px viewport, 4x CPU slowdown: projects cold 2.23 s, files cold 5.82 s,
  and warm navigation 33-35 ms, against an 8 s limit;
- cold projects transferred 107 KB across 9 requests; cold files transferred
  476 KB across 20 requests; and
- neither the desktop nor 320 px screenshots had horizontal page overflow.

Authenticated route smoke tests covered projects, files, VMs, app servers,
CLI discovery, Codex session discovery, text/code viewing, safe notebook
viewing, and the explicit notebook execution opt-in. No page errors or HTTP
5xx responses were observed. The first cold read of the test notebook had a
roughly 30-second project-host tail, while its warm read and execution-control
activation were immediate; this backend tail is kept separate from the static
client timing and remains operational performance work rather than a client
release failure.

### Essential Frontend Package And Data Plane

The package migration, CodeMirror editor, automatic terminal attachment,
bounded chat data plane, notifications, and minimal project settings were
deployed only to staging from commit `ad75c8b41f`.

- Static artifact:
  `20260815T170500Z-ad75c8b4-essential-frontend-ad75c8b41f`; deployment
  `20260815T170548Z-20260815T170500Z-ad75c8b4-essential-frontend-ad75c8b41f`;
  bay release `20260815170553-static`.
- Project-host artifact and version:
  `20260815T170626Z-ad75c8b4-essential-frontend-ad75c8b41f`; deployment
  `20260815T170731Z-20260815T170626Z-ad75c8b4-essential-frontend-ad75c8b41f`.
- Static rollback target: `ultralite-terminal-mobile-8d9879ec7f`.
- Project-host rollback version: `20260814T1927Z` from commit
  `c4189c2c54e6`.

The project-host rollout first upgraded canary host
`7843c648-86e4-45d3-9ed2-85ebe9faf9ee`, observed it for 60 seconds, then
upgraded host `37782b66-190d-41c3-a7e5-f5662e34cd4a` with concurrency one and
a 30-second stabilization interval. Both hosts remained running. Static and
project-host smoke tests passed. This rollout did not change the hub, project
image, tools bundle, ACP worker, router, persistence layer, or production.

Authenticated browser validation against
`https://staging.cocalc.ai/static/ultralite.html#/projects` covered:

- project discovery, file listing, syntax-highlighted reading, and the lazy
  CodeMirror 6 editor;
- the bounded project-host Codex history service, newest-message layout,
  Markdown rendering, bottom composer, catch-up, and continue controls;
- automatic terminal attachment to the retained shell;
- safe notebook viewing, including Markdown, source, and image output;
- listing and lifecycle controls for existing VMs;
- JupyterLab and VS Code app launch controls;
- notifications; and
- minimal project identity and lifecycle settings.

These checks produced no page errors or console errors. With cache disabled
and network throughput limited to 1.4 Mbps, the exact motivating file-listing
route rendered its listing in 4.82 seconds, transferring 467 KiB over 21
requests. The staged production build also passed every route budget; the
largest relevant cumulative totals were 615.0 KiB Brotli for the editor plus
largest language parser, 600.5 KiB for chat plus lazy math, and 488.5 KiB for
the terminal.

### Focused File And Jupyter Follow-Up

Commits `1c92cc436a` through `8e21132522` were deployed only as staging static
artifact `20260815T180334Z-8e211325-essential-jupyter-scan`, bay release
`20260815180425-static`. This did not update the hub or project hosts.

The exact motivating Go source route rendered 9,156 Prism tokens without a
load warning. Its CodeMirror editor was white, bordered, and 585 px high in a
900 px viewport. The repository README rendered as structured Markdown with
15 headings and 130 paragraphs instead of source text.

The first recent-notebook scan exposed permission errors under hidden project
state. The final query prunes hidden directories before traversing, after
which the staging project returned 127 visible notebooks ordered by
modification time. The result is cached by project host and project for the
browser session; only Refresh rescans. Opening `spiral.ipynb` produced two
bounded white CodeMirror cell editors, and Reload from disk preserved notebook
edit mode. These browser checks produced no page or console errors.

Production graph validation passed with 418.3 KiB Brotli for syntax-highlighted
code, 464.1 KiB for rendered Markdown, 619.3 KiB for ordinary editing, 665.1
KiB for Markdown editing, 623.4 KiB for executable Jupyter, and 403.9 KiB for
the recent-notebook index.

### Clean Routes And Open-File Watches

Commits `0c7506e655`, `23f08e2fdb`, and `7156df5baf` added the clean
`/essential/projects/...` URL schema and direct project-host open-file watches.
They were deployed only to staging. Production and project-host software were
not changed.

- Hub artifact:
  `20260815T182552Z-23f08e2f-20260815T182535Z-23f08e2f-essential-route-watch`;
  bay release `20260815182738-hub`.
- Final static artifact:
  `20260815T183713Z-7156df5b-20260815T183300Z-7156df5b-essential-watch-atomic`;
  bay release `20260815183805-static`.

A direct authenticated load and browser refresh of the motivating Go source
URL returned HTTP 200, retained the clean path, resolved the entry chunk from
`/static`, rendered `main.go`, and produced no page or console errors. A
historical hash link converted in place to its corresponding clean URL.

Live watch validation used a temporary project file and external atomic
uploads. A passive view automatically reloaded the new contents. A subsequent
atomic replacement while CodeMirror held an unsaved draft displayed the
changed-on-disk warning and retained the draft. The initial staging test also
found that `closeOnUnlink` ended subscriptions during normal rename-based
saves; `7156df5baf` fixed this by following the visible path until navigation
closes the watcher. All temporary project files were removed afterward.

## Relevant Code And Plans

- `src/packages/essential-frontend/`
- `src/packages/static/scripts/check-ultralite-budgets.mjs`
- `src/.agents/signed-in-startup-retention-performance-plan-2026-08-11.md`
- `src/.agents/scalable-architecture.md`
- `src/.agents/accessibility.md`
- `src/.agents/react-native-first-vertical-slice-plan-2026-08-14.md`
