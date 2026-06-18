---
description: Run ONE default public-site improvement round on a single route/section, ending at the human visual gate.
argument-hint: <route, e.g. /features/api>
---

You are running ONE public-site round under the operating system in
`docs/website-operating-system.md`. SOLO — no subagents, no Workflow.

Target route: $ARGUMENTS

1. **Preflight.** `git status --short`; read `docs/landing-page-brief.md` (the frozen
   contract), the relevant item in `docs/landing-page-issues-and-plans.md`, and
   `.agents/skills/public-site-landing-page/SKILL.md`.
2. **Evidence gate.** State the one punch-list item + hypothesis + the evidence
   (a screenshot observation, a buyer quote, a failed canary, an analytics drop) and which
   proof-spine point it advances. If it only "looks cleaner" with no evidence and moves no
   Brief metric → STOP and tell the user it's dropped (don't do tidy-only work).
3. **Frame.** State the route's primary visitor question; classify the route; set change
   budget = **ONE section/route**; for each component in that section pick exactly one
   action: keep / omit / combine / move-lower / move-to-disclosure / redesign. Bias to
   **subtraction**.
4. **Edit.** One high-confidence diff. No internal/pitch/planning language in public copy;
   no invented metrics, proof, or counts.
5. **Verify.** Focused C1 canary tests (`public/__tests__`) + lint/typecheck for the touched
   package. Copy/density edits should need no test edits (that's the point of C1).
6. **Hand to the human gate — do NOT declare done.** The Stop hook rebuilds and publishes
   `.preview-snapshots/index.html`. Summarize: what changed, what you deliberately left
   alone, and ask the user to gate **ship / revise / revert** from the contact sheet.
7. **On approval only:** area-prefixed commit; mark the punch-list item done (do not reopen);
   one line to `docs/landing-page-decisions.md` if a Brief/pitch/design decision was made.
