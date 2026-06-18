# CoCalc.ai Landing Page — Issues & Plans

> Single working tracker for fixing the landing-page effort. Created 2026-06-17.
> This doc deliberately **replaces** the sprawl (cohesion-audit changelog, scattered
> operating notes) as the place to look first. Keep it short. If it grows past ~2
> screens, something is being logged here that belongs in a commit message instead.

## Context — why this exists

242 commits (113 in one day) produced motion without progress. The landing page kept
getting *tweaked* but not *better*. Root cause, confirmed across the chat history, the
commit log, and the code: **the effort optimizes for process (small safe commits, copy
hygiene, test coverage) instead of outcomes (one promise, a buyer who converts, a page
that looks designed).** This tracker lists the distinct failure patterns and a concrete,
verifiable plan for each, in the order we should fix them.

The product framing we are committing to (from the chat + `docs/pitch/`):

- **One promise:** *Make computational work easier to share, review, and continue.*
- **Buyers / readers (in priority order):**
  1. End-user researchers & scientists — "which path fits my workflow?"
  2. Executive / platform decision-makers — "which operating model and pricing?"
- **Page job:** state the one promise, prove it (continuity / reviewability /
  deploy-anywhere), route to the right operating model, drive ONE primary action.

---

## Fix order (leverage, not difficulty)

1. **P2** — stop the runaway loop (prevents active harm, 5 min)
2. **P1** — write & freeze the one-page Brief (unblocks everything; needs you)
3. **P5** — fix the preview loop (so iteration is real again)
4. **D2 + D1** — re-architect the page & set a visual direction (the actual work)
5. **P3 + P4** — fix the operating instructions & doc structure (so it stays fixed)
6. **C1 + C2** — decouple tests & modularize (removes the per-change tax; parallelizable)

---

## PROCESS

### P1 — No single source of truth / "done" is undefined
- **Symptom:** Success defined 4+ ways across cohesion-audit, operating-audit, skill, and
  launch plan. An open TODO admits no conversion criteria exist.
- **Root cause:** The page never had a frozen north star, so every agent re-derived it.
- **Plan:** Write **`docs/landing-page-brief.md`** — ONE page, frozen: the one promise,
  the two buyers + their question, the page job, the proof spine, the ONE primary CTA, and
  a literal "Done means:" list. Every other doc references it; nothing contradicts it.
- **Done when:** the Brief exists, you've signed off on it, and it fits on one screen.
- **Status:** ✅ DONE — `docs/landing-page-brief.md` frozen (continuity promise) 2026-06-17.

### P2 — Autonomous scheduled loop with no human gate
- **Symptom:** "Scheduled run: Landing Page Iterations" fired ~89× on 2026-06-13, adding
  density while you asked for subtraction; multiple worker crashes; no steering.
- **Root cause:** A CoCalc scheduled-chat run executed an open-ended "iterate" prompt
  unattended.
- **Plan:** Disable the scheduled chat run named "Landing Page Iterations." Replace with
  **human-gated rounds**: each round = one hypothesis → one change → preview → your call.
  No open-ended autonomous iteration on the public site.
- **Done when:** no scheduled run is active; iteration only happens in attended rounds.
- **Status:** ◑ Dormant (last fired 2026-06-14 01:10, 110 runs). Manual step left for
  Blaec: delete the "Landing Page Iterations" scheduled run in the chat thread's UI so it
  can't resume.

### P3 — Agents optimize micro-tweaks, not strategic/visual moves
- **Symptom:** 136 edits to `home/app.tsx`; commit verbs are *tighten/quiet/clarify/
  lighten/reduce*. No structural decisions.
- **Root cause:** Instructions reward "high-confidence small reversible edits"; there is no
  permission or trigger for "delete this section" / "change the visual direction."
- **Plan:** Rewrite the operating instructions (skill + operating-audit) to (a) require a
  decision against the Brief before editing, (b) explicitly allow structural/visual moves
  at decision gates, and (c) add a **"stop tweaking" rule**: if a change only *tidies* and
  doesn't move a Brief metric, don't make it.
- **Done when:** the skill leads with the Brief and the stop-tweaking rule; next session's
  commits include structural decisions, not just copy hygiene.

### P4 — Strategy doc is an append-only changelog, not a spec
- **Symptom:** `public-site-cohesion-audit.md` is 1,324 lines, rewritten 45×, accreting
  PSL-* ledger entries; agents must read it all to learn the page has one promise.
- **Root cause:** The audit became the dumping ground for both the spec and every edit log.
- **Plan:** Split: (1) the frozen **Brief** (P1) is the spec; (2) a lean
  **`landing-page-decisions.md`** holds only durable design decisions (≤1 line each,
  append-only, e.g. "dark cards only for terminal/code mocks"); (3) archive the current
  cohesion audit to `docs/archive/` — stop writing to it.
- **Done when:** the audit is archived, decisions log exists, and per-turn change logs live
  in commit messages, not docs.

### P5 — Broken preview feedback loop
- **Symptom:** Commits weren't rebuilt; you couldn't see changes for hours ("preview must
  update at every turn!"); had to ask twice.
- **Root cause:** Source committed without rebuilding the static public bundle.
- **Plan:** Document the exact rebuild command in the skill and make "rebuild + confirm
  preview URL" a required step at the end of every round. (Identify the precise command —
  `pnpm -C src build:dev` / static rebuild — and pin it.)
- **Done when:** every round ends with a refreshed preview you can see, no reminder needed.
- **Status:** ✅ DONE — `pnpm static:watch` now runs (auto-rebuilds dist the hub serves);
  the Preview Loop is documented in the skill. Restart the watch if the session/box resets.

---

## CRAFT (makes iteration expensive)

### C1 — Tests pin exact copy → lockstep churn
- **Symptom:** `app.tsx` + `app.test.tsx` changed ~137× in tandem; tests assert exact
  headlines, section labels, and stale-text negative guards.
- **Root cause:** Behavioral tests written as copy snapshots.
- **Plan:** Migrate `home/__tests__/app.test.tsx` toward the **structural style already used
  in `visual-quality.test.tsx`** (grid templates, card counts, text-length bounds, link
  contracts). Drop exact-string assertions and stale-text guards; keep a few canary
  assertions for the one promise only.
- **Done when:** routine copy edits no longer require a test edit.
- **Status:** ✅ DONE — shared `public/__tests__/test-helpers.ts`; home/features/products
  tests + visual-quality decoupled (net −566/+334). Proven: full suite 227/227 green,
  breaking a CTA route fails a canary, rewording a headline stays green. Tier-2 copy work
  is now free of the test tax.

### C2 — Monolithic page + content baked into JSX
- **Symptom:** `home/app.tsx` is 1,092 lines; `IconBadge` duplicated across 15 feature
  pages; copy lives in JSX constants — no content model.
- **Root cause:** Layout, state, styling, and content are all in one file.
- **Plan:** Extract home sections into components (`Hero.tsx`, `AudienceRoutes.tsx`, …);
  externalize copy to a content module so words change without touching layout/tests; hoist
  shared `IconBadge`/mocks into `features/page-components.tsx`.
- **Done when:** a section can be added/removed/reworded by editing one small file.

---

## PRODUCT / DESIGN (the page itself)

### D1 — No visual design system / brand direction
- **Symptom:** Tokens exist, but "is this crowded?" is judged by eyeball every turn; design
  decisions live as prose in a ledger.
- **Root cause:** There is IA/copy guidance but no visual direction.
- **Plan:** Establish a one-page **visual direction**: type scale, spacing rhythm, color/
  tint usage rules, **card taxonomy** (when a card is dark vs light vs link vs panel),
  imagery standard (real product screenshots over text walls). Encode as design tokens +
  a `PublicSection` wrapper so rhythm is automatic, not hand-tuned per section.
- **Done when:** new sections inherit spacing/type/color without per-section tuning, and the
  dark-vs-light rule is enforced by a component, not a memo.

### D2 — Content architecture & cross-page coherence
- **Update (2026-06-17, Blaec):** the **home page is considered good** — minor language/
  framing tweaks only. The concern is **the rest of the site**: ~25 surfaces (15 feature
  pages, 5 product pages, pricing, compare, support, guides/docs bridge, policies, about).
- **Symptom (rest of site):** pages drifted in tone, density, and visual treatment from the
  home bar; heavy recent churn on individual feature/product pages without a shared standard.
- **Root cause:** no per-page job-to-be-done held against a common benchmark; each page
  evolved on its own.
- **Plan:** Treat the **home page + frozen Brief as the quality benchmark.** Run a finite,
  Brief-anchored audit of the rest of the site that, for each page, names (1) which buyer +
  question it serves, (2) its single next step, (3) its gap to the home bar — and produces a
  **ranked, finite punch-list** (not perpetual tweaking). Fix top-ranked pages first.
- **Done when:** every public page serves one buyer/question with one next step and reads as
  the same site as the home page; the punch-list is burned down, not reopened.

#### Site-wide audit punch-list (2026-06-17)

Audited all ~25 surfaces against the Brief + home benchmark. Strong as-is: **home, compare,
guides, policies** (use policies as the trust-page model). Findings, ranked:

**Tier 1 — highest leverage**
- `features/api-page.tsx`: ✅ **DONE** (approved by Blaec). Repositioned off infrastructure/
  institutional framing toward **research & engineering automation as a proof surface** (per
  the full-pitch read — NOT institutional/LMS, which doc 30 flags as the riskier lane). Hero
  leads with the benefit + the persistent-reviewable wedge; added a concrete HTTP-shape
  example; judge-panel-hardened; 75/75 tests. (First full round through the operating loop +
  the copy playbook.)
- `features/teaching-page.tsx`: ✅ **RESOLVED — no change.** Verified teaching is a *feature*
  page, not in any product-path list, so it already satisfies the Brief's "secondary workflow
  destination." The page quality is good; left intact.
- `features/r-statistical-software-page.tsx`: reads as generic "language + project," not
  differentiated from Python. Lead with reporting / RMarkdown-Quarto. (High, M)
- `features/julia-page.tsx`: its real differentiator (Pluto reactive notebooks) is buried in a
  list; front it in the hero. (High, M)
- `products/app.tsx`: ✅ **DONE.** Removed the arbitrary Star warning-tint and added a
  "Start here" tag to the CoCalc.ai card (hosted-first nudge, chooser stays neutral).

**Tier 2 — strong improvements**
- ✅ **Dead-end pages** — `PublicNextStep` now on About, News, Docs index, and Community.
  Remaining minor ones if wanted: About team-member, News detail, Docs not-found. (S each)
- ✅ `pricing/page.tsx`: opening reframed defensive → promise-first (keeps "operated by CoCalc").
- ✅ `features/linux-page.tsx`: continuity/recovery tie added to the body.
- Continuity reframes: ✅ `whiteboard-page`, ✅ `latex-editor-page` (line ~255 defensive→positive).
  `slides-page` SKIPPED — already ties to "the same project as the files and notebooks." `ai-page`
  held (entangled with the modal detour below).
- Modal detours ("See agent details") on `ai-page`, `jupyter-notebook-page` — HELD (inlining could
  add density; needs a careful pass, not a quick tweak). (Med, S)
- `python-page` Button→LinkButton / `sage-page` phrasing-echo / `octave-page` eyebrow — SKIPPED as
  low-altitude churn (forcing them is exactly the micro-tweak pattern we diagnosed).

**Tier 3 — consistency / tech-debt (fold into C2)**
- `IconBadge` redefined in ~6 feature pages; `TerminalMock` sprawl; one-off `CompactUseCard`;
  spacing scale varies page-to-page. Hoist shared bits to `features/page-components.tsx` /
  `feature-visuals.tsx`; define spacing tokens in `theme.ts`.
- Terminology drift "product path" vs "operating model" across products/pricing.

**Shipped this round (validated: 38/38 tests, 0 lint errors, preview auto-rebuilt):**
- New reusable `PublicNextStep` in `public/common.tsx` (mirrors home `PathSection`).
- Applied to `about/app.tsx` (overview) and `news/app.tsx` (list) so they route back into the
  funnel instead of dead-ending. Not committed — awaiting Blaec's review.

---

## How we'll know the whole thing worked

The page states one promise, looks intentionally designed (not assembled), routes the two
buyers to the right operating model, drives one primary action — and a single word can be
changed in under a minute without editing a test. The team can be proud to ship it.
