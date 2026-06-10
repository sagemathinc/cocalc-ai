# Stripe-Enabled Billing UI Simplification Plan

Status: planning.

## Problem

The current `commercial` site setting is overloaded and misleading.

It currently acts as a frontend visibility gate for billing, balance, purchase,
course payment, quota warning, and analytics UI. It is also forced to `false`
unless `kucalc === "yes"` cloud mode. That makes self-hosted or non-cocalc.com
multiuser installations unable to expose workflows that are now core to CoCalc:
memberships, course membership requirements, vouchers, site licenses, software
licenses, and admin-assigned entitlements.

This is especially wrong for course workflows. A course can use memberships,
site licenses, vouchers, or admin-assigned course seats without Stripe being
configured.

## Current Audit

Relevant settings:

- `stripe_publishable_key`
- `stripe_secret_key`
- `stripe_webhook_secret`
- legacy `commercial`

Existing useful helper:

- `src/packages/server/purchases/maintenance.ts`
  - `hasStripeBillingConfiguration(settings)` already defines Stripe
    availability as both publishable and secret keys being non-empty.

Important current `commercial` behavior:

- `src/packages/util/db-schema/site-defaults.ts`
  - `commercial_to_val` returns false unless platform mode is cloud.
  - the `commercial` admin setting has `show: only_cocalc_com`.
- `src/packages/frontend/customize.tsx`
  - maps `commercial` to `is_commercial`.
  - refreshes `/customize` periodically, so a blanket restart requirement is
    stale for the main frontend.

Frontend gates that currently use `is_commercial`:

- top navbar balance button
- purchases page wrapper
- account billing/settings navigation
- membership page `UseBalance`
- course payment warning banner
- RAM/OOM/disk quota warnings
- project settings membership upsell note
- analytics/conversion tracking

## Target Semantics

Memberships are always enabled.

There should not be a `memberships_enabled` flag. The membership system is the
source of user entitlements and is required for CoCalc-ai to make sense.

Add a public derived customize field:

```ts
stripe_enabled: boolean
```

Definition:

```ts
stripe_enabled =
  trim(stripe_publishable_key).length > 0 &&
  trim(stripe_secret_key).length > 0
```

Do not expose either key value through `/customize`; expose only the boolean.

Use `stripe_enabled` only for UI that requires Stripe/card payment capability:

- adding/managing payment methods
- Stripe checkout
- subscriptions that bill via Stripe
- automatic payment setup
- Stripe-backed invoice/payment action buttons

Never use `stripe_enabled` to hide entitlement or course configuration:

- membership status page
- site-license claims and requests
- software license visibility
- course required membership selection
- course student-pay/instructor-pay/site-license configuration
- vouchers and admin-assigned memberships
- purchase/history tables for existing ledger entries

Balance/credit UI is not Stripe-only:

- A user can have balance from admin vouchers or other manual credits.
- The top balance button should be visible when it is useful without Stripe,
  e.g. nonzero balance, balance alert, or explicit account credit activity.
- When `stripe_enabled` is false, balance UI must not offer card top-up or
  payment-method flows, but it can still show credit, vouchers, and history.

Analytics/conversion tracking should not be tied to Stripe or membership
entitlements. If needed, keep it behind Google Analytics configuration or add a
separate explicit analytics setting later.

## Implementation Plan

### Phase 1: Add Derived Stripe Capability

1. Add a shared helper for Stripe availability, probably near site settings or
   purchases:

   ```ts
   export function hasStripeBillingConfiguration(settings: {
     stripe_publishable_key?: string;
     stripe_secret_key?: string;
   }): boolean
   ```

2. Reuse this helper from `server/purchases/maintenance.ts` instead of keeping a
   private duplicate.

3. Extend backend customize generation in
   `src/packages/database/settings/customize.ts` to include:

   ```ts
   stripe_enabled: hasStripeBillingConfiguration(settings)
   ```

4. Extend frontend customize defaults/types in
   `src/packages/frontend/customize.tsx`:

   ```ts
   stripe_enabled: boolean
   ```

5. Add tests that verify:

   - both keys absent means `stripe_enabled === false`;
   - only one key set means false;
   - both keys set means true;
   - secret key value itself is not exposed in customize output.

### Phase 2: Replace `is_commercial` Gates With Correct Semantics

Replace each frontend `is_commercial` usage deliberately:

- `frontend/course/configuration/configuration-panel.tsx`
  - keep the course payment configuration visible. This is already done in
    commit `5429e339b3`; retain the intent, but it should be justified by
    membership-always-on semantics rather than "ignore commercialization".

- `frontend/course/pay-banner.tsx`
  - remove the commercial gate. The banner is about missing course funding
    policy, not Stripe.

- `frontend/account/membership-page.tsx`
  - membership page remains visible.
  - `UseBalance` should probably be visible if the account can have balance or
    subscriptions; it should internally disable Stripe-only actions if Stripe is
    unavailable.

- `frontend/account/settings-navigation.ts`
  - membership, site licenses, software licenses, team licenses, vouchers, and
    purchase history should not depend on `isCommercial`.
  - payment methods, Stripe payments, and Stripe subscriptions should depend on
    `stripe_enabled`.

- `frontend/purchases/purchases.tsx`
  - remove the `is_commercial` wrapper. Purchase history can exist without
    Stripe.

- `frontend/purchases/balance-button.tsx`
  - replace the commercial gate with usefulness:
    - show if `stripe_enabled`;
    - show if `balanceAlert`;
    - show if known balance is nonzero;
    - optionally show if the user explicitly opened billing/account credit UI.
  - hide Stripe-only top-up/payment controls inside the modal when
    `stripe_enabled` is false.

- `frontend/project/warnings/*`
  - RAM/OOM/disk quota warnings should not depend on commercial. They are
    resource-health warnings, and self-hosted course/beta deployments need them.

- `frontend/project/settings/upgrade-usage.tsx`
  - do not hide actual quota information.
  - only hide Stripe/membership purchase wording if there is no action the user
    can take.

- `frontend/misc/tracking.ts` and `frontend/customize.tsx` analytics setup
  - leave conversion tracking behind the legacy `commercial` flag for now, or
    move it to a future explicit analytics setting. Do not conflate with
    `stripe_enabled`.

### Phase 3: Make Stripe-Only Components Fail Closed

Audit components that import or instantiate Stripe functionality:

- `StripePayment`
- `PaymentMethods`
- `Subscriptions`
- `Address`
- course seat purchase modal
- course membership purchase banner
- membership purchase modal

Required behavior when `stripe_enabled === false`:

- purchasing with existing account credit may continue if backend supports it;
- card checkout/payment methods are hidden or replaced with a clear message;
- no component should call Stripe publishable-key APIs unless Stripe is enabled;
- backend should still reject Stripe RPCs if keys are missing.

### Phase 4: Admin Settings Cleanup

1. Stop treating `commercial` as the control for modern billing/membership UI.
2. Either:
   - deprecate `commercial` and keep it only for analytics/conversion tracking;
     or
   - remove it entirely after replacing analytics semantics.
3. Remove the hard cloud-only coercion if the setting survives.
4. Remove or update the stale "must restart your server" wording.
5. Consider surfacing a read-only "Stripe enabled" derived status in admin
   settings near the Stripe keys:

   - enabled when publishable + secret are both set;
   - warning if one key is set without the other;
   - webhook secret status separate, since webhooks affect reconciliation but
     not basic checkout availability.

### Phase 5: Tests

Add/adjust focused tests:

- customize server output includes `stripe_enabled` and does not expose secret
  keys;
- settings navigation with `stripe_enabled=false` still shows membership,
  licenses, vouchers, and purchase history, but hides payment methods and
  Stripe subscription/payment pages;
- settings navigation with `stripe_enabled=true` shows Stripe pages;
- course payment configuration renders regardless of legacy `commercial`;
- course pay banner renders based on course settings, not commercial;
- balance button shows for nonzero balance without Stripe and hides Stripe-only
  actions;
- purchase history component renders without Stripe.

### Phase 6: Validation

Focused commands:

```sh
cd src/packages/frontend && pnpm exec jest \
  account/settings-navigation.test.ts \
  account/__tests__/membership-page.test.tsx \
  course/configuration/actions.test.ts \
  --runInBand
```

```sh
cd src/packages/server && pnpm exec jest purchases/maintenance.test.ts --runInBand
```

Then:

```sh
cd src/packages/frontend && pnpm tsc --build
pnpm -C src lint:frontend
```

Manual smoke:

1. No Stripe keys:
   - membership page visible;
   - course payment configuration visible;
   - site/software license UI visible;
   - vouchers visible to admins;
   - payment methods and card checkout hidden;
   - nonzero balance still visible.
2. Only one Stripe key:
   - `stripe_enabled=false`;
   - admin settings warns about partial configuration.
3. Both Stripe keys:
   - `stripe_enabled=true`;
   - payment methods, checkout, subscriptions, and balance top-up visible.

## Release Notes

This should be presented as a simplification:

- Memberships and entitlements are core platform features.
- Stripe is only an external payment provider.
- Self-hosted deployments can use memberships, vouchers, course funding policy,
  site licenses, and admin-assigned entitlements without Stripe.

## Open Decisions

1. Should the top navbar balance button show for every signed-in non-Lite user,
   or only when `stripe_enabled || balanceAlert || balance !== 0`? (ANS: the latter.  It's also configurable in account settings to disable it.)
2. Should purchase history be in the Billing group even when Stripe is disabled,
   or under Membership/Credit to avoid implying card billing?  (ANS: I don't know; it's easy to move later so just select one.  Billing is probably fine for now.)
3. Should `commercial` survive temporarily as `commercial_analytics_enabled`, or
   should analytics be controlled only by Google Analytics being configured?  (ANS: remove commercial entirely.)

