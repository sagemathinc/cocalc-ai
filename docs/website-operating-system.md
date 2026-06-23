# CoCalc.ai Website — Operating System

> How we build the public site and keep the pitch honest, without relapsing into the
> 242-commit churn. One contract (the frozen Brief), two cadences, human-gated. Created
> 2026-06-17. Keep this short.

## The one rule

Every implementation round advances the **live queue**:
`cocalc-shared/codex-queue.md`. Claude curates rows from grounded audits and drift sweeps;
Codex implements only the top unchecked row; Blaec arbitrates batch decisions, protected
overrides, and ambiguous product calls. A change that only _tidies_ and moves no Brief
metric is dropped before it becomes a queue row.

## Two cadences

### Fast inner loop — autonomous queue contract

Codex runs the queue contract in `/home/user/cocalc-ai-synthesis` on
`blaec-synthesis-2026-06-18`: one queue row, one bounded commit, no raw-audit foraging.

`QUEUE (Claude/Blaec curates the top row) → IMPLEMENT (one bounded diff) → VALIDATE (focused
Jest, protected-surface gate, tsc, lint, static build, route browser-QA) → LAND (commit +
push) → RECORD (flip the row to [~], log SHA + validation) → AUDIT (Claude accepts or files
the next row)`

The queue is the anti-churn boundary. Codex stops only when the queue is empty or the next
row needs a protected-surface `OVERRIDE:` it does not have. Claude audits every landed
commit; Blaec arbitrates asynchronously at batch boundaries and for overrides.

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
the harness, not agent memory. _(Wiring the hook is a per-environment opt-in — see Status.)_

## Named command library (`.claude/commands/`)

- **/site-audit** — refresh the finite ranked punch-list against the Brief (ONE delegated
  subagent returns a ranked list; screenshots/files stay out of the driver's context).
- **/site-round `<route>`** — non-queue exploratory round. The change-budget + gates are
  baked in so the standard is identical when Blaec explicitly asks outside the live queue.
- **/site-verify `<route>`** — on-demand deterministic check (C1 canaries + lint/typecheck +
  scoped browser-QA).
- **/site-judge `<route>`** — judge panel: researcher-reader, exec-buyer, and visual-density
  critic score the route against the Brief and each must name what to **remove**.
- **/pitch-challenge** — adversarial-verify (via the deep-research skill) over the signals log.

## Keeping the pitch a living artifact

- **`docs/pitch/signals.md`** — every entry tagged by provenance: `ASSUMPTION` (internal
  belief) vs `EXTERNAL` (a real customer/prospect/use-case observation). Seed by mining our
  history (mostly `ASSUMPTION`); append `EXTERNAL` as real interactions happen.
- **`docs/landing-page-framing-system.md`** — the per-route public-site framing discipline:
  route question, claim class, evidence consulted, and the action chosen before editing.
- **`docs/landing-page-framing-research-register.md`** — dated internal and official-source
  market evidence used for public-site framing. It records implications; it does not approve
  named-product comparison copy.
- **`src/.agents/public-site-*-workplan*.md`** — live burn-down plans for current researched
  queues. Update the relevant plan before and after execution so user feedback changes the
  system, not just the chat transcript.
- `/pitch-challenge` asks: which `ASSUMPTION`s are still unvalidated, and does accumulating
  `EXTERNAL` signal confirm or contradict the Brief? Unvalidated assumptions are flagged as
  risks, not treated as truth — this keeps the red-team adversarial, not circular.
- Scheduled cloud agents (if used) are **read-only**: they open tasks / post a digest, never
  edit the site.

## Anti-churn guardrails (why this can't relapse)

- Frozen Brief; only the human-gated slow loop changes it.
- The live queue is the only Codex work source; no raw-audit foraging.
- One queue row = one bounded commit; Claude audits each landed commit.
- The protected-surface gate hard-stops `home/` and `theme.ts` without a committed override.
- Pricing money, plan-tier, and compliance content stays content-gated for human audit.
- Autonomous runs are bounded by the queue: continue until empty, blocked, or missing an
  `OVERRIDE:`.
- Critics must propose **subtraction**, not just additions.
- Per-round detail lives in commit messages — the 1,300-line cohesion-audit is **retired**.

## Durable artifacts

- `cocalc-shared/codex-queue.md` — live Codex queue and state.
- `cocalc-shared/codex-plan.md` — durable queue/validation/protected-surface contract.
- `cocalc-shared/INDEX.md` — shared-doc router.
- `docs/landing-page-brief.md` — FROZEN north star.
- `docs/landing-page-issues-and-plans.md` — legacy finite ranked punch-list.
- `docs/landing-page-design-system.md` — D1 direction (Tier A / Tier B).
- `docs/landing-page-decisions.md` — append-only log of Brief/pitch/design decisions.
- `docs/landing-page-framing-system.md` — route-level value framing and claim discipline.
- `docs/landing-page-framing-research-register.md` — dated internal/external framing evidence.
- `docs/pitch/signals.md` — provenance-tagged buyer signal.
- `src/.agents/public-site-*-workplan*.md` — finite live plans for researched work queues.
- `.agents/skills/public-site-landing-page/SKILL.md` — the operating standard agents inherit.
- `public-site-turn-snapshot.sh` + the Stop hook — the per-turn guarantee.

## Status / next actions

1. **Autonomous queue is live** — `cocalc-shared/codex-queue.md` is Codex's source of truth.
2. **Audit loop is live** — Claude audits each landed commit and files verified follow-up rows.
3. **Protected-surface gate is live** — `home/` and `theme.ts` require an override allowlist
   entry; pricing money/tier/compliance content remains human-audited.
4. **Named commands remain available** for explicit non-queue exploratory work and the slow
   `/pitch-challenge` loop.
