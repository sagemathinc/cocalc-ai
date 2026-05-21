# Project Creation Redesign Plan

Last updated: 2026-05-20

## Goal

Make project creation a high-trust, low-friction first-run experience.

This is not just a nicer form. It is the admission controller for a CoCalc
workspace. It must help users make good choices about runtime image, host,
region, quotas, storage, reliability, and start behavior without forcing them to
understand the full system up front.

The most important product message is:

CoCalc projects are not like cloud VMs. Nearly everything chosen here can be
changed later.

- Project title can be changed at any time and updates for collaborators.
- Projects can move between hosts in the same backup region quickly while
  retaining backups.
- Projects can move between backup regions; this works, but resets all but the
  most recent backup.
- RootFS image can be changed later, and rollback is possible.
- Host/region placement mainly affects interactive latency, not whether the
  project exists or where files can be copied.

The common path should fit on a normal laptop screen without scrolling. Advanced
details may expand or scroll, but the first impression should be clear and calm.

## Current Implementation Status

Implemented:

- `src/packages/frontend/projects/create/project-create-draft.ts`
- `src/packages/frontend/projects/create/project-create-draft.test.ts`
- `src/packages/frontend/projects/create/use-project-create-draft.ts`
- Modal shell instead of the old side panel.
- Deterministic draft/defaulting layer.
- Cheap title typing; title edits do not normalize RootFS or host state.
- Preset buttons.
- Right-side summary/action card.
- `Create Project` and `Create and Open`.
- `Create Project` passes `start: false` and does not open the project.
- `Create and Open` passes `start: true` and opens the project.
- Inline RootFS picker inside the create modal.
- Custom OCI path hidden from non-admins.
- RootFS scan findings visible but non-blocking.
- Host placement visible in the main path, still using the existing host picker.
- Account capacity health card with project slots, running-project slots, and
  storage usage.
- Health card can stop visible running projects when runtime slots are full.
- Host recommendation model with tests.
- Host picker uses create-specific recommendations and explains remote-host
  fallback when no compatible host exists in the selected backup region.
- RootFS presets choose catalog images by tags/metadata rather than hardcoded
  image names.
- Region/latency copy explains terminal/Jupyter lag, later host/region moves,
  nearby browser region, backup region, provider region, and backup-history
  limits when moving regions.
- Imagegen2-inspired layout polish: capacity is a top strip, project name comes
  before presets, presets are visual cards, region/latency is in the common
  path, and the summary uses decision-ready icon rows.

Still rough:

- The capacity card still needs visual polish and robust handling for missing
  backend usage fields.
- Host selection still opens a secondary modal.
- Host recommendations still need live dogfood validation against a deliberately
  varied set of hosts.
- Region/latency explanation has initial create-modal coverage, but still needs
  dogfood validation with remote-host fallback scenarios.
- RootFS preset configuration is not yet site-configurable beyond the initial
  built-in preset tags.
- The visual design is much closer to the target mockup, but still needs live
  dogfood validation across several viewport sizes and account states.

## Core Product Principles

### One Safe Default

For new users, the modal should show one obvious safe path:

- A reasonable title.
- A safe default RootFS image.
- Automatic host placement.
- Nearest sensible backup/host region.
- Clear `Create and Open` primary action.

The user should not have to understand hosts, regions, RootFS images, spot
instances, or storage policy before making their first project.

### Explain Impact, Not Internals

Every configurable choice should explain why it matters in user-visible terms.

Region/host choices primarily affect latency:

- How laggy typing in a terminal feels.
- How quickly Jupyter output appears.
- How responsive interactive editors feel.

The UI should explicitly say that region/host choices can be changed later.

### Surface Risk Without Blocking

RootFS vulnerabilities and host reliability risks should be visible, but should
not block ordinary usage unless policy explicitly requires blocking.

Critical RootFS vulnerabilities are common in real images. Blocking users from
selecting needed images would create more operational harm than value. The right
behavior is to show scan results, make details browsable, and allow publishers
to annotate reports.

### Normalize Host Signals

Users need enough host information to make an informed choice, but not raw
monitoring data or exact tenant counts.

Expose:

- Broad pressure buckets, not exact running project counts.
- Reliability and availability summaries, not private operational logs.
- Spot/standard/fallback strategy labels.
- Relative CPU speed, including coremark-derived processor speed where known.

Do not expose:

- Exact number of assigned projects if that leaks tenant data.
- Exact number of currently running projects if that leaks tenant data.
- Secret monitoring details.

## Quota And Health Card

Add a compact health card near the top of the modal. A more detailed version
should also appear on the main projects page.

Show:

- Project slots used, e.g. `3 / 7 projects`.
- Running projects vs runtime slots, e.g. `2 / 3 running`.
- Storage used vs storage quota.
- Membership tier name or a concise tier status.

Behavior:

- If under limits, show calm green/neutral status.
- If near project limit, explain that the user can delete projects or upgrade.
- If at project limit, block or warn before creation depending on backend
  policy, and show the two choices: delete projects or upgrade membership tier.
- If near storage limit, explain that archiving another project can reduce
  counted global storage.
- If at runtime slot limit and the user clicks `Create and Open`, make it easy
  to stop another running/sponsored project to make room.

Open question:

- The backend may already prompt/choose a project to stop when runtime slots are
  exceeded. The modal should detect whether this exists and either reuse that
  flow or provide a clear preflight prompt.

## Region Model

There are three related but different concepts:

- User latency region: inferred from the user's Cloudflare country/region.
- Project backup region: the R2/Cloudflare-style region where backups live.
- Host cloud provider region: a more precise cloud-specific region or zone.

Rules:

- If a project is assigned to a host, the project backup region and host's
  mapped backup region must match.
- A host can have a more specific provider region, such as a GCP or Nebius
  region/zone.
- The user's latency region can differ from the host/backup region.
- Projects can move between regions later.

UI requirements:

- Explain that region choice mostly affects interactive latency.
- Use concrete examples: terminal typing lag, time to see Jupyter output.
- If no hosts exist near the user, recommend the best available remote host or
  region instead of leaving the user with an empty list.
- Emphasize that changing region/host later is supported.
- If region changes invalidate a selected host, do not silently clear it without
  explanation.

## Host Placement

Host placement should become a recommendation system, not just a picker.

Inputs:

- User latency region.
- Project backup region.
- Available hosts in compatible backup regions.
- Host provider region/zone.
- Host pressure.
- Historical reliability.
- Spot vs standard.
- Spot-to-standard fallback strategy.
- GPU capability.
- Relative CPU speed/coremark-derived speed.
- User eligibility and membership tier.
- Whether the project needs GPU RootFS or GPU host.
- Whether the user can create their own host.

Recommended display:

- `Recommended` host or `Auto placement` summary.
- Clear alternatives grouped by region/latency.
- A short explanation such as `Closest available`, `More CPU, more restart risk`,
  or `Standard instance, lower restart risk`.
- Vague pressure labels such as `light`, `normal`, `busy`, `very busy`.
- Reliability labels based on intention-normalized uptime.
- Spot/fallback labels:
  - `Spot: more capacity, more likely to restart`.
  - `Fallback enabled: can switch to standard when spot is unstable`.
  - `Standard: less likely to restart`.

Historical uptime:

- Normalize by host intention: only count periods when the host was intended to
  be running.
- Do not penalize a host because an admin intentionally turned it off.
- Separate spot preemptions from intentional maintenance where possible.

Host creation path:

- If the user's tier can create hosts, show a concise path: `Need dedicated capacity? Create your own host.`
- If the user cannot create hosts, explain the membership/admin requirement.
- This should be visible without overwhelming first-run users.

## RootFS Runtime Images

Current status:

- Inline picker exists.
- Scan status is visible.
- Critical vulnerabilities do not block selection.
- Custom OCI is admin-only in the frontend.
- Project-create presets choose RootFS images from catalog tags such as
  `preset:standard`, `preset:gpu`, `preset:teaching`, `standard`, `gpu`,
  `teaching`, `course`, and `workshop`.
- The RootFS publisher tag editor offers one-click buttons for the explicit
  `preset:standard`, `preset:gpu`, and `preset:teaching` tags.

Next requirements:

- Launchpad customers should be able to define their own meaningful preset tags.
- The catalog should support very different deployments, such as a small
  research group that does not need teaching-oriented presets.
- Users should be able to browse the full scan report, not only see a small
  summary.
- RootFS publishers should be able to add comments/notes to scan reports.
- RootFS scan warnings should distinguish between:
  - Known vulnerability findings.
  - Publisher notes.
  - Community/collaborator trust warnings.
  - GPU/runtime compatibility warnings.

Preset examples should be metadata-driven:

- `standard`
- `gpu`
- `teaching`
- `research`
- `minimal`
- Site-specific/custom tags.

Do not build a complicated template system. Keep the UI simple, but let the
catalog provide the meaning.

## Project Actions

Actions:

- `Create Project`: create without starting/opening.
- `Create and Open`: create, start, and open.

Required behavior:

- If runtime slots are available, `Create and Open` proceeds normally.
- If runtime slots are exhausted, prompt to stop another eligible running or
  sponsored project if the backend supports this.
- If no project can be stopped, explain the limit and upgrade path.
- If creating without opening, the project list row must make the stopped/not
  started state obvious and include a clear start action.

## Security And Policy

Critical rules:

- Non-admins must not see custom OCI controls unless backend policy explicitly
  permits it.
- Any backend API that accepts custom OCI values must enforce the same policy.
- Self-hosted or user-controlled hosts must not be available to non-admins if
  they can expose secrets such as backup credentials.
- Frontend hiding is not sufficient for security-sensitive controls.

RootFS vulnerabilities:

- Do not block non-admin image selection solely because of known critical
  vulnerabilities.
- Keep vulnerabilities visible and link to full details.

## Design Direction

The modal should feel like a polished workspace creation flow, not an admin
console.

Desired layout:

- Health card at top.
- Presets below health card or next to first-run recommendation.
- Main configuration on the left.
- Sticky summary/action card on the right.
- Runtime image and host placement visible in the common path.
- Advanced controls compact and collapsed.
- Clear language that choices can be changed later.

Avoid:

- Long paragraphs in the default view.
- Modal-inside-modal where avoidable.
- Hiding important host/region choices under Advanced when they are relevant.
- Making users choose from empty lists without explanation.

Imagegen2 pass:

- Still useful after the health/host requirements are represented.
- Prompt should include quota health, latency explanation, runtime image, host
  recommendation, summary card, and create actions.

## Phase A Data And Policy Inventory

Status: completed 2026-05-20.

Architectural constraint:

- Account-facing quota and membership data must come from the account home bay.
- Project placement and project runtime state must respect project owning bay and
  host bay routing.
- The create modal should consume Conat hub APIs that already route correctly.
  It should not infer these values from local browser/project-list state.

### Project Quota And Storage

Available now:

- `src/packages/conat/hub/api/purchases.ts`
  - `MembershipUsageLimits`
  - `MembershipUsageStatus`
  - `MembershipDetails.usage_status`
  - `getMembershipDetails({ refresh_usage_status? })`
- `src/packages/server/conat/api/purchases.ts`
  - Routes `getMembershipDetails` to the account home bay when needed.
- `src/packages/server/membership/usage-status.ts`
  - Computes `owned_project_count`, `remaining_project_slots`,
    `total_storage_bytes`, soft/hard storage limits, and over-limit flags.
  - Samples provisioned project storage via project routing.
  - Uses a short cache; `refresh_usage_status` can force a refresh.
- `src/packages/server/membership/project-limits.ts`
  - `assertCanOwnAdditionalProject` enforces project count limits.
  - `assertCanIncreaseAccountStorage` enforces cached/fresh storage caps.
  - `assertCanRestoreProvisionedProjectStorage` protects archive restore.
- `src/packages/frontend/account/membership-status.tsx`
  - Existing account settings UI for project slots and storage progress.
- `src/packages/frontend/purchases/account-storage-warning.tsx`
  - Existing storage warning helper and threshold behavior.

Create-flow implication:

- The health card can fetch `hub.purchases.getMembershipDetails({})` for normal
  display.
- Use `refresh_usage_status: true` only for explicit refresh or near-limit
  preflight, not every render.
- Project-count and storage blocking should remain backend-enforced by
  `createProject`; the modal only previews and explains the likely outcome.

Missing:

- A small frontend hook/component shared by account settings, project list, and
  project creation so usage cards do not duplicate threshold logic.

### Runtime Slots

Available now:

- `src/packages/conat/hub/api/purchases.ts`
  - `MembershipUsageLimits.max_sponsored_running_projects`
- `src/packages/server/projects/runtime-slots.ts`
  - `listProjectRuntimeSlots` routes to the sponsor account home bay.
  - `getProjectRuntimeSlotDenial` produces structured slot exhaustion details.
- `src/packages/conat/hub/api/projects.ts`
  - `ProjectRuntimeSponsorStatus`
  - `getProjectRuntimeSponsorStatus({ project_id })`
- `src/packages/server/conat/api/projects.ts`
  - `getProjectRuntimeSponsorStatus` returns limit/current active projects for
    an existing project sponsor.
- `src/packages/util/runtime-sponsor-denial.ts`
  - Shared structured denial encoding/formatting.
- `src/packages/frontend/project/start-button.tsx`
  - Existing UI for runtime sponsor slot exhaustion and stopping/switching
    sponsor flows after a start attempt.
- `src/packages/frontend/project/settings/runtime-sponsor-controls.tsx`
  - Existing runtime sponsor usage summary for an existing project.

Create-flow implication:

- The backend already enforces runtime-slot admission when starting.
- `Create Project` does not need runtime-slot capacity because it does not
  start.
- `Create and Open` should preflight the actor/default sponsor's runtime slots
  before creation when possible, then still rely on backend enforcement.

Missing:

- There is no create-friendly account-level API yet for “my current runtime
  sponsor usage” before a project exists.
- Add a small Conat hub API such as
  `projects.getAccountRuntimeSponsorStatus({ sponsor_account_id? })` or
  `purchases.getMembershipDetails` extension that returns:
  - `limit`
  - `current`
  - visible active projects
  - stop eligibility/action hints
  - upgrade/change-sponsor hints
- The new API must route by sponsor account home bay, matching
  `listProjectRuntimeSlots`.

### Project Creation Admission

Available now:

- `src/packages/server/projects/create.ts`
  - Calls `assertAccountTrustedForProductAccess(account_id, "create projects")`.
  - Calls `assertCanOwnAdditionalProject`.
  - Calls cached `assertCanIncreaseAccountStorage`.
  - Creates project and optionally starts it.
  - Creates a `project-start` LRO when `start: true`.
- `src/packages/frontend/projects/create-project.tsx`
  - Current create modal sends `start: false` for `Create Project`.
  - Current create modal sends `start: true` for `Create and Open`.
- `src/packages/conat/hub/api/projects.ts`
  - `getAccountRuntimeSponsorStatus({})` exposes the authenticated account's
    current runtime-slot usage for create-time preflight.
- `src/packages/server/conat/api/projects.ts`
  - `getAccountRuntimeSponsorStatus` uses the existing account-home-bay routed
    runtime-slot listing and returns visible active projects.

Create-flow implication:

- The modal can safely expose both actions.
- If `Create and Open` fails due to runtime slots, reuse structured denial UI
  rather than inventing a second policy.
- Health card warnings must be treated as advisory; backend remains source of
  truth.

### Host Availability, Pressure, And Placement

Available now:

- `src/packages/conat/hub/api/hosts.ts`
  - `Host.can_place`
  - `Host.reason_unavailable`
  - `Host.pressure`
  - `Host.metrics.current`
  - `Host.tier`
  - `Host.scope`
  - `Host.pricing_model`, `desired_pricing_model`, `effective_pricing_model`
  - `Host.interruption_restore_policy`
  - `Host.spot_recovery_policy`
  - `Host.spot_recovery_state`
  - `Host.recovery_phase`
- `src/packages/server/conat/api/hosts.ts`
  - `listHosts` computes `can_place` and `reason_unavailable`.
  - `listHosts` can aggregate remote bay hosts.
- `src/packages/frontend/hosts/pick-host.tsx`
  - Existing host picker filters `can_place`, groups owned/collab/pool hosts,
    and sorts by pressure via `autoSelectCompare`.
- `src/packages/frontend/hosts/select-new-host.tsx`
  - Current project-create host selection block.
- `src/packages/frontend/hosts/pressure-ui.tsx`
  - Existing pressure buckets and placement summary.
- `src/packages/frontend/hosts/spot-ui.tsx`
  - Existing spot/fallback tags and explanatory popovers.
- `src/packages/frontend/hosts/components/host-current-metrics.tsx`
  - Admin/manager-facing exact metrics display.

Create-flow implication:

- Host recommendations should start from `hub.hosts.listHosts({ catalog: true })`
  and use `can_place`, pressure, provider/region, spot/fallback state, tier, GPU,
  and scope.
- Non-admin create UI should not show exact assigned/running project counts from
  host metrics.
- Convert raw metrics to privacy-preserving labels such as `light`, `normal`,
  `busy`, and `very busy` if they are exposed to ordinary users.

- Implemented:

- `src/packages/frontend/hosts/project-host-recommendations.ts`
- `src/packages/frontend/hosts/project-host-recommendations.test.ts`
- Create-mode host picker ranking by same-region availability, pressure,
  spot/fallback, GPU fit, scope, tier, and explicit selection.
- Remote-host fallback when the selected backup region has no available
  compatible hosts.

Still missing:

- A privacy-normalized host load/reliability summary suitable for non-admins.
- A create-specific host display that avoids opening a second modal for the
  common path.

### Host Reliability And Uptime

Available now:

- `src/packages/conat/hub/api/hosts.ts`
  - `last_seen`
  - host action/log types and `getHostLog`
  - spot recovery state has `outage_started_at`, retry/probe/fallback fields.
- `src/packages/frontend/hosts/hooks/use-host-log.ts`
  - Existing admin/manager log fetch hook.
- `src/packages/server/cloud/host-work.ts`
  - Persists spot recovery phases and `desired_state`.
  - Maintains `last_seen` and spot outage/fallback state.

Create-flow implication:

- Spot/fallback state can be displayed now.
- Intent-normalized reliability should not be hacked out of raw host logs in the
  browser.

Missing:

- A backend-derived, privacy-preserving reliability summary per host.
- The summary should count only periods where `desired_state` intended the host
  to be running.
- It should separate intentional off/maintenance, spot preemption, cloud
  failures, and unknown downtime where possible.

### Region And Latency

Available now:

- Host rows expose cloud-provider `region`.
- `src/packages/util/db-schema/projects.ts` and current project create flow
  support project `region`.
- `src/packages/frontend/hosts/pick-host.tsx` maps host provider region to
  backup/R2 region for region filtering.
- Existing move/rehome backend supports moving projects between hosts/regions.

Create-flow implication:

- The modal should explain that region mostly affects interactive latency.
- If no hosts exist in the user's nearest region, host recommendation should
  select the best remote compatible region instead of showing an empty state.
- The host and backup region must remain compatible when an explicit host is
  selected.

Missing:

- A clear frontend source for the user's inferred latency region in project
  creation.
- A reusable helper that ranks backup regions by user latency region and host
  availability.

### CPU Speed

Available now:

- `src/packages/util/project-host-benchmarks.ts`
  - GCP CoreMark-derived relative CPU speed and CPU platform data.
  - Baseline is `n2d-standard-4`.
- `src/packages/util/project-host-pricing.ts`
  - Machine-type parsing helpers.

Create-flow implication:

- GCP host recommendation can explain relative CPU speed when machine type is
  known.
- Unknown providers should show neutral/unknown speed rather than inventing a
  number.

Missing:

- A provider-neutral speed summary shape for host recommendations.
- Non-GCP benchmark sources for Nebius, Hyperstack, Lambda, and self-hosted.

## Implementation Roadmap

### Completed

- Draft model and tests.
- Hook adapter.
- Modal shell.
- Split create actions.
- Preset buttons.
- Summary/action column.
- Inline RootFS picker.
- Host placement visible in the main path.
- Account capacity health card.
- Runtime-slot full state includes stop actions for visible running projects.
- Host recommendation model and tests.
- Create-mode host picker uses recommendation ranking and remote-region fallback.
- RootFS preset image selection uses catalog tags/metadata.
- RootFS publisher UI documents and inserts project-create preset tags.

### Phase A: Update Data/Policy Inventory

Completed in `Phase A Data And Policy Inventory` above.

Follow-up completed:

- Added account-level runtime slot status API for the authenticated account.
- Phase B can now show all three health gauges together.

### Phase B: Health Card

Initial implementation completed 2026-05-20.

Requirements:

- Project slots used/available.
- Running projects/runtime slots.
- Storage used/quota.
- Clear near-limit and at-limit messaging.
- Links/actions for delete projects, archive projects, stop running projects, or
  upgrade membership tier where possible.

Follow-up:

- Add direct actions from the health card for upgrade, project cleanup, archive
  guidance, and richer stop/retry flows.
- Consider sharing the same health card data/formatting with the main projects
  page.

Validation:

- Normal account.
- Near project limit.
- At project limit.
- Near storage limit.
- Runtime slots exhausted.

### Phase C: Host Recommendation Model

Initial implementation completed 2026-05-20.

Upgrade host placement from a picker to recommendations.

Requirements:

- Recommend a host or auto placement using region, pressure, spot/standard,
  fallback, GPU, scope, tier, and eligibility. Implemented.
- If no host exists in the user's region, recommend the best remote region/host.
  Implemented in the host picker fallback.
- Make latency impact explicit and concrete. Partially implemented.
- Show privacy-preserving host load and reliability labels. Not yet implemented
  beyond existing pressure tags.
- Keep host creation path visible when eligible. Not yet implemented in project
  creation.

Validation:

- One-region Launchpad deployment with European user and North America hosts.
- Multiple hosts in same backup region with different pressure/speed.
- Spot host with fallback enabled.
- GPU project with no GPU host in nearest region.

Recommended dogfood host set:

- One standard GCP/Nebius pool host in the user's nearest backup region.
- One spot host in the same backup region, preferably with fallback enabled.
- One stressed or placement-blocked host in the same backup region to verify it
  is deprioritized or hidden by default.
- One GPU host in the same backup region.
- One standard remote-region host so the no-local-host fallback has a useful
  target.

This is enough to test same-region preference, spot/fallback labeling, pressure
avoidance, GPU fit, and remote-region fallback without needing a large fleet.

### Phase D: RootFS Metadata Presets

Initial implementation started 2026-05-20.

Replace hardcoded preset semantics with catalog metadata.

Requirements:

- Presets use tags/capabilities from RootFS catalog entries. Initial support
  implemented for `standard`, `gpu`, and `teaching` presets.
- RootFS publishers can add explicit project-create preset tags from the
  metadata editor without memorizing tag names.
- Site-specific Launchpad deployments can define different meaningful presets.
- Full vulnerability report is browsable.
- Publisher comments are displayed with scan reports.

Validation:

- Default CoCalc catalog.
- Site with no teaching image.
- Site with custom research images.
- Image with critical vulnerabilities and publisher notes.

Follow-up:

- Consider site-configurable preset labels/tags once multiple launchpad
  deployments need different first-run presets.
- Add a full scan report browser and publisher comments before calling Phase D
  complete.

### Phase E: Region/Latency Explanation

Add concise inline explanation and warnings.

Initial implementation started 2026-05-20.

Requirements:

- Explain region impact in terms of terminal/Jupyter lag. Initial copy added.
- Explain that region/host can be changed later. Initial copy added.
- Distinguish user latency region from project backup region and provider
  region without exposing too much terminology. Initial advanced-region card
  added.
- Explain when region changes reset backups beyond the latest backup. Initial
  advanced-region copy added.

Validation:

- User near available host.
- User far from all available hosts.
- Region changed after host selection.

### Phase F: Final Polish And Accessibility

Requirements:

- Imagegen2-informed visual pass. Initial pass implemented against the
  project-create mockup generated on 2026-05-20.
- No unnecessary vertical scrolling for the common path on normal laptop sizes.
- Mobile/narrow layout.
- Keyboard navigation.
- Screen-reader labels.
- Close button does not overlap scrollbars.
- Error states remain visible and actionable.

## Automated Validation

Run after frontend changes:

```sh
cd src/packages/frontend && pnpm exec jest projects/create-project-rootfs.test.ts projects/create/project-create-draft.test.ts --runInBand
cd src/packages/frontend && pnpm tsc --build
pnpm -C src lint:frontend
git diff --check
```

Add tests as new rules become deterministic:

- Health card quota states.
- Runtime slot exhausted preflight.
- Host recommendation ranking.
- Region mismatch explanation.
- RootFS metadata preset selection.

## Manual QA Checklist

- Open create modal from project list.
- Type project title; no lag.
- Apply each preset.
- Choose RootFS image inline.
- Choose custom OCI as admin.
- Verify non-admin cannot see custom OCI.
- Choose host.
- Reset host.
- Change region after choosing host.
- Create Project without opening.
- Create and Open.
- Hit runtime slot limit and stop another project if supported.
- Hit project count limit and see delete/upgrade options.
- Hit storage near-limit and see archive guidance.
- User in region with no nearby hosts sees a useful remote recommendation.
- RootFS with critical findings is selectable and links to full details.

## Immediate Next Step

Polish the existing modal before adding deeper policy UI:

- Fix capacity-card missing/unknown states.
- Reduce default vertical height so the common path fits on a normal laptop
  screen.
- Keep host choice visible, but avoid forcing the user into the secondary host
  picker unless they need to override the recommendation.
- Continue Phase D by adding full scan report browsing and publisher comments.
