---
description: Deterministic check for a public-site route — canaries + lint/typecheck + scoped browser-QA.
argument-hint: <route>
---

Route: $ARGUMENTS

Run the deterministic floor (this does NOT judge design):

1. From `src/packages/frontend`: focused C1 canary tests —
   `pnpm exec jest public/__tests__` plus the touched route's own test if any.
2. `pnpm -C /home/user/cocalc-ai/src lint:frontend` and a package typecheck for the touched
   package.
3. Scoped screenshot + assertion pass:
   `node src/packages/frontend/scripts/public-site-browser-qa.mjs --route $ARGUMENTS --viewport desktop --viewport mobile`

Report PASS/FAIL with the failed assertions (broken CTA route, horizontal overflow, leaked
internal phrase). Green here is a floor, not design approval — the human visual gate still
owns taste.
