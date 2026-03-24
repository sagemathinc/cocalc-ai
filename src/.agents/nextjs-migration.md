# Next.js Removal Migration Plan

## Goal

Eliminate the `@cocalc/next` package from the active CoCalc application stack.

This means:

- no Next.js runtime in `cocalc.ai`
- no Next.js requirement for auth, support, news, policies, about, features,
  vouchers, or `api/v2`
- no share-server dependency on Next.js
- a clear path to later remove `@cocalc/next` from `cocalc.com` after the
  August 2026 cutover

## Rollout Constraints

### Product rollout

- `cocalc.ai` launches in **April 2026**
- `cocalc.com` stays live for SEO and legacy routes until roughly
  **August 1, 2026**
- `cocalc.com` content can be gently updated to point users toward `cocalc.ai`
- `cocalc.ai` is effectively greenfield and does **not** need full parity with
  every legacy page on day 1

### Immediate scope decisions

- the **share server** can be deleted immediately for the new stack
- the old **store** should not be ported
- the only purchase flows that matter in the new system are:
  - membership upgrades
  - vouchers
  - student pay (not clearly defined yet)
  - user-owned hosts (not implemented at all yet)
  - team/organization memberships (not clearly defined yet)

### Non-goal

Do **not** migrate the old Next.js app router semantics into the old desktop
frontend router.

That would keep the wrong architecture alive.

## Executive Summary

This migration is feasible and the timing is good.

The key observation is that `@cocalc/next` is currently doing three very
different jobs:

1. public/marketing page host
2. auth/support/news/policies UI host
3. `api/v2` and share-server integration glue

These should be split apart.

The highest-leverage plan is:

1. move `api/v2` into its own package first
2. build a new **public web layer** with Rspack, not Next.js
3. move auth/support/news/policies/about/features to that web layer
4. move vouchers and the simplified purchasing flows into the main app
5. delete share-server code instead of porting it
6. keep `cocalc.com` on the old stack until the new stack is fully proven

## Architectural Direction

## Keep

- `@cocalc/frontend` as the main logged-in app UI library
- `@cocalc/static` / Rspack as the bundle system
- existing server-side auth, passport, SSO, and cookie logic
- existing hub/server/database business logic

## Remove

- Next.js pages router
- Next.js runtime server
- `next/link`, `next/router`, `next/head`, `_app`, `_document`
- `next-rest-framework` dependency from active request handling
- share-server dependence on Next.js

## Add

- a new **public-web** layer built with Rspack
- a new `api-v2` package
- explicit Express routing for public pages and JSON/feed endpoints
- build-time prerendering for mostly-static pages when useful

## Core Principle

The logged-in app and the public web surface are different products and should
be different entry points.

They may share components, theme, and API clients, but they should **not**
share the same top-level router or bundle.

## Recommended Package Split

## 1. `@cocalc/api-v2`

New package containing:

- all `pages/api/v2/**` handlers
- common request helpers currently in `src/packages/next/lib/api/**`
- the generated route manifest
- any thin Express adapter needed by the hub

Target outcome:

- the hub mounts `@cocalc/api-v2` directly
- Launchpad and Hub no longer depend on `@cocalc/next` for API routes

## 2. `@cocalc/public-web` or equivalent

New package or sub-package owning:

- landing pages
- feature pages
- auth pages
- support pages
- news pages
- policy pages
- about pages
- any public RSS/feed endpoints

This should be built with Rspack and React, not Next.

Important:

- it can share UI components with `@cocalc/frontend`
- it should **not** use the old desktop app route/store model
- it should have its own route table and its own small entry chunks

## 3. `@cocalc/frontend`

Keep as the authenticated product app.

Add only what naturally belongs there:

- voucher center
- simplified purchase flows
- user-owned hosts billing surfaces
- any account/settings surfaces already app-native

## Route Ownership After Migration

## Public-web

- `/`
- `/features`
- `/features/*`
- `/auth/sign-in`
- `/auth/sign-up`
- `/auth/password-reset`
- `/auth/verify/*`
- `/support`
- `/support/new`
- `/support/tickets`
- `/support/community`
- `/news`
- `/news/*`
- `/about`
- `/about/*`
- `/policies`
- `/policies/*`
- `/pricing` and any selected pricing subpages
- `/sso`
- `/sso/*`
- `/redeem`
- `/redeem/*`

## App SPA

- `/app`
- `/projects/*`
- `/settings/*`
- `/account/*`
- `/billing/*`
- `/hosts/*`
- vouchers and simplified purchase management once ported

## Server-only routes

These remain server endpoints, not frontend routes:

- passport/OAuth/SAML callback paths under `/auth/*`
- impersonation and other privileged auth endpoints
- `api/v2/*`
- blob/file upload endpoints
- any share-server legacy redirects during transition

## Why This Is Better Than Porting Into The Existing SPA Router

The current SPA route model is for product navigation.

It is not a good fit for:

- SEO-facing content pages
- low-JS public auth entry
- feed endpoints
- public support/news/article routing
- small direct-load bundles

The public web layer should instead have:

- explicit routes
- explicit data loaders
- explicit HTML entry generation
- explicit code-splitting boundaries

## Bundle Strategy

## Requirements

- feature pages must be directly loadable
- the user must not need to load the full app bundle for public content
- auth pages should stay lean and fast

## Recommended build model

Use Rspack multi-entry outputs, similar to how `@cocalc/static` already emits
multiple HTML entry points.

Suggested public entry groups:

- `public-home`
- `public-features`
- `public-auth`
- `public-news`
- `public-policies`
- `public-support`

Each entry can lazy-load route-specific code underneath.

## Rendering strategy

### Build-time prerender

Use build-time prerender for pages that are mostly static:

- home
- features
- about
- many policy pages
- some pricing pages

### Request-time render

Use request-time React render for pages that depend on account/customize or DB
state:

- sign-in / sign-up / password-reset
- support ticket creation/status
- news article pages
- voucher redemption pages if they remain public
- SSO overview pages

This does **not** require Next.js.

React DOM server or a small templating layer is sufficient.

## Data Bootstrap Strategy

Replace `getServerSideProps + withCustomize(...)` with an explicit request
bootstrap model.

Suggested shape:

1. server route resolves:
   - customize
   - account identity if relevant
   - page-specific data
2. server renders HTML shell
3. server embeds a JSON bootstrap object
4. client hydrates the route component

For pages that are build-time prerendered:

- render static HTML at build
- fetch small JSON payloads client-side if needed

## Migration Phases

## Phase 0: Immediate Cleanup

### Goal

Reduce scope before porting anything.

### Tasks

- remove share-server from the target architecture
- stop adding new features to `@cocalc/next`
- define the public-web route list for `cocalc.ai`
- decide the minimal day-1 page set for April launch

### Deliverable

A frozen list of public routes required for `cocalc.ai` launch.

## Phase 1: Extract `api/v2`

### Goal

Remove the biggest backend dependency on Next.js first.

### Tasks

- create `@cocalc/api-v2`
- move `pages/api/v2/**` into it
- move `next/lib/api/**` helpers into it or into a shared package
- replace `lib/*` alias dependence with standard package imports
- keep the manifest-based Express mounting model
- remove `next-rest-framework` from runtime handling if it is still only used
  for build-time validation

### Acceptance criteria

- Hub mounts `api/v2` without `@cocalc/next`
- Launchpad bundles no Next api handlers
- `@cocalc/next` is no longer needed for active API serving

## Phase 2: Public-Web Skeleton

### Goal

Stand up the new public website stack for `cocalc.ai`.

### Tasks

- create `@cocalc/public-web`
- add Rspack entries and HTML templates
- add route manifest for public pages
- implement base theme, layout, top nav, footer, head/meta handling
- implement `withCustomize` replacement
- wire hub Express routes to public-web handlers

### Acceptance criteria

- `cocalc.ai/` loads without Next.js
- direct route loads work for the initial public pages
- bundle sizes are bounded by route group, not app-wide

## Phase 3: Auth and SSO Pages

### Goal

Replace the temporary handcrafted auth pages with React versions that retain
existing functionality.

### Tasks

- port sign-in page UI
- port sign-up page UI
- port password reset and verify-email pages
- port SSO overview pages
- wire SSO strategy discovery via `api/v2/auth/sso-strategies`
- preserve server-side auth callback routes in hub/server
- preserve reCAPTCHA support if still required

### Important note

The **pages** move to public-web.
The **actual OAuth/passport handlers** stay server-side.

### Acceptance criteria

- all non-Next auth pages work in `cocalc.ai`
- sign-in and sign-up parity with current Next pages
- SSO flows still complete correctly through existing server auth endpoints

## Phase 4: Content Pages

### Goal

Move the public informational surface off Next.

### Workstreams

#### Features

- port the feature pages
- keep the route URLs stable
- modernize content later, not during the first migration

#### About

- port `/about` and team/event pages

#### Policies

- port policy and trust/legal pages

#### News

- port news list and article pages
- preserve feed endpoints:
  - `/news/rss.xml`
  - `/news/feed.json`

#### Support

- port support index/community/create-ticket/tickets pages
- keep Zendesk-backed flows working

### Acceptance criteria

- `cocalc.ai` has no public page dependency on Next.js
- equivalent routes work without loading the app bundle

## Phase 5: Voucher Center and Simplified Commerce

### Goal

Move real purchase/account-management flows into the app and throw away the old
store model.

### Keep

- memberships
- vouchers
- student pay
- user-owned hosts

### Delete

- shopping cart complexity
- general store navigation
- unrelated product catalog flows

### Tasks

- define the minimal commerce domain model
- create app-native voucher center screens
- create app-native voucher detail/admin screens
- port only necessary APIs
- connect simplified billing UX to existing purchases APIs or their replacements

### Acceptance criteria

- vouchers no longer require `@cocalc/next`
- no cart-based UX remains in the active product

## Phase 6: `cocalc.com` Transition

### Goal

Cut `cocalc.com` over only after `cocalc.ai` has proven stable.

### Until August 2026

- keep legacy `cocalc.com` pages live
- update content to point toward `cocalc.ai`
- use the legacy site for SEO continuity

### Before cutover

- confirm public-web route parity where required
- confirm SEO metadata and feed parity
- confirm auth/support/news pages are production-stable
- confirm old share-server routes are either deleted or intentionally redirected

### Acceptance criteria

- `cocalc.com` can switch without relying on Next.js

## Page Category Difficulty

## Easy

- features pages
- about pages
- many policy pages
- simple landing pages

Reason:

- mostly React + AntD content
- little real framework dependence
- typically just `withCustomize(...)`

## Medium

- auth pages
- support pages
- news pages
- vouchers overview/detail pages

Reason:

- more request-time state
- some authenticated behavior
- some redirects and feeds

## Hard but mostly being deleted

- share server
- old store/cart/checkout flow

Reason:

- these are the most entangled Next-owned surfaces
- deleting them is strategically correct

## Hidden Couplings To Untangle

These are the things most likely to slow the migration if not handled
explicitly:

- `withCustomize(...)` and `useCustomize(...)`
- `ROOT_PATH` and base-path behavior
- `next/link` and `next/router` assumptions throughout components
- server-rendered metadata via `next/head`
- Next `_app` global setup
- auth page redirects that currently happen in `getServerSideProps`
- feed endpoints and other non-HTML page outputs
- route enable/disable logic from customize settings

## Recommended Refactors Before Bulk Porting

## 1. Create a framework-neutral page bootstrap helper

This should replace the useful parts of `withCustomize(...)` without assuming
Next request objects.

## 2. Create framework-neutral public navigation primitives

Replace direct `next/link` and `useRouter` usage with wrappers owned by CoCalc.

## 3. Create a framework-neutral metadata layer

Replace direct `next/head` use with a small metadata abstraction that can render
into server templates or client-side head management.

## 4. Create framework-neutral route loaders

Each public page should declare:

- required bootstrap data
- optional account requirement
- optional redirects
- optional prerender eligibility

## Testing and Validation

## Unit and integration

- route loader tests
- bootstrap/customize tests
- auth page tests
- support/news/voucher page tests
- `api/v2` package tests independent of Next

## Browser tests

- direct-load public routes
- auth flows
- SSO overview and provider selection
- support ticket creation
- news article navigation
- voucher redemption

## Deployment tests

- `cocalc.ai` with no Next runtime at all
- `cocalc.com` legacy still functioning during the overlap window
- redirect behavior between the two sites

## Suggested Deliverables By Date

## By early April 2026

- `api/v2` extracted
- public-web skeleton live on `cocalc.ai`
- auth pages live on `cocalc.ai`
- minimal landing/features pages live on `cocalc.ai`
- no share-server dependency in the new deployment

## By late spring 2026

- support/news/policies/about live on `cocalc.ai`
- voucher center and simplified purchase flows in app
- old store paths no longer needed on `cocalc.ai`

## By July 2026

- `cocalc.com` replacement stack feature-complete
- SEO/feed/meta parity confirmed where needed
- cutover checklist complete

## By August 2026

- `cocalc.com` switches over
- Next.js runtime is no longer part of active production architecture

## Recommendation

Proceed with the migration.

But do it as a **split-and-replace** project, not an in-place rewrite inside
the old app router:

1. extract `api/v2`
2. build a new public-web layer with Rspack
3. port auth/content pages there
4. move simplified commerce into the app
5. delete the share server
6. cut over `cocalc.com` only after `cocalc.ai` proves the architecture

This gives the cleanest long-term result, minimizes framework overlap, and fits
the April-to-August rollout window.