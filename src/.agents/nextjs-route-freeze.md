# Next.js Route Freeze

Current snapshot: 2026-03-25

This is the route-inventory ledger for removing `@cocalc/next` from the active
stack. Every route family under [next/pages](/home/wstein/build/cocalc-lite4/src/packages/next/pages)
must end up in exactly one of these buckets:

- `port`: keep the route and serve it from the new public web layer
- `replace`: keep the user-facing capability, but not as a 1:1 Next page port
- `delete`: remove the route with no replacement in the new stack
- `keep server-only`: keep the behavior, but as a non-Next server route

Status meanings:

- `done`: already off Next in the current tree
- `partial`: some or most of the family is off Next, but parity is incomplete
- `not started`: still effectively Next-owned
- `decision needed`: route family is ambiguous and needs an explicit product call

## Frozen Route Inventory

| Route family | Next sources | Final disposition | Current status | Target owner | Notes |
| --- | --- | --- | --- | --- | --- |
| Next framework internals | `_app.tsx`, `_document.tsx`, `404.tsx` | `delete` | `partial` | none | These disappear once active page serving is off Next. |
| Root landing page | `index.tsx` | `port` | `partial` | `frontend/public/home` | `/` is live off Next, but old landing-page parity is not complete yet. |
| About overview | `about/index.tsx`, `about/events.tsx`, `about/team/index.tsx` | `port` | `partial` | `frontend/public/content` | `/about`, `/about/events`, and `/about/team` are live off Next. |
| Individual team pages | `about/team/andrey-novoseltsev.tsx`, `about/team/blaec-bejarano.tsx`, `about/team/harald-schilly.tsx`, `about/team/william-stein.tsx` | `port` | `not started` | `frontend/public/content` | These should become real public content pages if we want true route parity. |
| Feature index and detail pages | `features/index.tsx`, `features/ai.tsx`, `features/api.tsx`, `features/compare.tsx`, `features/i18n.tsx`, `features/icons.tsx`, `features/julia.tsx`, `features/jupyter-notebook.tsx`, `features/latex-editor.tsx`, `features/linux.tsx`, `features/octave.tsx`, `features/openai-chatgpt.tsx`, `features/python.tsx`, `features/r-statistical-software.tsx`, `features/sage.tsx`, `features/slides.tsx`, `features/teaching.tsx`, `features/terminal.tsx`, `features/whiteboard.tsx`, `features/x11.tsx` | `port` | `partial` | `frontend/public/features` | Core routing is live off Next. `compare` is still not really ported, and some pages still need deeper content parity. |
| Basic auth pages | `auth/sign-in.tsx`, `auth/sign-up.tsx`, `auth/password-reset.tsx` | `port` | `partial` | `frontend/public/auth` | Public auth shell is live, but full parity with the old pages is not done. |
| Auth completion flows | `auth/password-reset/[id].tsx`, `auth/password-reset-done.tsx`, `auth/verify/[token].tsx` | `port` | `not started` | `frontend/public/auth` | These are still missing from the new public-web layer. |
| SSO overview and detail | `sso/index.tsx`, `sso/[id].tsx` | `port` | `not started` | `frontend/public/auth` or `frontend/public/sso` | Should use `api/v2/auth/sso-strategies` for discovery. |
| Public support core | `support/index.tsx`, `support/new.tsx`, `support/tickets.tsx` | `port` | `done` | `frontend/public/support` | These routes are already live off Next. |
| Support community | `support/community.tsx` | `port` | `not started` | `frontend/public/support` | Keep this route in the new public web layer. |
| Support ChatGPT page | `support/chatgpt.tsx` | `delete` | `not started` | none | Explicitly remove this route instead of carrying it forward. |
| Public news | `news/index.tsx`, `news/[id].tsx`, `news/[id]/[timestamp].tsx`, `news/rss.xml.tsx`, `news/feed.json.tsx` | `port` | `done` | `frontend/public/content` + hub server routes | Public list/detail/feed routes are already off Next. |
| News editing | `news/edit/[id].tsx` | `replace` | `not started` | app-native admin/editor surface | This is not a public content page. It should move into an admin/app flow if we keep it. |
| Policy landing pages | `policies/index.tsx`, `policies/imprint.tsx`, `policies/policies.tsx` | `port` | `partial` | `frontend/public/content` | The top-level routes are already live off Next. |
| Remaining policy detail pages | `policies/accessibility.tsx`, `policies/copyright.tsx`, `policies/enterprise-terms.tsx`, `policies/ferpa.tsx`, `policies/privacy.tsx`, `policies/terms.tsx`, `policies/thirdparties.tsx`, `policies/trust.tsx` | `port` | `not started` | `frontend/public/content` | Still missing from the public-web layer. |
| Pricing pages | `pricing/index.tsx`, `pricing/courses.tsx`, `pricing/institutions.tsx`, `pricing/onprem.tsx`, `pricing/products.tsx`, `pricing/subscriptions.tsx` | `replace` | `not started` | public-web | These should be rebuilt around the simplified commerce model, not ported verbatim. |
| Redeem pages | `redeem.tsx`, `redeem/[id].tsx` | `replace` | `not started` | public-web or app-native | Route family still needed, but exact UX owner should follow the simplified commerce design. |
| Voucher pages | `vouchers/index.tsx`, `vouchers/[id].tsx`, `vouchers/admin.tsx`, `vouchers/created.tsx`, `vouchers/notes.tsx`, `vouchers/redeemed.tsx` | `replace` | `not started` | app-native voucher center | These should move into the main app, not stay as Next pages. |
| Billing and store catchalls | `billing/[[...page]].tsx`, `store/[[...page]].tsx` | `replace` | `not started` | app-native billing/purchases | The old cart/store model is explicitly not being ported. |
| Named account / project / public path pages | `[owner].tsx`, `[owner]/[project].tsx`, `[owner]/[project]/[...public_path].tsx` | `delete` | `not started` | none | These old public-path routes go away with the old share/public-path model. Custom subdomains, if kept, are a separate feature. |
| Share server pages | `share/index.tsx`, `share/accounts/[account_id].tsx`, `share/projects/[project_id].tsx`, `share/public_paths/[...id].tsx` | `replace` | `not started` | static app servers / public viewer | This is the main hard blocker. Current plan is to replace, not port. |
| Legacy config pages | `config/index.tsx`, `config/[...page].tsx` | `replace` | `not started` | server redirect or app redirect to `/settings/*` | These are already marked deprecated in the Next implementation. |
| `/.well-known/change-password` | `.well-known/change-password.tsx` | `keep server-only` | `not started` | hub/server redirect | Should become a tiny server redirect to the new password-change path. |
| Info pages | `info/index.tsx`, `info/doc.tsx`, `info/run.tsx`, `info/status.tsx` | `replace` | `not started` | public-web content folded into `/about` and `/support` | Keep the information, but fold it into the new public content surface instead of preserving `/info/*` as-is. `info/run` should be rewritten around CoCalc Launchpad and CoCalc Plus. |
| Language landing pages | `lang/index.tsx`, `lang/[locale]/index.tsx` | `port` | `not started` | public-web | Keep these as minimal translated landing pages if feasible. |
| Stars page | `stars.tsx` | `replace` | `not started` | app-native account/settings page | This is authenticated user functionality, not public-web. |
| Testimonials page | `testimonials/index.tsx` | `delete` | `not started` | none | Remove this route instead of porting it. |
| Token action pages | `token.tsx`, `token/[id].tsx` | `replace` | `not started` | special-purpose public-web or server-driven replacement | Likely keep only the student-pay / third-party payment flow, then rebuild that flow directly instead of porting the old generic token UI. |
| `api/v2` routes | `api/v2/**` | `replace` | `done` | `@cocalc/http-api` | Extracted already. |
| Legacy `api/conat` routes | `api/conat/hub.ts`, `api/conat/project.ts` | `replace` | `not started` | `@cocalc/http-api` or another non-Next server route package | These are still needed by the Python client and should move out of Next, likely under `/api/v2`. |

## Resolved Decisions

These decisions are now frozen for the migration:

1. `support/chatgpt`
Delete.

2. Named account/project/public-path routes
Delete them with the old share/public-path model.

3. `info/*`
Fold into `about` and `support`; rewrite `info/run` around CoCalc Launchpad and CoCalc Plus.

4. `lang/*`
Keep if feasible as minimal translated landing pages.

5. `testimonials`
Delete.

6. `token*`
Replace with a focused new flow rather than porting the old generic token UI.

7. `api/conat/*`
Keep, but move them out of Next because the Python client still depends on them.

## Completion Criteria For Step 1

Step 1 is complete when:

- every route family above has a frozen disposition
- the remainder of the migration can proceed against this ledger without route ambiguity
