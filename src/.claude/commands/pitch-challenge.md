---
description: Adversarially red-team the pitch/Brief against captured buyer signals; propose Brief amendments for sign-off.
---

This is a **Workflow** exception and the ONLY path that may change the frozen Brief.

Read `docs/pitch/signals.md` and `docs/landing-page-brief.md`. Via the `deep-research` skill
(or a Workflow with adversarial-verify), for each load-bearing pitch/positioning claim:

- Agent A argues the claim still holds given the newest product paths and the `EXTERNAL`
  signals in `signals.md`.
- A red-team agent attacks it using the still-unvalidated `ASSUMPTION` entries and any
  `EXTERNAL` signal that contradicts it.
- A judge rules **HOLD / REVISE / RETIRE** with a one-line reason.

Output is **internal grounding only** — never edit public copy from it. Surface proposed
Brief amendments to the user. Only on their sign-off: edit `docs/landing-page-brief.md` and
append the decision to `docs/landing-page-decisions.md`. Run this on a read-only cadence
(monthly / when notable new signal arrives), never as an autonomous site-editing loop.
