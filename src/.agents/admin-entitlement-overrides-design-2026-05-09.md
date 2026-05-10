# Admin Entitlement Overrides

Date: 2026-05-09

## Goal

Add a general, auditable admin override layer for per-account entitlements and limits. The immediate release-critical use case is dedicated hosts: support can raise or lower a user's host spend limits, enable host creation, or adjust postpaid exposure limits without changing their purchased membership tier.

This must support the recovery path for billing enforcement:

- a host is stopped or deprovisioned because a limit is exhausted,
- the user adds funds, fixes payment, or support increases the limit,
- the next policy/spend-maintenance pass sees the new effective policy,
- the user can restart or reprovision without support manually editing host state.

## Current State

Membership resolution is already layered:

- subscriptions,
- admin-assigned memberships,
- membership grants,
- free fallback.

The selected membership contributes `entitlements` and normalized `effective_limits`.

Relevant code paths:

- `src/packages/server/membership/resolve.ts`: resolves the base membership.
- `src/packages/server/membership/effective-limits.ts`: normalizes tier usage limits.
- `src/packages/server/project-host/admission.ts`: builds `AccountLocalDedicatedHostPolicySnapshot` and decides whether create/start/resize is allowed.
- `src/packages/server/project-host/spend-enforcement.ts`: decides warning/drain/stop/deprovision thresholds from policy snapshots.
- `src/packages/server/project-host/spend-maintenance.ts`: applies spend enforcement and sends notifications.
- `src/packages/frontend/admin/users/admin-membership.tsx`: existing admin UI for membership assignment and membership usage.
- `src/packages/server/conat/api/system.ts`: existing admin-only membership assignment APIs.

Admin-assigned memberships are not enough for this. They replace a tier and participate in membership priority. We need a narrower override that can say "this account remains on their purchased tier, but support temporarily raised their 7-day dedicated-host postpaid limit to $500".

## Design Principles

1. Overrides are an overlay, not a membership source.
2. Overrides are per-account and account-home local, so inter-bay policy snapshots remain authoritative.
3. Overrides are explicit and auditable: actor, timestamp, reason, expiration, old value, new value.
4. Override values replace base values, not `max()` them. Admins must be able to lower limits too.
5. Absence means inherit from membership/site settings.
6. Expired and disabled overrides are ignored by policy evaluation.
7. The schema should be general, but the first UI should expose only release-critical dedicated-host fields.
8. Do not add casual bypasses for 2FA or payment-method requirements. Those are security and billing integrity gates, not normal entitlements.

## Data Model

Add two tables.

### `account_entitlement_overrides`

Current override state for one account.

```ts
{
  account_id: uuid,              // primary key
  enabled: boolean,              // default true
  features: jsonb,               // default {}
  usage_limits: jsonb,           // default {}
  dedicated_hosts: jsonb,        // default {}
  reason: text | null,
  expires_at: timestamptz | null,
  updated_by: uuid,
  updated_at: timestamptz        // default now()
}
```

Suggested DB constraints:

- `account_id` references `accounts(account_id)` if available in this schema layer.
- `updated_by` references `accounts(account_id)` if available.
- `jsonb_typeof(features) = 'object'`.
- `jsonb_typeof(usage_limits) = 'object'`.
- `jsonb_typeof(dedicated_hosts) = 'object'`.

This table is optimized for fast policy reads. It can be deleted on clear; audit lives in the event table.

### `account_entitlement_override_events`

Append-only audit trail.

```ts
{
  id: uuid,                      // primary key
  account_id: uuid,
  action: "set" | "clear" | "expire" | "disable",
  old_value: jsonb | null,
  new_value: jsonb | null,
  reason: text,
  actor_account_id: uuid,
  created_at: timestamptz        // default now()
}
```

Reason should be required for every set/clear from the admin API. This matters because these changes affect user spend ceilings and site/provider exposure.

## Override Shape

Define shared TypeScript types in the Conat API package, near membership/purchases types or in a new account entitlement API module.

```ts
export interface AccountFeatureOverrides {
  create_hosts?: boolean;
}

export interface AccountUsageLimitOverrides extends MembershipUsageLimits {}

export interface DedicatedHostPolicyOverrides {
  funding_mode?: "account-prepaid" | "account-postpaid" | "site-funded";
  postpaid_unbilled_limit_usd?: number;
}

export interface AccountEntitlementOverride {
  account_id: string;
  enabled: boolean;
  features?: AccountFeatureOverrides;
  usage_limits?: AccountUsageLimitOverrides;
  dedicated_hosts?: DedicatedHostPolicyOverrides;
  reason?: string | null;
  expires_at?: Date | string | null;
  updated_by: string;
  updated_at: Date | string;
}
```

Initial UI-exposed fields:

- `features.create_hosts`
- `usage_limits.prepaid_host_usage_limit_5h_usd`
- `usage_limits.prepaid_host_usage_limit_7d_usd`
- `usage_limits.credit_spend_limit_5h_usd`
- `usage_limits.credit_spend_limit_7d_usd`
- `dedicated_hosts.postpaid_unbilled_limit_usd`
- `dedicated_hosts.funding_mode`
- `expires_at`
- `reason`

Do not expose storage, project count, egress, snapshots, or backups in the first UI pass unless needed. The table and validator can support all `MembershipUsageLimits`, but limiting the UI keeps the release change focused.

## Merge Semantics

Base policy comes from resolved membership and site settings:

```ts
const membership = await resolveMembershipForAccount(account_id);
const baseLimits = getEffectiveMembershipUsageLimits(membership);
const settings = await getServerSettings();
```

Then load and validate the active override:

```ts
const override = await getActiveAccountEntitlementOverride(account_id);
```

Apply overlay:

```ts
const effectiveFeatures = {
  ...(membership.entitlements?.features ?? {}),
  ...(override?.features ?? {}),
};

const effectiveLimits = {
  ...baseLimits,
  ...(override?.usage_limits ?? {}),
};

const fundingMode =
  override?.dedicated_hosts?.funding_mode ??
  getDedicatedHostFundingModeFromSettings(settings);

const postpaidUnbilledLimit =
  override?.dedicated_hosts?.postpaid_unbilled_limit_usd ??
  settings.project_hosts_postpaid_unbilled_limit_usd ??
  0;
```

`undefined` means inherit. `null` should not be accepted for numeric/boolean override fields in API input; clearing a field should remove it from the JSON object.

Numeric override validation:

- must be finite,
- must be greater than or equal to zero,
- stored as JSON number,
- no `NaN`, `Infinity`, string money values, or negative values.

Boolean override validation:

- only real booleans.

Enum validation:

- exact allowed strings only.

Expiration:

- active only when `enabled = true` and `(expires_at IS NULL OR expires_at > NOW())`.
- expired overrides are ignored by reads.
- a cleanup job may append an `"expire"` event and delete/disable rows later, but policy correctness must not depend on cleanup.

## Dedicated Host Policy Snapshot Changes

Extend `AccountLocalDedicatedHostPolicySnapshot` with optional override metadata:

```ts
admin_override?: {
  active: boolean;
  features?: AccountFeatureOverrides;
  usage_limits?: AccountUsageLimitOverrides;
  dedicated_hosts?: DedicatedHostPolicyOverrides;
  reason?: string | null;
  expires_at?: Date | string | null;
  updated_by?: string;
  updated_at?: Date | string;
};
```

This is not required for enforcement, but it is useful for debugging, admin UI, and explaining why a host can continue running after the base membership would have blocked it.

`getDedicatedHostPolicySnapshotLocal` should load the active override alongside membership/settings/payment state and return the merged effective policy. Because `getDedicatedHostPolicySnapshotForAccount` already routes to the account home bay, putting the merge in the local snapshot function keeps cross-bay behavior correct.

## Admin API

Add admin-only Conat system API methods. Naming can follow existing membership admin methods in `src/packages/server/conat/api/system.ts`.

```ts
getAccountEntitlementOverride({
  user_account_id,
}): Promise<{
  override?: AccountEntitlementOverride | null;
  events?: AccountEntitlementOverrideEvent[];
}>;

setAccountEntitlementOverride({
  user_account_id,
  override,
  reason,
}): Promise<AccountEntitlementOverride>;

clearAccountEntitlementOverride({
  user_account_id,
  reason,
}): Promise<void>;
```

Rules:

- caller must be site admin,
- `reason` is required and trimmed,
- API validates and normalizes the override before writing,
- set/clear writes the current table and event table in one DB transaction,
- clear deletes the current row or marks it disabled; event history is authoritative either way,
- methods operate on the account home bay when needed.

For frontend compatibility, add generic client wrappers beside:

- `get_admin_assigned_membership`
- `set_admin_assigned_membership`
- `clear_admin_assigned_membership`

Then expose convenience functions in `src/packages/frontend/admin/users/actions.ts`.

## Admin UI

Extend the existing admin membership page with an `AdminEntitlementOverrides` panel below membership assignment and usage.

Required UI behavior:

- Show base selected membership tier/source.
- Show active override, expiration, reason, actor, update time.
- Show a compact effective limits table with columns:
  - setting,
  - base value,
  - override value,
  - effective value.
- Provide editable fields for the first-pass dedicated-host subset.
- Provide `Inherit` controls for every field, not just blank inputs.
- Require a reason before save.
- Include expiration date/time.
- Include a clear override button.
- Show recent override event history.

Suggested first-pass sections:

1. `Dedicated host access`
   - create hosts: inherit / allow / deny
   - funding mode: inherit / account prepaid / account postpaid / site funded
2. `Dedicated host usage windows`
   - prepaid 5-hour USD
   - prepaid 7-day USD
   - postpaid 5-hour USD
   - postpaid 7-day USD
   - postpaid unbilled USD limit
3. `Audit`
   - reason
   - expires at
   - save / clear
   - history

This UI should not look like a tier editor. It is a support override surface for exceptional cases.

## Interaction With Billing Enforcement

Spend enforcement should not know how overrides are stored. It should continue consuming `AccountLocalDedicatedHostPolicySnapshot`.

Expected behavior after implementation:

- A host is in `billing_warned`, `billing_draining`, `billing_stopped`, or `billing_deprovisioned`.
- Support increases a relevant limit or changes funding mode.
- The next maintenance cycle loads a policy snapshot with the override applied.
- `spend-enforcement.ts` sees windows/exposure are no longer exhausted.
- Existing recovery logic can clear or avoid further enforcement transitions.
- User can restart or reprovision from backup depending on current host state.

If the current recovery logic does not clear enough state after policy recovery, fix that in spend enforcement rather than special-casing overrides.

## Security Boundaries

Do not add normal override fields for:

- bypassing 2FA,
- bypassing payment method requirements,
- bypassing usage subscription requirements for account-postpaid billing.

If support needs one of those temporarily, it should be a separate, highly visible break-glass mechanism with short expiration and audit. It should not be part of the general entitlement override UI.

`site-funded` funding mode is acceptable as an admin override because it explicitly shifts cost responsibility to the site. It must be visually distinct and require a reason.

## Notifications

Do not notify users for every admin override by default. Some overrides are internal support/accounting operations.

Add an optional follow-up:

- checkbox: "Notify user about this change",
- system message template explaining what changed and when it expires,
- default off for now.

Host billing enforcement notifications are already separate and should continue to fire when host state changes.

## Implementation Plan

Phase 1: Data and pure logic

1. Add DB schemas for `account_entitlement_overrides` and `account_entitlement_override_events`.
2. Add shared TypeScript types.
3. Add server helpers:
   - `getActiveAccountEntitlementOverride(account_id)`,
   - `validateAccountEntitlementOverrideInput(input)`,
   - `applyAccountEntitlementOverride({ membership, settings, override })`.
4. Add unit tests for validation and merge semantics.

Phase 2: Host policy integration

1. Update `getDedicatedHostPolicySnapshotLocal` to apply active overrides.
2. Extend `AccountLocalDedicatedHostPolicySnapshot` with optional override metadata.
3. Add admission tests:
   - override enables `create_hosts`,
   - override raises prepaid limits,
   - override raises postpaid limits,
   - override changes postpaid unbilled limit,
   - expired override is ignored,
   - lowering a limit can deny admission.
4. Add spend-enforcement/maintenance regression tests for recovery after an override increase, if current recovery behavior is incomplete.

Phase 3: Admin API

1. Add admin-only Conat system methods.
2. Add transactionally written audit events.
3. Add API tests:
   - non-admin denied,
   - invalid payload denied,
   - set writes current row and event,
   - clear removes/disables current row and writes event,
   - expired row is returned as inactive or omitted consistently.
4. Add frontend generic client and admin action wrappers.

Phase 4: Admin UI

1. Add `AdminEntitlementOverrides` under the existing admin membership page.
2. Show base/override/effective values.
3. Add save/clear/history.
4. Keep first UI scoped to dedicated-host release-critical fields.
5. Add lightweight frontend validation before API call, but rely on backend validation for correctness.

Phase 5: Operational polish

1. Add an admin runbook note:
   - when to raise prepaid vs postpaid limits,
   - when to use site-funded,
   - recommended expiration defaults,
   - how recovery works for stopped/deprovisioned hosts.
2. Add optional user notification checkbox if support wants it.
3. Add an admin dashboard filter later for accounts with active overrides.

## Testing Checklist

Focused tests:

- `src/packages/server/membership` override merge tests.
- `src/packages/server/project-host/admission.test.ts`.
- `src/packages/server/project-host/spend-enforcement.test.ts`.
- `src/packages/server/conat/api` admin API tests.

Validation commands:

```sh
cd src/packages/server && pnpm test -- admission.test.ts
cd src/packages/server && pnpm test -- spend-enforcement.test.ts
pnpm -C src tsc
pnpm -C src lint:frontend
```

Use focused package checks during development, then run broader checks before merging if the API types cross package boundaries.

## Open Decisions

1. Should `clear` delete the current override row or keep a disabled row?
   - Recommendation: delete current row and rely on the append-only event table for history.
2. Should site admins be able to set `funding_mode = "site-funded"`?
   - Recommendation: yes, but require reason and make it visually explicit.
3. Should overrides support all `MembershipUsageLimits` immediately?
   - Recommendation: backend validator can support them, UI initially exposes only dedicated-host fields.
4. Should users be notified when support changes an override?
   - Recommendation: not by default; add an explicit checkbox later.
5. Should there be a maximum expiration?
   - Recommendation: no hard maximum initially, but UI should default to a short expiration such as 7 or 30 days for support-created dedicated-host overrides.

## Minimal Release Definition

The release-critical version is complete when:

- support can enable/disable host creation for an account,
- support can raise/lower prepaid and postpaid host windows,
- support can raise/lower postpaid unbilled exposure limit,
- support can switch a host account to site-funded mode,
- all changes are audited with actor/reason/time,
- expired overrides are ignored,
- host admission and spend enforcement consume the effective policy,
- the admin page shows base, override, and effective values.
