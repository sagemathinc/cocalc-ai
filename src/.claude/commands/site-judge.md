---
description: Judge-panel review of a route's visual/credibility quality against the Brief (the subjective call tests can't make).
argument-hint: <route>
---

Route: $ARGUMENTS

This is one of the few **Workflow** exceptions (subjective judgment). Run a judge panel of
3 independent judges against `docs/landing-page-brief.md`, each reading the latest
`/tmp/cocalc-public-qa-*` screenshots for the route (capture them first via
`site-verify` if stale):

- **researcher-reader** judge — does the promise land for the user, and is there one obvious
  next step for "will this fit how my team works?"
- **exec/platform-buyer** judge — is the operating-model/credibility path clear for "which
  model + price, can we run it our way?"
- **visual-density / brand critic** — intentional rhythm or busy/assembled? Does it match the
  home benchmark?

Each scores the route on its Brief job and **must name what to REMOVE** (subtraction-biased;
"what's missing" suggestions that only add are discounted). Aggregate into a ranked shortlist
of changes; the human breaks ties. Do NOT edit the page — the output feeds `/site-round`.
