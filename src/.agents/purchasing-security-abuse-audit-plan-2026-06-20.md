# Purchasing Security and Abuse Audit Plan

Date: 2026-06-20

Status: draft execution plan for the final pre-public-release purchasing audit.

## Context

CoCalc AI is close to public release. The highest-risk remaining area is
purchasing because release will include:

- paid self-serve membership purchases;
- free users;
- free trials;
- course/student purchases;
- Stripe payment methods and payment intents;
- membership packages, seats, grants, and site-license pools;
- abuse-sensitive managed CPU, storage, egress, and AI usage limits.

Historical motivation: the old `cocalc.com` site was recently abused through a
voucher-minting vulnerability, causing about USD 1000 of GPU usage loss. The
exact voucher feature has been removed from `cocalc-ai`, but the same class of
bug remains possible anywhere users can convert weakly authorized state into
paid entitlements, usage credit, or compute access.

This audit should be finished before public launch and before the UCLA course
flow depends on student sign-up and payment.

## Audit Objective

Find release-blocking vulnerabilities where a user can:

- receive paid membership, course, site-license, team-license, CPU, storage,
  egress, AI, or project-host benefits without valid payment or explicit admin
  action;
- underpay for an entitlement by tampering with client-supplied price, tier,
  amount, quantity, interval, trial, or package fields;
- replay, race, or double-spend a payment, claim token, external claim token,
  package seat, Stripe payment intent, or renewal;
- use free accounts, free trials, or course flows to create unbounded cost;
- mutate purchases, memberships, site licenses, refunds, or billing state
  without fresh auth and the correct account/admin authority;
- route purchasing state to the wrong bay, creating lost, duplicated, or
  unauthorized entitlements;
- bypass abuse and kill-switch controls for high-cost resources.

## Release Blocker Standard

Treat a finding as release-blocking if it allows any of the following:

- unpaid access to a paid membership tier or package;
- free trial reuse or extension beyond policy;
- payment amount chosen by the client without server recomputation;
- Stripe metadata, payment intent ID, checkout session ID, invoice URL, or
  webhook-like processing accepted without ownership and amount validation;
- membership/course/site-license seat claim by an unauthorized account;
- admin purchase/refund/site-license mutation without admin authorization and
  fresh auth;
- cross-account or cross-bay billing mutation against the wrong account;
- compute/storage/network/AI usage limits bypassed for newly purchased,
  assigned, trial, or course memberships;
- missing idempotency on payment-processing paths that can duplicate grants or
  purchases.

## Key Source Surfaces

### HTTP Purchase APIs

Audit all handlers under:

- `src/packages/http-api/pages/api/v2/purchases/`
- `src/packages/http-api/pages/api/v2/purchases/stripe/`
- `src/packages/http-api/pages/api/v2/accounts/quarantine-billing-resources.ts`
- `src/packages/http-api/pages/api/v2/projects/course/set-course-info.ts`

Primary questions:

- Is every mutation authenticated with the correct account?
- Is every dangerous mutation protected by fresh auth?
- Are API-key scopes forbidden for browser-only payment mutations?
- Are admin endpoints actually admin-only?
- Are read endpoints scoped to the requester or explicitly admin-only?
- Are user-supplied `account_id`, `purchase_id`, `subscription_id`,
  `payment_intent`, `invoice`, `tier`, `amount`, and `metadata` values
  revalidated server-side?

### Conat Purchase APIs

Audit `src/packages/server/conat/api/purchases.ts`.

Primary questions:

- Does each purchase or entitlement mutation route to the authoritative account
  home bay or seed bay?
- Are site-license and external-claim operations seed-authoritative where they
  are global state?
- Does every browser-initiated purchase mutation call
  `validatePurchaseFreshAuth` or equivalent?
- Are admin-only functions gated by `isAdmin` and fresh auth?
- Are `browser_id` and `session_hash` inputs safe against spoofing and
  cross-account use?
- Are account rehome write fences applied around account-owned purchase state?

### Server Purchase Core

Audit:

- `src/packages/server/purchases/create-purchase.ts`
- `src/packages/server/purchases/is-purchase-allowed.ts`
- `src/packages/server/purchases/membership-package.ts`
- `src/packages/server/purchases/membership-change.ts`
- `src/packages/server/purchases/team-license.ts`
- `src/packages/server/purchases/create-subscription.ts`
- `src/packages/server/purchases/renew-subscription.ts`
- `src/packages/server/purchases/resume-subscription.ts`
- `src/packages/server/purchases/cancel-subscription.ts`
- `src/packages/server/purchases/admin-purchase.ts`
- `src/packages/server/purchases/create-refund.ts`
- `src/packages/server/purchases/create-credit.ts`
- `src/packages/server/purchases/create-invoice.ts`
- `src/packages/server/purchases/maintain-automatic-payments.ts`
- `src/packages/server/purchases/maintain-auto-balance.ts`
- `src/packages/server/purchases/maintenance.ts`

Primary questions:

- Is cost computed exclusively from server-side tier/package/license data?
- Are client-provided amounts used only as confirmation/tolerance checks?
- Are negative, zero, fractional, NaN, enormous, or currency-mismatched amounts
  rejected or safely rounded?
- Are purchases, subscriptions, grants, and membership packages created in a
  single transaction where required?
- Is `assertPurchaseAllowed` applied before every paid purchase path?
- Is minimum balance, unpaid invoice, chargeback, or quarantine state enforced
  before new cost can be incurred?
- Is idempotency enforced for renewals, resumes, and payment processing?

Voucher regression check:

- confirm there are no active source API routes, RPCs, database mutation paths,
  or frontend flows that mint voucher-like stored value;
- ignore generated `build/bundle` artifacts except as a signal to verify no
  source route still builds into a deployed bundle;
- if any voucher-like compatibility code remains, it must be unreachable in
  production or protected by admin plus fresh auth, with no user-redeemable
  compute credit path.

### Stripe Integration

Audit:

- `src/packages/server/stripe/client.ts`
- `src/packages/server/stripe/connection.ts`
- `src/packages/server/purchases/stripe/`

Primary questions:

- Are Stripe customer, payment method, setup intent, payment intent, checkout
  session, invoice, and receipt objects always checked against the account's
  Stripe customer?
- Can a user attach, delete, or default another customer's payment method?
- Are payment intent metadata fields treated as hints only, then checked
  against database ownership and expected amount?
- Are payment intent amounts verified against server-computed cost plus only a
  tightly bounded rounding/tax slack?
- Are failed/canceled intents unable to grant entitlements?
- Are processing paths idempotent under retries and repeated webhook/poll calls?
- Are kill switches respected before creating new Stripe obligations?
- Are invoice and hosted-payment URLs only returned for owned Stripe objects?

### Membership and Entitlements

Audit:

- `src/packages/server/membership/tiers.ts`
- `src/packages/server/membership/packages.ts`
- `src/packages/server/membership/grants.ts`
- `src/packages/server/membership/resolve.ts`
- `src/packages/server/membership/trials.ts`
- `src/packages/server/membership/entitlement-overrides.ts`
- `src/packages/server/membership/project-defaults.ts`
- `src/packages/server/membership/project-limits.ts`
- `src/packages/server/membership/effective-limits.ts`
- `src/packages/server/membership/usage-status.ts`
- `src/packages/server/membership/usage-windows.ts`
- `src/packages/server/membership/managed-cpu.ts`
- `src/packages/server/membership/managed-egress.ts`
- `src/packages/server/membership/blob-limits.ts`
- `src/packages/server/membership/rootfs-limits.ts`

Primary questions:

- Are active memberships derived from paid purchases, admin assignments,
  verified package seats, or explicitly trusted trials only?
- Can a user create, extend, or reassign a membership grant without owning the
  package or seat?
- Are free trials one-per-policy and resilient against account/email/domain
  cycling?
- Are usage limits recalculated immediately when membership changes?
- Are CPU, storage, egress, blob, rootfs, AI, and project default limits
  enforced for free, trial, paid, course, and site-license users?
- Are usage window resets admin-only and fresh-auth gated?

### Site Licenses and External Claims

Audit:

- `src/packages/server/membership/site-licenses.ts`
- `src/packages/server/membership/site-license-external-claims.ts`
- `src/packages/server/membership/site-license-affiliation-maintenance.ts`
- `src/packages/server/conat/api/purchases.ts` site-license sections
- `src/packages/frontend/claim/site-license-page.tsx`
- `src/packages/frontend/admin/site-licenses.tsx`
- `src/packages/frontend/admin/site-license-claims.tsx`

Primary questions:

- Is site-license state stored on the seed bay and not on arbitrary non-seed
  bays?
- Can non-admins create, update, archive, or manage site licenses?
- Can a site-license manager only mutate their authorized license/pool?
- Are allowed domains normalized, overlap-checked, and protected from
  subdomain confusion?
- Are external claim tokens signed, scoped, expiring, single-use where needed,
  and revocable?
- Can claim tokens be replayed across pools, accounts, domains, or bays?
- Can pending pool requests be approved, canceled, or reviewed only by the
  appropriate authority?

### Course and Student Payment Flows

Audit:

- `src/packages/frontend/course/membership-packages.ts`
- `src/packages/frontend/course/pay-banner.tsx`
- `src/packages/frontend/course/configuration/student-pay.tsx`
- `src/packages/frontend/course/configuration/institute-pay.tsx`
- `src/packages/server/projects/course/set-course-info.ts`
- `src/packages/server/conat/api/projects.course.test.ts`
- `src/packages/server/conat/api/purchases.ts` membership package and seat
  assignment sections

Primary questions:

- Can instructors assign paid student memberships without purchase, site
  license, or explicit package ownership?
- Can students claim only the package/seat intended for their course identity?
- Are course package seats bounded by paid seat count?
- Are deleted, removed, or transferred students revoked correctly?
- Can student-pay/institute-pay toggles be changed only by course owners with
  the correct permissions?

### Admin, Support, Refunds, and Abuse Review

Audit:

- `src/packages/frontend/admin/admin-purchase.tsx`
- `src/packages/frontend/admin/users/admin-membership.tsx`
- `src/packages/http-api/pages/api/v2/purchases/admin-purchase.ts`
- `src/packages/http-api/pages/api/v2/purchases/create-refund.ts`
- `src/packages/server/purchases/admin-purchase.ts`
- `src/packages/server/purchases/create-refund.ts`
- `src/packages/server/membership/admin-assigned.ts`
- `src/packages/server/membership/abuse-review-annotations.ts`
- `src/packages/server/conat/api/purchases.ts` admin sections

Primary questions:

- Are admin-created purchases, credits, refunds, membership assignments, and
  abuse annotations admin-only and fresh-auth gated?
- Are refunds linked to owned purchases and Stripe refunds where applicable?
- Can a support/admin path grant paid entitlements without an audit trail?
- Can abuse-review annotations be forged or used to bypass normal billing
  enforcement?

### Frontend Trust Boundary

Audit:

- `src/packages/frontend/account/membership-purchase-modal.tsx`
- `src/packages/frontend/account/membership-package-manager.tsx`
- `src/packages/frontend/account/membership-page.tsx`
- `src/packages/frontend/purchases/`
- `src/packages/frontend/client/purchases.ts`
- `src/packages/frontend/chat/use-codex-payment-source.ts`
- `src/packages/frontend/hosts/components/host-billing-enforcement.tsx`

Primary questions:

- Are all frontend prices, totals, tier IDs, package IDs, and expected amounts
  treated as display/confirmation only?
- Can editing local state, local storage, or request JSON alter the price or
  grant target?
- Are warning banners and blockers consistent with server enforcement?
- Are admin-only controls hidden and also server-protected?

## Abuse Scenarios to Actively Try

Use code inspection plus focused tests for these cases:

- buy paid membership package with `amount=0`;
- buy with a cheaper tier ID but expensive displayed tier metadata;
- expand someone else's existing membership package by passing their
  `package_id`;
- claim the same package seat twice in parallel;
- claim more seats than were purchased;
- claim a course/site package using an unrelated email identity;
- replay an external site-license claim token;
- process the same Stripe payment intent twice;
- process a Stripe intent whose metadata points to another account's purchase;
- attach or delete another customer's payment method;
- resume or renew another account's subscription by ID;
- create payment intent for an account with unpaid invoices or quarantine;
- bypass free trial uniqueness by changing email case/subdomain/account;
- create paid entitlement through admin APIs without fresh auth;
- use API keys against browser-only Stripe/purchase mutation endpoints;
- route a site-license mutation to a non-seed bay and verify it fails or
  forwards to seed;
- start high-cost CPU/GPU/storage/network use from a free/trial account after
  purchase failure or cancellation.

## Static Audit Method

1. Inventory all write endpoints and RPCs.
2. For each write path, classify:
   - caller type: browser, API key, admin, internal worker, Stripe process;
   - authoritative data owner: account home bay, project owning bay, host bay,
     seed bay, or Stripe;
   - required authorization: account ownership, course role, package owner,
     site-license manager/admin, site admin;
   - fresh-auth requirement;
   - transaction/idempotency requirement.
3. Trace every purchase path from frontend/API request to durable DB mutation.
4. Trace every entitlement path from durable DB mutation to effective limits.
5. For every client-supplied amount or identifier, identify the server-side
   recomputation and ownership check.
6. For every Stripe object ID, identify the customer/account ownership check.
7. For every claim token or seat, identify uniqueness, revocation, expiry, and
   replay protection.
8. For every multibay route, identify source and destination bay and prove the
   durable write happens on the authoritative bay.

## Existing Tests to Reuse First

Run focused tests before and after fixes:

```bash
cd src/packages/server && pnpm test -- purchases/is-purchase-allowed.test.ts
cd src/packages/server && pnpm test -- purchases/membership-change.test.ts
cd src/packages/server && pnpm test -- purchases/stripe/create-payment-intent-security.test.ts
cd src/packages/server && pnpm test -- purchases/stripe/process-payment-intents-security.test.ts
cd src/packages/server && pnpm test -- purchases/stripe/create-subscription-payment-security.test.ts
cd src/packages/server && pnpm test -- purchases/stripe/payment-method-mutations.test.ts
cd src/packages/server && pnpm test -- purchases/resume-subscription-security.test.ts
cd src/packages/server && pnpm test -- purchases/team-license.test.ts
cd src/packages/server && pnpm test -- membership/packages.test.ts
cd src/packages/server && pnpm test -- membership/site-licenses.test.ts
cd src/packages/server && pnpm test -- membership/site-license-external-claims.test.ts
cd src/packages/server && pnpm test -- conat/api/purchases.test.ts
cd src/packages/http-api && pnpm test -- pages/api/v2/purchases-stripe-fresh-auth.test.ts
cd src/packages/http-api && pnpm test -- pages/api/v2/purchases-stripe-api-key-scope.test.ts
cd src/packages/http-api && pnpm test -- pages/api/v2/purchases-billing-api-key-scope.test.ts
cd src/packages/http-api && pnpm test -- pages/api/v2/purchases-admin-fresh-auth.test.ts
cd src/packages/http-api && pnpm test -- pages/api/v2/purchases-subscription-state-fresh-auth.test.ts
cd src/packages/http-api && pnpm test -- pages/api/v2/purchases-renew-subscription-fresh-auth.test.ts
```

Add new tests for any untested blocker scenario before fixing, when practical.

## Manual Release Test Handoff

After code audit and fixes, manually test with Stripe test mode:

- new free account signup, no payment method;
- free trial membership activation and expiration behavior;
- membership purchase with new card;
- membership purchase with saved card;
- failed payment and retry;
- cancellation/downgrade/resume;
- course student purchase path;
- course instructor/institution package assignment path;
- site-license seat claim and release;
- account with unpaid invoice attempting new high-cost activity;
- payment method add/delete/default;
- admin refund and admin membership grant with fresh auth;
- usage-limit visibility immediately after purchase, cancellation, and trial.

Manual testing is not a substitute for the static audit because many attacks
require tampered request bodies, replay, concurrency, wrong-bay routing, or
foreign IDs that the UI will not generate.

## Audit Output Format

For each finding, record:

- severity: blocker, high, medium, low, hardening;
- attack scenario;
- impacted source files and functions;
- whether payment, entitlement, or usage-cost risk is involved;
- whether exploit requires auth, admin, API key, or only a browser session;
- suggested fix;
- regression test added or needed;
- commit hash after fix.

## Completion Criteria

The audit is complete enough for release when:

- every purchase-related write endpoint/RPC has an explicit authorization,
  fresh-auth, ownership, multibay, and idempotency classification;
- every paid entitlement path has a server-computed cost and purchase/assignment
  provenance;
- Stripe object ownership and amount checks are covered by tests;
- free trial and free-user cost controls are reviewed and tested;
- site-license/global purchasing state is seed-authoritative or deliberately
  account-home-bay authoritative;
- all blocker/high findings are fixed and committed with focused regression
  tests;
- manual Stripe test-mode release testing has a checklist and known expected
  outcomes.
