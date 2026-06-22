# Public Site Framing Workplan - 2026-06-20

Owner: Codex in `/home/user/cocalc-ai-synthesis`.

Purpose: store the current researched action list so future rounds can read,
revise, and burn it down without losing user feedback or redoing analysis.

## Status Key

- `pending`: not started.
- `in_progress`: currently claimed.
- `blocked`: needs human input or a proof gate.
- `done`: implemented and validated.
- `dropped`: deliberately not worth doing.

## Current Actions

### FS-001 - Make feature-index cards route consistently

Status: `done`

Evidence:

- User flagged a `/features` card that goes directly to docs while other cards
  open local feature pages.
- Source audit found docs-only card overrides for `CoCalc CLI` and `Dedicated
Compute`; "Project notes and Markdown" is a non-card group text link.
- External/source framing says docs links should support feature pages, not
  replace feature pages when the tile looks like a normal feature card.

Plan:

1. Re-evaluate the uncommitted `cli-page.tsx` and
   `dedicated-compute-page.tsx` drafts against
   `docs/landing-page-framing-system.md`.
2. Keep each page only if it answers a public visitor question in one
   scannable workflow frame.
3. Wire accepted pages through feature catalog, metadata, and tests.
4. Rebuild preview and QA `/features`, `/features/cli`, and
   `/features/dedicated-compute`.

Risks:

- CoCalc CLI should remain a technical automation surface, not a top-level
  executive product.
- Dedicated compute must avoid internal project-host terminology and unproven
  performance or capacity claims.

Current route frame for `/features/cli`:

```md
Route: /features/cli
Visitor: engineer, researcher, platform teammate, or agent-assisted operator
Visitor question: when should I use the CoCalc CLI instead of clicking through
the UI or starting from the HTTP API?
One-sentence promise: typed commands make recurring CoCalc project work easier
to repeat, inspect, and hand to people or agents.
Proof mechanism: project, notebook, browser, docs, and command examples that
start from the same project context.
Primary next step: open projects / create account.
Secondary next step: CLI guide and related automation pages.
What this must not claim: not an executive product path, not a replacement for
the main workspace, not a benchmark or automation outcome claim.
Evidence consulted: pitch docs classify CLI as an automation/integration
surface; user feedback requires feature-card consistency; framing system says
feature-like cards should route to feature pages.
Decision: promote the short CLI overview page and keep docs as a supporting CTA.
```

### FS-002 - Keep More Languages useful without becoming a language inventory

Status: `done`

Evidence:

- User asked whether the More Languages page omitted important languages.
- External Jupyter and Codespaces sources confirm broad language support is a
  common expectation.
- CoCalc public value is not "every language"; it is using many languages in a
  persistent project with files, notebooks, terminals, and documents.

Current disposition:

- More Languages now groups compiled code, scripting/shell, JVM/web, and data
  workflows.
- Future changes should add a language only when it is important to the target
  audience and supports a workflow family, not as an exhaustive list.

### FS-003 - Preserve whiteboards and slides as one coherent workflow

Status: `done / watch`

Evidence:

- User identified confusion between `/features/whiteboard` and
  `/features/slides`.
- Source/pitch grounding says whiteboards, slides, technical writing, and
  teaching/research explanation are durable legacy strengths.

Current disposition:

- `/features/whiteboard` is the canonical "Whiteboards and Slides" overview.
- `/features/slides` remains a focused detail route.
- Hero copy has been shortened after user feedback.

Watch item:

- If the overview still feels too whiteboard-heavy, split the title and hero
  imagery more evenly before adding text.

### FS-004 - Add route frames before future feature-page edits

Status: `pending`

Evidence:

- The feature page work repeatedly surfaced inconsistent cards, docs handoffs,
  redundant wording, and visual/text density problems.
- A route frame forces each change to answer one visitor question before
  source edits.

Plan:

1. For the next touched feature route, write the route frame in this file or a
   route-specific plan before editing.
2. After implementation, keep only the final route frame and decision; move
   mechanical detail to the commit message.

### FS-005 - Audit public pages for lazy docs handoffs

Status: `pending`

Evidence:

- The docs-only feature cards demonstrate the pattern.
- The research register says a card that looks like a feature card should not
  silently behave like documentation navigation.

Plan:

1. Search public feature/product indexes for `href` overrides to `/docs`.
2. Classify each docs link as one of:
   - supporting docs link, OK;
   - explicit docs bridge, OK if styled/named that way;
   - normal feature card routed to docs, fix or redesign.
3. Fix only the cards that break user expectation.

### FS-006 - Use external research as constraints, not public comparison copy

Status: `done / ongoing`

Evidence:

- Official sources show adjacent categories evolving quickly.
- Pitch docs require named-product refresh before publication.

Plan:

1. Keep external observations in
   `docs/landing-page-framing-research-register.md`.
2. Do not name competitors on public pages without explicit approval.
3. Use the research to sharpen CoCalc's own route-level value, not to publish
   comparison claims.

### FS-007 - Sharpen the terminal feature page

Status: `in_progress`

Evidence:

- Blaec requested the `/features/terminal` page improvement through Claude's
  live queue after the features-index fix.
- The current hero and `.term` section repeat the same "address/context"
  point across the H1, paragraphs, and four bullets.
- The Brief and framing system say feature pages should be tool-forward, prove
  the durable shared-project spine, and remove repetition when the visitor
  already understands the point.

Current route frame for `/features/terminal`:

```md
Route: /features/terminal
Visitor: technical user, champion, or reviewer who needs shell work beside
notebooks, files, logs, and collaborators.
Visitor question: can terminal work stay attached to the shared project instead
of disappearing into a private browser tab?
One-sentence promise: CoCalc gives the project a real Linux terminal that opens
where the work lives and can be reopened, shared, and reviewed.
Proof mechanism: .term file location, durable terminal context, shared stream,
split panes, output handling, TimeTravel-adjacent project review, and related
Linux/Jupyter paths.
Primary next step: create account / open projects.
Secondary next step: terminal field guide plus Linux, Jupyter, and software
install routes.
What this must not claim: no benchmark, setup-time, restore-time, managed
compute, pricing, compliance, or broad agent-platform claim; no audience-stamp
or vertical-specific language.
Evidence consulted: Claude live queue item 8, frozen Brief, framing system,
research register, current terminal page source/tests, and browser-QA canaries.
Decision: redesign copy/structure in the hero, .term section, and closing
fit section; keep proof surfaces and layout components.
```

Current disposition:

- Hero now leads with a project-anchored Linux terminal, while preserving the
  shell and `.term` file proof.
- The `.term` section now explains folder co-location and review value with two
  distinct bullets instead of four restatements.
- The closing fit section is renamed to "Where the terminal earns its place."

### FS-008 - Consolidate the Jupyter feature page onto shared primitives

Status: `done`

Evidence:

- The curated feature-page consistency slice identifies
  `/features/jupyter-notebook` as the worst remaining outlier: 31 inline
  `style={{}}` blocks, three route-owned mock/final-panel patterns, and zero
  shared feature-page primitives.
- The accepted terminal rework (`0126856906`) established the model: a
  text-first hero with compact `ContextList`, shared `StoryCard` proof cards,
  lower route-specific evidence, and a shared `FeatureFinalBand`.
- The frozen Brief says notebooks should prove durable project continuity,
  reviewability, and collaboration rather than read as an isolated notebook
  inventory.

Current route frame for `/features/jupyter-notebook`:

```md
Route: /features/jupyter-notebook
Visitor: researcher, engineer, instructor, or reviewer whose notebook depends
on files, packages, kernels, collaborators, and review history.
Visitor question: can Jupyter work stay attached to the shared project instead
of becoming an isolated notebook session?
One-sentence promise: CoCalc keeps Jupyter notebooks beside their data,
packages, live kernel state, collaborators, TimeTravel history, and related
project files.
Proof mechanism: kernels, data files, packages, collaborators, shared
kernel/live state, TimeTravel, terminal/Linux paths, and directed-graph
workflow proof.
Primary next step: create account / open projects.
Secondary next step: Jupyter guide, compatibility guide, AI/Linux/terminal/
teaching/product routes.
What this must not claim: no benchmarks, setup/restore timing, migration
guarantees, managed compute, compliance, vertical-specific proof, or broad
agent-platform claim.
Evidence consulted: feature-page consistency slice, frozen Brief, framing
system/register, current Jupyter page source/tests, browser-QA markers, and
terminal/language-page implementation patterns.
Decision: redesign the route structure and final band around shared primitives
while preserving the concrete Jupyter proof.
```

Current disposition:

- `/features/jupyter-notebook` now follows the accepted terminal/language-page
  model: text-first hero, compact `ContextList`, shared `StoryCard` proof
  cards, lower route-specific notebook evidence, project-scoped Jupyter command
  proof, and shared `FeatureFinalBand`.
- Inline `style={{}}` blocks in the page dropped from 31 to 9.
- Preserved Jupyter proof: kernels, data files, packages, collaborators,
  shared live state, TimeTravel, project-scoped notebook commands, and the
  directed-graph workflow pointer through whiteboards.

### FS-009 - Consolidate the Linux feature page onto shared primitives

Status: `done`

Evidence:

- The curated feature-page consistency slice names `/features/linux` as the
  next zero-shared-primitive feature page after Jupyter.
- Source inspection shows route-owned Linux workspace/layers/code/final-panel
  patterns where terminal/Jupyter now use shared `ContextList`, `StoryCard`,
  and `FeatureFinalBand` structure.

Current route frame for `/features/linux`:

```md
Route: /features/linux
Visitor: researcher, engineer, instructor, or lab/team lead who needs Linux
tools beside notebooks, files, services, and review history.
Visitor question: can I administer the Linux environment for this project
without losing reproducibility or asking every teammate to rebuild it by hand?
One-sentence promise: CoCalc gives each project an Ubuntu environment that can
install packages, run services, preserve setup context, and return to a
known-good state.
Proof mechanism: Ubuntu environment, sudo/apt, language packages, services,
terminal commands, snapshots/known-good state, reusable environment images, and
related Terminal/Jupyter paths.
Primary next step: create account / open projects.
Secondary next step: software install guide, environment image guide,
Terminal/Jupyter/product routes.
What this must not claim: no setup-time, performance, managed compute,
compliance, migration, root-filesystem jargon, or agent-runs-without-user-
approval claim.
Evidence consulted: feature-page consistency slice, frozen Brief, framing
system/register, current Linux page source/tests, browser-QA markers, and
terminal/Jupyter implementation patterns.
Decision: redesign the route structure and final band around shared primitives
while preserving concrete Linux proof.
```

Current disposition:

- `/features/linux` now follows the terminal/Jupyter shared-primitive model:
  text-first hero, compact `ContextList`, shared `StoryCard` proof cards, a
  lower Ubuntu/apt evidence panel, shared `CodeBlock` command proof, reusable-
  environment `ContextList`, and shared `FeatureFinalBand`.
- Inline `style={{}}` blocks in the page are now 12.
- Preserved Linux proof: Ubuntu environment, sudo/apt installs, system and
  language package layers, services, snapshots/known-good state, reusable
  environment images, and the "You decide what runs" boundary.

### FS-010 - Consolidate the LaTeX feature page onto shared primitives

Status: `done`

Evidence:

- The curated feature-page consistency slice names `/features/latex-editor` as
  the remaining hand-rolled feature page after Jupyter and Linux.
- Source inspection shows route-owned mock/context/computation/final-section
  patterns and zero shared feature-detail primitives, while the fit-decision
  table is a grounded section that must remain.

Current route frame for `/features/latex-editor`:

```md
Route: /features/latex-editor
Visitor: researcher, author, collaborator, or reviewer whose LaTeX paper
depends on code, figures, build logs, coauthors, and history.
Visitor question: can the paper stay connected to its source, generated
evidence, collaborators, and review context?
One-sentence promise: CoCalc keeps LaTeX source, PDF builds, coauthors,
TimeTravel, SageTeX/computation, and related project files together in one
reviewable project.
Proof mechanism: source/PDF/builds, real-time coauthors with visible cursors,
TimeTravel, SageTeX/computation, fit-decision table, and related
Jupyter/terminal/AI paths.
Primary next step: create account / open projects.
Secondary next step: LaTeX guide, paper-polishing workflow, related
feature/product routes.
What this must not claim: no competitor superiority, compliance/trust claims,
paper-quality guarantee, invented build metrics, or AI-as-author claim.
Evidence consulted: feature-page consistency slice, frozen Brief, framing
system/register, current LaTeX page source/tests, browser-QA markers, and
terminal/Jupyter/Linux implementation patterns.
Decision: redesign the route structure and final band around shared primitives
while preserving the fit-decision table and concrete LaTeX proof.
```

Current disposition:

- `/features/latex-editor` now follows the terminal/Jupyter/Linux shared-
  primitive model: text-first hero, compact `ContextList`, shared `StoryCard`
  proof cards, lower source/PDF/build-log evidence panel, computation-loop
  `ContextList`, preserved fit-decision table, and shared `FeatureFinalBand`.
- Inline `style={{}}` blocks in the page are now 5.
- Preserved LaTeX proof: source/PDF output, build logs, real-time coauthors
  with visible cursors, TimeTravel, SageTeX/computed figures, related
  Jupyter/terminal/AI paths, and the fit-decision table's caption/aria
  contract.

### FS-011 - Add Tier-1 feature-page consistency guardrails

Status: `done`

Evidence:

- After the Jupyter, Linux, and LaTeX consolidations, the feature suite needed
  a CI tripwire for shared primitives, local inline-style sprawl, and raw token
  drift.
- Source inspection showed a mixed feature-page fleet: the terminal/language
  standard plus Jupyter/Linux/LaTeX now use shared primitives, while several
  older custom surfaces still need explicit legacy budgets or allowlists until
  future slices convert them.

Current disposition:

- `public/features/__tests__/app.test.tsx` now locks the shared feature-detail
  cohort to render `FeatureFinalBand` and at least one `ContextList`.
- New tracked feature pages cannot ship with zero shared card primitives unless
  they are added to the explicit custom-page allowlist.
- Feature route files now have a default inline-style budget of 15
  `style={{}}` blocks, with named legacy ceilings for pages still above that
  threshold.
- Raw feature-page hex literals must be listed in a per-file allowlist, and raw
  px font-size literals are banned.
- The existing compare-page table row font size now references
  `PUBLIC_TYPE.body` instead of a raw `16px` literal.

### FS-012 - Balance shared feature final-band columns

Status: `done`

Evidence:

- The design-polish slice identified a systemic two-column balance issue:
  short CTA cards in the final "When X belongs" band sat top-aligned beside
  taller bullet/proof columns, leaving a dead gap below the right card.
- `FeatureFinalBand` owned that repeated row for language, runtime, notebook,
  paper, board/deck, and workflow pages, so the fix belonged in the shared
  component rather than per route.

Current disposition:

- `FeatureFinalBand` now uses `Row align="middle"` so the right CTA panel is
  vertically centered against the left proof column.
- The feature suite now renders every route that uses `FeatureFinalBand` and
  asserts the final-band row is middle-aligned, not top-aligned.
- Representative browser QA/screenshots covered `/features/julia`,
  `/features/r-statistical-software`, `/features/whiteboard`, and
  `/features/automations` on desktop and mobile.

### FS-013 - Standardize the Python hero right column

Status: `done`

Evidence:

- The design-polish slice called out Python as over-stacked: its hero right
  column combined a project card, dark terminal mock, and Codex context card.
- R was listed in the same polish item, but current source/render already
  follows the target pattern: one R project card plus a nearby `Project
  context` checklist.

Current disposition:

- `/features/python` now keeps the hero right column to one compact project
  card.
- The removed hero proof was preserved in standard composition: terminal and
  package proof remain in the project card/context checklist and package-heavy
  use-case card; notebook/script/paper/review proof remain in the workflow band.
- Python now uses shared `ContextList` and is included in the shared-primitive
  guardrail.
- Python's inline-style budget was tightened from 31 to 20.
- Representative browser QA/screenshots covered `/features/python` and
  `/features/r-statistical-software` on desktop and mobile.

### FS-014 - Polish the slides feature-card residuals

Status: `done`

Evidence:

- Design-polish item 15 called out `/features/slides`: the hero mock's
  cream/yellow code boxes clashed with the shared light system, and the
  bespoke 2x2 illustration needed to move toward the shared card treatment.

Current disposition:

- The slides hero mock now uses existing public color tokens for its gradient
  instead of raw white/blue/cream literals.
- Slide thumbnails now use compact icon cards with `IconBadge`, matching the
  surrounding feature mock pattern instead of nested cream/yellow boxes.
- The deck-flow cards now use `PUBLIC_COLORS.surfaceMuted` instead of a raw
  blue literal.
- The slides raw-hex allowlist now contains only the remaining route accent.
- Representative browser QA/screenshots covered `/features/slides` on desktop
  and mobile.

### FS-015 - Polish the whiteboard feature-card residuals

Status: `done`

Evidence:

- Design-polish item 15 called out `/features/whiteboard`: the hero mock still
  used a bespoke nested canvas illustration, and the directed graph proof panel
  needed to move toward the shared card treatment without losing board/code/
  output/math proof.

Current disposition:

- The whiteboard hero mock now uses compact tokenized icon cards for markdown
  notes, LaTeX math, Jupyter cells, and a connected page instead of a custom
  nested canvas drawing.
- The hero gradient and directed-graph proof cards now use existing
  `PUBLIC_COLORS`/`PUBLIC_ELEVATION` tokens.
- Directed-graph spacing was tightened so the proof stays readable on mobile.
- Whiteboard no longer needs a legacy inline-style budget, and its raw-hex
  allowlist is tightened to route accents only.
- Representative browser QA/screenshots covered `/features/whiteboard` on
  desktop and mobile.

### FS-016 - Refine the Octave hero hierarchy

Status: `done`

Evidence:

- Design-polish item 15 called out `/features/octave`: the hero headline and
  first proof-section heading rendered too close in size/weight, especially on
  mobile, reducing the hero's dominance.

Current disposition:

- The visible Octave hero remains the route's `h2`, preserving the detail-page
  heading model.
- The first Octave proof-section title remains an `h3` but now uses the
  existing `PUBLIC_TYPE.subhead` scale so it no longer competes with the hero.
- A focused test canary asserts the hero/proof heading relationship and the
  tokenized section-heading size.
- Representative browser QA/screenshots covered `/features/octave` on desktop
  and mobile.

## Next Recommended Burn-Down Order

1. Finish FS-001 because it is already in progress and fixes a visible
   inconsistency on `/features`.
2. Run FS-005 immediately after, because it is the same failure mode.
3. Apply FS-004 to each subsequent route edit.
4. Keep FS-002, FS-003, and FS-006 as watch rules unless user feedback reopens
   them.
