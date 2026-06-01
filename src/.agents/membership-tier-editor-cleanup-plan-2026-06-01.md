# Membership Tier Editor Cleanup Plan

Status: phases 1-4 implemented for release-blocker item 15 in
`release-blocker-triage-2026-05-29.md`; phase 5 is in progress; phase 6
remains undone cleanup work.

## Objective

Turn the admin membership tier editor from a long schema-shaped form into an
operator decision console.

The new editor should help an admin answer:

- What does this tier promise to users?
- What hard costs can this tier create?
- What shared-capacity pressure can this tier create?
- What abuse guardrails are active?
- Is this tier economically plausible at its monthly/yearly price?

The editor should be usable without knowing old CoCalc quota internals.
Advanced raw JSON remains available, but it should no longer be the main way to
configure ordinary product tiers.

## Product Decisions

These cocalc-ai decisions replace legacy cocalc.com quota semantics:

- Projects always have network. A project without network is not a useful
  cocalc-ai product surface.
- CPU is not sold as per-project `cores` or `cpu_shares`. CPU tiering is:
  - relative shared-compute priority;
  - project-host tier access;
  - rolling CPU-hours for abuse/product limits;
  - admin capacity and abuse visibility.
- `mintime` and `always_running` are not product controls. Project-host runtime
  eviction is based on global host pressure, running-project priorities, and
  observed activity, not a per-tier idle timeout knob.
- `member_host` is replaced by `features.project_host_tier`. A user with tier N
  can use shared public project hosts with host tier <= N, plus explicitly
  delegated/dedicated hosts.
- `ephemeral_state` and `ephemeral_disk` are obsolete experiment fields and
  should not appear in cocalc-ai tier configuration.
- Dedicated host creation remains a separate entitlement:
  `features.create_hosts`.
- There are no legacy cocalc-ai projects that need old cocalc.com tier
  semantics preserved as product behavior. Compatibility code can be temporary
  migration scaffolding, not a permanent user-visible contract.

## Current Code Inventory

Primary editor:

- `src/packages/frontend/admin/membership-tiers.tsx`
  - long Ant form;
  - has some typed fields for common usage limits;
  - still exposes raw `project_defaults`, `features`, `ai_limits`, and
    `usage_limits` JSON;
  - labels are narrow and currently get truncated in flyout-sized layouts.

Tier templates and presentation:

- `src/packages/util/membership-tier-templates.ts`
  - built-in tier defaults;
  - currently still includes legacy `network`, `member_host`, `mintime`, and
    `cores` in `project_defaults`.
- `src/packages/util/membership-tier-presentation.ts`
  - derives public/store presentation;
  - currently treats `member_host`, `mintime`, and old project quota fields as
    public-facing benefits/limits.

Backend normalization and policy:

- `src/packages/server/membership/project-defaults.ts`
  - only normalizes legacy settings fields:
    `cores`, `cpu_shares`, `memory`, `memory_request`, `disk_quota`,
    `member_host`, `privileged`, `network`.
  - This is the main bridge from membership entitlements to project run quota.
- `src/packages/server/project-host/placement.ts`
  - uses `features.project_host_tier` for shared project-host placement.
- `src/packages/server/conat/host-registry.ts`
  - uses `usage_limits.shared_compute_priority` for host stop/restart priority.
- `src/packages/server/projects/runtime-slots.ts`
  - uses `usage_limits.max_sponsored_running_projects`.
- `src/packages/server/membership/effective-limits.ts`
  - normalizes user/account usage limits including egress, CPU, ACP, blob,
    RootFS, invite, and spend limits.
- `src/packages/server/project-host/admission.ts`
  - uses `features.create_hosts` and dedicated-host spend guardrails.

Frontend references that must be updated or made compatibility-only:

- `src/packages/frontend/account/membership-status.tsx`
  - still lists legacy project default keys including `cores`, `network`,
    `member_host`, `cpu_shares`.
- `src/packages/frontend/project/project-banner.tsx`
  - shows trial/no-network/no-member-host warnings from run quota.
- `src/packages/frontend/project/settings/sections.tsx`
  - still models "network" settings around old no-network/non-member concepts.
- `src/packages/frontend/project/settings/run-quota/*`
  - legacy run-quota display/edit logic.
- `src/packages/frontend/projects/store.ts`
  - maps current `run_quota` back to legacy settings-shaped values.

## Field Classification

### Primary Product Fields

These should be first-class editable controls in the new tier editor.

Product/store:

- `id`
- `label`
- `disabled`
- `store_visible`
- `store_description`
- `store_highlights`
- `priority`
- `price_monthly`
- `price_yearly`
- `trial_days`
- `course_store_visible`
- `course_price`
- `course_duration_days`
- `course_grace_days`
- `notes`

Runtime/resource promises:

- `project_defaults.memory`
- `project_defaults.memory_request`
- `project_defaults.disk_quota`
- `features.project_host_tier`
- `usage_limits.shared_compute_priority`
- `usage_limits.max_sponsored_running_projects`

Usage budgets and abuse/product limits:

- `usage_limits.cpu_5h_seconds`
- `usage_limits.cpu_7d_seconds`
- `usage_limits.egress_5h_bytes`
- `usage_limits.egress_7d_bytes`
- `usage_limits.blob_account_total_bytes`
- `usage_limits.blob_account_count`
- `usage_limits.blob_project_total_bytes`
- `usage_limits.blob_project_count`
- `usage_limits.rootfs_count`
- `usage_limits.rootfs_total_storage_gb`
- `usage_limits.rootfs_max_storage_gb`
- `usage_limits.rootfs_oci_images`
- `ai_limits.units_5h`
- `ai_limits.units_7d`

Collaboration/course controls:

- `usage_limits.project_max_collaborators_and_pending_invites`
- `usage_limits.course_max_students_and_pending_invites`
- invite email send/count/message/link controls.

Codex/ACP controls:

- `usage_limits.acp_max_queued_per_account`
- `usage_limits.acp_max_queued_per_thread`
- `usage_limits.acp_max_created_5h_per_account`
- `usage_limits.acp_max_created_7d_per_account`
- `usage_limits.acp_max_running_per_account`
- `usage_limits.acp_max_running_per_project`
- `usage_limits.acp_max_active_automations_per_project`

Dedicated host controls:

- `features.create_hosts`
- `usage_limits.prepaid_host_usage_limit_5h_usd`
- `usage_limits.prepaid_host_usage_limit_7d_usd`
- `usage_limits.credit_spend_limit_5h_usd`
- `usage_limits.credit_spend_limit_7d_usd`
- `usage_limits.dedicated_host_egress_policy`
- dedicated host funding policy fields once they are exposed at tier level.

### Compatibility-Only Fields

These may remain in low-level run quota or historical compatibility code during
the transition, but should not be visible in the primary cocalc-ai tier editor.

- `project_defaults.cores`
- `project_defaults.cpu_shares`
- `project_defaults.mintime`
- `project_defaults.network`
- `project_defaults.member_host`
- `project_defaults.always_running`

Recommended migration:

- stop writing them from built-in templates;
- stop rendering them in membership tier presentation;
- keep `project-defaults.ts` tolerant of existing values until dependent
  project run-quota paths are simplified;
- later delete or neutralize the legacy run-quota UI paths that display
  no-network/member-host/trial warnings.

### Remove From cocalc-ai Tier Configuration

These should not be surfaced and should be removed from templates, editor
metadata, and docs when the compatibility pass reaches them.

- `ephemeral_state`
- `ephemeral_disk`
- any new product copy that implies no-network projects are a tier feature.

## Target Editor UX

The editor should use an intentional card/dashboard layout:

1. `Product Card`
   - public name, status, visibility, store text, course visibility;
   - summary: price, trial, store visibility, course availability.
2. `Runtime Card`
   - RAM limit/request, disk quota, host tier, shared compute priority,
     sponsored running projects;
   - summary: "8 GB RAM, 10 GB disk, host tier 1, priority 3, 3 sponsored
     running projects".
3. `Usage Budgets Card`
   - CPU-hours, egress, AI units, storage/blob, RootFS;
   - summary: CPU 80/400 h, egress X/Y GB, AI units, RootFS count.
4. `Collaboration & Course Card`
   - collaborators, course students, invite send limits, custom message limits;
   - summary: max project collaborators, max course students, invite email
     enabled/disabled.
5. `Codex / ACP Card`
   - queued/running/created automation limits;
   - summary: "100 created / 5h, 500 / 7d, 10 running/account".
6. `Dedicated Hosts & Spend Card`
   - can create hosts, spend windows, funding/egress policy;
   - summary: host creation enabled/disabled plus prepaid/postpaid guardrails.
7. `Financial Risk Card`
   - advisory model;
   - operator assumptions and expected usage estimates are persisted on the
     membership tier in `pricing_model`, not browser-local storage.
8. `Advanced JSON Card`
   - raw `project_defaults`, `features`, `ai_limits`, `usage_limits`;
   - collapsed by default;
   - visually marked "escape hatch / unsupported fields".

Card behavior:

- collapsed cards show a compact decision summary;
- expanded cards use wide labels and inline help;
- field groups use units and conversions (`GB`, `CPU-hours`, `USD`, counts);
- warnings appear next to fields with direct cost exposure;
- changes should update card summaries live before save.

Visual direction:

- use strong cards, summary badges, and risk meters rather than a plain vertical
  form;
- avoid clipped labels by using vertical labels or two-column cards with
  generous min-widths;
- use `COLORS` and existing CoCalc design tokens, but the layout should feel
  like an operations console;
- use image generation only for visual inspiration/mockup iteration, then
  implement as native React/Ant/CSS.

## Pricing And Capacity Model

The pricing model should be advisory. It should make assumptions explicit, not
pretend to solve pricing exactly.

### Operator Inputs

Initial inputs are persisted per tier in `pricing_model` so they travel with
export/import and can differ by price point:

- target gross margin percentage;
- support/overhead reserve percentage;
- cloud/provider egress cost per GB;
- object/blob storage cost per GB-month;
- RootFS/image storage cost per GB-month;
- AI unit cost in dollars per unit or per 100 units;
- shared project-host pool assumptions:
  - host monthly cost;
  - host usable RAM GB;
  - host usable vCPU;
  - target RAM oversubscription factor;
  - target CPU oversubscription factor;
  - target average active projects per paid user;
  - target average active projects per free user.

### Per-Tier Outputs

Show for the selected tier:

- monthly price and annualized monthly price;
- hard-cost budget:
  - AI 7-day limit converted to approximate monthly max;
  - managed egress 7-day limit converted to approximate monthly max;
  - blob/rootfs storage limit converted to monthly storage exposure;
  - dedicated host spend guardrails;
- shared-capacity budget:
  - CPU-hours per 7 days and approximate CPU-hours/month;
  - sponsored running project limit;
  - approximate RAM concurrency exposure;
  - host tier access.
- risk flags:
  - "hard-cost max exceeds monthly price";
  - "AI budget alone exceeds target margin";
  - "egress budget alone exceeds target margin";
  - "storage budget likely exceeds target margin";
  - "compute budget is generous; monitor abuse/capacity dashboard";
  - "free tier can create hard cost; keep limits low or require verification".

### Cost Categories

Use different language for different risks:

- `Hard cost`: AI, egress, dedicated-host postpay/prepay, storage.
- `Capacity pressure`: RAM, CPU-hours, running-project slots, host tier.
- `Abuse exposure`: free/trial CPU, free/trial egress, ACP creation, invite
  email sends.

This distinction matters because CPU on shared hosts is mostly about quality of
service and capacity planning; egress/AI can become immediate bills.

## Implementation Phases

### Phase 0: Plan And Inventory

- [x] Inventory current code paths.
- [x] Record product decisions about eliminated legacy fields.
- [x] Keep `features.create_hosts` as a separate dedicated-host entitlement.
- [x] Decide whether pricing model assumptions are local-only initially or
      persisted.

### Phase 1: Metadata Layer

Status: implemented.

Create a metadata module for tier fields, likely:

- `src/packages/util/membership-tier-field-metadata.ts`

It should define:

- field id;
- source object path;
- label;
- help text;
- unit;
- input type;
- conversion to/from stored representation;
- section/card;
- whether it affects hard cost, capacity, abuse, or storefront;
- whether it is primary, advanced, compatibility-only, or deprecated.

The editor, account entitlement override UI, public presentation, and pricing
model should all share this metadata where practical.

### Phase 2: Legacy Field Cleanup In Templates And Presentation

Status: implemented for the admin-facing cocalc-ai tier editor and templates.

- Remove legacy CPU/network/runtime keys from built-in tier templates:
  - `network`;
  - `member_host`;
  - `mintime`;
  - `cores`;
  - any accidental `cpu_shares`, `always_running`, `ephemeral_*`.
- Keep `memory`, `memory_request`, and `disk_quota`.
- Update `membership-tier-presentation.ts` to present cocalc-ai concepts:
  - project host tier;
  - shared compute priority;
  - CPU-hours;
  - sponsored running projects;
  - RAM/disk;
  - AI/egress/storage limits.
- Update `account/membership-status.tsx` to avoid showing eliminated legacy
  quota fields as tier benefits.
- Add tests that templates no longer emit eliminated fields.

Important: this phase changes product semantics but not the low-level project
runtime implementation yet. Low-level code can continue tolerating old keys.

### Phase 3: Card-Based Editor UI

Status: implemented.

Refactor `src/packages/frontend/admin/membership-tiers.tsx`:

- split editor into card components;
- preserve current save/load behavior;
- replace the long `labelCol` form with card-local field layouts;
- make advanced JSON collapsible and clearly secondary;
- add live summaries for each card;
- keep template buttons but show them as "Start from template" actions.
  - ensure templates are complete (all values filled in, none blank)

Likely new files:

- `src/packages/frontend/admin/membership-tiers/editor.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/product.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/runtime.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/usage-budgets.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/collaboration.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/acp.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/dedicated-hosts.tsx`
- `src/packages/frontend/admin/membership-tiers/cards/advanced-json.tsx`
- `src/packages/frontend/admin/membership-tiers/field-conversions.ts`

### Phase 4: Pricing/Risk Panel V1

Status: implemented.

Add an advisory financial model card.

Use tier-level persisted assumptions and deterministic calculations. Do not
block save based on risk; show risk severity and explanations.

Initial formulas:

- `monthly_ai_max = ai_units_7d * 30 / 7 * ai_unit_cost`
- `monthly_egress_max = egress_7d_gb * 30 / 7 * egress_cost_per_gb`
- `monthly_blob_max = blob_account_total_gb * storage_cost_per_gb_month`
- `monthly_rootfs_max = rootfs_total_storage_gb * rootfs_cost_per_gb_month`
- `monthly_hard_cost_max = ai + egress + blob + rootfs + host spend guardrail`
- `target_hard_cost_budget = monthly_price * (1 - target_margin - overhead)`

Compute/capacity indicators:

- `monthly_cpu_hours_budget = cpu_7d_hours * 30 / 7`
- `active_project_pressure = max_sponsored_running_projects`
- `ram_pressure = active_project_pressure * memory_limit_gb`
- compare RAM pressure to configured host-pool assumptions.

The output should guide tier tuning, e.g.:

- "At $20/month and 70% target gross margin, hard costs should stay below
  $6/month. This tier's configured max hard-cost exposure is $4.80/month."
- "CPU is not a direct hard cost here; use CPU-hours as a capacity and abuse
  budget."

### Phase 5: Low-Level Runtime Semantics Cleanup

Status: started.

Completed first slice:

- membership project defaults now normalize only cocalc-ai resource fields
  (`memory`, `memory_request`, `disk_quota`);
- membership-computed project run quotas force `network` and `member_host` on
  at the runtime boundary;
- cocalc-ai project banner/settings UI no longer shows no-network or
  non-member-host warnings;
- stale frontend quota conversion treats missing legacy `network` and
  `member_host` values as enabled, while preserving explicit false/0 values for
  compatibility.

Completed second slice:

- project run-quota display now shows cocalc-ai runtime fields instead of the
  legacy `PROJECT_UPGRADES.field_order` product model;
- invite email URL validation and project internet-access checks default to
  enabled unless a compatibility path explicitly disables network/member-host;
- removed unused no-network, non-member-host, and trial warning components.

After the editor is usable:

- make project defaults emit only cocalc-ai-supported fields;
- update `project-defaults.ts` to normalize only supported fields plus a
  compatibility path;
- remove no-network/no-member-host banners and warnings from cocalc-ai UI;
- ensure project runtime always has network unless a separate security mode
  intentionally disables it for a non-product operation;
- remove membership-tier presentation/tests that depend on legacy
  `member_host`, `network`, `mintime`, `cores`, and `cpu_shares`;
- audit `compute-states`, project settings run-quota UI, and old purchase quota
  utilities for cocalc-ai relevance.

### Phase 6: Remove Deprecated Fields

Status: not started.

Only after Phase 5 is validated:

- delete deprecated fields from cocalc-ai tier templates;
- remove compatibility UI;
- remove or isolate old quota purchase utilities if they are no longer used by
  cocalc-ai;
- update docs and tests.

## Validation Plan

Focused tests:

- membership tier template tests:
  - no eliminated legacy fields in built-in cocalc-ai templates;
  - product summaries include host tier, CPU-hours, and hard-cost limits.
- editor tests:
  - card summaries update from form values;
  - save produces the same persisted shape for supported fields;
  - advanced JSON still round-trips unknown fields.
- pricing model tests:
  - egress/AI/storage hard-cost formulas;
  - margin/risk classification;
  - CPU appears as capacity pressure, not direct bill.

Manual tests:

- edit the `standard` tier from templates;
- verify labels do not clip at common admin widths;
- save/reload preserves typed fields and advanced JSON;
- compare public pricing page output before/after;
- verify membership status page no longer advertises eliminated legacy
  concepts.

Regression checks:

- `pnpm -C src prettier --write <touched files>`
- frontend focused jest tests;
- `cd src/packages/frontend && pnpm tsc --build`
- `cd src/packages/util && pnpm tsc --build`
- `cd src/packages/server && pnpm tsc --build` when backend normalization is
  touched;
- `pnpm -C src lint:frontend` for frontend changes.

## Open Questions

1. Should pricing model assumptions be persisted globally as site settings, or
   stay local/ephemeral in the first implementation? (ans: persisted on each
   membership tier in `pricing_model`, including expected usage estimates)
2. Should host tier access be shown publicly in pricing, or only as admin/internal
   product configuration? (ans: public)
3. Do we want per-tier recommended defaults generated from price point targets
   (`$8`, `$20`, `$100`) or only advisory warnings after admins enter values? (ans: only warnings)
4. Should free-tier hard-cost features default to zero unless email/2FA/payment
   verification is present? (ans: no, this is up to admins; that said, AI should default to 0 for the free tier, since users can just enter their own codex subscription; the main issue is egress and a low but nonzero setting will be fine, but is needed, e.g., otherwise you can't even download a file or use anything. Running a business incurs risk...)
