# Project Creation Redesign Plan

## Goal

Replace the cramped project creation side panel with a polished modal workflow that is clear, fast, and robust. The redesign should follow the successful host creation pattern: put all defaulting and normalization in a small draft/controller layer first, then rebuild the UI around that stable model.

The common path should fit on a normal laptop screen without vertical scrolling. Advanced configuration may scroll or collapse.

## Current State

Primary files:

- `src/packages/frontend/projects/create-project.tsx`
- `src/packages/frontend/projects/create-project-rootfs.ts`
- `src/packages/frontend/projects/create-project-rootfs.test.ts`
- `src/packages/frontend/projects/projects-page.tsx`
- `src/packages/frontend/projects/actions.ts`
- `src/packages/frontend/hosts/select-new-host.tsx`
- `src/packages/frontend/hosts/pick-host.tsx`
- `src/packages/frontend/rootfs/catalog-ui.tsx`
- `src/packages/frontend/rootfs/scan-status.tsx`

Current behavior:

- `ProjectsPage` renders `NewProjectCreator` in `HostCreatePanel` on desktop and inside a small card on mobile.
- `NewProjectCreator` owns all state directly: title, saving/error, advanced toggle, region, selected host, RootFS catalog state, RootFS modal state, and submission.
- Project creation always passes `start: true` and opens the project after creation.
- RootFS selection is a separate modal with a single large `<Select>`.
- Host selection is a separate modal through `SelectNewHost`.
- RootFS defaulting changes when the selected host has `gpu`.
- Selecting a backup region clears the selected host if its cloud region maps to a different R2 region.

Known issues from the current UI:

- The side panel is too narrow for RootFS and host selection.
- “Choose image” and “Choose host” are secondary dialogs, so the main creation context disappears.
- Advanced controls make the panel tall and visually noisy.
- There is no strong summary of what will be created.
- The title-first form hides the most important decisions: runtime image and host.
- The implementation is high risk to modify because normalization is spread through component effects and event handlers.

## Product Decisions

### Primary Actions

Use two explicit final actions:

- `Create Project`
- `Create and Open`

Backend support already exists because `projects/actions.ts:create_project` takes `start?: boolean`, but the current UI hardcodes `start: true` and always opens the project. The new UI should map:

- `Create Project`: create with `start: false`, close modal, keep the user on the project list.
- `Create and Open`: create with `start: true`, open the new project at `project-home`.

Open question before implementation: if `start: false` creates a project that is not yet started, confirm the project row and status make this clear and that the user has an obvious way to start it later.

### Presets

Keep presets minimal and hardcoded. Do not build a flexible template system.

Initial presets:

- `Standard`: normal project, default RootFS, auto host, nearest backup region.
- `GPU`: GPU-capable RootFS if available, GPU host if one is selected or if host-picker recommendations support this later.
- `Teaching`: stable official RootFS, auto host, private project, phrasing oriented toward course/class use.
- `Custom`: no strong defaults beyond current account/site defaults; makes advanced options more visible.

Presets should only set valid draft fields. If a preset cannot find a valid RootFS or host for the current catalog/region, it should fall back gracefully and show why in the summary.

### RootFS Policy

RootFS images with scan findings are allowed. The UI should still surface scan status clearly:

- Clean/pending/error/findings tags are visible in image cards.
- Critical findings are visually prominent but not selection-blocking.
- Hidden or admin-blocked images remain excluded.
- GPU images are only suggested/selected for GPU projects or GPU hosts, but should be searchable if the policy allows it.

### Host Policy

The default should stay safe:

- Auto host by default.
- Host picker should show eligible hosts in the selected backup region.
- If a user explicitly selects a host, changing backup region should either clear the host with a clear message or offer to switch the region to match the host. Avoid silent resets if possible.

## Architecture

### New Draft Model

Create `src/packages/frontend/projects/create/project-create-draft.ts`.

Core types:

```ts
export type ProjectCreateMode = "standard" | "gpu" | "teaching" | "custom";

export type ProjectCreateDraft = {
  title: string;
  mode: ProjectCreateMode;
  region: R2Region;
  host_id?: string;
  rootfs_image: string;
  rootfs_image_id?: string;
  start: boolean;
  advanced_open: boolean;
  rootfs_touched: boolean;
  host_touched: boolean;
};

export type ProjectCreateContext = {
  defaultTitle: string;
  preferredRegion: R2Region;
  rootfsImages: RootfsImageEntry[];
  selectedHost?: Host;
  siteDefaultRootfs?: string;
  siteDefaultRootfsGpu?: string;
  accountDefaultRootfs?: string;
  accountDefaultRootfsGpu?: string;
};
```

Core functions:

- `createInitialProjectDraft(context): ProjectCreateDraft`
- `applyProjectPreset(draft, preset, context): ProjectCreateDraft`
- `normalizeProjectDraft(draft, context): ProjectCreateDraft`
- `setProjectDraftTitle(draft, title): ProjectCreateDraft`
- `setProjectDraftRegion(draft, region, context): ProjectCreateDraft`
- `setProjectDraftHost(draft, host, context): ProjectCreateDraft`
- `setProjectDraftRootfs(draft, rootfs, context): ProjectCreateDraft`
- `projectDraftToCreateOptions(draft): CreateProjectOptions`
- `projectDraftSummary(draft, context): ProjectCreateSummary`

Rules:

- `normalizeProjectDraft` should be deterministic and side-effect free.
- Name changes should not recalculate RootFS or host.
- RootFS should auto-update when GPU mode/host changes only while `rootfs_touched` is false.
- Host should auto-clear or become invalid only when region makes it impossible.
- Do not use timeouts or render-order assumptions for defaulting.
- Unit tests should cover every defaulting rule before major UI work.

### Hook Layer

Create `src/packages/frontend/projects/create/use-project-create-draft.ts`.

Responsibilities:

- Load account/site defaults through existing Redux hooks.
- Load RootFS catalog with `useRootfsImages`.
- Compute preferred R2 region from Cloudflare country/region.
- Own draft state and expose stable actions.
- Keep text input updates cheap.

Potential API:

```ts
export function useProjectCreateDraft({
  defaultValue,
}: {
  defaultValue: string;
}): {
  draft: ProjectCreateDraft;
  summary: ProjectCreateSummary;
  context: ProjectCreateContext;
  setTitle: (title: string) => void;
  applyPreset: (preset: ProjectCreateMode) => void;
  setRegion: (region: R2Region) => void;
  setHost: (host?: Host) => void;
  setRootfs: (rootfs: ProjectRootfsSelection) => void;
  setStart: (start: boolean) => void;
  reset: () => void;
};
```

Performance requirements:

- Typing the title must not re-filter the RootFS catalog or host list.
- RootFS search state should remain local to the RootFS picker section, not the global draft.
- Avoid expensive normalization on every keystroke unless the changed field actually affects dependent fields.

## Modal Design

### Layout

Use a wide modal instead of the side panel.

Desktop target:

- Width: roughly `min(1180px, 96vw)`.
- Height: roughly `min(820px, 92vh)`.
- Header: title, short subtitle, close button.
- Body: two-column layout.
- Left: main configuration.
- Right: sticky summary/actions panel.

Mobile target:

- Full-width modal or drawer-like modal.
- Summary moves below configuration.
- Keep the final action buttons sticky at bottom.

### Top-Level Structure

1. Presets
   - Four compact buttons/cards: Standard, GPU, Teaching, Custom.
   - Active preset visibly selected.
   - Each card describes what it changes in one short line.

2. Project basics
   - Project title.
   - Optional description only in advanced section unless existing backend/UI needs it.

3. Runtime image
   - Selected RootFS card with scan tags, official/public/mine tags, GPU tag, image id/name.
   - Inline “Change” opens an expanded section or compact picker inside the modal, not a separate blocking dialog.
   - Search/filter should be available without losing the summary.

4. Host placement
   - Auto host by default.
   - Selected host card if chosen.
   - Host picker can initially reuse `HostPickerModal`, but the plan should move toward inline host choices or a large in-modal picker if feasible.

5. Advanced
   - Backup region.
   - Custom OCI image entry.
   - Show older RootFS versions.
   - Future: quotas/license if needed.

6. Summary
   - Title.
   - RootFS label and scan status.
   - Host/placement.
   - Backup region.
   - Whether the project will start immediately.
   - Warnings and validation errors.
   - Final buttons: `Create Project`, `Create and Open`.

## Imagegen2 Design Pass

Before implementing the full modal styling, ask imagegen2 for 2-3 concepts.

Prompt requirements:

- Product: CoCalc project creation modal for a cloud computational workspace.
- Must fit common path on a 13-inch laptop screen without scrolling.
- Include: presets, project title, RootFS image, host placement, backup region, right-side summary, Create Project, Create and Open.
- Visual style: polished, calm, technical, high-trust, not generic SaaS purple.
- RootFS scan status should be visible but not scary/blocking.
- Host auto-placement should feel safe and understandable.
- Advanced settings should be collapsed or compact.

Implementation should borrow layout ideas from imagegen2 but use repo-native components and CoCalc design conventions. Do not introduce arbitrary image assets unless they become code-native SVG/icons.

## Implementation Phases

### Phase 1: Draft and Tests

Files:

- Add `src/packages/frontend/projects/create/project-create-draft.ts`.
- Add `src/packages/frontend/projects/create/project-create-draft.test.ts`.
- Optionally move current `create-project-rootfs.ts` logic into the new draft module or import it directly.

Work:

- Define draft/context/summary types.
- Implement deterministic initialization and normalization.
- Preserve current default behavior:
  - Default title is `Untitled YYYY-MM-DD`.
  - Region defaults from Cloudflare country/region mapping.
  - RootFS defaults from account/site defaults, with GPU-aware defaults.
  - Hidden/blocked RootFS images are excluded.
  - Non-GPU projects avoid GPU images.
- Add tests for:
  - Default Standard project.
  - GPU host switches default RootFS to GPU when untouched.
  - User-touched RootFS is preserved when host changes.
  - Region changes invalidate incompatible selected host.
  - `Create Project` maps to `start: false`.
  - `Create and Open` maps to `start: true`.

Validation:

- `cd src/packages/frontend && pnpm exec jest projects/create/project-create-draft.test.ts --runInBand`

### Phase 2: Hook Adapter

Files:

- Add `src/packages/frontend/projects/create/use-project-create-draft.ts`.
- Keep current UI in place initially.

Work:

- Wire Redux/customize values and RootFS catalog into the draft model.
- Replace scattered state in `NewProjectCreator` with the hook where practical.
- Keep old side panel UI but render from draft state.
- Preserve existing behavior before changing layout.

Validation:

- Existing `create-project-rootfs.test.ts`.
- New draft tests.
- Frontend typecheck.

### Phase 3: Modal Shell

Files:

- Update `src/packages/frontend/projects/projects-page.tsx`.
- Refactor `src/packages/frontend/projects/create-project.tsx` or split into:
  - `src/packages/frontend/projects/create/project-create-modal.tsx`
  - `src/packages/frontend/projects/create/project-create-summary.tsx`
  - `src/packages/frontend/projects/create/project-create-presets.tsx`

Work:

- Stop rendering `NewProjectCreator` inside `HostCreatePanel` on desktop.
- Render a modal when `createPanelOpen` is true.
- Keep mobile behavior sane; modal may be full-screen.
- Keep a compatibility wrapper if other code imports `NewProjectCreator`.
- Make close/cancel/reset behavior explicit.

Validation:

- Open/close modal from project page.
- No side panel layout regression when modal is closed.

### Phase 4: Inline RootFS Selection

Work:

- Replace the separate RootFS chooser modal with an in-modal section.
- Show selected image as a card.
- Add compact search and filter.
- Render RootFS cards/options using existing catalog UI helpers and `RootfsScanStatus`.
- Keep custom OCI entry in advanced mode.
- Keep scan findings visible but non-blocking.

Validation:

- Default image selection.
- Search official/community/my images.
- GPU mode filtering.
- Custom OCI entry.

### Phase 5: Host Placement UX

Work:

- Reuse `SelectNewHost` initially inside the modal.
- If it still feels modal-inside-modal or cramped, create a larger inline host picker section.
- Make region/host coupling explicit:
  - If region changes and host is incompatible, show a warning before clearing or immediately show “host reset because region changed.”
  - If host is chosen first, offer to set the backup region to match the host.

Validation:

- Auto host summary.
- Select host.
- Reset host.
- Region mismatch behavior.

### Phase 6: Actions and Creation Flow

Work:

- Add final action buttons:
  - `Create Project`
  - `Create and Open`
- `Create Project` calls `actions.create_project({ ..., start: false })` and closes modal without opening the project.
- `Create and Open` calls `actions.create_project({ ..., start: true })`, opens the project, and closes modal.
- Ensure Enter in title field does not accidentally create when focus is inside RootFS/host search.

Validation:

- Create without starting.
- Create and open.
- Error handling keeps modal open and shows actionable error.

### Phase 7: Polish and Accessibility

Work:

- Apply imagegen2-inspired visual polish.
- Reduce redundant headings.
- Use clear tags and compact cards.
- Ensure keyboard navigation is sane.
- Ensure modal close button does not overlap scrollbars.
- Ensure common path fits without body scrolling.

Validation:

- Desktop screenshot review.
- Mobile/narrow width review.
- Keyboard tab order spot check.

## Testing Checklist

Automated:

- `cd src/packages/frontend && pnpm exec jest projects/create-project-rootfs.test.ts projects/create/project-create-draft.test.ts --runInBand`
- `cd src/packages/frontend && pnpm tsc --build`
- `pnpm -C src lint:frontend`
- `git diff --check`

Manual:

- Open create modal from project list.
- Type project title; no lag.
- Apply each preset.
- Choose RootFS image.
- Choose custom OCI image.
- Choose host.
- Change region after choosing host.
- Create Project without opening.
- Create and Open.
- Verify non-admin user cannot see admin-only/custom dangerous controls beyond allowed custom OCI policy.
- Verify scan findings are visible but do not block selection.

## Risks

- RootFS defaulting is subtle because it depends on account defaults, site defaults, GPU status, hidden/blocked catalog entries, and whether the user has touched the field.
- Host/region coupling can silently erase user choices if not represented in the draft model.
- Modal-within-modal for host selection may feel awkward; inline host choices may be needed after Phase 3.
- Project creation flow currently assumes create-and-open; create-without-open may expose status/list edge cases.
- RootFS catalog filtering can become expensive if tied to title keystrokes or global draft updates.

## Recommended Next Step

Start with Phase 1 only. Do not change the UI until the draft model and tests exist. Once the draft layer is stable, the current side panel can be adapted to it, then the modal redesign becomes a layout change rather than another state-machine rewrite.
