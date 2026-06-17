# Public Site Audit Prompt Log

Agent-facing reference for reusable public-site audit prompts.

Keep this file concise. Store only prompts that are safe to reuse across agent
turns. Do not paste raw chat transcripts, competitor research, screenshots,
terminal logs, compliance interpretation, or unapproved public copy here.

Public-facing decisions and task checklists belong in
`docs/public-site-cohesion-audit.md`. This file is for continuity between audit
turns.

## Operating Standard

- Add one recommended next prompt before finishing any public-site audit pass.
- Add or update a `PSL-YYYY-MM-DD-NNN` ledger item in
  `docs/public-site-cohesion-audit.md` before editing public-site source.
- Reference ledger IDs in final reports and follow-up prompts so future agents
  can find the exact rationale, changed files, validation state, and open
  follow-up.
- Keep prompts scoped enough that the next agent can execute them without
  rediscovering the whole site.
- Include logging, validation, browser QA, rebuild, commit, and residual-risk
  reporting when source changes are expected.
- Keep legal/compliance document substance out of prompts unless the user
  explicitly puts that work in scope.
- Keep scratch QA artifacts outside the repository.
- Use `docs/public-site-cohesion-audit.md#agentic-public-site-operating-model`
  as the default workflow for CoCalc.ai public-site work.
- Use `.agents/skills/public-site-landing-page/SKILL.md` and
  `src/.agents/landing-page-agent-operating-audit.md` for public-site passes
  instead of relying on increasingly long prompts.
- Every prompt should preserve the current product framing unless it explicitly
  says otherwise: AI-native technical workspace, five product paths, teaching as
  a secondary workflow, feature pages as workflow spokes, and proof claims gated
  by the pitch evidence docs.
- Ask future agents to state the route's buyer/visitor question before editing
  and to update the relevant `PSL-*` ledger item as sub-actions close.
- Use the check split in
  `docs/public-site-cohesion-audit.md#agentic-public-site-check-matrix`:
  automate deterministic route/copy/CTA/process regressions, browser-QA visual
  rhythm and rendered layout, and escalate product positioning, proof posture,
  and commercial hierarchy for human judgment.
- Do not treat browser screenshots, terminal transcripts, raw prompt logs, or
  competitor/compliance research as commit-ready artifacts. Commit only source,
  tests, and intentional docs.

## Prompt Backlog

### Dogfood Landing Page Agent Workflow

Use `.agents/skills/public-site-landing-page/SKILL.md` and continue from
`PSL-2026-06-17-011`, `KI-2026-06-17-F`, and
`src/.agents/landing-page-agent-operating-audit.md`. Run one deliberately small
public-site pass that proves the improved operating loop works: choose exactly
one active known issue, state the visitor question and change budget before
editing, log findings first, make only high-confidence source/test changes if
needed, run focused validation, and update the `LPA-*`, `KI-*`, and `PSL-*`
status fields before final handoff. Keep scratch artifacts under
`/tmp/cocalc-public-qa-*`, commit completed work, and report residual risks plus
the next recommended prompt.

### Language/Math Feature Ending Density Review

Continue from `PSL-2026-06-17-010` and `KI-2026-06-17-B`. Audit the
bottom-of-page route-owned endings for `/features/python`, `/features/sage`,
`/features/r-statistical-software`, `/features/julia`, and `/features/octave`
after the secondary context panels were compressed. Use the rebuilt
`feature-details` browser-QA screenshots as the starting evidence. Decide
whether each final "when it belongs" section and dark start card answers a
distinct visitor question, or whether the ending should be shortened or
combined without losing high-intent language-route value. Log findings first in
`docs/public-site-cohesion-audit.md`, make only high-confidence copy/layout/test
changes, keep artifacts under `/tmp/cocalc-public-qa-*`, rebuild
`blaec.cocalc.ai` if public source changes, commit, and report residual risks
plus the next recommended prompt.

### Remaining Feature Detail Visual Evidence Review

Continue from `PSL-2026-06-17-009` and audit the remaining feature-detail pages
whose visual examples may still be too heavy or not clearly necessary:
`/features/whiteboard`, `/features/slides`, `/features/python`,
`/features/sage`, `/features/r-statistical-software`, `/features/julia`, and
`/features/octave`. Run the reusable browser QA script against `feature-details`
on the rebuilt `blaec.cocalc.ai` preview, inspect desktop/tablet/mobile
screenshots, and decide whether each visual example answers a distinct visitor
question. Log findings first in `docs/public-site-cohesion-audit.md`, make only
high-confidence layout/copy/test changes, avoid flattening route-specific
evidence just for uniformity, keep artifacts under `/tmp/cocalc-public-qa-*`,
rebuild if public source changes, commit, and report residual risks plus the
next recommended prompt.

### Feature Detail And Guides Visual Triage

Run the reusable public-site browser QA script against `feature-details` and
`guides` on the rebuilt `blaec.cocalc.ai` preview, then manually inspect the
desktop/tablet/mobile screenshots for the pages that still look visually heavy,
starting with `/features/latex-editor`, `/guides`, `/features/whiteboard`,
`/features/slides`, and the language/math feature pages. Create or update a
`PSL-*` ledger item in `docs/public-site-cohesion-audit.md` before editing.
Use the agentic public-site check matrix to separate deterministic regressions
from human design judgment. Make only high-confidence layout/copy/test changes,
keep artifacts under `/tmp/cocalc-public-qa-*`, rebuild `blaec.cocalc.ai` if
public source changes, commit, and report residual risks plus the next
recommended prompt.

### Browser QA Route Registry Hardening

Run the reusable public-site browser QA script against `feature-core`, `guides`,
`conversion-spine`, and `product-details` on the rebuilt `blaec.cocalc.ai`
preview, then audit whether the route groups and assertions should be adjusted.
Use `PSL-2026-06-17-008` and the agentic public-site check matrix as the
operating standard. Keep screenshots and JSON under `/tmp/cocalc-public-qa-*`,
log findings first in `docs/public-site-cohesion-audit.md`, make only
high-confidence script/docs/test changes, avoid broadening the script into
subjective design approval, run validation, commit, and report residual risks
plus the next recommended prompt.

### Reusable Browser QA Harness

Convert the successful throwaway headless-Chrome public-site QA harness into a
small reusable script for future public-site passes. Use `PSL-2026-06-17-007`
and `docs/public-site-cohesion-audit.md#agentic-public-site-check-matrix` as the
operating standard. The script should accept route groups, write screenshots and
assertion JSON only under `/tmp/cocalc-public-qa-*`, check horizontal overflow,
expected section order, stale text, route-specific hrefs, and selected visual
classes, and never commit generated artifacts. Add focused tests or docs only
where the rules are durable, run validation, commit, and report residual risks
plus the next recommended prompt.

### Guides And Feature QA Completion

Complete `PSL-2026-06-17-001` through `PSL-2026-06-17-006` after the Guides,
feature-index, and AI-page visual cleanup. Use
`docs/public-site-cohesion-audit.md` and the agentic public-site operating model
as source of truth. Run focused public app and feature tests, lint/typecheck,
static rebuild, and desktop/tablet/mobile browser QA for `/features`,
`/features/ai`, and `/guides`. Update validation states and residual risks in
the ledger, keep scratch QA artifacts outside the repo, commit source/tests/docs
only, and report the commit hash plus the next recommended prompt.

### Agentic Public-Site Workflow Hardening

Audit the public-site agent workflow itself after the current feature/guides
pass is committed. Use `PSL-2026-06-17-006` as the operating standard and
identify which checks should become automated tests, which should remain manual
browser QA, and which require human product judgment. Focus on preserving pitch
framing, avoiding unapproved proof claims, preventing visual-density regressions,
and keeping prompts/reference logs useful without committing raw chat or scratch
artifacts. Log findings first, make only high-confidence docs/test/process
changes, run relevant validation, commit, and report residual risks plus the
next recommended prompt.

### Feature Index Visual QA

Run a visual browser QA pass on `/features` after the feature-index rhythm pass.
Verify desktop, tablet, and mobile screenshots against the intended hierarchy:
AI first, notebooks/writing second, runtime before teaching, teaching secondary,
and languages visible without feeling crammed. Focus only on visual density,
wrapping, spacing, and whether any remaining card treatment should be
simplified. Log findings in `docs/public-site-cohesion-audit.md`, make only
high-confidence layout changes, run focused validation, rebuild, commit, and
report residual risks plus the next recommended prompt.
