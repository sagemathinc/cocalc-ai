# Alpha Bug Triage Plan - 2026-06-07

Source list: `/home/user/wstein-todo/wstein.tasks.md`, plus the later Codex queued-state report.

Goal: resolve the current alpha-test bug set in small reviewable commits, prioritizing release blockers and data/control-plane correctness before polish.

## Principles

- Prefer small batches with focused tests and one commit per coherent bug group.
- Do not paper over state-convergence bugs with UI-only heuristics unless the durable state path is already correct and only display derivation is wrong.
- For project/host/auth/move behavior, follow `src/.agents/scalable-architecture.md` before changing code.
- For live validation, use the current CoCalc CLI path exactly:
  `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`.

## Priority Order

### (done) P0-A: Codex/ACP Message Stays Queued Forever

Symptom: a sent Codex message can remain labeled `queued` indefinitely even while the turn is running and producing output.

Likely areas:

- `src/packages/frontend/chat/acp-api.ts`
- `src/packages/frontend/chat/chatroom.tsx`
- `src/packages/frontend/chat/chatroom-thread-panel.tsx`
- `src/packages/frontend/chat/chatroom-sidebar.tsx`
- `src/packages/frontend/chat/message-state.ts`
- ACP turn/session state produced by the project host worker.

Plan:

1. Trace the durable ACP turn lifecycle: queued, accepted, running, finished, failed.
2. Identify which row/message renders the `queued` badge and which durable row should supersede it.
3. Add tests for a thread where the user message row remains queued but assistant/ACP activity proves the turn is running.
4. Fix display derivation from durable activity/turn state, or fix missing durable state write if the running transition is not persisted.
5. Remove or simplify any ineffective repair code if it is masking the real state source.

Validation:

- Focused chat tests.
- Manual live Codex turn in a project, including navigation away/back while the turn runs.

### (done) P0-B: Detect Running HTTP Apps Stops The Project

Symptom: clicking `Detect running HTTP apps` on the Apps page stops the project.

Likely areas:

- `src/packages/frontend/project/app-server-panel.tsx`
- `src/packages/project/app-servers/*`
- `src/packages/project/conat/api/apps.ts`

Plan:

1. Inspect the detection call path and whether it invokes stop/restart or agent/install workflows unintentionally.
2. Reproduce with live project logs if possible.
3. Make detection read-only and non-disruptive.
4. Add a focused test around the detection action not calling lifecycle stop APIs.

Validation:

- Focused tests for app-server panel/control.
- Live click test on a disposable project.

### (done) P0-C: CoCalc Plus Project-Home Chat Tries To Make `/home/user`

Symptom: fresh `cocalc-plus` on a laptop shows `permission denied, mkdir '/home/user'` above project-home chat and the chat spinner never finishes.

Likely areas:

- `src/packages/frontend/project/new/*`
- `src/packages/frontend/lite/index.ts`
- `src/packages/project/runtime-bootstrap.ts`
- HOME/default-runtime helpers, especially code assuming `DEFAULT_PROJECT_RUNTIME_HOME`.

Plan:

1. Find project-home chat initialization path and its working directory.
2. Ensure cocalc-plus uses the real remote/user HOME from environment/config, not hardcoded `/home/user`.
3. Ensure no frontend/home chat path tries to create HOME itself.
4. Make chat fail visibly and recoverably instead of spinning forever if initialization fails.

Validation:

- Unit tests around HOME derivation where HOME is not `/home/user`.
- Manual cocalc-plus startup if available.

### (done) P0-D: Project Move Between Regions

Symptom: moving projects between regions probably does not work.

Likely areas:

- `src/packages/frontend/project/settings/move-project.tsx`
- `src/packages/frontend/project/move-ops.ts`
- `src/packages/server/conat/api/projects.ts`
- `src/packages/server/inter-bay/project-control.ts`
- Project backup/rootfs regional cutover code.

Plan:

1. Read the current move flow end-to-end.
2. Identify required ownership/routing checks for multibay and region cutover.
3. Run focused tests already present for project move and state address.
4. If live infrastructure supports it, run a disposable two-host move smoke.
5. Fix concrete failures only; do not rewrite the move architecture during this triage pass.

Validation:

- Focused server/frontend tests.
- Live move smoke if two suitable hosts are available.

## Fast Correctness Batch

### (done) P1-A: Duplicate File Fails With ENOENT

Symptom: selecting a file and choosing Actions -> Duplicate fails with `ENOENT`, likely absolute-vs-relative path handling.

Likely areas:

- `src/packages/frontend/project/redux/actions.ts`
- `src/packages/frontend/project/redux/file-selection.ts`
- `src/packages/frontend/project/redux/file-operations.ts`
- filesystem client copy/duplicate API.

Plan:

1. Trace duplicate from selected absolute path to filesystem API.
2. Normalize source and destination consistently.
3. Add unit test for duplicate of `/home/user/foo.txt`.

### (done) P1-B: PNG And No-Extension Files Load Forever

Symptom: opening PNG file tabs, or files with no extension, stays stuck at Loading forever. Download works.

Likely areas:

- `src/packages/frontend/file-associations.ts`
- `src/packages/frontend/file-editors.ts`
- registered image/editor fallback components.

Plan:

1. Confirm extension mapping for `png` and `""`.
2. Find editor bootstrap path that never resolves for viewer-only/image/fallback editors.
3. Fix mapping or fallback editor generation so every association produces a component.
4. Add tests for `x.png` and `x`.

### (done) P1-C: Drag-And-Drop To Parent Folder Does Nothing

Symptom: from `/home/user/foo`, dropping `bar.txt` onto `/home/user/` silently does nothing.

Likely areas:

- `src/packages/frontend/project/explorer/dnd/file-dnd-provider.tsx`
- `src/packages/frontend/project/explorer/file-listing/file-listing.tsx`
- `src/packages/frontend/project/explorer/path-navigator.tsx`

Plan:

1. Verify whether parent breadcrumb/root drop data is set correctly.
2. Fix invalid-drop logic so target parent is not mistaken for same-folder/no-op when the source is inside a child folder.
3. Add DnD helper tests if test harness exists; otherwise isolate path classification into a tested pure helper.

### (done) P1-D: Terminal Mention Side Chat Opens Duplicate Terminal File

Symptom: opening side chat via an `@mention` notification for a terminal also opens a second terminal file.

Likely areas:

- notification mention open target code.
- chat side-panel open logic.
- terminal file/open-file identity logic.

Plan:

1. Trace notification click target for terminal mention.
2. Ensure side-chat open uses the terminal's existing file/tab identity and does not foreground-open the terminal separately.
3. Add focused test for terminal mention navigation.

## UI State Batch

### (done) P1-E: `+New` Filename Must Regenerate On Reveal

Symptom: New page previously relied on mount to generate a fresh filename; retained pages now keep stale generated names.

Likely areas:

- `src/packages/frontend/project/new/*`
- `src/packages/frontend/project/page/flyouts/new.tsx`
- project full-page new tab wiring.

Required behavior:

- When the New page is shown, update generated filename and select the filename box.
- If the user explicitly edits the name, do not auto-update it again until they create a file.
- After creating a file, reset to auto-generate-on-show.

Validation:

- Component/state tests for reveal, edit, create, reveal.

### (done) P1-F: Invite Multiple Collaborators

Symptom: adding a second selected collaborator clears the first pending invitee.

Likely areas:

- `src/packages/frontend/collaborators/*`
- project collaborators panel.

Plan:

1. Find selection state update for account dropdown.
2. Change replacement behavior to append/dedupe.
3. Add component test selecting two users.

## UI Polish Batch

### (done) P2-A: Flyout Recovery CSS And Background

Symptom: Recovery snapshot section in flyout settings looks broken; all flyout background gray is too dark.

Likely areas:

- `src/packages/frontend/project/page/flyouts/settings.tsx`
- `src/packages/frontend/project/settings/recovery-panel.tsx`
- flyout shared styles.

Plan:

1. Fix Recovery section spacing/layout in flyout mode.
2. Lighten shared flyout background without harming contrast.
3. Add/adjust tests if snapshot layout has test coverage.

### (done) P2-B: Skinny Flyout Close Controls Vanish

Symptom: at narrow flyout widths, fullscreen and close controls disappear.

Likely areas:

- `src/packages/frontend/project/page/flyouts/header.tsx`
- flyout header CSS/flex layout.

Plan:

1. Make right-side controls non-shrinking and always visible.
2. Allow title/path content to truncate first.
3. Add component test or CSS-level regression if feasible.

### (done) P2-C: Host Resources Disk/Scratch Display

Symptoms:

- Total disk size is cutoff in the resources column.
- `/scratch` should be displayed as another metric row when available.
- If `/scratch` is not configured, replace gauge with info popover and link to scratch config.
- Add resources Detail view with plots like card drawer.

Likely areas:

- `src/packages/frontend/hosts/*`
- host resource/status components.
- commit `2a0aa533211759e109a8dd9d1bc997d18a5d847a` for data source.

Plan:

1. Find existing resource card/drawer plot implementation.
2. Reuse data and components for list resources detail.
3. Fix text cutoff with layout changes.
4. Add scratch metric and not-configured popover.

### (done) P2-D: Admin Software Lifecycle Artifact Controls

Symptom: no UI way to upgrade project bundle or tools bundle anymore.

Target UI:

- In Software lifecycle detail on host cards, add selectors for:
  - tools
  - project bundle
  - project-host
- Select a specific artifact/version to be available/default on host.
- Sort newest available first, with bounded history.

Likely areas:

- `src/packages/frontend/hosts/*`
- host software lifecycle APIs in Conat/server.
- CLI command reference: `cocalc host upgrade spot-utah --artifact tools --hub-source --wait`.

Plan:

1. Identify existing host runtime version controls and APIs.
2. Expose artifact-specific desired-version selectors using existing reconcile/upgrade backend.
3. Keep UI minimal for release: select version, save, show queued reconcile.

## Suggested Commit Batches

1. `frontend/chat`: ACP queued-state convergence.
2. `project/apps`: HTTP app detection must be read-only/non-disruptive.
3. `plus/runtime`: correct HOME handling and project-home chat failure behavior.
4. `frontend/project`: duplicate, file association loading, parent-folder DnD.
5. `frontend/project`: New page reveal state, collaborator multi-invite, terminal mention side-chat.
6. `frontend/project`: flyout CSS and close controls.
7. `frontend/hosts`: resources/scratch display and artifact lifecycle controls.
8. `project/move`: region move validation/fixes.

## Validation Matrix

- Frontend batches: focused tests plus `pnpm -C src lint:frontend`.
- Frontend package typecheck when touched changes are broad: `cd src/packages/frontend && pnpm tsc --build`.
- Project/server changes: package-local tests and typecheck for touched package.
- Live validation:
  - app detection on disposable running project.
  - Codex turn state in a live chat thread with navigation away/back.
  - file duplicate/open/DnD in file explorer.
  - project move only after focused tests pass and suitable disposable hosts are available.

