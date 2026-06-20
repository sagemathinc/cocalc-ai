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

Status: `in_progress`

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

## Next Recommended Burn-Down Order

1. Finish FS-001 because it is already in progress and fixes a visible
   inconsistency on `/features`.
2. Run FS-005 immediately after, because it is the same failure mode.
3. Apply FS-004 to each subsequent route edit.
4. Keep FS-002, FS-003, and FS-006 as watch rules unless user feedback reopens
   them.
