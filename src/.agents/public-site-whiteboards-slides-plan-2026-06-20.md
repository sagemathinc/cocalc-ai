# Public Site Plan — Whiteboards and Slides IA

Created: 2026-06-20 13:40 PDT  
Worktree: `/home/user/cocalc-ai-synthesis`  
Branch: `blaec-synthesis-2026-06-18`  
Owner: Codex public-site driver  
Status: implemented; awaiting Blaec visual review

## User Problem

`/features/whiteboard` is visibly titled "Whiteboard and Slides", while
`/features/slides` is also a separate full feature page. A visitor can reasonably
interpret these as two peer destinations and wonder which one is canonical.

## Research Notes

- Current feature index group "Notebooks and writing" already includes only
  `whiteboard`, not `slides`, but the catalog still marks both `slides` and
  `whiteboard` with `index: true`.
- `/features/whiteboard` already has the combined hero promise:
  "Whiteboards and slides for math, code, and collaboration."
- `/features/slides` is clean as a detail page, but it repeats the same
  "slides are slide-sized whiteboards" equivalence that the combined page should
  own.
- Prior audit (`docs/landing-page-audit-2026-06-17.md`) found both pages
  individually on-brief, with the main weakness being repetition of the
  slides/whiteboard equivalence.
- App-server template language already groups the public sharing preset as
  "Public Slides and Boards" / "Slides and whiteboards", supporting one combined
  discovery surface.
- The home page routes only to `/features/whiteboard`, so the broader site
  already treats it as the public discovery path.

## Decision

Keep `/features/whiteboard` as the canonical combined route and make it represent
whiteboards and slide decks equally. Keep `/features/slides` available for deep
links and visitors who specifically need slide-deck details, but stop presenting
it as a peer feature discovery card.

Do not add a new `/features/whiteboards-and-slides` route in this round. That
would add redirect and SEO surface area without solving more user confusion than
the stable canonical route already solves.

## Burn-Down Actions

### WSS-1 — Canonical Feature Index and Metadata

Status: done

Result:

- `slides` is no longer indexed as a feature discovery card.
- The canonical catalog title is now "Whiteboards and Slides".
- Public metadata uses balanced whiteboards/slides language.
- The feature-index test now asserts `/features/whiteboard` is discoverable and
  `/features/slides` is not.

Evidence:

- `catalog.ts` currently has both `slides` and `whiteboard` with `index: true`.
- Feature index group currently includes only `whiteboard`, so marking `slides`
  non-indexed aligns the catalog with the rendered IA.

Plan:

- Set the `slides` catalog entry to `index: false`.
- Rename visible `whiteboard` catalog title to "Whiteboards and Slides".
- Update public-route metadata so the canonical route has plural, balanced
  naming.
- Keep `/features/slides` metadata available for direct route rendering.
- Add/adjust tests so `/features` links to `/features/whiteboard` and does not
  surface `/features/slides` as a discovery card.

Expected result:

- The feature index has one discoverable card for the combined canvas/presentation
  workflow.
- Deep links to `/features/slides` still render.

### WSS-2 — Canonical Combined Page Content

Status: done

Result:

- `/features/whiteboard` now includes a dedicated slide-deck section with the
  slide-deck visual from the focused Slides page.
- The hero's "Slide decks" action now scrolls within the canonical page instead
  of immediately sending visitors to the secondary route.
- The final CTA names both board and deck creation.
- The final panel no longer repeats the "More about slide decks" CTA, since the
  dedicated slide-deck section already owns that next step.

Evidence:

- `/features/whiteboard` currently has strong whiteboard/computation content but
  only mentions slide-sized pages; it does not show the slide-deck visual flow
  from `/features/slides`.
- User specifically wants a page that "actually represents both equally."

Plan:

- Reuse the slide-deck visual/flow from `slides-page.tsx` on the canonical
  `/features/whiteboard` page instead of duplicating a second route conceptually.
- Keep the hero as the single equivalence statement.
- Ensure each section has one job:
  - hero: combined promise,
  - execution graph: computational whiteboard use,
  - slide flow: presentation/deck use,
  - final fit section: choose board/deck use cases and next steps.
- Remove or demote hero-level links from the combined page to `/features/slides`
  so the visitor is not immediately sent back into the confusion.

Expected result:

- `/features/whiteboard` feels like the overview for both workflows, not a
  whiteboard page with incidental slides.

### WSS-3 — Secondary Slides Route Treatment

Status: done

Result:

- `/features/slides` remains routable.
- Its internal overview CTAs now say "Whiteboards and slides overview" instead
  of the narrower "Whiteboard".
- The slide-specific support CTA remains unchanged.

Evidence:

- Direct `/features/slides` route is useful for old links and visitors who ask
  specifically about presentations.
- If it remains visually identical in hierarchy, the confusion can persist for
  visitors who arrive directly.

Plan:

- Keep the route available.
- Make its internal CTAs point back to the combined route using language like
  "Whiteboards and slides overview" instead of just "Whiteboard".
- Keep slide-specific support CTA because the route is still about slide decks.
- Avoid broad redirects this round.

Expected result:

- A visitor who lands on `/features/slides` understands it is the slide-deck
  detail page under the broader whiteboards/slides feature.

### WSS-4 — Tests and Browser QA

Status: done

Progress:

- Focused feature Jest passed: `public/features/__tests__/app.test.tsx` (86 tests).
- `lint:frontend` passed.
- `packages/static build:dev` passed.
- Desktop browser QA passed on `/features`, `/features/whiteboard`, and
  `/features/slides` (56 assertions / 0 failures).
- Mobile browser QA passed on `/features/whiteboard` and `/features/slides`
  (33 assertions / 0 failures).
- Desktop and mobile screenshots were reviewed from the QA artifacts and show the
  canonical page as: whiteboard canvas, directed Jupyter graph, slide decks, then
  board/deck CTA.

Evidence:

- `public/features/__tests__/app.test.tsx` includes route-specific canaries for
  both routes.
- `public-site-browser-qa.mjs` directly tests `/features/slides` under the
  feature-details group.

Plan:

- Update canaries only where the IA changes require it.
- Keep direct `/features/slides` route tests.
- Add a negative feature-index assertion for `/features/slides` if the existing
  tests do not already prove it.
- Run focused feature tests, `lint:frontend`, static build, and browser QA for
  `/features`, `/features/whiteboard`, and `/features/slides`.

Expected result:

- The IA change is protected without pinning exact copy unnecessarily.

### WSS-5 — Preview and Handoff

Status: done

Result:

- Rebuilt the preview bundle from `/home/user/cocalc-ai-synthesis`.
- Verified the live hub owner by `/proc`: pid `13303`, cwd
  `/home/user/cocalc-ai-synthesis/src`.
- Recovered preview ownership during the round after `blaec.cocalc.ai` was found
  serving the platform hub again; stopped the platform hub and restarted the
  synthesis hub.
- Updated this plan and the active-agent ledger.
- No PR created.

Plan:

- Rebuild the preview bundle from the synthesis worktree only.
- Verify the hub owner by `/proc`.
- Run live content checks on the canonical and secondary routes.
- Update this plan with final statuses and residual risks.
- Update `src/.agents/active-agent-handoff.md`.
- Commit and push the branch checkpoint. Do not create a PR.
