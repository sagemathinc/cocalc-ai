# Public Site Cohesion Audit

Running checklist for the public-site redesign work. Keep this file updated as
recommendations are evaluated, completed, or deliberately deferred.

## Current Reference Ledger

Use these IDs in follow-up prompts, commits, and review comments. Keep new
public-site work in this ledger until it is validated and committed, then leave
the entry in place as a decision record.

### PSL-2026-06-17-001: Feature Index Starter Cards

- **Routes:** `/features`
- **Trigger:** Browser QA and user feedback showed that the blue-tinted starter
  cards felt visually arbitrary now that the top page is no longer centered on
  terminal/runtime visuals.
- **Principle:** Small starter links should not carry more visual mood than the
  actual route directory below them.
- **Decision:** Keep the starter panel and route order, but make starter links
  use the same neutral surface as the rest of the feature directory.
- **Changed files:** `src/packages/frontend/public/features/app.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`
- **Validation state:** Focused feature tests passed, public app tests passed,
  frontend lint passed, frontend typecheck passed, static preview rebuilt, and
  desktop/tablet/mobile browser QA passed on 2026-06-17.
- **Follow-up:** If `/features` still feels too tall on mobile, audit the hero
  and starter panel together; do not hide high-intent language/runtime routes
  merely to shorten the page.

### PSL-2026-06-17-002: AI Page Visual Weight

- **Routes:** `/features/ai`
- **Trigger:** User feedback flagged `Codex thread` as potentially too
  vendor-specific and the lower AI page sections as visually heavy/busy. Browser
  inspection also showed the dark workflow strip dominating a non-terminal
  section.
- **Principle:** The AI page should make the agent/project-context story clear
  without using terminal-like dark panels or repeated CTA cards that compete for
  attention.
- **Decision:** Use `Agent thread` for the visible durable-thread concept, keep
  `Codex` where naming the actual integration/guide, simplify live-project
  context to a quiet left-rule list, convert the workflow strip to a light panel,
  and replace the lower stacked cards with one route-owned ending.
- **Changed files:** `src/packages/frontend/public/features/ai-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`
- **Validation state:** Focused feature tests passed, public app tests passed,
  frontend lint passed, frontend typecheck passed, static preview rebuilt, and
  desktop/tablet/mobile browser QA passed on 2026-06-17.
- **Follow-up:** Audit `/features/ai` together with `/features/terminal` and
  `/features/linux` for whether command-line agent guidance belongs on AI,
  terminal, or both without creating repeated sections.

### PSL-2026-06-17-003: LaTeX Feature Re-Audit

- **Routes:** `/features/latex-editor`
- **Trigger:** User requested a fresh LaTeX feature-page re-audit.
- **Principle:** A feature detail page should have one clear workflow example,
  one route-owned ending, no decorative metadata, no unsupported proof, and no
  repeated visual sections that answer the same visitor question.
- **Finding:** Desktop/tablet/mobile browser QA showed no horizontal overflow,
  a route-owned ending, no direct competitor naming in public page copy, and no
  stale separate Codex/build-assistant heading.
- **Decision:** No source change in this pass. The page still has three visual
  explanations, but they answer distinct questions: editor workflow, project
  working tree, and computation-backed writing.
- **Changed files:** none.
- **Validation state:** Browser QA completed before the Guides pivot. No source
  validation required because no LaTeX source changed.
- **Follow-up:** If mobile length becomes a concern, evaluate whether the
  working-tree diagram and computation-flow diagram can be combined or one moved
  behind a disclosure.

### PSL-2026-06-17-004: Guides Entry Page

- **Routes:** `/guides`
- **Trigger:** User noted the Guides page had not received the same systematic
  cleanup as features/products. Source inspection showed `/guides` was a small
  bridge page with six stale/tagged cards while the companion guide site has a
  much broader current guide set.
- **Principle:** `/guides` should be a curated public front door that answers
  "which practical guide should I open first?" without duplicating the companion
  guide homepage or becoming a docs dump.
- **Decision:** Replace decorative tag cards with task-based groups: common
  workflows, research/writing, runtime/code, and teaching/operating paths. Add
  high-intent current guide routes from the companion guide site while keeping
  RootFS and competitor-comparison detail out of bridge copy.
- **Changed files:** `src/packages/frontend/public/guides/app.tsx`,
  `src/packages/frontend/public/__tests__/app.test.tsx`
- **Visual follow-up:** User review confirmed the route inventory was better
  "in spirit" but the page still looked like a visual eyesore because too many
  large bordered cards stacked after the hero.
- **Follow-up decision:** Keep the guide inventory, but compress the body into
  one calmer task directory. Only the top three routes get mild emphasis; the
  remaining routes become compact grouped rows.
- **Validation state:** Public app tests passed, focused feature tests passed,
  frontend lint passed, frontend typecheck passed, static preview rebuilt, and
  desktop/tablet/mobile browser QA passed on 2026-06-17.
- **Follow-up:** Browser-QA `/guides` at desktop/tablet/mobile for visual
  density, wrapping, external-link clarity, and whether the guide groups feel
  useful without overwhelming visitors.

### PSL-2026-06-17-005: Prompt And Audit Logging

- **Routes:** repo process, not a public route.
- **Trigger:** User asked whether prompts are stored somewhere referenceable and
  then asked for more detailed, referenceable task logging.
- **Principle:** Public-site audit continuity needs stable references without
  committing raw chat transcripts, screenshots, competitor research, compliance
  interpretation, or unapproved public copy.
- **Decision:** Keep reusable next prompts in
  `src/.agents/public-site-audit-prompt-log.md`; keep decisions, task status,
  rationale, changed files, and follow-ups in this audit doc.
- **Changed files:** `src/.agents/public-site-audit-prompt-log.md`,
  `docs/public-site-cohesion-audit.md`
- **Validation state:** Prompt log file is intentional source documentation.
  The next recommended prompts were appended before final handoff.
- **Follow-up:** Every future public-site pass should add a ledger item before
  editing, update it after validation, and include the next prompt in both the
  final response and the prompt log.

### PSL-2026-06-17-006: Agentic Public-Site Development Workflow

- **Routes:** repo process for public-site design, copy, QA, and prompt
  continuity.
- **Trigger:** User asked for research on how to build an agentic system for
  professional web development and how to adapt the useful parts to CoCalc.ai
  language/design cleanup.
- **External research checked:** Anthropic's agent guidance emphasizes simple,
  composable workflows before autonomous complexity; ReAct supports
  observation-grounded reasoning/action loops; SWE-agent shows that
  agent-computer interface design materially affects software-agent results;
  GOV.UK and Material writing guidance support short, direct, user-need-driven
  UI copy; Playwright and WCAG reflow guidance support repeatable visual/mobile
  checks; OpenAI eval guidance supports explicit style/content criteria.
- **Pitch-doc alignment:** `docs/pitch/pitch/06-product-pitch-outlines.md`
  defines the public spine as AI-native technical workspace, one workspace
  across code/notebooks/documents/compute/agents, five product paths, and
  organization/site-license routes. `39-proof-evidence-benchmark-sheet.md`
  requires qualitative fallback wording unless proof is measured and approved.
- **Principle:** Use agents as an inspectable professional web-development
  workflow, not as a free-running redesign system. The agent should gather
  sources, classify the visitor question, make scoped edits, run deterministic
  checks, and leave referenceable decisions.
- **Decision:** Adopt a fixed audit loop for future public-site passes:
  source-of-truth scan, route buyer question, component-necessity audit,
  high-confidence edit, focused tests, desktop/tablet/mobile browser QA,
  rebuild when public source changes, commit, residual-risk report, and next
  prompt logged.
- **Changed files:** `docs/public-site-cohesion-audit.md`,
  `src/.agents/public-site-audit-prompt-log.md`
- **Validation state:** Process documentation change. It was committed with the
  current public-site source/test changes after focused validation and browser
  QA.
- **Follow-up:** Future agents should explicitly name the ledger ID they are
  executing against, list buyer questions before edits, and update the ledger
  as each sub-action closes.

### PSL-2026-06-17-007: Agent Workflow Hardening

- **Routes:** repo process for public-site agent workflow, tests, browser QA,
  and human review boundaries.
- **Trigger:** User asked to audit the public-site agent workflow itself after
  the feature/guides pass and identify which checks should become automated,
  which should remain browser QA, and which require human product judgment.
- **External research checked:** Anthropic's agent guidance still supports
  simple composable workflows before more autonomous loops; OpenAI eval guidance
  supports criteria-based evaluation; Playwright visual-comparison docs warn
  that screenshots vary by browser/platform; W3C reflow guidance supports
  horizontal-overflow checks as a baseline mobile-readability guard.
- **Visitor/process question:** Can future agents continue CoCalc.ai cleanup
  without losing pitch framing, skipping QA, omitting next prompts, or
  committing scratch/internal artifacts?
- **Principle:** Automate deterministic regressions, browser-QA visual
  judgments that need rendered layout, and reserve product positioning and
  evidence approval for humans.
- **Decision:** Add an explicit check matrix and automation backlog to this
  audit doc, keep reusable prompts in `src/.agents/public-site-audit-prompt-log.md`,
  and add focused tests that make the ledger/prompt-log operating standard
  harder to accidentally drop.
- **Changed files:** `docs/public-site-cohesion-audit.md`,
  `src/.agents/public-site-audit-prompt-log.md`,
  `src/packages/frontend/public/__tests__/public-site-agent-workflow.test.ts`
- **Validation state:** Focused process-doc Jest test passed, frontend lint
  passed, and frontend typecheck passed on 2026-06-17. No static rebuild was
  needed because no public runtime source changed.
- **Follow-up:** Convert the successful throwaway browser-QA harness into a
  reusable script only after deciding the stable assertion set and artifact
  location policy.

### PSL-2026-06-17-008: Reusable Browser QA Harness

- **Routes:** repo process for public-site browser QA across route groups.
- **Trigger:** User asked to convert the successful throwaway headless-Chrome
  public-site QA harness into a small reusable script for future public-site
  passes.
- **Operating standard:** Use `PSL-2026-06-17-007` and the
  `Agentic Public-Site Check Matrix`: automate stable rendered checks, keep
  visual rhythm as browser-QA/human review, and write generated artifacts only
  under `/tmp/cocalc-public-qa-*`.
- **Visitor/process question:** Can a future agent run the same public-site
  visual QA without copying a one-off script from chat, rediscovering routes,
  or committing screenshots by accident?
- **Principle:** The script should check durable layout/route invariants:
  horizontal overflow, expected section order, stale text, route-specific hrefs,
  and selected visual classes. It should not pretend to approve subjective
  visual design.
- **Decision:** Add a frontend script with route groups, direct routes,
  desktop/tablet/mobile defaults, cache-busting navigation, screenshots,
  assertion JSON, and a `/tmp` artifact root. Add focused tests for CLI
  discoverability, route groups, and artifact hygiene.
- **Changed files:** `src/packages/frontend/scripts/public-site-browser-qa.mjs`,
  `src/packages/frontend/public/__tests__/public-site-browser-qa-script.test.ts`,
  `docs/public-site-cohesion-audit.md`,
  `src/.agents/public-site-audit-prompt-log.md`
- **Validation state:** Focused script/process Jest tests passed, frontend lint
  passed, frontend typecheck passed, and the script passed a live
  `feature-index` smoke against `https://blaec.cocalc.ai` on desktop/tablet/mobile
  with 69 assertions and 0 failures. Smoke artifacts were written to
  `/tmp/cocalc-public-qa-YPDUho`. No static rebuild was needed because no public
  runtime source changed.
- **Follow-up:** After a few more QA passes, decide whether to add the script to
  package scripts or keep it as an explicit `node scripts/...` tool.

### Current Open Validation Tasks

- [x] `PSL-2026-06-17-001` through `PSL-2026-06-17-004`: run static preview
      rebuild after the Guides changes.
- [x] `PSL-2026-06-17-001`, `PSL-2026-06-17-002`, and
      `PSL-2026-06-17-004`: browser-QA `/features`, `/features/ai`, and `/guides`
      on desktop, tablet, and mobile after rebuild.
- [x] `PSL-2026-06-17-005`: append the next recommended prompt to
      `src/.agents/public-site-audit-prompt-log.md`.
- [x] `PSL-2026-06-17-006`: incorporate the agentic public-site workflow into
      the prompt log so future agents start from the same operating model.
- [x] Final pre-commit hygiene: run `git status --short`, `git diff --name-only`,
      and `git ls-files --others --exclude-standard` so scratch QA artifacts do not
      enter the repository.
- [x] `PSL-2026-06-17-007`: run focused process-doc tests, update validation
      state, commit, and report the next recommended prompt.
- [x] `PSL-2026-06-17-008`: add reusable browser-QA script, focused tests,
      docs updates, validation, commit, and next recommended prompt.

## Agentic Public-Site Operating Model

Use this for CoCalc.ai public-site cleanup at `blaec.cocalc.ai`.

The system should behave more like a senior web team with an agent assistant
than a fully autonomous redesign agent. The reliable path is a structured
workflow with explicit checkpoints:

1. **Ground the route.** Read the route source, relevant pitch docs, existing
   audit ledger entries, and any current user feedback. State the visitor
   question before proposing edits.
2. **Classify the work.** Decide whether the page is a workflow-discovery page,
   product-decision page, support/trust page, docs/guides bridge, or proof
   destination. Do not import patterns from one class into another without a
   reason.
3. **Apply the component-necessity test.** Every visible component must answer a
   distinct visitor question. Omit, combine, or move details behind links or
   disclosures when they repeat the same point.
4. **Protect product framing.** Keep AI first, teaching secondary, Markdown as
   supporting project context, Star bounded to single-VM, Launchpad/Rocket
   customer-operated, and feature pages as workflow spokes rather than product
   taxonomy.
5. **Protect evidence boundaries.** Do not add metrics, proof claims,
   security/privacy claims, competitor positioning, or broad open-format
   promises unless the pitch evidence register says they are approved.
6. **Edit narrowly.** Prefer copy, spacing, CTA, and layout-density changes that
   directly resolve the route question. Avoid redesigning adjacent pages unless
   the route handoff is the problem.
7. **Test what automation can test.** Use focused tests for stale phrasing,
   duplicate labels, route-specific CTAs, decorative metadata, product-boundary
   violations, and known layout regressions.
8. **Browser-QA what tests cannot judge.** Check desktop, tablet, and mobile for
   visual density, wrapping, horizontal overflow, card monotony, dark/light
   section weight, and whether the route-owned ending still feels like the
   right next step.
9. **Log as the work moves.** Add or update a `PSL-YYYY-MM-DD-NNN` ledger item
   before edits, then update changed files, validation state, residual risks,
   and follow-ups before final handoff.
10. **Handoff with continuity.** Store the next recommended prompt in
    `src/.agents/public-site-audit-prompt-log.md`, cite the relevant ledger IDs,
    and keep scratch QA artifacts outside the repository.

The acceptance rubric for future agents:

- Can a technical visitor quickly identify the workflow value?
- Can an executive or platform buyer quickly understand the operating path?
- Does the page preserve the AI-native technical workspace pitch without
  becoming generic AI-tool marketing?
- Does each card/section earn its visual weight?
- Are CTAs specific to the route and the visitor's next decision?
- Is the language natural, concise, and public-facing?
- Are unapproved proof/compliance/competitor/internal claims absent?
- Does mobile scanning work without horizontal scroll or crammed endings?

## Agentic Public-Site Check Matrix

Use this matrix when deciding what to automate, what to browser-QA, and what to
escalate for human product review.

### Automate

Automate checks when the failure can be expressed as source text, route
structure, DOM state, or stable browser measurement.

- **Pitch and product-boundary guardrails:** reject stale/internal phrases,
  direct competitor framing, unapproved proof language, broad open-format
  promises, unapproved security/privacy claims, and product-path boundary drift
  such as Star becoming more than single-VM or Launchpad/Rocket becoming
  self-service product promises.
- **CTA route discipline:** assert that route-owned endings point to the useful
  next step for the page, such as product comparison, contextual support,
  pricing, docs, or the relevant guide instead of looping every card to one
  generic page.
- **Duplicate-label and decorative-metadata regressions:** assert that audited
  pages do not bring back duplicate card headings, tag rows, repeated metadata
  chips, stale map labels, or component names that only make sense internally.
- **Prompt and ledger continuity:** assert that the audit doc has the operating
  model, the prompt log has a reusable next prompt, prompts cite `PSL-*` ledger
  IDs, and both files warn against raw chat, scratch artifacts, compliance
  interpretation, and unapproved public copy.
- **Rendered layout baselines:** use browser automation for horizontal overflow,
  expected section order, presence/absence of known visual classes, route
  heading text, and specific href targets.
- **Standard repo validation:** run focused Jest tests, frontend lint,
  typecheck, prettier, and static rebuild when public source changes.

Do not automate a test merely because a user disliked a screenshot once. Turn it
into a test only when the underlying regression can be stated as a durable rule.

### Manual Browser QA

Keep checks manual, with screenshots under `/tmp/cocalc-public-qa-*`, when the
question depends on visual rhythm or rendered perception rather than a stable
source rule.

- Does the page feel visually crowded or monotonous at desktop, tablet, and
  mobile widths?
- Do cards look clickable when they are links, and non-clickable when they are
  explanatory panels?
- Are tinted, dark, or high-emphasis panels reserved for sections that earn that
  visual weight?
- Does mobile scanning preserve information scent without hiding high-intent
  routes behind unnecessary interaction?
- Does the bottom-of-page ending feel like one clear next step instead of a
  stack of competing CTA rows?
- Are screenshots, mocks, and visual assets readable and properly cropped at
  the tested widths?

Browser QA can include deterministic assertions, but final visual judgment
should remain a human review note unless the regression has a stable, testable
shape.

### Human Product Judgment

Escalate or leave as human review when the question changes positioning,
evidence posture, public claims, or the commercial hierarchy.

- Whether AI is prominent enough without turning CoCalc into generic AI-tool
  messaging.
- Whether teaching is correctly weighted as a secondary workflow for courses,
  labs, workshops, and training rather than a top-level product path.
- Whether a feature deserves visible surface area or should stay as a docs link
  or guide route.
- Whether a page should omit, combine, move, or disclose content that is true
  but not decision-critical.
- Whether screenshots, proof, metrics, trust language, compliance language,
  competitor framing, or deployment-boundary claims are approved for public use.
- Whether public copy sounds natural and buyer-facing rather than agent-written,
  stiff, internal, or over-claimed.

Human review should produce a ledger entry or checklist update, not just chat
feedback, so future agents can continue without losing the decision.

## Agentic Public-Site Automation Backlog

- [x] Add a focused process-doc test that checks the audit doc and prompt log
      preserve the operating model, PSL references, next-prompt continuity, and
      artifact hygiene rules.
- [x] Convert the throwaway headless-Chrome QA harness into a reusable script
      that writes screenshots and assertion JSON to `/tmp/cocalc-public-qa-*`.
      Keep it outside the normal Jest suite until its runtime and browser
      assumptions are stable.
- [ ] Add a route registry for public-site QA groups so agents can run
      `conversion spine`, `feature index`, `feature detail`, `product detail`,
      or `guides/docs bridge` checks without rediscovering routes from chat.
- [ ] Consider criteria-based LLM review only as an advisory layer for tone and
      repetition. Do not let an LLM judge approve product positioning, proof
      claims, compliance language, or final public copy without human review.
- [ ] Add a lightweight final-handoff checklist template that forces commit
      hash, validation, browser QA, residual risks, and next recommended prompt.

### Current Browser QA Script

Run from `src/packages/frontend`:

```sh
node scripts/public-site-browser-qa.mjs --base-url https://blaec.cocalc.ai --group feature-index
```

Useful groups:

- `feature-index`: `/features`
- `feature-core`: `/features` plus the high-traffic AI, Jupyter, terminal,
  Linux, and teaching workflow pages
- `feature-details`: audited feature detail pages
- `guides`: `/guides`
- `conversion-spine`: homepage, products, pricing, compare, support, and
  support form
- `product-details`: Plus, Star, Launchpad, and Rocket product pages

The script writes screenshots and `results.json` only under
`/tmp/cocalc-public-qa-*`. It checks durable rendered invariants such as
horizontal overflow, known section order, stale text, route-specific hrefs, and
selected visual classes. It does not approve subjective visual design; agents
still need to inspect screenshots and log human-review residual risks.

### Browser QA Route Registry Hardening, 2026-06-17

- [x] Ran `feature-core` against `https://blaec.cocalc.ai`: 264 assertions,
      0 failures. Artifacts: `/tmp/cocalc-public-qa-0Gq6kI`.
- [x] Ran `guides` against `https://blaec.cocalc.ai`: 69 assertions,
      0 failures. Artifacts: `/tmp/cocalc-public-qa-zf8yW1`.
- [x] Ran `conversion-spine` against `https://blaec.cocalc.ai`: 198 assertions,
      0 failures. Artifacts: `/tmp/cocalc-public-qa-tm9dpy`.
- [x] Ran `product-details` against `https://blaec.cocalc.ai`: 132 assertions,
      0 failures. Artifacts: `/tmp/cocalc-public-qa-vS8oDn`.
- [x] Finding: the route groups are useful as-is. `feature-core` catches the
      highest-traffic workflow routes, `guides` keeps the bridge isolated,
      `conversion-spine` covers the decision path, and `product-details`
      isolates Plus/Star/Launchpad/Rocket boundary checks.
- [x] Finding: the assertion depth was uneven. Feature index, AI, and Guides had
      route-specific checks; conversion-spine and product-detail pages only had
      global stale-copy and overflow checks.
- [x] Decision: keep the route groups unchanged and add conservative route-owned
      assertions for conversion-spine and product-detail pages: core headings,
      product-path labels, key operating-boundary phrases, and CTA destinations.
      Do not add visual-design approval or brittle exact-copy assertions.
- [x] Updated the browser QA script and focused tests to cover the previously
      shallow conversion-spine and product-detail route groups.
- [x] Reran `conversion-spine` with the stronger route-owned assertions: 330
      assertions, 0 failures. Artifacts: `/tmp/cocalc-public-qa-Ai3HYw`.
- [x] Reran `product-details` with product-boundary and CTA assertions: 204
      assertions, 0 failures. Artifacts: `/tmp/cocalc-public-qa-sCrJVk`.
- [x] Reran `feature-core` on the current harness: 264 assertions, 0 failures.
      Artifacts: `/tmp/cocalc-public-qa-JQ8men`.
- [x] Reran `guides` on the current harness: 69 assertions, 0 failures.
      Artifacts: `/tmp/cocalc-public-qa-spMud6`.
- [x] Validation: focused Jest tests for the browser QA script and agent
      workflow passed; `pnpm -C src lint:frontend` passed; frontend package
      `tsc --build` passed.
- [x] Rebuild decision: no public route, style, asset, or metadata source
      changed in this pass, so the already rebuilt `blaec.cocalc.ai` preview did
      not need another rebuild.
- [x] Remaining standard: the harness is a regression screen for objective
      route, copy, CTA, overflow, and selected class checks. It should not grow
      into subjective design approval; human screenshot review remains required
      for visual hierarchy, rhythm, and page-specific judgment.

## Conversion Spine Pass

- [x] Re-audit homepage, `/products`, `/pricing`, `/features/compare`, and `/support` as the core public decision path before continuing deeper feature cleanup.
- [x] Treat `/products` as the operating-model chooser: hosted CoCalc.ai, local Plus, single-VM Star, customer-operated Launchpad, and customer-operated Rocket.
- [x] Treat `/features/compare` as the fit/comparison page, not another product chooser.
- [x] Treat `/pricing` as hosted plans plus licensing and buying routes, not a duplicate of the product chooser.
- [x] Rename spine CTAs so `/products` reads as "Compare operating models", `/features/compare` reads as "Compare CoCalc fit", and `/pricing` remains "Pricing and licensing".
- [x] Move the CoCalc.ai card on `/products` forward to hosted pricing instead of looping visitors back to the homepage.
- [x] Keep support/contact as the point for context-preserving sales, licensing, deployment, and existing account/project questions.
- [x] Future proof pass: decide where the public spine needs concrete trust signals such as screenshots, support expectations, deployment boundaries, security/data-ownership notes, or customer-style proof without making the pages noisy.

## Trust And Buyer Confidence Pass

- [x] Keep trust signals at decision points instead of adding a broad proof section that competes with the conversion spine.
- [x] Products: use the operating-model and site-licensing sections to clarify who operates CoCalc, what the boundary is, and when support should discuss rollout, procurement, data-location, security, or support expectations.
- [x] Pricing: keep hosted plans self-service while pointing organizational buyers toward site licensing, quotes, deployment rights, and support expectations.
- [x] Support: make purchase/contact context collect the product path, who will operate it, expected users, procurement timeline, security/data-ownership expectations, and support constraints.
- [ ] Future evidence pass: add real screenshots, workflow examples, security/data-ownership documentation links, or customer-style proof only when the evidence exists and answers a visitor decision better than concise copy.

## Evidence Readiness Pass

- [x] Use existing public policy routes as lightweight evidence only where visitors are already making trust-sensitive decisions: operating model, pricing/licensing, comparison, and support.
- [x] Keep the homepage free of extra trust links for now because it should make the broad promise and route visitors into the decision spine rather than becoming an evidence index.
- [x] Products: add trust/privacy review routes near site licensing because that is where procurement, support, data-location, and operator-boundary questions naturally surface.
- [x] Pricing: add trust/privacy review routes to organizational buying paths, not to every hosted plan card, so self-service pricing stays scannable.
- [x] Compare: add a trust/privacy route as a next step for evaluators who have accepted CoCalc fit and now need buyer confidence.
- [x] Support: expose trust/privacy resources before contact so buyers can gather known policy context without opening a ticket first.
- [x] Support form: include trust/privacy resources in the helpful-links block so security and data-ownership questions have an existing public evidence route.
- [x] Policy evidence pages: keep long legal/documentation links contained on mobile by wrapping policy-document anchors instead of editing policy text.
- [x] Do not add screenshots, metrics, customer proof, setup-time claims, restore-time claims, or stronger data-flow claims during this pass because the pitch evidence register keeps those gated until validated assets exist.
- [ ] Future: identify route-specific screenshots or short workflow captures only after they have a named owner, current capture, and public-use approval gate.
- [ ] Future: review the public trust/privacy/DPA pages themselves for buyer-oriented clarity; this pass only improves discoverability of already-published materials.

## Non-Compliance Evidence And Decision Support Pass

- [x] Keep legal, privacy, DPA, retention, SOC 2, GDPR, certification, and policy-document substance out of this general public-site pass; those materials remain in Andrey's review lane.
- [x] Treat workflow evidence as route-specific decision support, not as a generic proof wall. The useful question is what a visitor can evaluate on the page: notebook continuity, course handout/collection, agent reviewability, operating-model boundary, or support next step.
- [x] Do not add setup-time, restore-time, deployment-speed, customer-proof, or security/privacy-strength claims because the pitch evidence register still gates those until there are named owners, repeatable captures, and public-use approval.
- [x] Homepage: keep concrete workflow assets but make the feature-index CTA describe the destination as workflow browsing instead of a generic feature list.
- [x] AI: reduce decorative mini-labels in the chat illustration and make the top evidence cards answer concrete evaluator questions: where the agent starts, what context it can use, and how people review the result.
- [x] Jupyter and teaching: leave the current route-specific examples in place during this pass because they already answer distinct workflow questions without adding unsupported proof.
- [x] Products, pricing, compare, and support: leave policy/trust destinations as surrounding-page links only; do not reinterpret the documents or strengthen compliance language.
- [ ] Future: add approved route-specific screenshots or short captures only when the asset itself shows the workflow better than concise copy and has a freshness owner.

## Feature Evidence And Decision Support Pass

- [x] Start with `/features/ai`, `/features/jupyter-notebook`, `/features/teaching`, `/features/terminal`, and `/features/linux` because these routes carry the core workflow-evidence story.
- [x] AI: keep the concrete Codex-thread example and route-specific support CTA; do not add broader agent superiority claims or competitor positioning to the public page.
- [x] Jupyter: keep the notebook continuity example, but remove fake numeric notebook outputs that can read like benchmark or scientific proof.
- [x] Teaching: keep the LMS/CoCalc boundary and assignment-loop example, but remove the fake "26 notebooks ready" mock count.
- [x] Linux: keep the install/verify workflow, but remove the fixed Graphviz version string so the mock does not age into stale evidence.
- [x] Terminal: keep the `.term` and shared-stream examples; no further compression in this pass because each remaining section answers a distinct terminal-evaluation question.
- [x] Add tests for proof-like mock literals and internal-context leakage so public feature pages do not accidentally expose pitch, competitor, or agent-operating notes.

## Next-Tier Feature Evidence Pass

- [x] Re-inspect `/features/whiteboard`, `/features/latex-editor`, `/features/slides`, `/features/api`, `/features/python`, `/features/sage`, `/features/r-statistical-software`, `/features/julia`, and `/features/octave` for route-specific examples, useful next steps, decorative metadata, and unsupported proof.
- [x] Whiteboard: keep the executable-canvas example and route-specific whiteboard support CTA; no public copy changes needed in this pass.
- [x] Slides: keep the slide-deck mock and whiteboard/Jupyter/teaching routes; no public copy changes needed in this pass.
- [x] API: keep the page focused on documented HTTP API integration, but avoid broad "stable" language that could sound stronger than the docs themselves.
- [x] LaTeX: remove mock build counts and replace direct competitor-positioning language with neutral task-fit language so public copy does not read like internal comparison notes.
- [x] Python: remove fake package-count and test-count outputs from terminal mocks so the example stays illustrative instead of proof-like.
- [x] Sage: remove build/test/development language that reads like internal implementation proof and keep the page focused on SageMath use in courses, notebooks, LaTeX, and research projects.
- [x] R: replace direct competitor-positioning language with neutral dedicated-tool language while preserving the distinction that CoCalc is strongest when R is part of a broader project workflow.
- [x] Julia: keep the project/context page structure and route-specific next steps; no public copy changes needed in this pass.
- [x] Octave: remove the fake convergence count from the mock terminal output.
- [x] Extend tests so the next-tier feature pages reject mock evidence counts, direct competitor-positioning terms, and public copy that reads like internal comparison framing.

## Feature Visual Hierarchy And Density Pass

- [x] Re-inspect `/features/python`, `/features/latex-editor`, `/features/sage`, `/features/r-statistical-software`, and `/features/octave` after the evidence cleanup for card overuse, repeated section purpose, mobile length, and CTA rhythm.
- [x] Python: remove the repeated hero-adjacent cards if they only restate the notebook/script/terminal workflow already shown in the hero mock and workflow map.
- [x] Python: remove remaining implementation-heavy "RootFS" wording from the public page and replace it with visitor-facing shared-environment language.
- [x] LaTeX: remove the separate Codex review/build section if the same idea can live as a concise writing-workflow bullet and AI route CTA.
- [x] LaTeX: avoid a card-heavy mid-page rhythm where hero mock, paper project diagram, evidence diagram, Codex diagram, and comparison matrix all compete for attention.
- [x] Sage: compress repeated mathematics/project/course/research sections so the page does not read as a sequence of similar card grids.
- [x] R: avoid repeating "R is useful when the surrounding project matters" across hero, middle fit section, and final CTA.
- [x] Octave: avoid repeating notebooks/scripts/teaching across hero mock, immediate cards, middle flow section, and final CTA.
- [x] Keep workflow value before operating-model handoff; leave the shared operating-model section intact unless it becomes redundant after page-level compression.

## Teaching Lower-Page Density Pass

- [x] Re-inspect `/features/teaching` lower-page sections after the feature-density pass.
- [x] Keep the LMS boundary section because it answers the distinct buyer question "Is this replacing our LMS?"
- [x] Keep the assignment-loop section because it shows the concrete workflow that differentiates CoCalc teaching from generic notebook hosting.
- [x] Combine the separate setup/support-friction section and final teaching-path CTA because they both answer "what should I do next for a course?"
- [x] Suppress the shared operating-model handoff on `/features/teaching` because the course-specific next-step block already routes visitors to hosted teaching, guides, product comparison, and support without adding a second ending.
- [x] Preserve course management as a workflow destination beside the LMS, not a top-level product path or LMS replacement.
- [x] Keep implementation details behind the environment guide CTA instead of expanding setup language on the public page.

## Workflow Feature Mobile-First Pass

- [x] Re-audit `/features/jupyter-notebook` and `/features/teaching` together as the two highest-traffic workflow feature pages.
- [x] Jupyter: keep the hero notebook mock as the single primary workflow example.
- [x] Jupyter: remove the repeated scenario panel under "When the notebook depends on more than cells" because it restates the three benefit cards: long runs, collaboration, and review/recovery.
- [x] Jupyter: combine the four-card "Where to go from here" section with the final operating-model handoff so the page has one route-specific ending instead of a workflow card grid followed by a generic shared ending.
- [x] Teaching: keep the course dashboard and assignment loop, but remove the three early summary cards because they repeat student projects, handout/collection, and environment consistency already carried by the hero, LMS boundary, assignment loop, and final planning block.
- [x] Teaching: preserve course management as a workflow destination beside the LMS, not a product path or LMS replacement.
- [x] Keep shared operating-model handoff on ordinary feature routes, but suppress it on pages that already own a route-specific final decision block.

## High-Traffic Workflow Set Pass

- [x] Re-audit `/features/ai`, `/features/jupyter-notebook`, `/features/teaching`, `/features/terminal`, and `/features/linux` as a set after the earlier feature cleanup.
- [x] Leave Jupyter and Teaching structurally intact in this pass because they already have one primary workflow example and one route-owned final decision block.
- [x] AI: remove the hero-adjacent summary cards because the Codex thread, workflow strip, and live-project section already carry those points with more specific evidence.
- [x] AI: treat the Codex thread/workflow strip as the primary workflow example, make the lower CTA the route-owned ending, and suppress the shared operating-model handoff.
- [x] Terminal: remove the hero-adjacent summary cards because `.term` addressing and shared terminal-stream sections carry those points with more specific evidence.
- [x] Terminal: treat the `.term` file workflow as the primary example, make the final terminal CTA own the next step, and suppress the shared operating-model handoff.
- [x] Linux: remove the hero-adjacent summary cards because install/verify and reusable-environment sections carry those points with more specific evidence.
- [x] Linux: treat install/verify as the primary workflow example, make the final Linux CTA own the next step, and suppress the shared operating-model handoff.

## Remaining Workflow Route-Owned Ending Pass

- [x] Re-audit `/features/python`, `/features/latex-editor`, `/features/whiteboard`, `/features/slides`, `/features/api`, `/features/sage`, `/features/r-statistical-software`, `/features/julia`, and `/features/octave` against the route-owned ending standard.
- [x] Treat the shared "Decide how CoCalc should run" section as redundant on these pages once a route-specific ending already provides workflow next steps, support context, and product comparison.
- [x] Python: keep the notebook-to-script-to-paper workflow and use-case section, but make the final CTA route-owned with Python support context and product comparison.
- [x] LaTeX: keep the task-fit comparison as the route-owned ending and add product comparison there instead of following it with a generic shared handoff.
- [x] Whiteboard: remove the hero-adjacent story cards because the hero mock and executable-canvas section already carry editable text, math, and code; keep the final whiteboard next steps.
- [x] Slides: remove the hero-adjacent story cards because the hero mock and slide-flow section already carry slide sizing, math/code material, and collaboration; keep the final slide next steps.
- [x] API: replace the generic shared handoff with an API-owned integration ending that points to API docs, contextual support, and operating-model comparison.
- [x] Sage, R, Julia, and Octave: keep the language-specific workflow fit sections, but replace generic or mailto support routes with contextual support and product comparison in each final ending.
- [x] Julia: remove the hero-adjacent story cards because the hero mock already shows Jupyter, terminal, source-file, and Pluto options.
- [ ] Future: if a language page still feels long after route-owned endings, evaluate whether the language-specific fit section can move into a disclosure without hiding the primary workflow example.

## Feature Discovery Index Pass

- [x] Re-audit `/features` as the workflow discovery layer after route-owned endings were added to the detail pages.
- [x] Keep the index focused on workflow discovery instead of adding product/pricing/support CTAs; product decisions now belong on detail-page endings and `/products`.
- [x] Replace taxonomy-first group labels such as "Documents" and "Compute" with visitor decision labels that better describe what a person is trying to find.
- [x] Remove implementation-only or overly broad index summaries such as "transparent JSONL format" and generic "data science and machine learning" language.
- [x] Keep feature cards because each card is an actionable route choice, but reduce mobile card height so the index scans more like a directory than a wall of large panels.
- [ ] Future: if the feature index still feels long after copy and density cleanup, evaluate whether language/tool cards should be grouped behind a disclosure or tab without hiding core workflow paths.

## Feature Mobile Decision-Speed Pass

- [x] Active: rework `/features` so AI is visually first-class again, teaching is discoverable as a course/workshop workflow rather than equal product focus, and language/math discovery is shorter on mobile without hiding high-intent routes.
- [x] Active: validate that `Dedicated project hosts` stays framed as dedicated hosted capacity, not a standalone general-market project-host product or public self-hosting promise.
- [x] Active: rerun focused tests, browser QA, rebuild `blaec.cocalc.ai`, and commit after the corrected feature-index hierarchy is validated.
- [x] Active: restore `Courses and labs` as a visible lower workflow group without returning it to the cramped footer-adjacent position.
- [x] Active: finish the `Compute and languages` split into clearer visible groups and verify the split improves scan speed without adding visual clutter.
- [x] Active: decide whether `Dedicated project hosts` belongs as a compute/runtime discovery card and keep the wording bounded to the source-supported customer-facing surface.
- [x] Active: rerun focused tests, browser QA, rebuild `blaec.cocalc.ai`, and commit only after the feature-index IA decision is settled.
- [x] Re-audit `/features` and language/tool feature pages as a connected mobile discovery path.
- [x] Keep language/tool cards visible for now because each card is a direct destination and hiding them behind a collapsed control would reduce information scent for visitors looking for a specific language, terminal, or Linux environment.
- [x] Do not introduce a mobile-only disclosure pattern during this pass; external UX guidance supports accordions for dense mobile content, but they add interaction cost and are strongest when the collapsed headings provide a useful mini-IA.
- [x] Keep `Courses and labs` first-class on the feature index, but avoid leaving it as a footer-adjacent orphan section; it should appear as a visible workflow group before the runtime/language/AI sections and also remain a top starting point.
- [x] Split the long `Compute and languages` section into `Runtime and project hosts` and `Languages and math` because the original group mixed environment/capacity decisions with language-stack decisions.
- [x] Keep the split visible rather than using a disclosure so mobile visitors can still scan directly to Python, R, Julia, SageMath, Octave, Terminal, or Linux without opening an extra control.
- [x] Add a conservative `Dedicated project hosts` route to the runtime group because source and docs support customer-facing dedicated hosted capacity; do not frame self-hosted project hosts as a general public feature while the code keeps self-host providers admin/alpha-gated.
- [x] Revise the previous course-group restore: teaching should remain easy to find for instructors, courses, and professional-development workshops, but the feature index should not make course management look like the central business focus.
- [x] Revise the previous group order: AI should not sit behind notebook, teaching, runtime, and language sections on a page for an AI-native technical workspace.
- [x] Prefer a compact visible language/math treatment over a collapsed disclosure unless browser QA shows the compact treatment harms readability; external UX guidance supports preserving strong information scent for high-intent links.
- [x] Put AI first in the feature-index starter panel and first grouped section; this matches the pitch hierarchy for an AI-native technical workspace without turning the page into generic AI IDE messaging.
- [x] Replace the equal-weight course starter/group treatment with a secondary `Teaching and workshops` callout so teaching remains discoverable for instructors and training use without becoming the main commercial signal.
- [x] Keep language/math routes visible but render them as compact linked rows rather than full cards, reducing mobile scroll while preserving direct information scent for Python, R, Julia, SageMath, and Octave.
- [x] Rename the public runtime group to `Runtime and hosted compute` and the project-host card to `Dedicated compute hosts` so `Project Host` remains a linked technical detail rather than a general-market product label.
- [ ] Future: if the language/math group still feels long on mobile, evaluate a compact two-column mobile card treatment or a language-specific disclosure only after confirming it does not hide high-intent language routes.

## Feature First-Click Discovery Pass

- [x] Audit `/features` plus `/features/ai`, `/features/jupyter-notebook`, `/features/terminal`, `/features/linux`, and `/features/teaching` as one first-click workflow journey.
- [x] Reduce top-of-page repetition between the starter panel and grouped directory without demoting AI from the first visible decision.
- [x] Verify that each first-click destination reinforces the route promise from the feature index and keeps its own next-step ending.
- [x] Keep teaching visible for courses, labs, and workshops, but secondary to the AI-native technical workspace and not framed as a product path.
- [x] Keep project-host language bounded to dedicated hosted compute and technical docs rather than a standalone public product.
- [x] Update focused tests for first-click route discipline, AI-first hierarchy, teaching hierarchy, and compute-host framing before rebuilding the preview.
- [x] Finding: the starter panel and first AI group both used "start" language; keep the starter panel as the first decision and make the AI group read like a directory category.
- [x] Finding: the feature-index hero listed too many artifact types for a page that should route visitors quickly; shift the copy toward workflow questions and route-owned next steps.
- [x] Finding: teaching should not be a top starter, but placing it after every runtime and language route makes it feel like a footer orphan; move it after the core workflow group while keeping the styling secondary.
- [x] Browser QA: validate `/features` plus the five first-click routes on desktop, tablet, and mobile for expected route text, section order, and horizontal overflow.

## Markdown And Open-Format Discovery Pass

- [x] Capture the current public-site state for Markdown, project files, open-format language, RootFS/runtime-image framing, and agent-workflow relevance in `docs/public-site-markdown-open-formats-audit.md`.
- [x] Decide that Markdown/project notes should appear as a small docs-linked discovery surface on `/features`, not as a new feature page or full card.
- [x] Add the `/features` surface as a low-density text link in the notebook/writing group so it does not create an orphan fifth card at common desktop widths.
- [x] Decide that `/features/ai` should mention Markdown as editable project context, but should not mention `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or internal agent-instruction files in public copy.
- [x] Follow-up visual audit: keep `Project notes and Markdown` as a supporting docs link in the writing group; it is visible enough on desktop/mobile and does not add a fifth card, tag row, or decorative metadata.
- [x] Follow-up AI audit: keep Markdown in the AI hero copy only; do not repeat it in the route-owned ending, where the visitor needs to choose Codex, terminal workflows, support, or product comparison.
- [x] Project-files-as-agent-context audit: keep Markdown as the supporting `/features` docs link, and add only a concise `/products` overview sentence that the same project model keeps files, notebooks, terminals, chats, and agent context together across operating paths.
- [x] External source check: Codex, GitHub Copilot, and Claude Code documentation all support Markdown/project instruction files as agent context, but the public site should express that as a project-workflow benefit rather than a new feature taxonomy.
- [x] Keep RootFS and operating-system language out of high-level public marketing copy unless a technical-doc route is the explicit destination.
- [x] Avoid broad "all open formats" claims until the supported scope is defined and reviewed.

## Project Context Continuity Pass

- [x] Audit `/features`, `/features/ai`, `/features/jupyter-notebook`, `/features/terminal`, `/features/linux`, `/products`, `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, `/products/cocalc-rocket`, `/pricing`, and `/features/compare` for whether project files, notebooks, terminals, chats, and agent context carry from workflow discovery into product decision.
- [x] Finding: workflow pages already convey project context through route-owned examples; adding a new "project files" feature group would create taxonomy noise and repeat the Markdown/open-format pass.
- [x] Finding: `/pricing` should stay focused on hosted plans, site licensing, dedicated hosted compute, and quotes; adding project-context explanation there would dilute the buying task.
- [x] Finding: `/features/compare` already explains the project-context advantage as a comparison point; do not turn it into another product-detail summary.
- [x] Change: add one compact shared-project note to product-detail pages so visitors understand that product choice changes where CoCalc runs and who operates it, while files, notebooks, terminals, chats, and agent context still stay with the project.
- [x] Preserve Markdown as a supporting `/features` docs link and `/features/ai` hero mention; do not add Markdown to product-detail or pricing pages.
- [x] Add focused product-detail tests for shared project-context continuity and blocked RootFS/open-format/operating-system marketing language.
- [x] Run focused tests, lint, browser QA, rebuild, and commit.

## Product Context Note Visual Weight Pass

- [x] Audit `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` for whether the shared-project continuity note helps buyer comprehension without competing with the route-owned buyer question, positioning cards, or next-step ending.
- [x] Finding: the continuity note is conceptually useful because it prevents product-path pages from feeling disconnected from workflow discovery.
- [x] Finding: the full-width muted blue block reads like a card, alert, or extra section on desktop and mobile; it has too much visual weight for a supporting continuity reminder.
- [x] Finding: the four product detail pages still have one clear buyer question and route-owned ending; the change should reduce note weight rather than restructure the pages.
- [x] Change: restyle the shared-project note as a compact inline callout with a left rule, muted copy, and no card background so it supports the lead instead of competing with the decision cards.
- [x] Run focused tests, browser QA, rebuild, and commit.

## Product Detail Bottom Conversion Pass

- [x] Audit `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` for whether the bottom conversion area gives the right next action without repeating the page.
- [x] Finding: CTA order is broadly correct: install-first for Plus and Star, support-first for Launchpad and Rocket, with pricing or neighboring product paths as secondary actions.
- [x] Finding: the final paragraphs on Plus, Star, Launchpad, and Rocket are longer than needed for conversion; the visitor has already seen the buyer question, boundary, and evidence cue above.
- [x] Change: shorten final conversion copy while preserving route-owned endings and existing CTA destinations.
- [x] Change: make pricing handoff copy say hosted plans are operated by CoCalc, not "operated by us," so the buyer-facing boundary is explicit.
- [x] Finding: feature-index group labels drifted too long during prior specificity passes. Keep the order and information scent, but return headings to shorter labels backed by descriptive body copy.
- [x] Change: shorten `AI workflows and integration`, `Runtime and hosted compute`, `Teaching and workshops`, and `Languages and math` to shorter scannable labels.
- [x] Run focused tests, browser QA, rebuild, and commit.

## Feature Index Rhythm Pass

- [x] Audit `/features` after the shortened group-label pass for visual density, section order, and mobile rhythm.
- [x] Finding: the overall order is now right for the product story: AI first, notebooks/writing next, runtime/hosted compute before teaching, teaching secondary, and languages last as high-intent direct routes.
- [x] Finding: the page still feels long on mobile because multiple full card groups stack back-to-back; hiding language/tool routes behind a disclosure would reduce information scent, so prefer compact visible treatment first.
- [x] Finding: `Notebook, writing, and visual work` is the remaining heavy group label. It wraps awkwardly on mobile and reads like a taxonomy label instead of a quick route marker.
- [x] Decision: keep teaching as a secondary callout after `Runtime`; do not promote it back into the starter panel or remove it from the page.
- [x] Change: shorten the notebook/writing label to `Notebooks and writing` and tighten the group description so it reads like a route marker instead of a taxonomy.
- [x] Change: add mobile-only spacing reductions for the feature hero, starter cards, route cards, and language rows while keeping every high-intent route visible.
- [x] Validation: focused feature tests, frontend lint, frontend typecheck, and static dev build passed.
- [x] Follow-up closed: reran desktop/tablet/mobile browser QA with a
      throwaway system-Chrome DevTools session after the later feature/guides
      pass.

## Feature Index Visual QA Pass

- [x] Browser QA: capture desktop, tablet, and mobile screenshots for `/features` using a throwaway headless Chrome session and keep screenshots under `/tmp/cocalc-public-qa-*`.
- [x] Finding: the intended hierarchy is mechanically correct: AI first, notebooks/writing second, runtime before teaching, teaching secondary, and languages visible.
- [x] Finding: the page has no horizontal overflow and the old `Notebook, writing, and visual work` label is absent.
- [x] Finding: the blue-tinted starter cards carry too much visual mood for simple route links. That treatment made more sense when darker/tinted areas were tied to terminal/runtime content; on the current index it reads as arbitrary emphasis before the actual directory begins.
- [x] Decision: neutralize the starter-link treatment instead of changing the information architecture. Keep the starter panel useful, but make its internal links align with the light directory rhythm used by the rest of the page.
- [x] Change: make the starter links use the same neutral surface as the route cards while preserving their clickable treatment and icon color.
- [x] AI copy note: change the mock header from `Codex thread` to `Agent thread` so the persistent-thread concept reads as a CoCalc workflow concept rather than vendor-specific UI terminology. Keep `Codex` where the page names the actual agent integration or guide.
- [x] Change: simplify the AI page's live-project evidence from a gradient panel with nested icon rows into a quiet left-rule list. This keeps files, notebooks, terminals, and durable agent thread as evidence without making a second dashboard mock.
- [x] Change: convert the AI page workflow strip from a dark terminal-like section into a light workflow panel. The four-step workflow is useful, but the dark treatment made a non-terminal AI section feel visually heavier than its visitor question.
- [x] Change: simplify the AI page bottom section into one route-owned ending. Remove the standalone provider-support card, the separate other-agent terminal card, and the dark final CTA box; keep Codex, terminal workflows, support, and operating-model comparison as lower-friction next actions.
- [x] Active: rerun focused validation and browser QA after the visual changes.
- [x] Active: rebuild the public static preview after validation.
- [x] Browser QA: use a throwaway system-Chrome DevTools session to validate `/features`, `/features/ai`, and `/guides` on desktop, tablet, and mobile; 75 assertions passed with no failures. Screenshots and `results.json` were kept under `/tmp/cocalc-public-qa-agent-web-mvq7WK`.
- [x] Active: commit the source, tests, docs, and prompt-log changes.
- [x] Active: add the next recommended prompt to `src/.agents/public-site-audit-prompt-log.md` before final handoff.

## Guides Entry Pass

- [x] Re-audit `/guides` as a public resource-discovery page rather than a simple bridge to the companion guide site.
- [x] Finding: the companion guide site has a much broader current guide set than the `/guides` bridge exposed, including paper polishing, software install, Python, GitHub, research runs, Git review, Jupyter, teaching, terminal, self-hosting, Plus, agent sandbox, and architecture guides.
- [x] Finding: the existing six-card bridge used decorative blue tags and stale category coverage, making it feel less aligned with the cleaner feature-index standard.
- [x] Decision: keep `/guides` as a curated front door, not a duplicate of the companion guide homepage. The page should answer "which guide should I open first?" and then route visitors to the full guide library, docs, features, or support.
- [x] Change: replace decorative tag cards with task-based guide groups: common workflows, research/writing, runtime/code, and teaching/operating paths.
- [x] Change: add high-intent current guide routes from the companion guide site while keeping RootFS and competitor-comparison details out of the bridge copy.
- [x] Change: keep docs/support/feature routes as lower-page handoffs so the guide page remains connected to the public site decision path.
- [x] Visual follow-up: compress the large guide-card wall into one calmer task directory. Keep the top three workflow guides mildly emphasized and render the rest as compact grouped rows.
- [x] Active: run focused public app and feature tests after the Guides changes.
- [x] Active: browser-QA `/guides`, `/features`, and `/features/ai` on desktop, tablet, and mobile after rebuild.
- [x] Active: rebuild the public static preview and commit the source, tests, docs, and prompt-log changes.
- [ ] Future: review `/guides` mobile featured-link weight with a human eye after deployment. Browser QA passed, but the top three featured guide links remain visually stronger than the compact rows below.

## LaTeX Feature Re-Audit

- [x] Browser-QA `/features/latex-editor` on desktop, tablet, and mobile after the current source state.
- [x] Finding: the LaTeX page has one route-owned ending, no horizontal overflow, no direct competitor naming in public page copy, and no stale separate Codex/build-assistant heading.
- [x] Finding: the page still uses three visual explanations: hero editor mock, working-tree diagram, and computation-flow diagram. They answer distinct questions, but this should be watched if the page later feels long on mobile.
- [x] Decision: make no immediate LaTeX source change in this pass; prioritize the newly identified `/guides` gap.

## Workflow To Product Decision Handoff Pass

- [x] Audit `/features`, `/features/ai`, `/features/jupyter-notebook`, `/features/terminal`, `/features/linux`, `/features/teaching`, `/products`, `/pricing`, `/features/compare`, and `/support/new` as one path from workflow fit to operating-model decision.
- [x] Verify that workflow pages explain value first, then route visitors to product comparison, pricing, or support without making each feature page a duplicate product chooser.
- [x] Keep product-path boundaries clear: CoCalc.ai hosted, Plus local/self-directed, Star bounded to one public Ubuntu VM, Launchpad lightweight customer-operated private deployment, and Rocket broader private-cloud path.
- [x] Preserve AI-first positioning and keep teaching as a secondary workflow path for courses, labs, and workshops rather than a top-level product focus.
- [x] Keep project-host language bounded to dedicated hosted compute and technical docs, not a standalone public product.
- [x] Check support/contact prefill context so visitors arriving from workflow pages or product pages know what information to provide.
- [x] Add focused tests for workflow-to-product CTA discipline, support context, and stale/internal language before rebuilding the preview.
- [x] Finding: `/features/ai`, `/features/jupyter-notebook`, `/features/terminal`, `/features/linux`, and `/features/teaching` already keep workflow value first and route visitors toward products, docs, or contextual support without turning each feature page into a full product chooser.
- [x] Finding: `/products`, `/pricing`, and `/support/new` already preserve the five operating paths and purchase context; leave those boundaries intact during this pass.
- [x] Finding: `/features/compare` was the handoff weak point because it is the decision page but still sent "Talk with CoCalc" to a raw email link instead of the contextual support form.
- [x] Change: move the compare-page contact CTA to `/support/new` with product-decision context so visitors can describe workflow fit, operating model, purchasing, deployment, and support constraints in one place.
- [x] Browser QA: validate the workflow and decision route set on desktop, tablet, and mobile with zero horizontal overflow; confirm compare-page contact uses `context=feature-compare` and `type=purchase`, and confirm `/support/new` preserves the prefilled decision context in the preview's email-only mode.

## Product Decision Buyer Path Pass

- [x] Active: audit `/products`, `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, `/products/cocalc-rocket`, `/pricing`, and `/features/compare` as one buyer path.
- [x] Active: keep `/products` as the operating-model chooser and `/features/compare` as the fit/comparison page rather than duplicating the same decision on every page.
- [x] Active: preserve the five product paths: hosted CoCalc.ai, local/self-directed Plus, single-VM Star, customer-operated Launchpad, and customer-operated Rocket.
- [x] Finding: the `/products` overview already separates who operates CoCalc and where it runs; leave the overview structure intact during this pass.
- [x] Finding: `/pricing` already frames hosted plans, site licensing, dedicated hosted compute, quotes, and trust/privacy routes without becoming another product chooser; leave its structure intact.
- [x] Finding: `/features/compare` now hands off to products, pricing, and contextual support correctly; leave its structure intact.
- [x] Change: replace repeated generic product-detail "Next action" endings with route-owned ending labels that describe the buyer decision on that product page.
- [x] Change: keep Plus focused on local evaluation, hosted pricing, and operating-model comparison instead of routing its ending back to workflow feature pages.
- [x] Change: tighten Star to the public-facing single public Ubuntu VM path for this buyer pass, without local Lima or agent-sandbox-oriented framing.
- [x] Change: focus Launchpad's ending on Launchpad requirements, pricing, and neighboring Star/Rocket decisions rather than a low-value comparison back to Plus.
- [x] Browser QA: validate `/products`, all four self-directed/customer-operated product-detail pages, `/pricing`, and `/features/compare` on desktop, tablet, and mobile with zero horizontal overflow; confirm Plus hosted evaluation routes to `/pricing`, Launchpad support uses `context=product-cocalc-launchpad`, and stale `Next action`, `local Lima`, and `agent sandbox` language is absent. The known `CoCalc Crashed` overlay remains present in the DOM and was ignored per user instruction.

## Product Detail Visual Decision Pass

- [x] Active: audit `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` as buyer decision pages after the CTA cleanup.
- [x] Change: move the feature-index teaching callout below `Runtime and hosted compute` so AI, notebooks, and runtime/hosted capacity remain the primary technical discovery path while teaching stays visible as a secondary workflow route.
- [x] Change: replace repeated `Audience`, `Deployment model`, and `Why choose it` product-detail labels with `Who it fits`, `How it runs`, and `When to choose it` so the cards read more like buyer decision support.
- [x] Change: make each product page lead with the buyer question: local evaluation, one public VM, bounded private deployment, or institutional private-cloud planning.
- [x] Change: make generic `Operational boundary` cards route-specific so the visitor can quickly tell what is bounded on that product page.
- [x] Finding: keep the overview, pricing, and compare pages structurally unchanged during this pass; this is a product-detail visual hierarchy pass, not a product taxonomy redesign.
- [x] Browser QA: validate `/features`, `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` on desktop, tablet, and mobile with zero horizontal overflow; confirm teaching now follows runtime/hosted compute and precedes languages/math, product pages use buyer-question headings, generic taxonomy labels are absent, and Launchpad support retains `context=product-cocalc-launchpad`. The known `CoCalc Crashed` overlay remains present in the DOM and was ignored per user instruction.

## Product Detail Evidence Depth Pass

- [x] Active: audit `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` for install proof, deployment boundary, support expectation, workflow evidence, and next-step confidence.
- [x] Finding: product pages should not add new screenshot or performance proof during this pass; the evidence register still requires approved, fresh public assets before screenshots, setup-time claims, restore-time claims, or benchmark-style proof become product-page evidence.
- [x] Finding: CoCalc Star has the strongest existing public proof route because `/docs/self-hosting/cocalc-star` documents the VM, firewall, onboarding, first-admin, project-start, and invite-user checks.
- [x] Finding: Launchpad and Rocket need clearer operating-boundary and support-expectation language, especially who owns infrastructure, recovery, and ongoing operations, without implying managed private cloud or guaranteed support levels.
- [x] Finding: Plus needs a clearer self-serve/local ownership boundary so technical evaluators do not confuse it with hosted collaboration or a supported shared deployment path.
- [x] Change: expose compact, route-specific evidence cues using existing install commands, public docs routes, and contextual support prefill rather than adding new proof sections.
- [x] Change: link CoCalc Star to the public setup guide from the install card; keep Plus, Launchpad, and Rocket evidence tied to install commands, ownership boundaries, and contextual support rather than adding unapproved screenshots.
- [x] Change: clarify that Plus is self-serve local software, Launchpad/Rocket remain customer-operated, and support guidance does not move infrastructure ownership to CoCalc.
- [x] Add focused tests for product evidence cues, support-context preservation, product-boundary discipline, and unsupported proof phrasing.
- [x] Browser QA: validate `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` on desktop, tablet, and mobile with zero horizontal overflow; confirm Star setup-guide routing, Plus local ownership language, Launchpad support context, and Rocket operator-boundary support context.

## Product Visual Proof Readiness Pass

- [x] Active: audit `/products`, `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` for approved visual proof readiness.
- [x] Finding: `/products` benefits most from a non-visual evidence cue because it is the route chooser; adding a short `What to verify` line in each existing card is lower-risk than adding screenshots or another proof section.
- [x] Finding: CoCalc Star is the only product-detail page with a public, route-specific setup-guide asset that is already ready to link from the product page. Keep that as a link rather than lifting the screenshot into the product page until the docs asset has an explicit public marketing freshness owner.
- [x] Finding: Plus, Launchpad, and Rocket still need owner-approved captures before screenshots can be used as visual proof. Keep their proof concrete through install commands, operating-boundary copy, and contextual support prefill.
- [x] Proposed future visual: CoCalc.ai workspace screenshot. Buyer question: "What does the hosted workspace look like?" Freshness owner needed: Blaec for marketing fit plus William or product reviewer for UI accuracy. Placement: `/products` hosted card or a future hosted detail page; do not add until a current capture is approved.
- [x] Proposed future visual: CoCalc Plus install/starter-project capture. Buyer question: "Can I evaluate CoCalc locally on my own machine?" Freshness owner needed: Blaec recording readiness plus William/product reviewer for installer accuracy. Placement: Plus install card; do not add until Plus install fixture and supported baseline are approved.
- [x] Proposed future visual: CoCalc Star setup screenshot or excerpt. Buyer question: "What checks are involved in the one-public-VM path?" Freshness owner needed: Star docs owner plus product reviewer. Placement: Star install card or linked setup guide; link is safe now, embedded visual deferred.
- [x] Proposed future visual: Launchpad operator-boundary diagram. Buyer question: "What does my team operate, and where does CoCalc support fit?" Freshness owner needed: Blaec messaging plus William/product reviewer; Andrey only if trust/privacy/security language is strengthened. Placement: Launchpad boundary card or disclosure; defer until the diagram is approved.
- [x] Proposed future visual: Rocket planning checklist or deployment-boundary diagram. Buyer question: "What context should procurement and platform teams bring before talking to CoCalc?" Freshness owner needed: Blaec messaging plus William/product reviewer; Andrey only if compliance/security details are included. Placement: Rocket planning card; keep current text-only support context until approved.
- [x] Change: add compact `What to verify` cues to the `/products` overview cards without introducing screenshots, metrics, customer proof, or new claims.
- [x] Add focused tests that the `/products` overview exposes route-specific verification cues and still blocks unapproved proof language.
- [x] Browser QA: validate `/products`, `/products/cocalc-plus`, `/products/cocalc-star`, `/products/cocalc-launchpad`, and `/products/cocalc-rocket` on desktop, tablet, and mobile with zero horizontal overflow; confirm the `/products` route shows five `What to verify` cues and the detail pages retain their route-specific evidence links and support context.

## Agent Workspace And Public-Site Artifact Standards

- [x] Store browser-QA screenshots, scratch reports, and generated inspection files outside the repository, e.g. `/tmp/cocalc-public-qa-*`, unless the user explicitly approves them as public assets.
- [x] Commit only source, tests, and intentional documentation. Do not commit raw screenshots, Playwright traces, terminal transcripts, prompt drafts, competitor research dumps, or generated QA JSON.
- [x] Public assets under `src/packages/frontend/public` require a freshness owner and public-use rationale; otherwise keep candidate screenshots or captures in `/tmp` during the pass.
- [x] Keep pitch docs, competitor comparison notes, internal framing, and agent process notes out of public React components, static metadata, and public route copy.
- [x] Before committing, check `git status --short`, `git diff --name-only`, and untracked files so accidental scratch artifacts are caught.
- [x] Tests should guard against internal-context leakage using public-page render checks, but the audit file may keep internal rationale because it is an engineering task log rather than public route copy.

## Policy Evidence Destination Pass

- [x] Treat `/policies`, `/policies/trust`, `/policies/privacy`, and `/policies/dpa` as evidence destinations that need buyer orientation, not just legal text dumps.
- [x] Preserve the legal and compliance document bodies unless a source-backed typo or route defect is found; add summaries and next steps around them instead of rewriting claims.
- [x] Use existing public-safe facts only: policy titles, document descriptions, the public Trust Center, and support/contact routes.
- [x] Keep the public Trust Center URL on `trust.cocalc.ai`; the domain is intentional and will be made live.
- [x] Add concise page summaries that explain which visitor question each policy page answers without expanding SOC 2, GDPR, privacy, retention, or data-flow claims.
- [x] Add route continuity from policy pages back to operating models, pricing/licensing, and context-preserving support/contact so buyers know what to do after reviewing evidence.
- [x] Keep mobile readability and long-link containment as policy-page requirements.
- [ ] Future: perform a line-level legal/trust review of the policy document bodies themselves before changing legal substance, certification wording, retention periods, or DPA terms.

## Policy-Adjacent Entry Point Pass

- [x] Keep legal, privacy, DPA, Trust Center, SOC 2, GDPR, retention, and certification language in Andrey's review lane; do not continue changing policy document bodies during general site passes.
- [x] Audit only the surrounding public pages that point visitors toward published trust/privacy materials: products, pricing, compare, support, footer/nav, sign-in, and sign-up.
- [x] Leave sign-in/sign-up Terms and Privacy acceptance links alone because they serve a legal acceptance function, not a buyer-confidence narrative function.
- [x] Leave the footer and top-nav `Policies` label alone for now because it is a neutral legal-resource destination and does not overstate trust or compliance.
- [x] Reframe surrounding-page links from broad "trust resources" language toward "trust materials" and make support the path for organization-specific security, privacy, data-location, or procurement questions.
- [x] Avoid adding compliance interpretation, stronger security claims, or route-specific summaries that Andrey should own.
- [ ] Future: after Andrey reviews the policy materials, re-check whether public-page trust labels should point to more specific reviewed destinations such as Trust Center, DPA, FERPA, or privacy.

## Jupyter And Teaching Pass

- [x] Re-inspect `/features/jupyter-notebook` and `/features/teaching` against the component-necessity standard after the broader feature-page cleanup.
- [x] Jupyter: reduce the hero to one public promise and move detailed agent mechanics behind the existing modal.
- [x] Jupyter: collapse four proof cards to three distinct visitor benefits: persistent runs, live collaboration, and review/recovery.
- [x] Jupyter: remove the separate final thesis section because it repeated the project-context argument already made earlier.
- [x] Jupyter: remove the "Ready to try a notebook workflow" CTA strip because it duplicated existing actions without adding decision value.
- [x] Jupyter: align the "Where to go from here" intro with the card grid so section text and clickable choices read as one block.
- [x] Teaching: keep course management positioned as a workflow destination beside the LMS, not an LMS replacement or top-level product path.
- [x] Teaching: collapse overlapping grading, nbgrader, help, setup, and environment sections into fewer visitor questions.
- [x] Teaching: preserve route-specific next steps for hosted use, product-path comparison, environment guidance, Jupyter, and teaching support.
- [x] Update focused tests for stale headings, duplicate headings, decorative metadata, CTA route discipline, and repeated section density.

## Shared Feature Detail Shell Pass

- [x] Re-inspect the shared feature-detail bottom pattern after the individual page cleanup.
- [x] Keep one compact operating-model handoff because feature pages should still connect workflow fit to hosted, local, single-VM, Launchpad, and Rocket choices.
- [x] Remove previous/next feature links because feature pages are not a linear sequence and those links compete with route-specific CTAs.
- [x] Rename the shared handoff from "Choose the operating model that fits" to "Decide how CoCalc should run" so it reads as the next decision rather than repeated homepage language.
- [x] Suppress the shared operating-model handoff on `/features/compare` because that page already has its own comparison and next-route section.
- [x] Keep a single low-priority route back to the feature index as "Browse feature workflows" instead of an arbitrary previous/next trail.

## Open Considerations For Future Passes

- [ ] Persona journeys: verify that researchers, instructors, IT/platform teams, and executive buyers can each answer "what is this, is it for me, and what should I do next?" without reading every page.
- [ ] Proof and confidence: decide where public pages need evidence such as screenshots, concrete workflow examples, deployment boundaries, support expectations, or customer-style proof without making pages noisy.
- [ ] IT and procurement readiness: audit whether support, pricing, products, and product-detail pages answer security, data ownership, SSO/auth, deployment responsibility, support model, and procurement questions at the right depth.
- [ ] Technical depth layering: keep public pages concise while making sure route-specific CTAs lead to guides, docs, modals, or support forms that preserve context for advanced evaluators.
- [ ] Product-path boundaries: keep checking that CoCalc.ai can serve individuals and institutions, Star stays bounded to a single VM, Plus stays local/self-directed, and Launchpad/Rocket remain customer-operated paths.
- [ ] Navigation intent: verify that every shared nav/footer/CTA label sets a truthful expectation about the destination, especially when moving between workflow pages, product paths, pricing, compare, and support.
- [ ] Visual system consistency: continue checking that cards, icons, screenshots, spacing, and mobile stacking are used only when they reduce decision effort.
- [ ] Conversion measurement: identify which user decisions the public site should optimize for and which pages need analytics events or clearer success criteria before launch.

## Current Feature-Page Pass

- [x] Re-inspect `/features/ai`, `/features/terminal`, `/features/linux`, `/features/api`, `/features/whiteboard`, `/features/latex-editor`, and `/features/slides` against the component-necessity standard.
- [x] Use desktop screenshots to identify pages that are visually or conceptually heavy before editing.
- [x] Replace generic feature-card labels with visitor-situation labels where the current copy feels like metadata.
- [x] Consolidate or remove repeated page-level sections on LaTeX, Terminal, Linux, and Whiteboard.
- [x] Keep API lightweight and route-specific; make documentation/support the primary evaluation path.
- [x] Update tests so generic labels, decorative tags, stale/internal language, and vague CTA routes regress visibly.
- [x] Run focused feature tests, typecheck, lint, browser QA, preview rebuild, and commit.

## Current-Pass Change Rationale

- [x] AI: changed generic card headings like "Rich prompts" into task-oriented labels so the page reads as agent workflow guidance instead of a capability list.
- [x] Terminal: removed the full-width Codex process strip because terminal state, collaboration, and agent access were already explained elsewhere on the page.
- [x] Linux: removed the full-width reusable-environment process strip because it pushed the public page toward operations documentation; kept the concept in the course/team environment section.
- [x] Linux: shifted public wording from "RootFS images" toward "reusable environment images" while preserving the technical guide link.
- [x] Whiteboard: removed lower-priority format/realtime cards and kept collaboration as a decision bullet so the page focuses on explaining computational ideas.
- [x] LaTeX: removed repeated recovery/collaboration panels and merged the final CTA into the comparison section so the page has one ending.
- [x] API: made documentation and contextual support the primary next steps because API evaluators usually need integration details before a generic account action.

## Carry-Forward Reviews

- [x] Revisit `/features/jupyter-notebook`; it is improved but still needs a fresh density and hierarchy review.
- [x] Revisit `/features/teaching`; it is improved but still has heavy sections that should be re-evaluated against the same standard.
- [x] Continue checking whether each feature page explains workflow value before product operating model.
- [x] Continue checking that every CTA preserves page context and points to the most useful next step.
- [ ] Teaching follow-up: the lower page still feels overloaded; re-check whether the last two teaching sections answer distinct visitor questions or should be combined into one clearer next-step block.

## Site-Wide Principles Learned

- [x] Avoid decorative tags and repeated metadata when the section heading already carries the meaning.
- [x] Do not make non-clickable labels visually compete with clickable cards.
- [x] Keep cards for scannable choices or genuinely distinct concepts, not for every fact.
- [x] Align section intros with the grid or cards they introduce; small offsets are visible when cards carry the visual weight.
- [x] Remove arrows or progression indicators when the visitor is not meant to read a sequence.
- [x] Prefer public buyer/user language over internal planning language.
- [x] Preserve CoCalc Star as a bounded single-VM product path.
- [x] Preserve teaching/course management as a workflow destination, not a top-level product or LMS replacement.

## Testing Principles Learned

- [x] Keep Jest/Testing Library tests focused on visitor-visible behavior: headings, CTA labels, destination routes, duplicated labels, stale phrases, and whether a page exposes the expected next action.
- [x] Use browser smoke tests for what component tests cannot see: desktop/tablet/mobile wrapping, screenshot containment, viewport overflow, and whether the rebuilt preview actually serves the intended public route.
- [x] Prefer route-specific CTA contract tests over broad link-count tests; the failure we want to catch is a card pointing to a generic or misleading destination.
- [x] Add duplicate-heading and duplicate-card-label checks when a page has repeated cards or repeated section patterns.
- [x] Add source or DOM checks for decorative metadata when a page has already been simplified; tags/chips should not return without a distinct information function.
- [x] Consider Playwright screenshot baselines only for stable hero, card-grid, and CTA sections. Use them sparingly because visual snapshots can become noisy when copy and responsive breakpoints are still actively changing.
- [x] Consider axe/Playwright accessibility scans for public routes as a separate smoke layer; they can catch contrast, labels, and duplicate-id issues but should not be treated as complete design QA.
- [x] Consider Lighthouse CI assertions later for first-load public polish, especially performance and accessibility budgets, once the route set and assets are stable.
