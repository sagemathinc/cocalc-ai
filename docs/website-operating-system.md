# CoCalc.ai Website — Operating System

> How we build the public site and keep the pitch honest, without relapsing into the
> 242-commit churn. One contract (the frozen Brief), two cadences, human-gated. Created
> 2026-06-17. Keep this short.

## The one rule
Every round advances a **Brief** proof-point or a ranked **punch-list** item, with
**evidence** (a screenshot observation, a buyer quote, a failed canary, an analytics drop).
A change that only *tidies* and moves no Brief metric is dropped automatically. The agent
never self-authorizes a broad round; the human selects or approves the item.

## Two cadences

### Fast inner loop — the default round (~80% of work, SOLO)
The main agent runs the `public-site-landing-page` skill **solo** (no fan-out) on **one
section/route**:

`SELECT (human picks item + hypothesis) → FRAME (agent: state visitor question, classify
route, budget = one section, pick one action per component) → EDIT+VERIFY (one diff; C1
canary + lint/typecheck) → REBUILD+SNAPSHOT (the hook) → REVIEW (human opens the contact
sheet, calls ship/revise/revert — the load-bearing gate) → RECORD (commit, tick the item)`

Multi-agent **Workflow is the exception**, reserved for: subjective visual judgment
(`/site-judge`), adversarial pitch-challenge (`/pitch-challenge`), or burning down a finite
enumerated queue. Reaching for a workflow on a single-section edit *is* the churn pattern.

### Slow outer loop — keep the pitch honest (event- or month-triggered, READ-ONLY)
`/pitch-challenge` adversarially red-teams pitch claims against captured buyer signals.
Only this loop, only on a REVISE/RETIRE verdict, and only with Blaec's sign-off, may amend
the Brief. It never edits public copy directly.

## The rebuild + visual guarantee (the hook)
`src/packages/frontend/scripts/public-site-turn-snapshot.sh` runs from a Claude Code **Stop
hook** every turn: speed-guards on a public-source git-diff (zero cost otherwise), waits for
a fresh dist, captures home + touched routes at desktop+mobile, and publishes
`.preview-snapshots/index.html` (a contact sheet with a green/RED canary banner) + a one-row
`log.md`. Non-blocking; the **only** blocking case is a failed CTA/overflow/leaked-phrase
canary (once, loop-guarded). This makes "rebuilt every turn, preview captured" a property of
the harness, not agent memory. *(Wiring the hook is a per-environment opt-in — see Status.)*

## Named command library (`.claude/commands/`)
- **/site-audit** — refresh the finite ranked punch-list against the Brief (ONE delegated
  subagent returns a ranked list; screenshots/files stay out of the driver's context).
- **/site-round `<route>`** — the default solo round (above). The change-budget + gates are
  baked in so the standard is identical every session.
- **/site-verify `<route>`** — on-demand deterministic check (C1 canaries + lint/typecheck +
  scoped browser-QA).
- **/site-judge `<route>`** — judge panel: researcher-reader, exec-buyer, and visual-density
  critic score the route against the Brief and each must name what to **remove**.
- **/pitch-challenge** — adversarial-verify (via the deep-research skill) over the signals log.

## Keeping the pitch a living artifact
- **`docs/pitch/signals.md`** — every entry tagged by provenance: `ASSUMPTION` (internal
  belief) vs `EXTERNAL` (a real customer/prospect/use-case observation). Seed by mining our
  history (mostly `ASSUMPTION`); append `EXTERNAL` as real interactions happen.
- `/pitch-challenge` asks: which `ASSUMPTION`s are still unvalidated, and does accumulating
  `EXTERNAL` signal confirm or contradict the Brief? Unvalidated assumptions are flagged as
  risks, not treated as truth — this keeps the red-team adversarial, not circular.
- Scheduled cloud agents (if used) are **read-only**: they open tasks / post a digest, never
  edit the site.

## Anti-churn guardrails (why this can't relapse)
- Frozen Brief; only the human-gated slow loop changes it.
- Change budget = one section/route; no co-editing one surface across agents.
- Evidence gate drops tidy-only rounds automatically.
- Loops draw ONLY from the finite punch-list; the only stop-predicate is "items remaining = 0."
- No autonomous open-ended runs; one human turn = one round.
- Critics must propose **subtraction**, not just additions.
- Per-round detail lives in commit messages — the 1,300-line cohesion-audit is **retired**.

## Durable artifacts
- `docs/landing-page-brief.md` — FROZEN north star.
- `docs/landing-page-issues-and-plans.md` — the finite ranked punch-list (the queue).
- `docs/landing-page-design-system.md` — D1 direction (Tier A / Tier B).
- `docs/landing-page-decisions.md` — append-only log of Brief/pitch/design decisions.
- `docs/pitch/signals.md` — provenance-tagged buyer signal.
- `.agents/skills/public-site-landing-page/SKILL.md` — the operating standard agents inherit.
- `public-site-turn-snapshot.sh` + the Stop hook — the per-turn guarantee.

## Status / next actions
1. **Hook wiring** — script built & verified; needs Blaec's OK to install the Stop hook
   (it modifies agent config). Options in the chat.
2. **Encode the queue + write the 5 commands** under `.claude/commands/`.
3. **Seed `signals.md`** (mine history, provenance-tagged) + create `decisions.md`; update
   `SKILL.md` to encode the hook contract, command library, and subtraction rule.
4. Then run the first real `/site-round` (top Tier-1 item: `features/api-page.tsx`).
