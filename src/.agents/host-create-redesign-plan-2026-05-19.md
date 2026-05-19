# Host Create Redesign Plan

Status: proposed implementation plan, second draft recorded on 2026-05-19.

The current create-host flow is hard to reason about because the same AntD form
is mutated by several independent effects. This has already made the "Create
similar" flow fragile: opening the side panel, mounting form items, defaulting
provider fields, catalog-driven option normalization, and create-similar all race
to write to the same form instance.

This plan treats the problem as a state ownership and UI architecture issue, not
as another timing patch.

## Goals

- Make create-host state deterministic and testable.
- Make "Create similar" a normal initialization path, not an imperative form
  patch.
- Keep provider constraints for GCP, Nebius, self-host, zones, regions,
  machine types, GPU types, disk types, spot support, and storage modes correct.
- Treat GCP, Nebius, Lambda, and Hyperstack as first-class managed providers in
  the create flow. Lambda and Hyperstack should be simpler than GCP/Nebius
  because their option sets are comparatively small, but they must not be
  bolted on after the draft model is designed.
- Include a small number of hardcoded minimal presets that are valid, useful,
  and visually natural in the modal. This should be deliberately simple, not a
  flexible template system.
- Avoid infinite normalization loops.
- Improve the UI enough that users can understand the form without scrolling
  through a cramped side panel.
- Preserve existing backend create behavior and payload shape.

## Non-Goals

- Do not change the host create RPC or billing semantics as part of the first
  pass.
- Do not redesign host list/card/status UI in this work.
- Do not redesign provider catalog fetching beyond what is needed for a clean
  create flow.
- Do not add click-to-switch pricing mode here.
- Do not build a broad user-configurable preset/template system. A few
  hardcoded presets are enough.

## Current Failure Mode

The current flow has multiple writers:

- `HostsPage` writes form values for create-similar.
- `useHostProviders` writes a default provider.
- `useHostForm` writes defaults and clears inactive provider fields.
- `HostCreateProviderFields` writes region, zone, machine type, GPU, disk, and
  storage defaults.
- `HostCreateAdvancedFields` writes disk type and advanced defaults.
- `HostCreateForm` writes funding, restore policy, self-host, and pricing
  defaults.
- `Form.Item initialValue` also writes defaults during mount.

These writes are triggered by `useEffect`, `Form.useWatch`, conditional mounts,
catalog loading, and side-panel open/close state. The resulting behavior is not
one state machine; it is a collection of implicit state machines sharing one
mutable object.

The key technical smell is this: the authoritative create-host state is the
AntD form instance, but many components also derive state from it and then write
back into it.

## Target Architecture

Introduce a pure draft module:

`src/packages/frontend/hosts/create/host-create-draft.ts`

The draft module owns all defaulting and normalization.

Core types:

```ts
type HostCreateDraft = {
  name: string;
  provider: HostProvider;
  funding_mode?: HostFundingMode;
  region_preference: "balanced" | "closest" | "cheapest";
  price_display: "hourly" | "monthly";
  region?: string;
  zone?: string;
  machine_type?: string;
  gpu_type?: string;
  size?: string;
  gpu?: string;
  storage_mode?: "persistent" | "ephemeral";
  disk_type?: string;
  disk_gb?: number;
  pricing_model: HostPricingModel;
  interruption_restore_policy: HostInterruptionRestorePolicy;
  spot_recovery_policy?: HostSpotRecoveryPolicy;
  self_host_kind?: string;
  self_host_mode?: string;
  self_host_ssh_target?: string;
  auto_grow_enabled?: boolean;
  auto_grow_max_disk_gb?: number;
  auto_grow_growth_step_gb?: number;
  auto_grow_min_grow_interval_minutes?: number;
};

type HostCreateDraftContext = {
  enabledProviders: HostProvider[];
  providerOptions: Array<{ value: HostProvider; label: string }>;
  catalogByProvider: Partial<Record<HostProvider, HostCatalog>>;
  providerFlags: HostProviderFlags;
  billing: {
    fundingModeOptions: HostFundingModeOption[];
    defaultFundingMode?: HostFundingMode;
  };
  pricingSettings: HostPricingSettings;
  userLocation?: {
    country?: string;
    regionCode?: string;
  };
};
```

Supported managed providers in this model:

- GCP: most complex, with region/zone compatibility, CPU/GPU machine families,
  spot/on-demand, persistent disk constraints, and pricing metadata.
- Nebius: GPU-oriented, with important spot support constraints and disk type
  constraints.
- Lambda: smaller catalog, important because VM availability has returned and
  because a Lambda partnership is plausible. The draft model should be ready for
  full Lambda testing.
- Hyperstack: smaller catalog, expected to be easier than GCP/Nebius, but still
  must flow through the same deterministic draft normalization.
- Self-host: should be a separate simpler flow, not a branch inside the managed
  cloud modal.

Core functions:

```ts
buildDefaultDraft(context): HostCreateDraft
buildSimilarDraft(host, context): HostCreateDraft
normalizeDraft(draft, context, reason): HostCreateDraft
applyPreset(presetId, draft, context): HostCreateDraft
buildCreateHostPayload(draft, context): CreateHostPayload
getDraftWarnings(draft, context): HostCreateWarning[]
getDraftPriceEstimate(draft, context): ProviderPriceEstimate | undefined
getAvailablePresets(context): HostCreatePreset[]
```

Rules:

- `normalizeDraft` must be pure.
- `normalizeDraft` must be idempotent:
  `normalizeDraft(normalizeDraft(draft, context), context)` must not change the
  draft.
- Provider changes are explicit actions, not implicit effects.
- Catalog changes can trigger normalization, but only through one owner.
- Components render draft state and dispatch actions; they do not call
  `form.setFieldsValue` to repair each other.
- `Form.Item initialValue` should be removed from the create-host form path.
- AntD Form may still be used for layout and validation, but it must not be the
  canonical state store.

## Minimal Presets

Add a very small preset system as part of the draft module. This should be
hardcoded and intentionally modest.

Presets are not templates, not user-editable, and not meant to cover every
provider. They are a UI aid that gives users a few valid starting points instead
of a single fragile default.

Recommended initial presets:

- `Balanced CPU`: modest CPU/RAM, persistent disk, standard pricing.
- `Low-cost spot`: modest CPU/RAM, persistent disk, spot pricing with immediate
  restore when supported.
- `GPU workstation`: first valid GPU choice for the selected provider, with
  provider-appropriate disk defaults.

Preset rules:

- A preset is only shown if it can normalize to a valid draft for the current
  provider and catalog.
- Presets should be provider-aware but not provider-specific UI branches.
- Applying a preset is just another reducer action:
  `apply_preset -> normalizeDraft`.
- If a preset cannot be satisfied exactly, it should either be hidden or visibly
  marked unavailable. It should not silently become a misleading configuration.
- Create-similar should not auto-apply a preset. It is already a concrete draft.

UI placement:

- Presets should appear near the top of the managed cloud modal as compact cards
  or pills under the provider selector.
- They should look like shortcuts, not a required wizard step.
- Each preset should show a one-line summary such as "2-4 vCPU, persistent disk"
  or "GPU when available".
- The selected preset does not need to remain sticky after the user edits fields;
  it can become "Custom" once modified.

This deliberately avoids the failure mode of a large flexible template system
with too many choices.

## Draft Reducer

Add:

`src/packages/frontend/hosts/create/use-host-create-draft.ts`

Reducer actions:

- `init_default`
- `init_similar`
- `apply_preset`
- `set_provider`
- `set_basic_field`
- `set_region_preference`
- `set_placement`
- `set_machine`
- `set_storage`
- `set_pricing`
- `set_restore_policy`
- `set_spot_recovery_policy`
- `set_self_host`
- `set_auto_grow`
- `catalog_changed`
- `billing_changed`

Every reducer action should call `normalizeDraft` exactly once before storing
the result.

This makes the state machine explicit:

```txt
action -> draft update -> normalize once -> render
```

Not:

```txt
render -> useEffect -> setFieldsValue -> useWatch -> render -> useEffect ...
```

## Create Similar

The new create-similar flow should be:

```ts
openCreateHostModal({
  mode: "similar",
  sourceHostId: host.host_id,
  initialDraft: buildSimilarDraft(host, context),
});
```

There should be no timeout, no panel-mount dependency, and no post-mount form
patch.

The modal should show a small "Created from ..." banner with the source host
name and truncated host id. That gives users confidence that they are editing a
clone, not the default form.

Create-similar copy rules:

- Copy funding mode if it is still allowed for the current account; otherwise
  fall back to the current account policy.
- Copy concrete region and zone, not region preference.
- Copy pricing model and recovery policy if supported for the provider/machine
  combination; otherwise normalize to the nearest safe valid choice and show a
  warning.
- Copy disk/storage settings when supported; otherwise normalize and show a
  warning.
- Do not apply a preset after create-similar. The source host is the preset.

## UI Direction

Replace the side panel with a modal. The side panel is too narrow for this
problem domain: provider, placement, machine type, GPU, storage, price, spot
recovery, and billing all have meaningful constraints.

Self-host should move into a separate simpler create flow instead of sharing the
managed cloud modal. It needs more hand-holding, not more controls:

- Explain that CoCalc takes over the VM reachable by SSH.
- Make the destructive/ownership implication clear before setup.
- Include a compact tutorial path for local/manual VM setup, e.g. install
  Multipass, create a VM, enable SSH access to that VM.
- Keep self-host create state separate from managed cloud provider defaults.

Recommended modal layout:

- Width: 960-1100 px on desktop.
- Header: "Create host" or "Create similar host".
- Left/main column: form sections.
- Right sticky column: price estimate, selected provider, risk/warning badges,
  and Create button.
- Mobile: full-screen modal or drawer with the same sections stacked.

Sections:

1. Basics
   - Name
   - Provider
   - Billing/funding mode
2. Presets
   - Balanced CPU
   - Low-cost spot
   - GPU workstation
3. Location
   - Region preference
   - Region
   - Zone
   - Backup region explanation
4. Compute
   - Machine type
   - GPU type, when relevant
   - Machine sort toggle
5. Storage
   - Storage mode
   - Disk type
   - Disk size
   - Auto-grow
6. Pricing and Recovery
   - Standard/spot choice
   - Interruption restore
   - Spot recovery strategy
7. Summary
   - Price estimate
   - Availability warnings
   - Catalog status
   - Create button

The summary panel is not an admin approval step. It is simply a compact
"review before create" area for the user who is creating the host. It should
make cost, provider, location, machine, disk, and spot/recovery choices easy to
verify before clicking Create.

The first implementation does not need a strict multi-step wizard. A single
modal with section cards and a sticky summary is likely better because users
need to see price and warnings while they make choices.

## Imagegen2 Design Phase

Before implementing the modal UI, use imagegen2 to generate design options.

Prompt ingredients:

- Show screenshots of the current long create-host form.
- Explain that the UI configures dedicated cloud/project hosts with provider,
  region, zone, machine type, GPU, disk, billing, spot/standard pricing, and
  recovery strategy.
- Ask for a clean admin/product UI, not a marketing landing page.
- Ask for a wide modal with section cards and a sticky summary.
- Ask for dense but readable controls suitable for technical users.
- Include examples for GCP CPU-only, GCP GPU, Nebius GPU, Lambda GPU,
  Hyperstack GPU, and self-host as a separate simpler flow.
- Include a compact presets row with only a few choices: Balanced CPU,
  Low-cost spot, and GPU workstation.
- Ask for visible warnings and price summary, but avoid alarmist visuals.

Evaluate imagegen2 output before implementation:

- Can a user find provider, machine, disk, and pricing in under 5 seconds?
- Do the presets look like helpful shortcuts rather than a complicated template
  system?
- Is the price summary always visible?
- Are advanced/recovery options discoverable without dominating the form?
- Does the layout handle long machine type names?
- Does it work at 900 px wide and mobile full-screen?

Implementation should adapt the best visual ideas, not copy generated text or
invented provider details.

## Implementation Phases

### Phase 0: Branch Hygiene

The recent create-similar timing commits should not be the foundation for the
refactor. Before implementation:

- Save the current branch state if needed.
- Remove or revert the timing-patch commits from the working branch.
- Keep any unrelated host work intact.
- Start the redesign from the last known stable host-create baseline.

The goal is to avoid building the new architecture on top of known-bad
workarounds.

### Phase 1: Pure Draft Module

Add `host-create-draft.ts` and tests first.

Tests must cover:

- default GCP draft;
- default Nebius draft;
- default Lambda draft;
- default Hyperstack draft;
- default self-host draft;
- GCP CPU machine with no GPU;
- GCP GPU machine constraining region and zone;
- Nebius GPU machine;
- Nebius spot-supported and spot-unsupported machine types;
- Lambda GPU machine;
- Hyperstack GPU machine;
- persistent versus ephemeral storage;
- disk type defaults;
- spot pricing default restore policy;
- standard pricing restore policy;
- available presets for GCP;
- available presets for Nebius;
- available presets for Lambda;
- available presets for Hyperstack;
- applying each visible preset produces a valid normalized draft;
- applying a preset is idempotent after normalization;
- create-similar from GCP host;
- create-similar from Nebius host;
- create-similar from Lambda host;
- create-similar from Hyperstack host;
- create-similar from self-host host;
- provider switch GCP -> Nebius;
- provider switch Nebius -> GCP;
- provider switch Lambda -> GCP;
- provider switch Hyperstack -> Nebius;
- idempotence of normalization for every fixture.

The idempotence test is critical. It is the safety check against infinite
defaulting loops.

### Phase 2: Wire Draft Into Existing UI

Before changing the visual shell:

- Replace `useHostProviders`, `useHostForm`, and scattered form default effects
  in the create path with `useHostCreateDraft`.
- Keep the existing side panel temporarily.
- Keep AntD Form only as a renderer/validator.
- Remove `Form.Item initialValue` from create-host fields.
- Remove provider/default repair effects from presentational components.
- Make create-similar initialize draft state directly.
- Add the minimal presets to the draft model, but do not worry about final
  visual styling yet. A simple row of buttons is enough for this phase.

This phase should fix correctness before visual redesign.

### Phase 3: Modal Shell

Replace `HostCreatePanel` with:

`src/packages/frontend/hosts/components/host-create-modal.tsx`

Behavior:

- "Create host" opens modal with `buildDefaultDraft`.
- "Create similar" opens modal with `buildSimilarDraft`.
- Presets are visible in the modal when they are valid for the selected
  provider/catalog.
- Successful create closes modal.
- Cancel closes modal without mutating the host list.
- The host list no longer needs layout width hacks for the create panel.

Keep the old side panel component temporarily if rollback is useful, but remove
it once the modal is validated.

### Phase 4: Self-Host Flow Split

Move self-host creation into a separate, simpler modal or flow.

The self-host flow should:

- avoid managed-cloud machine/region/disk terminology;
- explain that CoCalc will manage the target VM after SSH setup;
- provide a short Multipass-based local VM guide as an expandable tutorial;
- keep the existing self-host backend payload behavior;
- reuse shared validation and create action plumbing where sensible.

### Phase 5: Visual Redesign

Implement imagegen2-inspired layout:

- `HostCreateModal`
- `HostCreateBasicsSection`
- `HostCreatePresetsSection`
- `HostCreateLocationSection`
- `HostCreateComputeSection`
- `HostCreateStorageSection`
- `HostCreatePricingRecoverySection`
- `HostCreateSummaryPanel`
- `HostCreateWarnings`

Use existing CoCalc theme constants where appropriate. Avoid one-off magic
colors unless the surrounding hosts UI already uses them.

### Phase 6: Payload and Create Action

Move payload creation behind draft conversion:

```ts
const payload = buildCreateHostPayload(draft, context);
await onCreate(payload);
```

Keep backend validation authoritative. Frontend validation should prevent
obvious impossible choices, but backend must still reject invalid provider
combinations.

### Phase 7: Remove Old Create Form State

Delete or simplify:

- create-specific branches of `useHostProviders`;
- create-specific defaulting in `useHostForm`;
- create-specific normalization in `HostCreateProviderFields`;
- create-specific normalization in `HostCreateAdvancedFields`;
- `HostCreatePanel`, if the modal replaces it completely.

Do not delete provider registry helpers; the draft module should reuse them.

## Validation Plan

Automated checks:

- `cd src/packages/frontend && pnpm jest hosts/create/host-create-draft.test.ts --runInBand`
- `cd src/packages/frontend && pnpm jest hosts/components/host-create-modal.test.tsx --runInBand`
- `pnpm -C src lint:frontend`
- `cd src/packages/frontend && pnpm tsc --build`

Component tests:

- Open default create modal.
- Open create-similar while modal is closed.
- Open create-similar while modal is already open.
- Apply each visible preset and verify the resulting fields are non-blank and
  valid for the selected provider.
- Switch provider repeatedly and verify no blank required fields.
- Simulate catalog arriving after modal opens.
- Verify Nebius GPU create-similar preserves provider, machine type, disk, spot
  policy, and storage settings.
- Verify GCP GPU create-similar preserves compatible region/zone when valid and
  normalizes when invalid.
- Verify Lambda create-similar preserves provider and valid machine selection.
- Verify Hyperstack create-similar preserves provider and valid machine
  selection.
- Verify self-host create-similar preserves SSH target.

Manual smoke tests:

- GCP standard CPU host.
- GCP spot CPU host.
- GCP GPU host.
- Nebius GPU standard host.
- Nebius GPU spot host.
- Lambda VM, now that Lambda has VMs available again.
- Hyperstack VM.
- Self-host direct SSH target.
- No catalog loaded.
- Admin and non-admin billing modes.
- Admin catalog refresh from inside the modal, including last-refresh timestamp
  if the backend exposes it.
- Mobile width.

## Rollback Strategy

Keep the refactor in small commits:

1. draft module and tests only;
2. existing UI wired to draft state, including minimal presets;
3. modal shell behind existing create action;
4. self-host split;
5. visual redesign;
6. remove old side panel and old default effects.

If the modal work regresses, the draft module should still be valuable and can
remain. The key rollback boundary is after Phase 2: once the existing UI is
driven by draft state, correctness should improve even before the modal lands.

## Open Questions

- What exact hardcoded preset values should we start with for each provider?
  Initial implementation can choose the first valid modest option from catalog
  rather than committing to product-level names in advance.
- Does the backend expose provider catalog last-refresh timestamps in the data
  already available to the frontend? If yes, show them in the admin refresh
  affordance. If not, this is optional.
- Should Lambda-specific partnership language appear in product UI? Not for
  this implementation; keep it provider-neutral until there is a concrete
  partnership.

Resolved decisions:

- Create-similar copies funding mode if allowed; otherwise it falls back to the
  current account policy.
- Create-similar copies concrete region/zone, not region preference.
- Self-host gets a separate simpler flow.
- The "review" concept is not admin review. It is a user-facing summary panel
  before clicking Create.
- Admin catalog refresh may appear inside the modal, visible only to admins,
  with explanatory text that it is mainly needed for onboarding and normally
  refreshes automatically afterward.

## Recommended First Commit

Start with the pure draft module and tests. Do not change UI in the first
commit except for imports needed by tests. The first commit should prove that
the hard part, provider normalization, is deterministic.
