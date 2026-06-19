# Blocker Bug Fix Plan - 2026-06-19

Source: `/home/user/wstein-todo/wstein.tasks.md`, read on 2026-06-19.

Scope: systematically fix the current blocker bug list, excluding the course
project host/provisioning item, which William confirmed is completely fixed.

## Operating Principles

- Work one concrete scenario at a time.
- Start every item with reproduction or forensic evidence, not speculation.
- Keep commits narrow and independently reviewable.
- Prioritize data loss, corruption, and stuck workflows over UI polish.
- For project-host, filesystem, rootfs, hosts, and admin work, follow
  `src/.agents/scalable-architecture.md` before changing routing or authority.
- Validate each fix with the narrowest useful automated test, then browser or
  live dev smoke where the bug is UI or runtime dependent.
- Do not leave a dirty tracked worktree between bug iterations unless the next
  iteration intentionally depends on the previous one.

## Excluded Item

### Course Project Host Assignment And Assignment Copy

Status: excluded from this plan.

Reason: William confirmed on 2026-06-19 that the course project issue is
completely fixed. Do not spend time on it unless a fresh reproduction appears.

## Priority Order

1. Btrfs quota deadlock when deleting snapshots or deleting folders from
   snapshots.
2. Slides/whiteboard collaborative sync corruption with runaway blank lines and
   duplicated content.
3. ACP worker chat persistence to disk during long-running agent work.
4. Markdown importer for legacy slides and whiteboards.
5. Project rootfs upgrade should restart running projects.
6. Jupyter kernel install drawer should use the AI Assistant modal.
7. Implicit `.local` navigator chat labels should use the owner's name.
8. Admin hosts page should expose other-user prices and allow deleting
   `local-validation`.
9. Slate markdown open should not add trailing whitespace.

## Iteration 1: Btrfs Quota Cleanup Deadlock

Severity: high. Users can fill quota and then fail to free space because
snapshot deletion itself needs temporary metadata space.

Primary evidence:

- `btrfs subvolume delete .../.snapshots/...` fails with `Disk quota exceeded`.
- Disabling quota manually lets the same deletes succeed.

Likely code areas:

- `src/packages/file-server/btrfs/subvolume-snapshots.ts`
- `src/packages/file-server/btrfs/snapshots.ts`
- `src/packages/file-server/btrfs/subvolume.ts`
- `src/packages/project-host/file-server.ts`
- `src/packages/project-host/file-server-sandbox-policy.ts`
- `src/packages/project-host/file-server-sandbox-policy.test.ts`
- Existing tests under `src/packages/file-server/btrfs/test/`

Reproduction plan:

- Create a small btrfs-backed test project or host-local test subvolume.
- Set a deliberately tight quota.
- Create files, snapshot them, delete live files, then attempt snapshot delete.
- Reproduce both full snapshot delete and "delete folder from snapshot"
  behavior.

Fix strategy:

- Add a project-host/file-server quota-relief helper around destructive snapshot
  cleanup operations.
- The helper should record current effective quota, temporarily raise quota by a
  bounded relief amount, run the delete/prune, then restore the intended quota.
- Use a conservative bound, for example max of a small fixed metadata reserve
  and a small percentage of quota, with a host-configurable ceiling.
- Serialize quota-relief operations per project to avoid overlapping restores.
- Prefer temporarily raising quota over disabling quota. Disabling quota should
  remain an emergency manual path, not normal product behavior.
- Apply the helper to both:
  - deleting a snapshot
  - pruning/deleting a path inside a snapshot
- Restore quota in a `finally` block and log failures with enough detail for
  operator recovery.

Validation:

- Unit tests for command construction and restore-on-error behavior.
- Existing btrfs snapshot tests still pass.
- Live host smoke: quota-full project can delete snapshots and prune snapshot
  paths without operator disabling quotas.

Commit shape:

- `file-server/btrfs: allow quota-full snapshot cleanup`

## Iteration 2: Slides/Whiteboard Sync Corruption

Severity: high. This is data corruption and can hang all collaborators'
browsers.

Primary evidence:

- Collaborative slides editing in Slate mode produced thousands of blank lines.
- Later markdown-mode editing doubled words.
- Forensic sqlite patchflow database exists at:
  `/home/user/scratch/2026-06-15-all-hands.slides.db`

Likely code areas:

- `src/packages/frontend/frame-editors/whiteboard-editor/actions.ts`
- `src/packages/frontend/frame-editors/whiteboard-editor/migrate.ts`
- `src/packages/frontend/frame-editors/whiteboard-editor/types.ts`
- `src/packages/frontend/frame-editors/whiteboard-editor/*.test.ts`
- `src/packages/frontend/editors/slate/*`
- `src/.agents/slate-sync.md`
- `src/.agents/sync-bugs-plan.md`

Reproduction and forensic plan:

- Write a small read-only forensic script that inspects the copied sqlite
  patchflow database and summarizes operation types, affected keys, repeated
  deltas, and unusually large inserts.
- Identify whether the loop is:
  - editor local normalization repeatedly writing semantically equivalent state
  - remote patch replay being converted back into local edits
  - Slate markdown/rich text mode roundtrip instability
  - whiteboard element/page-level sync feedback
- Try a two-browser dev reproduction on a small slides document with one sticky
  note in Slate mode, then repeat in markdown mode.

Fix strategy:

- Add source-origin or idempotence guards at the exact feedback boundary.
- Avoid broad debounce-only fixes; they hide the symptom but still corrupt data.
- Add a sanity guard that refuses or logs abnormal single-operation blank-line
  explosions, but only as a backstop after the root feedback loop is fixed.
- Make markdown and Slate mode conversion stable for a note element: remote state
  should not be re-serialized and written back unless content actually changed.

Validation:

- New focused replay test from a minimized version of the bad operation pattern.
- Two-client browser smoke: editing one note in Slate mode does not duplicate or
  amplify content.
- Existing whiteboard/slides and Slate tests still pass.

Commit shape:

- `frontend/slides: prevent collaborative note sync feedback`
- Optional separate forensic-only commit if the script is useful long term.

## Iteration 3: ACP Worker Chat Persistence

Severity: high/medium. Live state exists, but initial file load can be stale for
an hour or more, causing confusing agent history and making `.chat` files less
useful to external tools.

Likely code areas:

- `src/packages/lite/acp-worker.ts`
- `src/packages/lite/hub/acp/index.ts`
- `src/packages/lite/watchdog.ts`
- `src/packages/project-host/acp-worker.ts`
- `src/packages/project-host/hub/acp/worker-manager.ts`
- `src/packages/frontend/frame-editors/chat-editor/actions.ts`

Reproduction plan:

- Start an ACP run that appends multiple turns.
- Confirm the live sync state shows new turns.
- Before or immediately after reconnecting, inspect the on-disk `.chat` file and
  confirm it is stale.

Fix strategy:

- Add debounced periodic save/checkpoint of the `.chat` sync doc during active
  ACP writes.
- Always flush on finalization, worker shutdown, and writer disposal.
- Keep the live sync document authoritative; disk save is a durable checkpoint,
  not a competing source of truth.
- Expose save age and save error counts in watchdog stats so stale persistence
  can be detected.
- Use a bounded interval to avoid heavy disk churn during rapid token streaming.

Validation:

- Unit test with fake chat writer and fake timers: active changes trigger one
  debounced disk save, finalization forces a flush, and errors are logged.
- Live smoke: after a long ACP run, opening the chat from file before sync fully
  connects shows recent turns.

Commit shape:

- `lite/acp: periodically persist active chat files`

## Iteration 4: Legacy Markdown Import For Slides And Whiteboards

Severity: medium/high. Legacy CoCalc documents import incorrectly and remain
visibly escaped.

Primary evidence:

- `.slides` created on `cocalc.com` contain escaped square brackets and
  parentheses and no schema version.
- Import does not unescape them for slides/whiteboards.

Likely code areas:

- `src/packages/frontend/frame-editors/whiteboard-editor/migrate.ts`
- `src/packages/frontend/frame-editors/whiteboard-editor/migrate.test.ts`
- `src/packages/frontend/frame-editors/whiteboard-editor/document-schema.test.ts`
- `src/packages/frontend/frame-editors/whiteboard-editor/types.ts`
- `src/packages/jupyter/ipynb/import-from-ipynb.ts`
- `src/packages/jupyter/ipynb/export-import.test.ts`

Fix strategy:

- Use the notebook legacy markdown delimiter migration as the model.
- For slides/whiteboard documents missing schema version, unescape legacy
  markdown delimiters exactly once:
  - `\[`
  - `\]`
  - `\(`
  - `\)`
- Set the current document schema version after migration so the unescape step
  is idempotent.
- Audit whether schema version can be moved from per-page data to global
  document metadata without a larger syncdb migration. If not, document why and
  keep the minimal safe per-page migration.

Validation:

- Add a legacy `.slides` or `.board` fixture that includes escaped delimiters and
  no schema version.
- Test import/migration unescapes once and does not unescape again on second
  load.
- Test existing current-schema documents are unchanged.

Commit shape:

- `frontend/whiteboard: migrate legacy markdown delimiters`

## Iteration 5: Rootfs Upgrade Should Restart Running Projects

Severity: medium. The project appears upgraded but the running container can
continue using the old rootfs until manual restart.

Likely code areas:

- `src/packages/frontend/project/page/flyouts/rootfs`
- `src/packages/frontend/project/settings/restart-project`
- `src/packages/frontend/project/page/start-in-progress.tsx`
- `src/packages/server/projects/rootfs-state.ts`
- `src/packages/server/conat/api/projects.ts`
- `src/packages/conat/project-host/api.ts`

Reproduction plan:

- Start a project.
- Open the project listing rootfs modal and upgrade rootfs.
- Confirm whether the project keeps running without restart and whether UI
  communicates this.

Fix strategy:

- After successful rootfs update, check whether the project is currently
  running.
- If running, request a project restart through the existing project action path.
- If stopped, do not start it just to apply the upgrade.
- Show restart progress using existing start/restart progress UI.
- Handle restart denial or quota/run-slot errors explicitly rather than silently
  leaving the project on the old runtime.

Validation:

- Focused frontend test for the upgrade modal action path.
- API/server test if restart is triggered server-side.
- Live smoke for running and stopped projects.

Commit shape:

- `projects/rootfs: restart running projects after upgrade`

## Iteration 6: Jupyter Install Kernel Drawer Agent Flow

Severity: medium. It is a core workflow issue for users installing missing
kernels, but data is not at risk.

Likely code areas:

- `src/packages/frontend/jupyter/select-kernel.tsx`
- `src/packages/frontend/jupyter/__test__/select-kernel.test.tsx`
- `src/packages/util/jupyter-kernel-installs.ts`
- `src/packages/frontend/project/new/navigator-intents.ts`
- `src/packages/frontend/project/new/navigator-intents.test.ts`
- Existing AI Assistant modal code under `src/packages/frontend/frame-editors/ai/`

Fix strategy:

- Replace the drawer's bespoke Ask Agent modal with the shared AI Assistant
  modal.
- Ensure the modal supports:
  - automatically submit checkbox
  - add to composer without submit
  - create new agent thread
  - visible/editable full agent prompt
- Change prompts such as `Install Bash` to `Install the bash Jupyter kernel`.
- Preserve the intent tag `intent:jupyter-install-kernel` so existing routing
  and tests remain meaningful.

Validation:

- Update existing Jupyter select-kernel tests.
- Add navigator intent test for the improved prompt text.
- Browser smoke: Ask Agent from kernel drawer can submit automatically and can
  stage only in composer.

Commit shape:

- `frontend/jupyter: use assistant modal for kernel installs`

## Iteration 7: Owner Name For Implicit `.local` Navigator Chats

Severity: medium/low. This is confusing in shared projects and makes it hard to
know whose main chat is open.

Likely code areas:

- `src/packages/frontend/project/workspaces/chat-display.ts`
- `src/packages/frontend/project/workspaces/chat-display.test.ts`
- `src/packages/frontend/project/page/file-tab.tsx`
- `src/packages/frontend/project/page/file-tabs.tsx`
- `src/packages/frontend/project/new/navigator-shell.tsx`
- `src/packages/frontend/project/new/navigator-intents.ts`
- Account name helpers under `src/packages/frontend/users/`

Reproduction plan:

- Open another user's implicit navigator `.local/share/cocalc/navigator-*.chat`
  in a shared project.
- Confirm tab/label currently uses UUID instead of user display name.

Fix strategy:

- Parse the owner account id from implicit navigator chat paths.
- Resolve display name through existing account/user name cache.
- Label as `<First name>'s Main Chat` or `<Display name>'s Main Chat`.
- Fall back to UUID only when name lookup is unavailable.
- Avoid relabeling ordinary user-created `.chat` files.

Validation:

- Unit tests for:
  - own default navigator chat
  - another user's account-id suffixed navigator chat
  - workspace chat paths
  - ordinary `.chat` paths
- Browser smoke in a shared project if account fixtures are available.

Commit shape:

- `frontend/workspaces: label shared navigator chats by owner`

## Iteration 8: Admin Hosts Page Prices And `local-validation` Delete

Severity: medium. Admins cannot inspect cost/pricing correctly and cannot remove
a validation host entry.

Likely code areas:

- `src/packages/frontend/hosts/components/host-create-card.tsx`
- `src/packages/frontend/hosts/components/host-edit-modal.tsx`
- `src/packages/frontend/hosts/components/host-price-breakdown.tsx`
- `src/packages/frontend/hosts/providers/registry.test.ts`
- `src/packages/server/conat/api/hosts*`
- `src/packages/conat/hub/api/*hosts*`

Reproduction plan:

- As admin, view hosts owned by another user and confirm prices are missing.
- Attempt to delete `local-validation` and capture the exact API/UI failure.

Fix strategy:

- For admins, return enough pricing context for hosts owned by other accounts.
- Keep non-admin visibility unchanged.
- Add or fix the delete action for `local-validation`, using the same fresh-auth
  or dangerous-action policy as other host deletion paths.
- Make the UI error explicit if deletion is intentionally blocked by policy.

Validation:

- Frontend host-price tests for admin viewing another owner's host.
- API tests for admin/non-admin price visibility.
- API/UI test for deleting `local-validation` or for the explicit denial path if
  policy says it must not be deletable.

Commit shape:

- `hosts/admin: show cross-user prices and handle validation deletes`

## Iteration 9: Slate Markdown Open Adds Trailing Whitespace

Severity: low/medium. It causes unnecessary diffs and undermines trust in Slate
for repo files.

Primary evidence:

- Opening a markdown file in Slate can add a final blank line without the user
  editing anything.

Likely code areas:

- `src/packages/frontend/editors/slate/markdown-to-slate`
- `src/packages/frontend/editors/slate/slate-to-markdown`
- `src/packages/frontend/editors/markdown-input/*`
- Markdown editor/generic editor actions under
  `src/packages/frontend/frame-editors/`

Reproduction plan:

- Create a markdown file with no trailing blank line.
- Open it in Slate/rich text mode.
- Close or let autosave run without edits.
- Confirm whether a final blank line is added.

Fix strategy:

- First determine whether the mutation is from:
  - markdown-to-slate normalization
  - slate-to-markdown serialization
  - autosave treating normalization as a user edit
- Preserve exact source text on open when the document is semantically unchanged.
- If normalization must add an internal empty paragraph, avoid marking the
  document dirty until the user makes a real edit.

Validation:

- Golden unit test: open/roundtrip no-op markdown does not add trailing blank
  lines.
- Browser smoke on a git-tracked markdown file: opening in Slate leaves
  `git diff` clean.

Commit shape:

- `frontend/slate: avoid no-op trailing newline edits`

## Tracking Template Per Bug

Use this template in commit notes or follow-up `.agents` notes while executing:

```
Iteration:
Area:
Severity:
Repro:
Evidence:
Root cause:
Fix:
Validation:
Commit:
Residual risk:
```

## Expected Validation Commands

Use focused commands first, adjusted to touched files:

```
pnpm -C src prettier --write <files>
cd src/packages/frontend && pnpm test -- <focused-test>
cd src/packages/project-host && pnpm test -- <focused-test>
cd src/packages/file-server && pnpm test -- <focused-test>
pnpm -C src lint:frontend
pnpm -C src version-check
```

For live browser validation, first load the matching environment:

```
cd src && eval "$(pnpm -s dev:lite:env)"
cd src && eval "$(pnpm -s dev:hub:env)"
```

## Notes For Future Agents

- Use `/home/user/scratch/2026-06-15-all-hands.slides.db` only as forensic
  input. Do not mutate it.
- Before changing project-host, project files, hosts, rootfs, or Conat
  control-plane APIs, read `src/.agents/scalable-architecture.md`.
- The course project item was intentionally omitted from active work because it
  has already been fixed.
