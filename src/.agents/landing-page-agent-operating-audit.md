# Landing Page Agent Operating Audit

Created: 2026-06-17

Purpose: make the CoCalc.ai public-site cleanup process more reliable. This is
an internal agent operating file, not public copy.

## Sources Reviewed

- Local repo guidance: `AGENTS.md`
- Public-site process ledger: `docs/public-site-cohesion-audit.md`
- Prompt handoff log: `src/.agents/public-site-audit-prompt-log.md`
- Browser QA harness: `src/packages/frontend/scripts/public-site-browser-qa.mjs`
- Process tests:
  `src/packages/frontend/public/__tests__/public-site-agent-workflow.test.ts`
  and
  `src/packages/frontend/public/__tests__/public-site-browser-qa-script.test.ts`
- Codex manual fetched 2026-06-17:
  `https://developers.openai.com/codex/codex-manual.md`
- External workflow references:
  - NN/g iterative, parallel, and competitive design:
    `https://www.nngroup.com/articles/parallel-and-iterative-design/`
  - NN/g small qualitative usability tests:
    `https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/`
  - GOV.UK Design System community principles:
    `https://design-system.service.gov.uk/community/community-principles/`
  - GOV.UK Design System image guidance:
    `https://design-system.service.gov.uk/styles/images/`
  - Playwright visual comparisons:
    `https://playwright.dev/docs/test-snapshots`
  - Storybook visual testing:
    `https://storybook.js.org/docs/writing-tests/visual-testing`
  - Microsoft Writing Style Guide:
    `https://learn.microsoft.com/en-us/style-guide/welcome/`

## Core Diagnosis

The Landing Page Agent is not failing because it lacks tools. It is failing
because the operating loop lets broad prompts become broad changes before the
route's decision problem is pinned down.

The existing system has useful parts:

- a public-site ledger with `PSL-*` entries,
- a prompt backlog,
- deterministic copy/route/browser QA,
- scratch artifact hygiene,
- focused tests for process docs,
- a rebuilt preview target at `blaec.cocalc.ai`.

The failure is that these tools are being used mostly as end-of-turn cleanup,
not as the controlling structure for the work.

## Operating Failure Register

Use these IDs in follow-up prompts, commits, and review comments.

| ID        | Failure mode                                                                                                   | Why it hurts                                                                                                              | Current fix                                                                                                                                                | Status  |
| --------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `LPA-001` | Prompts are too broad: many routes, copy, layout, tests, browser QA, rebuild, and commit in one request.       | The agent optimizes for completion across too many pages instead of making a small number of excellent product decisions. | Require a route-classification and change-budget step before edits.                                                                                        | Open    |
| `LPA-002` | The route's visitor question is sometimes implicit.                                                            | Sections get judged by whether they sound plausible, not whether they answer a necessary decision question.               | Every page pass must state the primary visitor question and the section-level question before editing.                                                     | Open    |
| `LPA-003` | User feedback arrives as visual judgment, but the agent converts it too quickly into source changes.           | This creates swingy redesigns, removals that feel arbitrary, and loss of useful route-specific evidence.                  | Require a "considered options" note before source edits: keep, omit, combine, move to disclosure/modal, or redesign.                                       | Open    |
| `LPA-004` | Known issues are scattered across chat, ledger prose, prompt log, and screenshots.                             | Future turns rediscover the same concerns and sometimes miss earlier objections.                                          | Keep `KI-*` items in `docs/public-site-cohesion-audit.md` and link each next prompt to the relevant `KI-*` and `PSL-*`.                                    | Partial |
| `LPA-005` | Next prompts sometimes fail to get logged.                                                                     | The iterative process stalls and the user has to ask why there is no recommended prompt.                                  | Treat prompt-log update as a required done condition and test for the operating standard.                                                                  | Partial |
| `LPA-006` | Automated tests catch text/route regressions but not visual design quality.                                    | The agent can pass validation while producing pages that still feel busy, monotonous, or psychologically off.             | Split checks into deterministic tests, manual screenshot QA, and human product judgment; do not pretend tests approve design.                              | Partial |
| `LPA-007` | Browser screenshots are generated but not always summarized into durable decisions.                            | QA evidence exists in `/tmp`, but the reason for a visual decision can vanish after the turn.                             | Ledger entry must summarize what screenshots showed, which files were inspected, and why unchanged routes stayed unchanged.                                | Partial |
| `LPA-008` | Public copy can drift toward internal pitch, competitor, or planning language.                                 | Buyer-facing pages risk sounding like internal strategy or unsupported proof claims.                                      | Keep pitch/competitor material as grounding only; public source must use approved public framing and existing proof assets/routes.                         | Partial |
| `LPA-009` | Page-specific work is sometimes flattened into generic shared patterns.                                        | Feature pages become visually uniform but less useful, and route-specific evidence is lost.                               | "Do not flatten route-specific evidence just for uniformity" is now a standing rule.                                                                       | Partial |
| `LPA-010` | The agent often fixes the visible symptom but does not improve the operating system.                           | The same class of issue returns in the next page batch.                                                                   | Each pass must ask whether a lesson belongs in tests, browser QA, docs, prompt log, or a repo skill.                                                       | Open    |
| `LPA-011` | Source, process docs, and scratch artifacts have different commit rules but are not always separated mentally. | Internal reasoning or generated artifacts could accidentally be committed, while useful operating notes might be omitted. | Keep scratch under `/tmp/cocalc-public-qa-*`; commit only source, tests, and intentional docs; never commit raw chat, screenshot dumps, or research dumps. | Partial |
| `LPA-012` | Interrupted turns can leave ambiguity about validation and commit state.                                       | The next agent may continue stale assumptions or skip final hygiene.                                                      | Start every continuation with `git status --short`, latest commit, and unfinished process tasks.                                                           | Open    |

## Better Operating Loop

Use this loop for CoCalc.ai public-site passes.

1. **Preflight the workspace.**
   Check `git status --short`, latest commit, and whether a prior task is
   unfinished. Do not mix unrelated source edits.
2. **Load the right sources.**
   Read the active `PSL-*`, relevant `KI-*`, the route source, pitch docs only
   as private grounding, and the current reusable prompt.
3. **State the visitor decision.**
   Write one sentence: "This page must help [audience] decide [decision]."
4. **Classify the page.**
   Use one class: homepage, feature index, feature detail, product decision,
   pricing/compare, support/contact, guides/docs bridge, or trust/policy
   destination.
5. **Set a change budget.**
   Name the maximum safe scope before editing. Example: "one section rewrite,
   one CTA adjustment, one visual-density simplification." If more is needed,
   split the pass.
6. **Evaluate components before editing.**
   For each candidate section, choose exactly one action:
   keep, omit, combine, move lower, move to disclosure/modal, or redesign.
7. **Separate evidence types.**
   - Automated tests: route, copy, CTA, overflow, stale/internal phrases.
   - Browser QA: desktop/tablet/mobile wrapping, density, visual rhythm.
   - Human judgment: product hierarchy, commercial framing, proof posture,
     whether a page feels credible.
8. **Make high-confidence edits only.**
   Prefer local, reversible changes that improve decision quality without
   broad product restructuring.
9. **Log as you go.**
   Update the active `PSL-*` with findings before edits, then check off
   validation and follow-up items as they close.
10. **Validate and inspect.**
    Run focused tests, lint/typecheck when relevant, rebuild if public source
    changed, and run the reusable browser QA script for the affected route group.
11. **Handoff with continuity.**
    Commit completed work. Final report must include changed files, validation,
    preview/QA artifact path, residual risks, commit hash, and one next prompt
    already stored in the prompt log.

## What To Automate Next

- [ ] Add a required active-issue reference to public-site prompt-log entries:
      each prompt should mention the `PSL-*` and any `KI-*` it closes.
- [ ] Add script support for a `--route-file` or `--group custom` mode so a
      prompt can test exactly the routes it changed without editing the script.
- [ ] Consider visual snapshot baselines only for stable route fragments, not
      whole public pages yet. Playwright warns that screenshots vary by OS,
      browser, fonts, headless mode, and hardware, so baseline ownership must
      be explicit before committing reference images.
- [ ] Add a lightweight "section count / heading density" diagnostic to the
      browser QA JSON. It should warn, not fail, until calibrated by human
      review.
- [ ] Add a prompt-log lint test that fails when the top prompt does not contain
      "report residual risks plus the next recommended prompt."

## What Must Stay Human-Owned

- Whether AI should be visually first on a page.
- How much emphasis teaching/workshops should receive relative to research and
  professional technical teams.
- Whether proof claims are approved for public use.
- Whether a section feels credible to executive buyers.
- Whether a route-specific visual is psychologically clarifying or merely busy.

## Immediate Process Changes Made

- [x] Created this operating audit file.
- [x] Added a repo-scoped `public-site-landing-page` skill so future Codex
      turns can load the workflow without enormous prompts.
- [x] Added focused tests that require this operating audit and skill to remain
      discoverable.
- [ ] Future pass: convert the most stable parts of this audit into a small
      preflight script or checklist command after one or two more uses.
