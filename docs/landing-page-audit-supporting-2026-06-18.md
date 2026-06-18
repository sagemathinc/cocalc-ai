# Supporting-pages audit — 2026-06-18 (frozen-Brief + D1, workflow w1or930j3)

> 9-agent audit of the public supporting pages. 0 high, 16 medium, 29 low.
> Dominant theme: design-system drift (ad-hoc fontSize/color/cards predating D1) + the about page's bios (banned superlatives, internal jargon, flowery prose).

## about  (9)
_A credible team/about page that correctly uses the shared shell and components and routes back into the funnel on its main view, but its bios carry banned superlatives, internal marketing jargon, and over-written filler, and a few spots diverge from the design tokens._

- **[medium/hygiene]** Banned superlatives rendered in team bios
  - fix: Reword without the banned words, e.g. 'front-end and back-end development and maintenance for Sage and CoCalc' and 'an admirer of its underlying algorithms' / 'its capable algorithms'.
- **[medium/hygiene]** Internal sales/marketing jargon leaked into a public bio
  - fix: Rewrite in plain, outward-facing terms (e.g. 'helping more researchers and teams discover CoCalc, including outreach at conferences and online'), or trim entirely.
- **[medium/tone]** Over-written, flowery prose undercuts a credible 'about' tone
  - fix: Keep some personality but dial back the hyperbole: drop 'math prodigy', 'tech torchbearer', 'with gusto', 'cryptic brethren', etc., favoring concrete, plain statements of what each person does.
- **[medium/consistency]** Raw <h2> event headers bypass the antd Title type scale
  - fix: Replace the raw <h2> elements with <Title level={2}> (or render the two event groups via PublicSection's title prop), removing the inline marginBottom.
- **[low/consistency]** Ad-hoc inline styling diverges from the design tokens
  - fix: Use PUBLIC_RADIUS.media (12) for image corners, PUBLIC_TYPE.caption / PUBLIC_WEIGHT.bold for the date, and PUBLIC_COLORS.mutedText (already aliased via MUTED_STYLE) for the icon color.
- **[low/density]** Dense bio paragraphs read as walls of text
  - fix: Split the longest background paragraphs into shorter ones and trim redundant clauses so the profiles scan top-to-bottom.
- **[low/routing]** Profile 'GitHub' links point to the company repo, not the person
  - fix: Point each person's GitHub social link to their personal profile, or drop the icon for members without a personal GitHub rather than reusing the company repo URL.
- **[low/copy]** Card and profile bios repeat the same sentences
  - fix: Differentiate cardText (short teaser) from background (full story) so the profile page does not echo its grid-card text.
- **[low/routing]** Team/profile/event sub-routes dead-end without a next step
  - fix: Render <PublicNextStep authenticated={...}/> at the bottom of the dedicated about sub-routes too, matching the main about view.

## support-community  (6)
_A clean, on-tone utility page whose copy and hygiene are fine, but it diverges from the shared grid/external-link conventions and pads each card with a redundant eyebrow and identical "Open" CTA._

- **[medium/consistency]** Card grid is hand-rolled CSS grid instead of the shared PublicGrid
  - fix: Wrap the three tiles in `<PublicGrid columns={3}>` instead of the inline CSS grid so the column/responsive rhythm matches the rest of the site. (Also consider PublicCard rather than a bare PublicSection per tile, since PublicSection is a semantic <section> with no border/elevation; the sibling SupportCard at least adds a card-like wrapper.)
- **[medium/routing]** External channel links open in the same tab with no target/rel
  - fix: Add `target="_blank" rel="noreferrer"` to the external link buttons so the page keeps the visitor's session on-site, matching the rest of the public pages.
- **[low/density]** Identical "COMMUNITY" eyebrow repeated on every card
  - fix: Drop the per-card eyebrow (the page H1 already sets the context), or replace it with something that differentiates the tile (e.g. CODE / SOCIAL).
- **[low/routing]** Three CTAs all labeled just "Open"
  - fix: Give each button a distinguishing label or aria-label (e.g. "Open on GitHub", "Open LinkedIn"), reusing item.title.
- **[low/consistency]** Intro paragraph uses an inline fontSize literal instead of the type token
  - fix: Use `fontSize: PUBLIC_TYPE.body` (importing the token), or drop the inline size since 16 is already close to the page default, so a paragraph is never an ad-hoc px value.
- **[low/copy]** Intro tells the visitor to "open a direct support ticket" but provides no link
  - fix: Make "open a direct support ticket" a link to the support/new (or support index) route so the dangling instruction is actionable from where it's stated.

## guides  (6)
_A clean, professional guides-index page that does its utility job and carries no banned superlatives, but it repeats the "guides vs docs" idea across three sections, triplicates its CTAs, ships a literal-backtick rendering artifact, and diverges from sibling supporting pages on design-system reuse and funnel routing._

- **[medium/copy]** Literal markdown backticks render as visible characters in a guide card
  - fix: Drop the backticks and write ".term files" in plain prose (the surrounding bodies use no code formatting), or render the body through the shared Markdown component if inline code styling is actually wanted. Plain prose is the simpler, consistent choice here.
- **[medium/density]** The "guides vs docs" distinction is restated across three sections
  - fix: Say the guides-vs-docs split once. Keep it in the hero subtitle (where it sets up the page) and delete or repurpose the standalone "Guides and docs work together" section so the page reads as one argument, not the same point three times.
- **[medium/routing]** CTAs are triplicated and the page ends on a tacked-on bare button row
  - fix: Collapse to one obvious next step per destination. Keep the hero's primary "Open all guides" + a docs link; drop the trailing title-less `PublicSection` (lines 409-416), folding "Browse workflow features" into a single closing section if it is needed at all.
- **[low/routing]** Page dead-ends and never routes back toward the funnel, unlike sibling supporting pages
  - fix: End the page with the shared `PublicNextStep` (from public/common) like about/news/docs do, so a reader who finished evaluating workflows has a clear next step into the funnel and the close matches the rest of the site.
- **[low/consistency]** Ad-hoc icon and elevation styling diverges from the shared design system
  - fix: Reuse `IconBadge` (sizes sm/md already match the intended 36-46 boxes) and use `PUBLIC_ELEVATION.hover` for the card hover shadow instead of the raw rgba(33,49,57) literal, so guides matches the tokenized elevation/icon treatment used elsewhere.
- **[low/hygiene]** "Agent sandbox cloud" card leans into a category-collapse-adjacent framing
  - fix: Reframe the card around the durable collaborative project benefit rather than the "agent sandbox cloud" category label (e.g. "A durable project where people and agents work together"), keeping the link target but losing the category-collapse phrasing.

## support  (5)
_A clean, on-job support hub: hygiene is solid (no banned superlatives, no category-collapse, no leaked internal/compliance copy, no invented proof) and it routes well into the funnel; the issues are design-system divergence, not positioning._

- **[medium/consistency]** Bespoke SupportCard bypasses the shared PublicCard and uses ad-hoc inline typography instead of the type scale
  - fix: Render each support tile with the shared `PublicCard` (antd Card + `title`, which already styles the head via PUBLIC_COLORS.heading and the display font), or at minimum replace literal px/weight/color with PUBLIC_TYPE / PUBLIC_WEIGHT / PUBLIC_COLORS tokens and use an antd <Title>/<Text> for the tile title. Also note that wrapping each grid cell in `PublicSection` (a semantic `<section>` without aria-label) is the wrong primitive for a card.
- **[medium/consistency]** Hardcoded hex color literals in the non-default-branding callout box
  - fix: Replace the literals with PUBLIC_COLORS tokens (e.g. background brandTint/surfaceMuted, border brandSubtle, text brand/heading) and `fontSize: PUBLIC_TYPE.caption`, so the callout matches the rest of the public site rather than raw antd blue.
- **[low/consistency]** Inconsistent CTA affordance within one card grid (Buttons vs bare text links)
  - fix: Pick one affordance for the tile action — e.g. a default Button for every card's primary action — so the grid is visually consistent; if a plain link is intentional, use a single shared link style/Typography.Link rather than inline COLORS.BLUE_D.
- **[low/density]** Index intro is a single run-on sentence, hurting scannability
  - fix: Split into a short lead plus the tile labels carrying the specifics, or break into two sentences and drop the self-referential "clarifying support" so the sentence isn't about using support to ask about support.
- **[low/consistency]** Body copy hardcodes "CoCalc" while the component computes siteName for titles
  - fix: Thread the already-available `siteName` through the index/card copy (as the rest of the shell does via getSiteName) instead of hardcoding "CoCalc". Harmless for cocalc.ai itself, but it's an internal inconsistency in the same file.

## support-new  (5)
_A clean, helpful, appropriately-scoped support ticket form with correct tone and no superlative/metric hygiene problems; the issues are design-system divergences (ad-hoc type/color instead of the PUBLIC_TYPE/COLORS tokens the rest of the public site uses) plus a heading that duplicates the shell's page title._

- **[medium/consistency]** View renders an H2 that duplicates the shell's H1 page title
  - fix: Drop the duplicate H2 (let the PublicPage H1 be the page title) or, when initial.title deep-links a distinct heading, render it as a sub-section heading with different text; and use `siteName` instead of the literal "CoCalc" in the fallback so white-labeled sites stay consistent.
- **[medium/consistency]** Ad-hoc inline fontSize on text instead of the PUBLIC_TYPE scale
  - fix: Import PUBLIC_TYPE (and PUBLIC_WEIGHT) from public/theme and replace literal `fontSize: 16` with `fontSize: PUBLIC_TYPE.body` / the SectionLabel size with a token, matching the rest of the public site.
- **[low/consistency]** Status indicator hardcodes raw palette hex + ad-hoc weights instead of COLORS tokens
  - fix: Derive the done/pending colors from COLORS/PUBLIC_COLORS (success/warning) and use PUBLIC_WEIGHT.bold rather than inline hex and 700.
- **[low/tone]** "Helpful links" rendered as a warning-styled (yellow/caution) Alert
  - fix: Use `type="info"` (or a plain bordered block) for the Helpful links list; reserve the warning style for actual cautions.
- **[low/hygiene]** Banned word-family ("easier") in instructional copy
  - fix: Optional: reword to avoid the banned family, e.g. "Attaching relevant projects and files helps us understand and resolve your problem faster" — or leave as-is if utility-context uses of the word are considered out of scope for the ban.

## docs  (4)
_A clean, well-routed docs hub that reuses the shared shell and the standard next-step funnel and carries no banned-superlative or pitch-language hygiene problems; the only real issues are design-system divergence (a hardcoded, mis-spelled brand name and ad-hoc type sizing instead of the PUBLIC_TYPE tokens)._

- **[medium/consistency]** Brand rendered as hyphenated "CoCalc-ai" (vs site-wide "CoCalc.ai"), and hardcoded instead of the dynamic siteName
  - fix: In /home/user/cocalc-ai/src/packages/frontend/public/docs/app.tsx use the already-computed `siteName` instead of the literal: eyebrow `{siteName} documentation` and `These docs are served by {siteName} itself, ...`. If a literal must stay, spell it "CoCalc.ai" to match the rest of the site (e.g. the "Start on CoCalc.ai" CTA in PublicNextStep).
- **[medium/consistency]** Lead paragraph uses an ad-hoc fontSize: "1.125em" instead of the PUBLIC_TYPE.lead token
  - fix: Import PUBLIC_TYPE from ../theme and set `fontSize: PUBLIC_TYPE.lead` (matching products/app.tsx and the features pages).
- **[low/consistency]** Hero header is hand-rolled and diverges from the canonical eyebrow/title pattern
  - fix: Add `fontSize: PUBLIC_TYPE.eyebrow` and `letterSpacing: 0` to the eyebrow Text, and drop the hand-set Title margins (use `margin: 0` and let the surrounding `<Flex gap="large" vertical>` handle spacing) so the docs header matches the rest of the site's hero blocks.
- **[low/copy]** H1 leans on infra-jargon ("instance") for a public docs hub heading
  - fix: Consider a plainer heading such as "Documentation" (or "Documentation for this deployment"), drop the trailing period, and let the existing lead paragraph carry the "matches this instance/version" nuance.

## news  (4)
_A clean, correctly-wired supporting page: it uses the shared PublicSectionShell/PublicGrid/antd Title, links to real RSS+JSON feed endpoints, and routes back into the funnel via the canonical PublicNextStep — only minor polish issues remain (label casing, one ad-hoc font size, an awkward channel tooltip, and the article view omitting the funnel CTA)._

- **[low/consistency]** Channel filter labels and tag chips render lowercase, inconsistent with the title-cased "All" option
  - fix: Display channel names capitalized for the user (e.g. capitalize the label in the segmented `options` map and in the `<Tag>`), keeping the underlying lowercase `value`/`item.channel` for filtering. This makes the control read "All | Feature | Announcement | Platform | About | Event".
- **[low/consistency]** Ad-hoc inline fontSize on the markdown preview diverges from the PUBLIC_TYPE scale
  - fix: Drop the inline `fontSize` (or map the preview to a PUBLIC_TYPE token, e.g. caption/body) so card previews use the shared type scale instead of an arbitrary rem value.
- **[low/copy]** Awkward "In one's own behalf" channel description surfaces as the 'about' filter tooltip
  - fix: Reword the 'about' channel description to something a visitor understands, e.g. "Company news and updates about CoCalc", so the rendered tooltip is clear and idiomatic.
- **[low/routing]** News article (detail) view dead-ends without the funnel CTA the list page has
  - fix: Render `<PublicNextStep authenticated={...} />` at the bottom of NewsDetailPage too (as the list page does), so deep-linked articles route back into the funnel rather than only offering "Back to news".

## policies  (4)
_A clean, professional, scannable policy/trust index that uses the shared design primitives, routes correctly into products/pricing/support, and carries no banned superlatives or invented proof; only minor consistency and copy-redundancy nits._

- **[low/consistency]** Next-step section diverges from the shared PublicNextStep used by every other supporting page
  - fix: Either adopt <PublicNextStep authenticated={...}/> (optionally after the tailored cards) so the closing next-step matches the rest of the site, or consciously keep the policy-specific variant and record it as a deliberate exception. Routing isn't broken — this is a cross-page coherence divergence (D1).
- **[low/copy]** Card title and bold label restate the same action in the evaluation cards
  - fix: Drop the redundant bold label (the body line + clickable card title already carry the action), or let the label be the only action phrase and simplify the card title so the two don't echo each other.
- **[low/consistency]** Hand-rolled bordered panel bypasses the design-system radius/elevation tokens
  - fix: Reuse PublicCard or a shared panel, and reference PUBLIC_RADIUS.panel instead of the literal 8, so this surface tracks the design system rather than re-defining spacing/radius inline.
- **[low/consistency]** Gate/empty state skips a heading level (h1 → h3)
  - fix: Use level 2 for these gate/empty-state headings (or pass them through PublicSection's `title`) to keep the heading hierarchy consistent and accessible.

## trust  (2)
_A clean, on-brand compliance page that correctly reuses the policy design system (PolicySection/antd Title, A, policyHref) with no banned superlatives; the only issues are two precision/tone slips in the SOC 2 paragraph that slightly undercut the exactness a trust page needs._

- **[medium/tone]** SOC 2 paragraph overstates what the attestation guarantees
  - fix: On a page whose whole job is precision, soften the guarantee language: SOC 2 attests that controls were suitably designed and operating over a period, it does not "ensure" effective protection. Reword to e.g. "...independent audits that assess our controls across the Trust Services Criteria." Also confirm the report actually covers all five categories listed (Security is required, the other four are optional) before naming them, otherwise the list implies broader scope than the report holds. Per the Brief, trust/compliance wording routes through Andrey for sign-off.
- **[low/copy]** Salesy filler sentence on a precision page
  - fix: Cut the sentence. It restates nothing concrete and reads as vendor puffery ("enhances trust and reliability") of exactly the kind the copy playbook says erodes credibility with a skeptical reader. The adjective stack ("rigorous standards" / "high standards") can be trimmed to one. End the paragraph on the factual Trust Center pointer instead.
