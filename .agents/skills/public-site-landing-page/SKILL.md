---
name: public-site-landing-page
description: Use when asked to audit, redesign, QA, or improve CoCalc.ai public-site landing pages, feature pages, product pages, guides, public copy, CTA routes, or reusable public-site agent workflow.
---

# Public Site Landing Page Agent

Use this skill for CoCalc.ai public-site work tested at `blaec.cocalc.ai`.

## Required Sources

Before editing public-site source, read:

1. `AGENTS.md`
2. `docs/public-site-cohesion-audit.md`
3. `src/.agents/public-site-audit-prompt-log.md`
4. `src/.agents/landing-page-agent-operating-audit.md`
5. the route source and any route-specific tests

Use pitch docs as private grounding only. Do not paste pitch, competitor,
compliance, or internal planning language into public React routes unless the
user approves that exact public wording.

## Operating Loop

1. Check `git status --short` and the latest commit.
2. Identify the active `PSL-*` ledger entry and any `KI-*` issue being closed.
3. State the page's primary visitor question before editing.
4. Classify the route: homepage, feature index, feature detail, product
   decision, pricing/compare, support/contact, guides/docs bridge, or
   trust/policy destination.
5. Set a small change budget. If the task spans many routes, split it into
   inspect-first and edit-second phases.
6. For each candidate component, choose one action: keep, omit, combine, move
   lower, move to disclosure/modal, or redesign.
7. Log findings in `docs/public-site-cohesion-audit.md` before source edits.
8. Make only high-confidence source/test changes.
9. Run focused tests, lint/typecheck when relevant, rebuild if public source
   changed, and run `src/packages/frontend/scripts/public-site-browser-qa.mjs`
   for the affected route group.
10. Store browser QA artifacts only under `/tmp/cocalc-public-qa-*`.
11. Update the ledger and `src/.agents/public-site-audit-prompt-log.md` before
    final response.
12. Commit completed work unless the user asked not to or the change is still
    exploratory.

## Decision Rules

- Workflow value comes before product operating model on feature pages.
- Product pages should answer one buyer question and end with one route-owned
  next step.
- Cards are for scannable choices or distinct evidence, not every fact.
- A visual earns space only when it answers a visitor question better than text.
- Do not flatten route-specific evidence just to make pages uniform.
- Teaching is a secondary workflow destination, not a top-level product path.
- Preserve the five product paths and the Star/Launchpad/Rocket boundaries.
- Keep tests deterministic; leave visual taste and product hierarchy to human
  review backed by screenshots and ledger notes.

## Done Condition

A public-site pass is not done until the ledger lists:

- what changed,
- what was deliberately left alone,
- validation results,
- browser QA artifact path when applicable,
- residual risks,
- commit hash,
- next recommended prompt stored in the prompt log.
