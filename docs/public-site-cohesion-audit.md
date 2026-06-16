# Public Site Cohesion Audit

Running checklist for the public-site redesign work. Keep this file updated as
recommendations are evaluated, completed, or deliberately deferred.

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

## Policy Evidence Destination Pass

- [x] Treat `/policies`, `/policies/trust`, `/policies/privacy`, and `/policies/dpa` as evidence destinations that need buyer orientation, not just legal text dumps.
- [x] Preserve the legal and compliance document bodies unless a source-backed typo or route defect is found; add summaries and next steps around them instead of rewriting claims.
- [x] Use existing public-safe facts only: policy titles, document descriptions, the public Trust Center, and support/contact routes.
- [x] Fix the Trust Center URL from unresolved `trust.cocalc.ai` to the working public `trust.cocalc.com` destination.
- [x] Add concise page summaries that explain which visitor question each policy page answers without expanding SOC 2, GDPR, privacy, retention, or data-flow claims.
- [x] Add route continuity from policy pages back to operating models, pricing/licensing, and context-preserving support/contact so buyers know what to do after reviewing evidence.
- [x] Keep mobile readability and long-link containment as policy-page requirements.
- [ ] Future: perform a line-level legal/trust review of the policy document bodies themselves before changing legal substance, certification wording, retention periods, or DPA terms.

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

## Site-Wide Principles Learned

- [x] Avoid decorative tags and repeated metadata when the section heading already carries the meaning.
- [x] Do not make non-clickable labels visually compete with clickable cards.
- [x] Keep cards for scannable choices or genuinely distinct concepts, not for every fact.
- [x] Align section intros with the grid or cards they introduce; small offsets are visible when cards carry the visual weight.
- [x] Remove arrows or progression indicators when the visitor is not meant to read a sequence.
- [x] Prefer public buyer/user language over internal planning language.
- [x] Preserve CoCalc Star as a bounded single-VM product path.
- [x] Preserve teaching/course management as a workflow destination, not a top-level product or LMS replacement.
