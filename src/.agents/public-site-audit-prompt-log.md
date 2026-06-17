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
- Every prompt should preserve the current product framing unless it explicitly
  says otherwise: AI-native technical workspace, five product paths, teaching as
  a secondary workflow, feature pages as workflow spokes, and proof claims gated
  by the pitch evidence docs.
- Ask future agents to state the route's buyer/visitor question before editing
  and to update the relevant `PSL-*` ledger item as sub-actions close.

## Prompt Backlog

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
