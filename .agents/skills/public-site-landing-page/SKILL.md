---
name: public-site-landing-page
description: Use when asked to audit, redesign, QA, or improve CoCalc.ai public-site landing pages, feature pages, product pages, guides, public copy, CTA routes, or reusable public-site agent workflow.
---

# Public Site Landing Page Agent

Use this skill for CoCalc.ai public-site work tested at `blaec.cocalc.ai`.

## Operating System (read first)

This skill runs inside the system in `docs/website-operating-system.md`. Core rules:

- **Solo by default.** One agent, one section/route, one change per round. Multi-agent
  Workflow only for `/site-judge`, `/pitch-challenge`, or a finite enumerated queue.
- **Evidence gate.** Every round advances a Brief proof-point or a punch-list item with
  evidence. Tidy-only edits that move no Brief metric are dropped.
- **Subtraction bias.** Prefer removing/combining over adding; critics must name what to cut.
- **Human visual gate.** The Stop hook rebuilds + publishes `.preview-snapshots/index.html`
  every turn; the human calls ship/revise/revert. Green tests are a floor, not design taste.
- Use the `/site-round`, `/site-audit`, `/site-verify`, `/site-judge`, `/pitch-challenge`
  commands so the standard is identical every session.

## Required Sources

Before editing public-site source, read:

1. `AGENTS.md`
2. `src/.agents/multi-agent-github-operating-model.md` when multiple branches,
   worktrees, or agent threads are active
3. `docs/landing-page-brief.md` (FROZEN contract) + `docs/landing-page-issues-and-plans.md`
   (the finite queue)
4. `docs/landing-page-design-system.md` (visual tokens) and `docs/landing-page-decisions.md`
5. the route source and any route-specific tests

`docs/public-site-cohesion-audit.md` is RETIRED — do not append to it.

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
7. State the one hypothesis + its evidence before editing (the evidence gate). Do NOT log to
   the retired cohesion audit.
8. Make only high-confidence source/test changes.
9. Run focused tests, lint/typecheck when relevant, refresh the preview (see
   **Preview Loop** below), and run
   `src/packages/frontend/scripts/public-site-browser-qa.mjs` for the affected
   route group.
10. Store browser QA artifacts only under `/tmp/cocalc-public-qa-*`.
11. Append any durable decision to `docs/landing-page-decisions.md` and mark the punch-list
    item done; per-round mechanical detail belongs in the commit message.
12. Commit completed work unless the user asked not to or the change is still
    exploratory.

## Preview Loop

The preview at `blaec.cocalc.ai` is served by the running hub from
`src/packages/static/dist`. It only reflects source changes after that bundle is
rebuilt. Do not report a public-site change as done without a refreshed preview.

- **Preview ownership:** `blaec.cocalc.ai` is the public-site preview. It must
  be served from the active public-site synthesis worktree/branch, not a
  platform-UI or historical landing worktree. Before a public-site pass, verify
  with `git worktree list` and a hub process cwd check such as
  `readlink /proc/<hub-pid>/cwd`. If the hub is rooted in the wrong checkout,
  stop that hub and restart from the synthesis worktree.
- Keep local preview secrets and tunnel/data plumbing in `.local` or `data/`;
  never commit them. If the landing worktree needs the existing preview data,
  configure that only in `.local/hub-daemon.env`.
- **Keep a watch running** so every save auto-rebuilds the bundle. Once per
  session, confirm it is up; if not, start it:
  `pnpm static:watch` (from `src/`), logging to `/tmp/cocalc-static-watch.log`.
- After editing public source, wait for `Rspack compiled successfully` in that
  log, then verify the change at `blaec.cocalc.ai` before finishing.
- **Fallback** (no watch running): one-shot rebuild with `pnpm static:dev`
  (from `src/`).
- The watch runs `clean-webpack-plugin` on (re)start, briefly clearing `dist`;
  let the first build finish before testing the preview.

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
