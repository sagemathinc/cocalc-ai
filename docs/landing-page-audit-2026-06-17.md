# Public-site audit — 2026-06-17 (frozen-Brief, workflow w1bn862ka)

> 19-agent audit of 18 conversion pages vs the FROZEN Brief + copy playbook + density.
> Every high-severity finding adversarially verified. 1 high, 37 medium, 44 low, 0 rejected.
> Dominant theme: **idea-repetition within pages** (the Brief 'do not repeat' rule) + several
> feature pages lean teaching-forward vs the research-forward Brief.

## r
_The page competently shows R working inside a shared CoCalc project and is clean of banned superlatives and invented metrics, but it serves the teaching pipeline far more than the Brief's priority-1 research/R&D audience and repeats its single "R beside other tools" idea in every section._

- **[high/do-not]** Same idea ('keep R beside other tools / project context > a dedicated R IDE') repeated in every section
  - fix: Pick one home for the project-context argument (the fit-band) and cut it from the hero subhead and the 'When R belongs' bullets. Let the other sections carry distinct, non-overlapping points (e.g. a concrete reproducible-report workflow; a collaboration/review example) so the page reads as one progressing argument rather than three paraphrases.
- **[medium/positioning]** Priority-1 research/R&D audience is absent while teaching/courses is foregrounded ~8 times
  - fix: Rebalance so the lead use cases name research/R&D analysis (e.g. statistical modeling, reproducible research reports for a lab) before teaching, keeping courses present but not dominant. Teaching can stay as one of several uses, not the recurring frame.
- **[medium/copy]** Hero subhead is a 9-item tool inventory with no outcome
  - fix: Lead the subhead with the outcome (what R-in-CoCalc lets a team do) and trim the tool roster to 3-4 representative items, letting the RWorkflowMock visual carry the rest rather than enumerating the full stack in prose.
- **[low/cta]** Secondary buyer CTA undifferentiated, and primary CTA label varies between hero and close
  - fix: Give 'Compare operating models' distinct subordinate treatment (separate it from the feature-link cluster) and thin that cluster of links near the final CTA. Use one consistent label for the primary sign-up action in both hero and close.
- **[low/consistency]** Section title spacing composed differently from sibling sections (uneven rhythm)
  - fix: Wrap the third section's column in the same <Flex vertical gap> pattern and set the title margin to 0 (or standardize on one spacing approach across all three sections).
- **[low/copy]** 'Codex context' dropped into a tool list as undefined jargon
  - fix: Either omit it from this list or give it a one-line concrete meaning tied to the R workflow, rather than listing 'Codex context' alongside files and terminals without explanation.

## sage
_The page stays on-message and avoids the hard do-nots, but it leans teaching-forward and repeats its core tool enumeration, so it under-serves the Brief's research-forward priority and lets the decision-maker CTA get lost in a button cluster._

- **[medium/positioning]** Teaching leads; research/R&D is demoted to a 'surrounding' afterthought
  - fix: Reorder so the research/continuable-work section ('Use Sage with the surrounding project' — source files, terminals, logs, collaborators/Codex, long-running research jobs) is the first dedicated section, with the courses section following. Teaching stays present and respected but is not the lead, per the Brief's 'sales framing leads with research/R&D, teaching never buried.' In the hero line, lead with 'collaborators and reviewers' before 'students.'
- **[medium/do-not]** The 'notebooks / terminals / LaTeX / courses' enumeration and the reviewability idea repeat across sections
  - fix: Brief: 'Don't repeat the same idea across sections.' Keep the surface enumeration in one place (the hero), and let each later section add a new, specific idea instead of re-listing the same tools. Drop the duplicate reviewability sentence.
- **[medium/cta]** Final section is a 5-button cluster that buries the decision-maker secondary CTA
  - fix: Brief: secondary is 'Compare operating models'; tertiary links 'present but never competing for the eye.' Give 'Compare operating models' a single clearly-subordinate treatment, and demote the LaTeX/Terminal/SageTeX/support links to lighter inline (LinkButton-style) tertiary links so they don't read as five peers of the primary action.
- **[low/copy]** 'When SageMath belongs in CoCalc' bullets don't answer 'when' and pair no outcome
  - fix: Either rename the heading to match the content, or rewrite the bullets as actual 'when' scenarios with a paired outcome, in one parallel grammatical form (e.g. all imperative), and remove the overlap with the hero and the 'surrounding project' section.
- **[low/density]** Two near-duplicate bullets in the 'surrounding project' list
  - fix: Merge the two into a single bullet so the four-item list carries four distinct ideas (Principle 6: cap bullets, one idea each).
- **[low/consistency]** Inconsistent punctuation across sibling section titles
  - fix: Pick one convention for section-title punctuation and apply it to all sibling headings (D1 rhythm). Optionally align the two primary-CTA labels so the single obvious action reads consistently top and bottom.

## terminal
_A research-forward, well-structured feature page that frames the terminal as a durable, continuable project document (on-brief), but it ships a literal rendering bug, one banned word, and a couple of redundancy/consistency snags that read as unpolished._

- **[medium/consistency]** Missing space in the central .term code example (JSX whitespace bug)
  - fix: Insert an explicit space before the second code element, e.g. `...and the shell starts in{" "}<code>research/runs/</code>.` (or put the space inside the text on the same line as the tag).
- **[medium/copy]** Banned superlative 'easy' in body copy
  - fix: Drop the superlative and state the mechanism: 'Reopen that file later and the same terminal context — working directory and history — comes back for a collaborator, instructor, or agent.'
- **[low/consistency]** Literal backticks render in a bullet (no markdown processing)
  - fix: Pass a ReactNode with a real `<code>open</code>` element instead of a backtick string, matching the inline-code treatment used in the surrounding paragraphs.
- **[low/consistency]** Section heading duplicated verbatim inside its paired diagram
  - fix: Give the diagram a distinct internal label (e.g. a path/breadcrumb caption) rather than restating the section heading.
- **[low/do-not]** Same 'terminal sits beside the other tools' idea stated in two sections
  - fix: Keep the adjacency claim in the hero and make the closing section earn its place with the specific 'fastest path' workflow framing only, trimming the long re-list of tools (or vice-versa).
- **[low/positioning]** Only human-persona illustration leads with teaching, under-serving the co-primary research/engineering audience
  - fix: Swap one teaching persona for a research/engineering collaborator (e.g. Researcher / Reviewer / Codex) so the lead audience is visible in the collaboration illustration; teaching stays represented via the instructor reference in the .term section.

## products
_A clean, well-structured operating-model routing page that serves the procurement/decision-maker audience well — explicit customer-operated boundaries, correct "source-available" framing for Plus, no invented metrics or vendor-operated SLA implications — but it tilts toward an academic/IT operator persona in one place and carries minor redundancy and ad-hoc styling drift._

- **[medium/positioning]** Launchpad audience leads with "Academic IT," drifting toward the university-IT buyer the Brief explicitly excludes
  - fix: Reorder "Who it fits" to lead with the research/engineering/department users (e.g. "Research labs, engineering and platform teams, workshops, and departments") and demote IT to the operator role rather than the lead audience, matching the overview path card.
- **[low/cta]** Overview hero has no primary action; two co-equal LinkButtons and the "Start here" card routes to pricing
  - fix: Make one hero action visually primary (or route the "Start here" hosted card to the sign-up/Start-on-CoCalc.ai action) and keep the other link clearly subordinate.
- **[low/do-not]** Product detail pages restate the same boundary/routing idea in the boundary card and a near-duplicate closing section
  - fix: Drop or compress the trailing closing section into a single reinforcing CTA bar, letting the boundary card carry the when-to-choose guidance once.
- **[low/density]** Overview site-licensing sentence packs a seven-item concern list into one line
  - fix: Split into a short lead sentence plus a tight bulleted or trimmed list of the procurement/governance concerns so it scans.
- **[low/consistency]** Ad-hoc styling inconsistencies in radius, font unit, and max-width across sibling elements
  - fix: Normalize the code box to borderRadius: 8 (or pull radius/size from theme tokens), use one unit (px or token) for inline font sizes, and align the stacked lead and note to the same max-width.

## feature-index
_A clean, scannable navigation hub free of banned superlatives, but the hero stays generic rather than research-forward, the decision-maker/operating-model route is missing and mislabeled as "platform integration," and a curated "Start with" panel repeats the top of the grid._

- **[medium/positioning]** Subhead promises a "platform integration" route that never renders, and frames the buyer as IT-integration
  - fix: Drop "platform integration" or replace it with the actual buyer route. Add a visible operating-model route on the index (e.g. a Compare-fit / "Decide how CoCalc should run" entry pointing to Compare operating models), so the second priority audience is actually routed, and make the subhead list match the sections that render.
- **[medium/do-not]** "Start with" panel duplicates the lead of the grid (same three destinations twice)
  - fix: Either cut the "Start with" panel, or make it genuinely additive (e.g. a single benefit-led entry that states the promise and routes to sign-up / compare) rather than re-listing the first three grid cards.
- **[low/copy]** Hero copy is generic and repetitive, not research-forward
  - fix: Tighten to one verb and add a grounding line for the user (per the playbook: benefit + who-it's-for). Drop "Use this index to choose" and let the subhead say who the routes are for and what each proves, instead of restating "choose the route."
- **[low/consistency]** Trailing-period inconsistency across sibling headings
  - fix: Remove the trailing period from the level-3 heading so headings are punctuated consistently.
- **[low/copy]** Automation in the AI group description is abstract, not a concrete workflow example
  - fix: Replace the generic automation clause with one concrete workflow shape (e.g. provision a project and run a notebook from a script, results land back in the project) or drop it and let the API/CLI cards carry the proof.

## ai
_The page proves AI/Codex as a reviewable, continuable proof surface and routes to sign-up, but it leans entirely into software-engineering debugging scenarios (under-serving the research co-primary), restates the same files/notebooks/terminals + durable-thread idea in nearly every section, and renders the buyer's designated secondary CTA as the weakest element in the close._

- **[medium/cta]** Buyer's secondary CTA (Compare operating models) is de-emphasized below tertiary links and out of brief order
  - fix: Render "Compare operating models" as a default `Button` (matching siblings) and order it directly after the primary CTA, ahead of the tertiary "Terminal workflows" / "Ask about AI workflows" links, so the buyer path keeps its secondary rank.
- **[medium/do-not]** Same files/notebooks/terminals + durable-thread idea is repeated in every section
  - fix: Let each section carry one distinct idea: keep the durable-thread/continuity point in ONE place (e.g. the ThreadMock or WorkflowStrip), and have section 3 and the ProjectContextList say something new rather than re-enumerating files/notebooks/terminals and re-asserting durability.
- **[medium/positioning]** Engineering-only examples leave the research/R&D co-primary with no concrete proof
  - fix: Swap or add at least one concrete example aimed at the research/R&D reader (e.g. reproducing an analysis, continuing a long-running computation, reviewing notebook results before handoff) so the named co-primary audience sees itself, and lead the hero subhead with the share/review/continue value rather than the agent name.
- **[low/consistency]** Sibling section titles mix terminal punctuation
  - fix: Pick one heading convention across sibling titles (all sentence+period, or all fragments) and apply it consistently.
- **[low/consistency]** Icon badge re-implemented three times at three different sizes instead of one shared component
  - fix: Give `IconBadge` a `size` prop and use it in WorkflowStrip and ProjectContextList so badge dimensions and accent opacities are defined once.

## jupyter
_The page serves the Brief well on the basics — research groups/classes/technical teams are named, teaching stays present-but-secondary, the buyer is routed to "Compare operating models" (not university-IT/LMS), the continuity proof leads, and there are no banned superlatives or category collapse — but the closing region over-stacks CTAs and the automation/agent surface is weighted heavier than the deploy/operating-model proof._

- **[medium/positioning]** Automation/agent (Codex) gets more dedicated UI than the deploy-anywhere proof
  - fix: Demote the agent material to a plain inline proof block (no standalone "See agent details" toggle/modal as an interactive affordance), keep the concrete CLI example as workflow shape, and give the deploy/operating-model routing at least equal weight so the third proof point reads as the buyer path it is.
- **[medium/cta]** Closing region stacks six buttons across two adjacent panels
  - fix: Consolidate: keep the single primary (Create account) clearly dominant, fold the left-column links into inline text or one "Explore" cluster, and avoid presenting six co-weighted buttons in the close.
- **[medium/density]** The "Choose the notebook path that fits" section states the same three routes three times
  - fix: Pick one carrier for the routing (the bullets), cut the paragraph's restatement to a single framing line, and let the adjacent panel be only the CTA without re-listing the routes.
- **[low/do-not]** Reviewability/"review history" repeated across hero, story card, and closing bullet
  - fix: Let the story card own reviewability; drop "review history" from the hero dependency list and the closing bullet so the idea lands once.
- **[low/consistency]** Ad-hoc type sizes and a one-off code-block style bypass shared tokens/components
  - fix: Use one lead-paragraph size token, drive section spacing from the parent gap (drop the ad-hoc marginBottom), and render the CLI example via the shared `CodeBlock` component for a consistent code style.

## python
_A clean, superlative-free Python-workflow page that leans research-coded (notebook → script → paper), but it restates one idea section-to-section, over-lists tools, and lets the closing CTAs and spacing drift, so it reads assembled rather than as one tightening argument._

- **[medium/do-not]** Same idea repeated across sections (do-not: don't repeat the same idea)
  - fix: Give each section a distinct beat rather than re-asserting the same one-project claim: e.g. hero = the workflow promise, map = the mechanics, use-cases = who it's for, close = where it runs / next step. Rename the map heading so it doesn't echo the hero, and let Codex appear once as a proof element.
- **[medium/density]** Long tool-inventory comma-lists hurt scannability
  - fix: Cap each list at 3-4 representative items, and remove the duplicated package-chip and terminal mocks so the same evidence isn't shown twice.
- **[medium/cta]** CTA hierarchy diluted at the close
  - fix: Keep one primary plus one clearly subordinate CTA per section. Make 'Compare operating models' the single secondary at the close and demote Linux/terminal/Ask to inline text links; trim the hero to the primary plus one low-commitment link.
- **[medium/consistency]** Close-section spacing inconsistent with the rest of the page
  - fix: Wrap the close column's children in a `<Flex vertical gap={...}>` matching the sibling sections so the heading, paragraph, and buttons breathe consistently.
- **[low/positioning]** Teaching leads the use-cases; co-primary research/engineering is under-foregrounded
  - fix: Lead the use-case row with the research/engineering case (reproducible analysis → paper, package-heavy work) and keep 'Teaching and teams' present but not first, so the co-primary audience sees itself first.

## linux
_A clean, scannable Linux-administration feature page that lands the reproducible/continuable-environment proof and routes correctly to sign-up + Compare operating models, but it leans teaching-first over the co-primary research/R&D reader, repeats the "don't risk your own machine" idea across hero and section 2, makes an unearned quality claim about the Codex automation surface, and has one real spacing-rhythm break in the closing section._

- **[medium/do-not]** Same "don't risk your own machine" idea is stated twice across sections
  - fix: Let section 2 own the sandbox/"don't risk your machine" idea, and change the hero's second paragraph to a different, non-overlapping facet of the proof spine — e.g. the environment-with-project / continue-a-teammate's-work benefit ("the environment lives in the project, so teammates can see how it was set up and return to a known-good state") rather than restating the same risk-avoidance point.
- **[medium/copy]** Unearned quality claim on the Codex automation surface
  - fix: Drop the "especially good at this kind of Linux work" judgment and keep only the workflow-shape description, e.g. "Codex can read the exact error, choose the right layer, run the command, and verify the package or binary is available" — the concrete steps already carry the point without the quality claim.
- **[medium/consistency]** Closing section's left column loses vertical rhythm (margin:0 children with no gapped wrapper)
  - fix: Wrap that Col's children in <Flex vertical gap={12}> (as the sibling sections do), so the heading, paragraph, and button row get the same spacing as the rest of the page.
- **[low/positioning]** Teaching/student framing consistently leads over the co-primary research/R&D reader
  - fix: Keep teaching present but stop always placing it first — lead at least the hero context line and one section with the research/engineering reader (e.g. "A research or engineering team can stand up a real Ubuntu environment... and students get the same without risking a laptop"), so a research lead feels the page is for them.
- **[low/copy]** Closing heading promises a choice it doesn't deliver, over a near tool-inventory line
  - fix: Rename the heading to match the content (e.g. "Your tools sit on a real project-local Linux system") and trim the six-item enumeration to the outcome, so the heading isn't read as a deploy/operating-model path choice and the line stops reading as a tool inventory.

## teaching
_The page correctly treats teaching as a respected secondary/pipeline audience and is clean of banned superlatives and invented metrics, but it states the single "keep admin in the LMS, run coursework in CoCalc" boundary idea on four-plus surfaces and leans on institutional/academic-IT framing, which dilutes the instructor/student user proof and makes the page feel like one point repeated._

- **[medium/do-not]** The LMS-vs-CoCalc boundary is repeated across four sections (one phrase verbatim)
  - fix: State the boundary once. Let the CourseBoundaryPanel be the single canonical place that draws it; collapse hero paragraph 2 and the entire section-2 ("Keep administration in the LMS...") into a one-line context cue, and stop repeating the rosters/calendars/announcements list. Reclaim the freed sections for a distinct idea (e.g. reproducible/continuable student work, or grading/recovery) so the page advances instead of restating.
- **[medium/consistency]** Secondary CTA labeled 'Compare product paths' diverges from the Brief's named CTA and every sibling page
  - fix: Rename both instances to "Compare operating models" to match the Brief's named secondary CTA and the site-wide convention; the route is already correct.
- **[low/positioning]** Page courts 'academic IT' and leads on the institutional boundary, drifting from the instructor/student user proof
  - fix: Drop "academic IT" as a named addressee (or demote it to a single supporting note) and re-anchor the lead on the instructor/student experience — running technical assignments, instructor visibility, grading, and recovery — keeping the LMS boundary as a one-line reassurance, not the spine of the page.
- **[low/density]** Closing planning-guides panel lists the same three guides twice (bullets + buttons)
  - fix: Pick one representation — either annotated link buttons OR a bullet list — not both. Reducing the close to the primary CTA plus a small subordinate set keeps tertiary links from competing for the eye.
- **[low/copy]** Hero subhead is a tool inventory mixing tools with capabilities
  - fix: Replace the inventory with a feature+outcome line, e.g. lead with what students do (run real assignments in a shared computing environment instructors can see and recover) and let the dashboard mock carry the breadth, rather than naming every surface in prose.

## compare
_A clean, on-brand decision-maker / fit-evaluation surface that correctly avoids competitor-naming and category collapse, but it restates the same CoCalc-vs-focused-tool comparison across two consecutive sections (plus a hero preview) and leans on templated phrasing, which undercuts the "one argument, no idea repeats, intentionally designed" bar._

- **[medium/do-not]** "The practical split" and "Decision checklist" restate the same comparison along the same axes
  - fix: Keep ONE comparison vehicle. Either collapse "The practical split" into the "Decision checklist" (the question-led rows are the stronger format), or make the split a 2-3 item gut-check that is NOT re-expanded below. Let the hero Quick read be the only TL;DR and stop re-listing the same five axes.
- **[medium/cta]** Three co-present hero CTAs exceed the two-CTA hero, and two duplicate the closing routes
  - fix: Reduce the hero to one primary ("Compare operating models") plus one subordinate action; drop "Pricing and licensing" and "Talk with CoCalc" from the hero since both already exist as routes in the closing "Where to go next" panel.
- **[low/copy]** Templated "A focused tool can work when..." stem repeated verbatim four times
  - fix: Vary the "other" sentences so each says something specific (e.g. "...when your artifacts already live in a stable repo", "...when review only happens at the end", "...when hosting is already decided") instead of leading every row with the same clause.
- **[low/consistency]** Section headings end with periods — a style used on no other feature page
  - fix: Drop the trailing periods on section titles to match the rest of the public site (D1 rhythm), or, if the full-stop voice is intentional, apply it consistently and record the choice in the decisions log.
- **[low/cta]** Page never surfaces the site's one primary action ("Start on CoCalc.ai")
  - fix: Acceptable as a buyer-routed page, but consider adding a single subordinate "Start on CoCalc.ai" at the close (the "Where to go next" panel) so the co-primary user audience has the site's one primary action available without competing with the operating-model route.

## pricing
_The pricing page serves the operating-model/procurement buyer cleanly — it keeps the operator boundary explicit (hosted "operated by CoCalc," dedicated hosts "not a private deployment path"), carries zero banned superlatives or invented metrics, and routes sign-up correctly to CoCalc.ai; a few redundancy, density, and type-scale nits remain._

- **[medium/do-not]** Site-licensing CTA and idea repeated verbatim across two sections
  - fix: Drop the site-licensing button from the hero and let the hero keep only the Brief's designated secondary CTA (`Compare operating models`); the dedicated Site licensing card below is the single home for that route. This removes the repeated idea and keeps one obvious site-licensing path.
- **[low/consistency]** Sibling section-lead paragraphs render at different type sizes (hardcoded 18 vs default)
  - fix: Pick one treatment for section-lead paragraphs and apply it to both (either both at the larger lede size or both at default), sourcing the value from a theme token rather than a bare `18`; convert the literal `gap={12}`/`marginTop: 16` to tokens for consistent rhythm (D1).
- **[low/density]** Site-licensing card body is a single run-on sentence with a long comma list
  - fix: Split into a short lead plus a tight scannable list, e.g. "Use site licensing when one organization needs a single agreement — procurement, governance, support, and rollout — or deployment rights across CoCalc.ai, Star, Launchpad, or Rocket." Move the long enumeration into a brief bulleted set if all items must stay.
- **[low/copy]** Hero signposts deploy options to the "buying paths below," but those cards don't contain them
  - fix: Point the reader to the correct surface, e.g. "...local, single-VM, and private-deployment options are on Compare operating models," so the signpost matches where the deploy ladder actually lives.

## api
_Serves the research/R&D + engineering co-primary audience well and correctly keeps the HTTP API as a proof surface with a concrete workflow example routing the buyer to "Compare operating models" — but it restates its core idea across three sections, opens with a tool-inventory headline, and breaks the sibling-page pattern by making "API documentation" (not a conversion CTA) the page's only primary action._

- **[medium/do-not]** Same "documented direct route, not browser scripting" idea repeated across the hero, a bullet, and an entire section
  - fix: Let the hero own the "documented, direct, not browser-scripting" claim once. Repurpose the third section to add a NEW idea (e.g. scoped API keys, scheduling, or where it runs) instead of restating the hero, and drop the closing card's prose recap of the hero CTAs (or replace it with genuinely new next-step content).
- **[medium/cta]** Hero's only primary action is "API documentation"; page has no conversion CTA and diverges from every sibling feature page
  - fix: Make the conversion CTA (Create account / Open projects) the hero's type="primary" button and demote "API documentation" to a secondary/default button, matching the sibling feature pages. This keeps one consistent primary action across the site and avoids giving the API/docs link the sole primary emphasis.
- **[low/do-not]** Tool-inventory hero headline, with the same tool list duplicated in the subhead
  - fix: Lead the H2 with the outcome (e.g. "Run and continue your work from your own code") and let a single subhead sentence name the surfaces once, rather than enumerating the same tools in both the headline and the subhead.
- **[low/consistency]** Ad-hoc gutter spacing: middle Row uses gutter 16 while the page's other Rows use 24
  - fix: Align the middle Row to the page's 24px gutter rhythm (or make the tighter card grid an intentional, shared token) so the spacing reads as designed rather than assembled (D1).

## julia
_On-pattern and technically clean (no banned superlatives, correct primary/secondary CTAs and routes, no invented metrics or SLA/source claims), but it under-serves the research-forward Brief by over-indexing on teaching and by repeating one idea — "Julia lives alongside other tools in a collaborative project" — across nearly every section instead of advancing the argument with concrete outcomes._

- **[medium/do-not]** The same "Julia lives in a collaborative project" idea repeats across hero, both middle sections, and the close
  - fix: Give the two middle sections distinct jobs. Keep one as the "which tool when" fit panel; repurpose the other to advance the argument the page is missing (e.g., a reproducible/continuable angle: a shared Julia package environment any collaborator or scheduled task can instantiate and pick up). Collapse the repeated Jupyter/Pluto/terminal inventory to one place rather than five.
- **[medium/copy]** Copy states where Julia runs but rarely the outcome ("so what")
  - fix: Add the "so what" to the hero and bullets: e.g., the environment is reproducible so a teammate can `instantiate` the exact package set and continue the work, or mixed Julia/Python/R analyses stay together so handoff doesn't require rebuilding setup. Pair every capability bullet with the outcome, as the sibling pages do.
- **[medium/positioning]** Teaching is over-weighted versus research for a research-heavy language
  - fix: Rebalance toward research/R&D for this language: lead the fit section with a research/scientific-computing scenario (shared package environments, mixed-language modeling, long-running jobs that a teammate can continue) and keep teaching present but as the secondary thread it is in the Brief, rather than the dominant one.
- **[low/density]** Run-on inline inventory hurts scannability in the fit paragraph
  - fix: Trim the sentence to the load-bearing point and let the adjacent ContextList carry the enumerated items, so the prose breathes instead of duplicating the visual list.

## octave
_It competently serves the teaching pipeline and routes the decision-maker via "Compare operating models," but it restates the same two ideas in every section and frames the co-primary research user as only "lightweight," so it reads thin rather than as one building argument._

- **[medium/do-not]** Same surface-inventory and "no local install" idea repeated in every section
  - fix: Give each section a distinct job: keep the surface list once (hero), then make OctaveFlow about reproducible/continuable work (history, shared environment) and the bottom band about who it's for / fit, instead of re-listing notebooks+terminals+.m files. Compare with the R page, which varies each section (reproducible reporting, Quarto/Knitr/LaTeX, mixing with Python) instead of restating one list.
- **[low/positioning]** Research audience framed only as "lightweight," diminishing a co-primary user
  - fix: Keep teaching prominent (correct for Octave) but drop the diminishing "lightweight" qualifier from the research mentions, or replace with a neutral phrasing (e.g. "numerical research and prototyping") so a research reader isn't told up front this isn't for them.
- **[low/copy]** Hero H2 is a tool-surface list with no outcome in the headline
  - fix: Fold an outcome into the H2 (e.g. lead with running Octave online without local installs, or teaching/sharing a common setup) so the headline states a benefit, not just where Octave runs; let the subhead keep the surface detail.

## latex
_The page serves the research/R&D and technical-team audience well — a benefit-led, research-forward hero, superlative-free copy, and correctly routed CTAs — but the middle of the page restates one idea (keep paper + computation together so collaborators can review) several times, and a couple of small layout/style inconsistencies break the rhythm._

- **[medium/do-not]** Section 3 states the same writing loop three times (paragraph + both bullet lists)
  - fix: Collapse §3 to one expression of the loop: keep the lead paragraph + ONE supporting list. Drop the right ComputationWritingLoop card (or merge its two unique-enough lines into the left list) so the section makes its point once. Trim the cross-section overlap so the hero/§2 'one project' enumeration isn't re-listed a third time in §3.
- **[low/consistency]** Section 3 grid row only fills 22 of 24 columns
  - fix: Set the §3 columns to sum to 24 (e.g. `lg={12}` + `lg={12}`, or `lg={14}` + `lg={10}`) to match the other rows.
- **[low/consistency]** Same 'Read the LaTeX guide' action rendered with two different button styles
  - fix: Pick one treatment for the guide link and use it in both places (a secondary Button in both, or a LinkButton in both), so the repeated action has a consistent visual weight.

## whiteboard
_A clean, on-brief feature page: benefit-led hero, no banned superlatives, no category-collapse, correct primary CTA and a subordinate "Compare operating models" route — but the capability inventory is restated across three sections, with one bullet repeated almost verbatim._

- **[medium/do-not]** Capability list repeated across sections (infinite-canvas/pages bullet near-verbatim twice)
  - fix: Let each section carry one idea: keep the hero's capability summary, give the ExecutionGraph section its distinct graph-execution point only, and make the final "When a whiteboard belongs in CoCalc" list about decision/fit (use cases) rather than re-listing features. Delete the duplicate infinite-canvas/multiple-pages bullet so it appears once.
- **[low/copy]** Internal editor-library name ("Slate-based") leaks into public copy; bullet is feature-only
  - fix: Drop the framework name: "Use markdown and rich text for explanations." and, where space allows, add the outcome (e.g. why editable text/math next to code matters) instead of just naming the capability.
- **[low/consistency]** "Directed graph / not naturally linear" claim contradicted by a strictly linear illustration
  - fix: Either adjust the copy to match (a linear data→clean→fit→plot pipeline) or change the mock to actually show branching/fan-out (a real directed graph) so the claim and the illustration agree.

## slides
_A clean, on-brief feature page: it frames slides as part of the continuous technical workspace for lectures/research talks/demos, keeps one primary sign-up CTA plus the decision-maker "Compare operating models" route, and carries zero banned superlatives or invented proof — its main weakness is that the "slides are whiteboards" idea is restated several times._

- **[medium/do-not]** The "slides are whiteboards" idea repeats across the hero, the flow section, and the bullets
  - fix: Keep the equivalence stated once (the hero). Re-cut the SlideFlow heading/paragraph to lead with what that section actually adds — the build sequence (choose size, write, add code/math, present) — e.g. a title about how a deck comes together, and drop the second restatement of "slides = whiteboards." Vary the bullet so it doesn't echo "slide-sized whiteboard pages" a fourth time.
- **[low/copy]** "the same technical canvas ideas as whiteboards" is vague filler, not a concrete capability
  - fix: Replace "the same technical canvas ideas" with the concrete shared capability, e.g. "the same free-form canvas — math, diagrams, code, and drawings placed anywhere — but organized into ordered slide pages," so the engineer reads a real feature instead of a summary.
- **[low/consistency]** Inconsistent heading margins between sibling section titles
  - fix: Make the two `level={3}` section headings consistent — apply the same `margin` treatment (e.g. `style={{ margin: 0 }}`) to the "When slides belong in CoCalc" title so section spacing is uniform.
