# Landing Page — Decisions Log

> Append-only. Durable Brief / pitch / design decisions, one line each, dated. Per-round
> mechanical detail lives in commit messages, NOT here. This replaces the retired
> `docs/public-site-cohesion-audit.md` as the place to record *decisions*.

- 2026-06-17 — **Brief FROZEN** (`docs/landing-page-brief.md`), signed off by Blaec. Changed
  only via the human-gated `/pitch-challenge` loop.
- 2026-06-17 — Home page **leads with the continuity promise** ("make computational work
  easier to share, review, and continue"); AI/workspace/deploy are *proof*, not the headline.
  (Chosen over "AI-native workspace" and a buyer-split lead.)
- 2026-06-17 — **Teaching stays a secondary feature page**, not a top-level product path (the
  page is good; left intact — it already satisfies the Brief).
- 2026-06-17 — Products page: **hosted-first "Start here"** cue on the CoCalc.ai card; the
  5-path chooser stays neutral. Removed the arbitrary warning-tint on the Star card.
- 2026-06-17 — Julia hero leads with **reactive Pluto notebooks**; R hero leads with
  **reproducible reporting** (wording chosen by Blaec).
- 2026-06-17 — **C1**: public-site tests assert structure/canaries, not exact copy — copy
  edits are test-tax-free; a broken CTA route still fails.
- 2026-06-17 — **D1 design system**: Tier A (safe normalization, home pixel-identical) lands
  first; Tier B (spacing/type/accent restyle) runs page-by-page behind the per-turn
  visual-diff gate. (`docs/landing-page-design-system.md`.)
- 2026-06-17 — **Pitch is a living artifact**: `docs/pitch/signals.md` (provenance-tagged
  ASSUMPTION vs EXTERNAL) feeds a monthly read-only `/pitch-challenge`; only a sign-off
  amends the Brief.
- 2026-06-17 — **Operating system** adopted (`docs/website-operating-system.md`): two
  cadences, solo-by-default, evidence-gated rounds, finite punch-list, per-turn rebuild +
  screenshot Stop hook. `docs/public-site-cohesion-audit.md` retired (no new appends).
