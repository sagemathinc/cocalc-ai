# Admin Entitlement Overrides

Date: 2026-05-09

## Goal

Add a general, auditable admin override layer for per-account entitlements and limits. The immediate release-critical use case is dedicated hosts: support can raise or lower a user's host spend limits, enable host creation, or adjust postpaid exposure limits without changing their purchased membership tier.

The same mechanism should also cover the support cases that actually happen during courses and heavy usage:

- per-project disk quota,
- total account disk quota,
- number of projects,
- project memory limit/default,
- managed egress windows.
- AI limits.

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
4. Numeric overrides are directional policy rules, not blind replacements. Admins must be able to raise a floor, lower a cap, or set an exact value.
5. Absence means inherit from membership/site settings.
6. Expired and disabled overrides are ignored by policy evaluation.
7. The schema should be general, but the first UI should expose only support-critical fields.
8. Do not add casual bypasses for 2FA or payment-method requirements. Those are security and billing integrity gates, not normal entitlements.

The directional numeric rule is important:

- If support lowers a limit, that is a cap. A later membership upgrade should not bypass the cap.
- If support raises a limit, that is usually a floor. A later membership upgrade with an even higher limit should win.
- If support needs an exact value regardless of membership, use `set`.

## Data Model

Add two tables.

### `account_entitlement_overrides`

Current override state for one account.

```ts
{
  account_id: uuid,              // primary key
  enabled: boolean,              // default true
  features: jsonb,               // default {}
  project_defaults: jsonb,       // default {}
  ai_limits: jsonb,              // default {}
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
- `jsonb_typeof(project_defaults) = 'object'`.
- `jsonb_typeof(ai_limits) = 'object'`.
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
export interface NumericLimitRule {
  mode: "minimum" | "maximum" | "set";
  value: number;
}

export interface EnumOverride<T extends string> {
  mode: "set";
  value: T;
}

export interface AccountFeatureOverrides {
  create_hosts?: boolean;
}

export interface ProjectDefaultOverrides {
  disk_quota?: NumericLimitRule;
  memory?: NumericLimitRule;
  memory_request?: NumericLimitRule;
}

export type AiLimitOverrides = Record<string, NumericLimitRule>;

export interface AccountUsageLimitOverrides {
  shared_compute_priority?: NumericLimitRule;
  total_storage_soft_bytes?: NumericLimitRule;
  total_storage_hard_bytes?: NumericLimitRule;
  max_projects?: NumericLimitRule;
  max_snapshots_per_project?: NumericLimitRule;
  max_backups_per_project?: NumericLimitRule;
  egress_5h_bytes?: NumericLimitRule;
  egress_7d_bytes?: NumericLimitRule;
  egress_policy?: EnumOverride<MembershipEgressPolicy>;
  dedicated_host_egress_policy?: EnumOverride<DedicatedHostEgressPolicy>;
  credit_spend_limit_5h_usd?: NumericLimitRule;
  credit_spend_limit_7d_usd?: NumericLimitRule;
  prepaid_host_usage_limit_5h_usd?: NumericLimitRule;
  prepaid_host_usage_limit_7d_usd?: NumericLimitRule;
}

export interface DedicatedHostPolicyOverrides {
  funding_mode?: EnumOverride<
    "account-prepaid" | "account-postpaid" | "site-funded"
  >;
  postpaid_unbilled_limit_usd?: NumericLimitRule;
}

export interface AccountEntitlementOverride {
  account_id: string;
  enabled: boolean;
  features?: AccountFeatureOverrides;
  project_defaults?: ProjectDefaultOverrides;
  ai_limits?: AiLimitOverrides;
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
- `usage_limits.total_storage_soft_bytes`
- `usage_limits.total_storage_hard_bytes`
- `usage_limits.max_projects`
- `usage_limits.egress_5h_bytes`
- `usage_limits.egress_7d_bytes`
- `usage_limits.prepaid_host_usage_limit_5h_usd`
- `usage_limits.prepaid_host_usage_limit_7d_usd`
- `usage_limits.credit_spend_limit_5h_usd`
- `usage_limits.credit_spend_limit_7d_usd`
- `project_defaults.disk_quota`
- `project_defaults.memory`
- `project_defaults.memory_request`
- `ai_limits.*` for known numeric AI limit keys
- `dedicated_hosts.postpaid_unbilled_limit_usd`
- `dedicated_hosts.funding_mode` with only `account-prepaid` and `account-postpaid` exposed in the normal support UI
- `expires_at`
- `reason`

Naming note:

- The current membership tier schema already has `project_defaults` and `ai_limits`.
- The current project defaults use `disk_quota`, `memory`, and `memory_request`.
- The override schema should use those same keys unless we first rename the underlying membership/project-default schema everywhere.
- The admin UI can label `disk_quota` as "per-project disk quota" and `memory` as "project memory", but the stored keys should stay consistent.
- Keep the existing project-default units consistent with the project model. Today `disk_quota` is the project disk quota value consumed by project quota checks, and `memory`/`memory_request` are the project memory values.
- `disk_quota`, `memory`, and `memory_request` are currently in MB in the project quota system. Do not introduce `*_bytes` names in the override layer unless the underlying project quota model is migrated at the same time.
- AI limits are currently `units_5h` and `units_7d`. They are internal cost-weighted units, not user-facing dollars, even if they roughly track spend. The UI can explain them as AI usage units without promising a dollar conversion.

Schema style decision:

- Keep the membership table grouped as `project_defaults`, `ai_limits`, `features`, and `usage_limits` JSON objects.
- Do not flatten these into top-level columns such as `ai_5h_units` or `per_project_disk_quota_bytes` right now.
- The table is small, policy-shaped, and edited by admins; the value of JSON extensibility is higher than SQL column-level constraints here.
- The red flag with JSON is typo/validation risk, so the implementation must add typed normalizers, known-key validation, and structured UI controls instead of relying on free-form JSON.
- If a future field becomes heavily queried, indexed, or audited independently, promote that specific field to a top-level column then.

Membership field note:

- `total_storage_*`, `max_projects`, and egress are modeled in `MembershipUsageLimits`.
- `disk_quota`, `memory`, and `memory_request` are modeled in `MembershipEntitlements.project_defaults`.
- AI limits are modeled in `MembershipEntitlements.ai_limits`.
- All three groups are first-class membership-derived policy and should be overrideable with the same directional semantics.
- A per-project disk quota increase does not increase total account storage. It only lets the user's storage be distributed less evenly across projects.
- Project default changes should apply to all projects owned by the account through an explicit membership/default reconciliation path. This is not a silent arbitrary resize; it is the expected consequence of changing the account's membership-derived project policy.
- Running projects should not have quota/memory changed in place. The current shared-project path recomputes `run_quota` when project control starts a project, by resolving the selected account's membership and merging membership project defaults into project settings.
- There should be no long membership-resolution cache in that start path; if a fully stopped project is started after a tier/default change and still gets the old quota, treat that as a bug to investigate. Usage-status caches are separate and should not control project start quotas.
- The admin UI/runbook should state the expected propagation clearly: running projects keep current limits until restart; stopped projects should pick up the effective policy on next start; bulk reconciliation/status should make pending existing-project changes visible.

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

Apply overlay. Numeric fields use rule semantics:

```ts
const effectiveFeatures = {
  ...(membership.entitlements?.features ?? {}),
  ...(override?.features ?? {}),
};

function applyNumericRule(
  base: number | undefined,
  rule: NumericLimitRule | undefined,
): number | undefined {
  if (!rule) return base;
  if (base == null) return rule.value;
  switch (rule.mode) {
    case "minimum":
      return Math.max(base, rule.value);
    case "maximum":
      return Math.min(base, rule.value);
    case "set":
      return rule.value;
  }
}

const effectiveLimits = applyUsageLimitRules(
  baseLimits,
  override?.usage_limits,
);

const effectiveProjectDefaults = applyNumericRulesByKey(
  membership.entitlements?.project_defaults ?? {},
  override?.project_defaults,
);

const effectiveAiLimits = applyNumericRulesByKey(
  membership.entitlements?.ai_limits ?? {},
  override?.ai_limits,
);

const fundingMode =
  override?.dedicated_hosts?.funding_mode?.value ??
  getDedicatedHostFundingModeFromSettings(settings);

const postpaidUnbilledLimit = applyNumericRule(
  settings.project_hosts_postpaid_unbilled_limit_usd ?? 0,
  override?.dedicated_hosts?.postpaid_unbilled_limit_usd,
);
```

`undefined` means inherit. `null` should not be accepted for numeric/boolean override fields in API input; clearing a field should remove it from the JSON object.

Examples:

- base 7-day postpaid limit is `$100`; support sets `minimum: $300`; effective is `$300`.
- user later buys a membership with `$500`; effective is `$500`.
- support sets `maximum: $50`; effective is `$50` even if the user buys a `$500` membership.
- support sets `set: $125`; effective is exactly `$125` until the override expires or is cleared.

Admin UI help popover:

- Put a small `?` next to the numeric override mode selector.
- Use the examples above in the popover because they explain the key distinction:
  - `minimum` is a support floor and does not block a later higher membership,
  - `maximum` is an admin cap and continues to cap later memberships,
  - `set` forces an exact value until the override expires or is cleared.
- The UI should avoid saying only "override" for numeric fields, since that hides whether the admin is setting a floor, cap, or exact value.

Numeric override validation:

- must be finite,
- must be greater than or equal to zero,
- stored as JSON number,
- must include `mode`,
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
  project_defaults?: ProjectDefaultOverrides;
  ai_limits?: AiLimitOverrides;
  dedicated_hosts?: DedicatedHostPolicyOverrides;
  reason?: string | null;
  expires_at?: Date | string | null;
  updated_by?: string;
  updated_at?: Date | string;
};
```

This is not required for enforcement, but it is useful for debugging, admin UI, and explaining why a host can continue running after the base membership would have blocked it.

`getDedicatedHostPolicySnapshotLocal` should load the active override alongside membership/settings/payment state and return the merged effective policy. Because `getDedicatedHostPolicySnapshotForAccount` already routes to the account home bay, putting the merge in the local snapshot function keeps cross-bay behavior correct.

## Multibay Architecture

This design follows the bay model in `src/.agents/scalable-architecture.md`.

Authority rules:

- Account entitlement overrides are account-home state.
- The current override row and audit events live in the account's `home_bay`.
- The browser/admin UI may be connected to any bay, but admin API calls must route to the target account's home bay before reading or writing overrides.
- `getDedicatedHostPolicySnapshotForAccount` already routes account-local policy resolution through inter-bay RPC; overrides should be applied inside the account-local snapshot on the home bay.
- Project-owning bays and project hosts should not independently interpret override rows. They should consume already-resolved policy snapshots or explicit reconciled project default updates.

This avoids split-brain behavior where a project-owning bay sees different limits than the account home bay.

Projection rules:

- Active override summaries may be projected to admin dashboards, but projections are read-only convenience data.
- Enforcement decisions must use home-bay authoritative reads or snapshots produced by the home bay.
- Audit events are append-only on the home bay. If global admin reporting needs them, replicate events outward rather than accepting writes elsewhere.

Launchpad is the one-bay special case, so the same code path should work locally without special routing.

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
- Provide editable fields for the first-pass support-critical subset.
- Provide `Inherit` controls for every field, not just blank inputs.
- For numeric fields, require the admin to choose one of:
  - inherit,
  - minimum,
  - maximum,
  - exact.
- Require a reason before save.
- Include expiration date/time.
- Include a clear override button.
- Show recent override event history.

Suggested first-pass sections:

1. `Dedicated host access`
   - create hosts: inherit / allow / deny
   - funding mode: inherit / account prepaid / account postpaid
2. `Dedicated host usage windows`
   - prepaid 5-hour USD
   - prepaid 7-day USD
   - postpaid 5-hour USD
   - postpaid 7-day USD
   - postpaid unbilled USD limit
3. `Project and account limits`
   - max projects
   - total storage soft cap
   - total storage hard cap
   - per-project disk quota
   - project memory
   - managed egress 5-hour bytes
   - managed egress 7-day bytes
4. `AI limits`
   - known numeric AI limit keys from membership tiers
5. `Audit`
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

`site-funded` should not be in the normal support UI for public-user overrides. It does not mean "a host account"; it means "this account's dedicated-host usage is paid by the site/operator instead of by the user's prepaid or postpaid billing lane." That can be useful for internal testing, demos, institutional arrangements, or self-hosted deployments, but it is not needed for a normal user asking support to increase a spend limit.

Recommendation:

- support UI initially exposes only `account-prepaid` and `account-postpaid`,
- `site-funded` remains a backend enum because the product supports site-funded deployments,
- setting a single public user's account to `site-funded` should require a separate break-glass/admin-only path or a later explicit product decision.

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
4. Add unit tests for validation and merge semantics, including minimum/maximum/set behavior across membership upgrades.

Phase 2: Host policy integration

1. Update `getDedicatedHostPolicySnapshotLocal` to apply active overrides.
2. Extend `AccountLocalDedicatedHostPolicySnapshot` with optional override metadata.
3. Add admission tests:
   - override enables `create_hosts`,
   - override raises prepaid limits,
   - override raises postpaid limits,
   - override changes postpaid unbilled limit,
   - `minimum` does not block a later higher membership limit,
   - `maximum` continues to cap a later higher membership limit,
   - expired override is ignored,
   - lowering a limit can deny admission.
4. Add spend-enforcement/maintenance regression tests for recovery after an override increase, if current recovery behavior is incomplete.

Phase 3: Project/account/AI limit integration

1. Apply override-aware `MembershipUsageLimits` in project limit checks:
   - max projects,
   - total storage soft cap,
   - total storage hard cap,
   - managed egress 5-hour and 7-day windows.
2. Apply override-aware `project_defaults`:
   - `disk_quota`,
   - `memory`,
   - `memory_request`.
3. Apply project default changes to new projects and existing owned projects through the membership/default reconciliation path.
4. Confirm and document the project-start propagation timing:
   - running projects keep their current `run_quota`,
   - stopped projects pick up effective project defaults on next start,
   - a stopped project still receiving old values after a membership/default change is a bug.
5. Apply override-aware `ai_limits` wherever membership AI limits are checked.
6. Add tests for project creation, storage admission, restore admission, egress checks, project default reconciliation, and AI limit checks using effective override-aware limits.

Phase 4: Admin API

1. Add admin-only Conat system methods.
2. Add transactionally written audit events.
3. Add API tests:
   - non-admin denied,
   - invalid payload denied,
   - set writes current row and event,
   - clear removes/disables current row and writes event,
   - expired row is returned as inactive or omitted consistently.
4. Add frontend generic client and admin action wrappers.

Phase 5: Admin UI

1. Add `AdminEntitlementOverrides` under the existing admin membership page.
2. Show base/override/effective values.
3. Add save/clear/history.
4. Keep first UI scoped to dedicated-host, project/storage/memory, egress, and AI support-critical fields.
5. Add the numeric mode `?` popover with floor/cap/exact examples.
6. Add lightweight frontend validation before API call, but rely on backend validation for correctness.

Phase 6: Operational polish

1. Add an admin runbook note:
   - when to raise prepaid vs postpaid limits,
   - why `site-funded` is not the normal support path for public users,
   - recommended expiration defaults,
   - how recovery works for stopped/deprovisioned hosts.
2. Add optional user notification checkbox if support wants it.
3. Add an admin dashboard filter later for accounts with active overrides.

## Testing Checklist

Focused tests:

- `src/packages/server/membership` override merge tests.
- `src/packages/server/membership/project-limits` effective limit tests.
- AI limit enforcement tests for override-aware `ai_limits`.
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
   - Recommendation: not in the first support UI. Keep backend compatibility with site-funded deployments, but require a separate break-glass path if this becomes necessary.
3. Should overrides support all `MembershipUsageLimits` immediately?
   - Recommendation: backend validator can support them; UI initially exposes dedicated-host, storage, max-projects, memory, egress, and known AI limit fields.
4. Should users be notified when support changes an override?
   - Recommendation: not by default; add an explicit checkbox later.
5. Should there be a maximum expiration?
   - Recommendation: no hard maximum initially, but UI should default to a short expiration such as 7 or 30 days for support-created dedicated-host overrides.

## Minimal Release Definition

The release-critical version is complete when:

- support can enable/disable host creation for an account,
- support can raise/lower prepaid and postpaid host windows,
- support can raise/lower postpaid unbilled exposure limit,
- support can raise/lower max projects, total storage, per-project disk quota, project memory, managed egress windows, and AI limits,
- all changes are audited with actor/reason/time,
- expired overrides are ignored,
- host admission and spend enforcement consume the effective policy,
- the admin page shows base, override, and effective values.
