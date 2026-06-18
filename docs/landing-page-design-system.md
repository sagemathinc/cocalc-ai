# CoCalc.ai Public Site — Design System Direction (D1)

> Status: **DRAFT — awaiting sign-off.** Date 2026-06-17. Codify the latent system the
> home page already embodies into named tokens, then propagate it so "designed" is the
> default. **No rebrand** (Space Grotesk + PUBLIC_COLORS unchanged), incremental rollout.
> Hardened by adversarial critique — which corrected the original proposal's claim of
> "zero visual change." Read the Tier split before approving.

## The honest split (the critique's key correction)

The work divides into two tiers. They carry very different risk and need different gates.

### Tier A — Safe normalization (home stays pixel-identical, low risk)
Removes the "assembled, not designed" tells without changing how anything looks:
- **One elevation ink.** ~13 ad-hoc `box-shadow` strings across **two** inks (feature pages
  use slate `rgba(33,49,57)`, home uses `alpha(brandDark #0E2B59)`). → `PUBLIC_ELEVATION`
  `{sm,md,lg}` **derived from home's exact current values** (`0 12px 34px /.05`,
  `0 18px 44px /.07`, `0 10px 30px /.05`) so home is untouched and feature pages converge
  onto it. (Correction: do **not** invent `.06/.10/.12` / `0 24px 70px`.)
- **Radius tokens.** 8px panel radius is already canonical (~132 uses). `PUBLIC_RADIUS
  {panel:8, media:12, pill:999}`; snap the 7 strays (FeatureImage 14, CodeCommand 12,
  about 14/16, auth/sso 14, latex chip 12, terminal 10) deterministically.
- **De-duplicate primitives.** Hoist `IconBadge` (8 copies + home's `IconTile`), `alpha()`
  (4 copies), `PANEL_RADIUS` (5 consts) to single shared sources.
- **Dark-mock tokens.** `PUBLIC_DARK {terminalSurface #0b1522, codeSurface #10213f,
  barSurface #111827, +#0b1f47 (jupyter — currently unnamed)}`; rebuild
  `DARK_FEATURE_CARD_STYLE` from these tokens so the "panels stay light" guard tracks them.
- **Fix the real shell bug:** `PublicHero.subtitle` and `PublicSection.intro` currently fall
  to antd 14px. Scope a 16/18px lead fix to **body/lead typography only** — NOT a global
  `token.fontSize` change (that would restyle nav/footer/tags/mocks).

### Tier B — Deliberate, modest restyle (touches home, gate behind visual diffs)
Genuine visual changes — worth doing, but each must be visually signed off per page:
- **One spacing rhythm.** Section gaps drift 34/24/22/18. *Decision needed:* keep home's
  effective **34** as the section step, or move everything to **48** (more generous, but
  re-rhythms home). The 10/14/18/22 gap clusters (~115 sites) are **off** any clean 4/8/12/
  16/24 scale — either keep 10 & 14 as named steps (2nd/3rd most-used) or accept a
  visual-diffed snap, one file at a time. (Correction: this is **not** "zero churn.")
- **One type scale** (display / h2=30 / h3=24 / h4=20 / eyebrow=12 / bodyL=18 / body=16 /
  small=14 / label=13). Collapsing 17/18/19 lead → 18 is a *tiny* home edit; and a single
  `display` clamp would **enlarge** non-home hero titles (info pages are centered ~38 today)
  — keep info-page titles distinct unless you want them enlarged.
- **Accent unification = a recolor (acknowledged).** Today AI/Codex is orange on home but
  **purple `#7c3aed`** on jupyter; "blue" ranges over `#4474c0/#003eb3/#096dd9/#2f6fda`.
  `PUBLIC_ACCENTS {blue,green,ai,amber,red,neutral}` makes one concept = one accent — but
  this **restyles home's icon accents** (home uses `#003eb3` and `AI_ASSISTANT_FONT`). Map
  `blue` to what home actually uses, and visual-diff every reassignment.
- **Parameterized mock gradient.** ~10 hand-mixed near-white gradients → one recipe
  `mock(accent) = surface → tint(accent,~.05) → warningTint`, preserving per-domain tint
  (AI violet, python green) instead of flattening to one.

## Tokens (added to `src/packages/frontend/public/theme.ts`)
`PUBLIC_TYPE`, `PUBLIC_SPACE`, `PUBLIC_RADIUS`, `PUBLIC_ELEVATION`, `PUBLIC_ACCENTS`,
`PUBLIC_GRADIENTS`, `PUBLIC_DARK`, + shared `alpha()` / `tint()` helpers. Shell upgrades:
`PublicSection` gains `eyebrow`/`action`/`variant` (owns padding/bg/border/elevation/rhythm);
`PublicPage` owns the section gap; `IconBadge` consolidated with a `size` prop.

## Enforcement (so it can't drift back)
- **Ratcheting token-lint** Jest test (no "warn level" exists in Jest — implement as a
  committed baseline count that may only decrease): hard-fail on raw `box-shadow` literals,
  `borderRadius ∉ {8,12,999,50%}`, and duplicate `function IconBadge|alpha` / `const
  PANEL_RADIUS`. Keep hex-in-accent / off-scale-spacing as the ratcheting (not hard-fail)
  axis — those are regex-brittle and dark mocks legitimately use off-scale padding.
- **Token-object snapshot** test so scale edits surface as reviewable diffs.
- **`DARK_FEATURE_CARD_STYLE` derived from `PUBLIC_DARK`**; `fontSize ≥ 16` render guard on
  hero subtitle / section intro so the shell bug can't silently revert.

## Rollout (each step independently shippable + visual-diffed)
0. Tokens only (zero consumers, zero visual change) + lint scaffolding.
1. Shell wiring **behind an opt-in `rhythm` prop** (not a global flip) + scoped lead-size fix
   + `IconBadge` consolidation.
2. Reference page (`python-page`) → lock as template, visual-diff vs home.
3. Fan out feature-detail pages (2–3 at a time), each a small diff under the panel-light test.
4. Home — migrate onto shared tokens **without restyling** (elevation/accents resolve to its
   own current values).
5. Info/lang pages; flip token-lint baseline tighter as groups convert.

## Non-goals
No rebrand. No new hues (Tier A names existing values; Tier B *reassigns* existing values,
not new ones). No big-bang PR. No IA/copy/routing changes. Mock *interiors* stay bespoke —
tokens own shell chrome, not every illustration.
