# cocalc → cocalc-ai port backlog (`PR-TODO-cocalc2`)

**This is the working notes file for the cocalc→cocalc-ai porting effort.**
Keep all triage decisions, findings and staging plans here. Started 2026-08-27,
re-verified against `cocalc-ai/main` on **2026-08-28**.
Small-fix backlog rechecked **2026-09-07** against `a447e89fab`; other tiers
still reflect the August review unless explicitly updated below.

Label: <https://github.com/sagemathinc/cocalc/pulls?q=is%3Apr+label%3APR-TODO-cocalc2>

## Conventions for this backlog

1. **No new issue tickets in cocalc-ai.** Everything discovered while triaging is
   tracked _in this file_. Do not propose opening cocalc-ai issues for follow-ups.
2. **Divergence is NOT a reason to drop a PR.** Even when the code has diverged so far
   that no hunk applies — the Gmail-style file actions (#8785/#8792) are the canonical
   example — **keep the upstream PR around as the reference design.** Dropping is only
   for things that are genuinely _done_ here, or genuinely _moot_ (the feature, file or
   subsystem no longer exists at all, so there is nothing the idea could apply to).
3. Consequence: the label is a _reference index_, not a work queue. Priorities live in
   §1b and the tier headings below, not in whether the label is present.
4. The exception to (2) is a **design** that would be redone from scratch anyway — not
   merely code that drifted. #8783 (OAuth2 provider) is the one case so far; see §6.

---

## 0. Ground rules discovered during triage

**Fork point: upstream #8674, 2025-12-08.** Every labelled PR is post-fork; nothing
arrived via a merge.

**Git ancestry cannot answer "is this ported".** `git merge-base cocalc/master
cocalc-ai/main` returns nothing — no common ancestor — because the `cocalc` remote
in this clone is a **shallow** fetch (`.git/shallow`, oldest commit ~2026-02-03)
while `cocalc-ai/main` carries the full 2012→ history. Grepping `git log --all` for
`#8xxx` matches _everything_ and is worthless. To triage, compare files/markers
directly, or deepen first:
`git fetch --shallow-since=<date> cocalc master`.

**Five verdict buckets.** The third is the one that's easy to get wrong:

1. Ported (a real port commit/PR exists).
2. **Independently reimplemented** in cocalc-ai — parallel work, not a port.
   Check `git log -- <file>` in cocalc-ai: you'll see its own commit arc.
3. Feature/file simply gone.
4. Structurally replaced (e.g. eslint → oxlint).
5. Still to do.

**A CLOSED cocalc-ai PR is not proof that its work was dropped.** William regularly
rebases branches into his own umbrella PRs (“Misc”, “Merge”, …), so the original PR
shows **CLOSED** with no `mergedAt` while its commits are on `main` under different
hashes. Verified 2026-08-28: #285, #286, #297 all read CLOSED but landed; #280's
substance landed too (`job_key` naming the document, `project/document-build/runtime.ts:50,288`);
only #278 genuinely did not. **Always check for the content on `main`, never just the
PR state.** `git merge-base --is-ancestor <headRefOid> cocalc-ai/main` also lies here
— it answers "same commits", not "same content".

---

## 1. Current status

**37 PRs still labelled** (refreshed after Harald's pass; **rechecked 2026-08-28 —
unchanged**, no additions and no further removals):

```
8888 8830 8818 8817 8815 8807 8795 8792 8791 8785 8782 8778 8768 8756 8754
8751 8744 8742 8733 8731 8724 8723 8715 8714 8705 8704 8701 8700 8698 8693
8692 8691 8686 8669 8663 8655 8636
```

Harald has removed: 8601 8657 8667 8672 8676 8683 8689 8694 8696 8697 8699 8703
8706 8710 8718 8719 8721 8730 8734 8738 8740 8745 8759 8777 8783 8824 8847 8861 8875.

> Two removals worth remembering, because the underlying issue is still real and
> is now tracked **only here**:
>
> - **#8697** — the Next `/api/v2/exec` half is moot (that route layer is gone), but
>   `project/exec_shell_code.ts:31` still calls `handleExecShellCode(mesg)` **without
>   `await`**, so the catch never fires. One-word fix, see Tier 1.
> - **#8777** — SSO signed-in link context: `server/auth/sso/` exists here but has no
>   link token, so the behaviour was never brought over. Dropped from the label, so
>   if it's wanted it has to come from this file.

### What landed in cocalc-ai between 2026-08-25 and 2026-08-28

William merged a large batch; `main` moved **75 commits** (`131a0451c8 → ddc24288d7`).
**Two labelled PRs are now DONE** and have moved to §5:

| PR                                                                                   | Landed as                                                                                                                                                |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#8756** don't auto-build on open if output exists                                  | `0ef98257c2`, then `f5835d37c9` (absent `build_on_save` ⇒ enabled) and `6402a1cadc` (rmd/qmd: don't drop a save that lands before account settings load) |
| **#8830** suppress the LaTeX error toast when a build/output/errors frame is visible | `b758416e55` (rich toast content), `93b975345d` (`get_visible_leaf_ids`), `732d864784` (the rework), `6e4b7611cd` (keep toasting what nothing renders)   |

Also landed, not port targets but relevant context: the **minimap** rework
(`3bb5828282`…`0c2b7b65d9`), the code-editor **Run button** (`9425ae69cb`…`d80319466d`),
keyboard-accessible kebab menus (`c9ba6e6efc`, `a8995acf8a`), workspace file/download
hardening (`97c7d704e6`, `90baf63c7f`, `345c3226bb`), and Blit/X11 locale + Wayland
fixes (`35dc8fa974`, `ed81354eaa`).

**Nothing in the batch invalidated any other verdict** in this file — Tiers 1, 2, 3,
5, 6, 7 and all six §7 loose findings were re-verified line by line on 2026-08-28 and
still hold. Only line numbers drifted (noted inline).

---

## 1b. Decided next steps (Harald)

0. ~~**#8756**~~ — **DONE 2026-08-28**, landed on `main` before we started it. See §5.
1. **#8636 Stage 1** — extract the **quick navigation dialog** (double-Shift box).
   See §3 — this is the first thing we want out of that large PR. **Now the head of
   the queue.**
2. **#8815** — wanted, deferred, to be done in stages. See §4.
3. **#8669** — priority 0, keep referenced only (one owner per project today). See Tier 7.

**2026-09-07 selection:** port the remaining Synctex frontend changes from
**#8701 + #8705** in `synctex-fixes-20260907`. The small-fix audit is below;
#8636 remains the next larger feature previously selected.

**Keep on the list, but parked** (Tier 7): **#8888** super low priority;
**#8663** low priority and the _approach_ is unresolved (overlaps #8815's contrast
parameter); **#8686** blocked on a design call, since both trees reworked the same
student list after the fork.

Opportunistic, whenever convenient: the remaining Tier 1 and Tier 2 items below.

---

## 2. Recommended next actions (priority order)

### Tier 1 — small-fix audit, 2026-09-07

- **#8724 + #8733 — DONE on main.** The deployed sanitizer hotfix landed via
  `2fd8ed567c` (including `d6a5b34075`). The old missing-fix verdict is obsolete.
- **#8698 — implemented on a branch, NOT on main.** The native-crypto replacement
  exists as `0d5d58bb73` on `cocalc-ai/hotfix/html-sanitizer-20260828` (with earlier
  equivalent commits). Current main still imports and calls `get-random-values`
  in `util/misc.ts` and declares it in `util/package.json`. Recover the existing
  change separately; do not count it as landed or reimplement it in the Synctex PR.
- **#8697 project half — still open.** `project/exec_shell_code.ts:31` calls
  `handleExecShellCode(mesg)` without `await`. This is TypeScript project-service
  code, not the replaced Python cocalc-api package. Its Next route half remains moot.

### Tier 2 — small-fix audit, 2026-09-07

| PR    | What                                                  | Current verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8692 | Collaborator cursor crash                             | **Parked / partially addressed.** See the dated cursor finding below.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #8701 | Synctex jumps into non-source files                   | **Implemented in `synctex-fixes-20260907`, pending merge.** Reuse the log parser’s supported text-dependency extensions plus latex (case-insensitive); ignore other targets and release the automatic-sync flag. The sync-doc half is **superseded**: `syncstring_table_get_one()` now delegates to `getDocumentMetadataState()`, which handles absent legacy tables and uses patchflow metadata or an empty Map. Porting the old early-return guard would skip valid metadata handling. |
| #8705 | Synctex numeric RegExp recompiled per call            | **Implemented in `synctex-fixes-20260907`, pending merge.** Compile once at module scope; retain parsing behavior.                                                                                                                                                                                                                                                                                                                                                                       |
| #8700 | AI-history event-emitter leak                         | **Still open.** `frame-editors/ai/use-ai-history.ts` still registers a per-hook `listenerRef`; upstream uses a shared listener and subscribers.                                                                                                                                                                                                                                                                                                                                          |
| #8693 | knitr TimeTravel frame path | **Implemented in PR #430.** TimeTravel and returning to Code retain the authored rnw/rtex source; same-type selections preserve subfiles. |
| #8655 | Starred-projects bar unnecessary remeasurement        | **Still open.** `projects/projects-starred.tsx` resets measurement on `[starredProjects]`, not a signature of layout-affecting fields.                                                                                                                                                                                                                                                                                                                                                   |
| #8714 | Peer-grading parsing runs serially                    | **Still open.** `course/assignments/actions.ts` loops over `peer_student_ids` serially while reading grades. Other parallel copy loops do not implement this fix.                                                                                                                                                                                                                                                                                                                        |
| #8723 | Email-address field retains edited value after Cancel | **Merged in PR #426.** Cancel restores the saved email, the input is controlled, and saving locks the form until the request settles. The existing Card and fresh-auth flow remain. |

This audit did not refresh GitHub label counts or the larger-feature tiers.

### Tier 3 — partially ported, needs scoping

- **#8807** course duplicate invite emails. `students/actions.ts:84` already awaits
  `create_student_project`, but the `configure` flag, `emitChangeImmediately`, and the
  missing awaits in `configuration/actions.ts` are absent (`create_student_project`
  takes only `student_id`).
- **#8742** flyout `disableActions` for student projects. `file-list-item.tsx` has two
  guards (`:193`, `:548`); the guard inside `makeContextMenuEntries`
  (`file-list-item.tsx:432`) is still missing. **Update 2026-08-28:**
  `flyouts/files-controls.tsx` now _exists_ (created by `a8995acf8a`, the kebab-menu
  unification) but contains **no `disableActions` / `student_project_functionality`
  check at all** — so the gap is unchanged, only the file it belongs in is now there. Note the **explorer** side already respects
  `disableActions` (`file-listing.tsx:1458`) — it's only the flyout that's short.
- **#8768** explorer. The independent explorer/flyout browsing paths were
  _independently built_ here (`explorer_browsing_path_abs` / `flyout_browsing_path_abs`,
  `navigate-browsing-path.ts`). Outstanding: the **directory-download bug fix**,
  actions deriving cwd from the checked files, and dead-code removal
  (`file-listing/file-row.tsx`, `file-checkbox.tsx` still present). Overlaps the known
  bulk-download gap.
- **#8818** flex `minHeight`/`minWidth`. Present in `chat/chatroom.tsx`,
  `jupyter/cell-list.tsx`, `frame-tree/title-bar.tsx`; **missing** in
  `frame-tree/frame-tree.tsx`, `chat/side-chat.tsx`, `jupyter/main.tsx`,
  `project/page/content.tsx`, plus the Safari scrollbar styling.

### Tier 4 — LaTeX / build cluster

> **Architecture update (Harald, 2026-08-27): a strict client-side BuildCoordinator
> port is NO LONGER NEEDED.** William implemented the build on the **project side**.
> Verified in the tree: `project/document-build/` (`manager.ts`, `runtime.ts`,
> `paths.ts`, `index.ts` + tests), exposed over Conat as
> `conat/project/api/document-build.ts` (`capabilities / start / get / getActive /
getRecent / cancel`), landed in commit `035fc76478` _"document-build: integrate
> project service, CLI, and editors"_. The manager already does cross-client
> **dedup by generation key** (`manager.ts:121` — a second request for the same
> generation returns the in-flight snapshot), keeps `active`/`completed` maps with
> TTL/retention knobs (`COCALC_DOCUMENT_BUILD_MAX_ACTIVE` default 2, `…MAX_QUEUED`
> 100, `…RETAIN_MAX` 100), and is capability-gated.
>
> **All three editors are already wired to it** — `latex-editor/actions.ts`,
> `rmd-editor/actions.ts`, `qmd-editor/actions.ts` all import
> `@cocalc/app-document-build`, plus `frontend/client/document-build-watcher.ts` and
> `latex-editor/build-command.tsx`. Each has an `actions-document-build.test.ts`.
>
> This is exactly the _"project-owned build service would collapse most edge cases"_
> V2 that the old build-coordinator design doc listed as design debt — it got built.
> So: **abandon the #255 / `build-coordinator-20260813` branch** rather than reviving
> it. Harald: _"something is there, we already tweaked it a bit, but more work is
> needed."_ Next step is to assess the gaps in the project-side service on its own
> terms, not to port upstream's client-side design.

- **#8756 — DONE 2026-08-28.** Don't auto-build on open if output already exists.
  It landed on `main` (`0ef98257c2` + `f5835d37c9` + `6402a1cadc`) before we picked it
  up. All four pieces we had scoped are present:
  `AccountStore.waitUntilReady()` (`account/store.ts`, + `store-wait-until-ready.test.ts`),
  the gated open-build in `latex-editor/actions.ts:525-533` (replacing the old
  unconditional `force_build()`), `do_build_on_save()` now defaulting to **false**
  until `is_ready` fires (rmd + qmd), and `checkProducedFiles()` made tri-state
  (`Set<string> | null`) with a try/catch in `rmd-editor/utils.ts`. Tests came with it:
  `actions-build-on-open.test.ts`, `rmd-editor/build-on-save.test.ts`.
  **Not included**, and therefore still open: upstream's `backend/exec-stream.ts` +
  `util/aggregate.ts` half — that is the multi-client stuck-spinner fix, which belongs
  to #8795 below. `util/aggregate.ts:108` still omits `streamCB` from the cache key and
  `exec-stream.ts` has no `finished:<job_id>` fallback.
- **#8795 — RE-EVALUATE, don't port as-is.** It was written against the _client-side_
  coordinator (stale `build_logs` "running" entries vs. the `building` flag,
  `cleanupStaleBuildLogs()`, a `BuildCoordinator` init race). With build state now
  owned by the project, the stuck-spinner class of bug should be re-derived from the
  document-build snapshot lifecycle instead. Keep the _symptom_ on the list — stuck
  spinner with two users on one `.tex` — and check it against the new architecture.
- **#8778** — recover PDF preview after project startup. Still not ported;
  cocalc-ai's `pdfjs-doc-cache.test.ts` is an unrelated CMap test. Independent of the
  above.
- **#8830** — **DONE 2026-08-28.** cocalc-ai PR #297 (`latex-error-toast-20260826`)
  reads **CLOSED** on GitHub, but its commits are on `main`: `b758416e55`,
  `93b975345d`, `732d864784`, `6e4b7611cd`. `tree_ops.get_visible_leaf_ids` is live at
  `latex-editor/actions.ts:681`. (Canonical example of the CLOSED-≠-dropped rule in §0.)

### Tier 5 — frame-editor UX

- **#8782** flatten splits inside tabs + better tab labels (`tabs-container.tsx`
  exists, `flatten_tabs` does not).
- **#8791** submenu icon pinning (no `resolveCompoundCommand`).
- **#8817** drag-and-drop toolbar reordering (no `sortable-button-bar.tsx`,
  no `get/setToolbarOrder`).

### Tier 6 — backend / perf

- **#8715** process-stats parallel + per-caller `last` — `backend/process-stats.ts:46`
  still `private last?`.
- **#8754** offload the proc scan to a worker thread — no `process-stats.worker.ts`.
  **Port these two together, #8754 last** (it supersedes/extends #8715).

### Tier 7 — larger features, each needs a yes/no

- **#8692 — PARKED / PARTIAL (2026-09-07 independent review).** Avatar navigation
  and the whiteboard missing-position crash were fixed in `7e9fd8287b`; Jupyter
  `gotoUser` also guards absent positions. Remaining upstream defensive guards
  are still missing in `frame-editors/base-editor/actions-base.ts:2301` and
  `jupyter/cursor-manager.ts:48`, which call `info.get("locs").forEach(...)`
  directly. Current SyncDoc cursor-map construction forwards `state.locs`
  unchanged, so the new transport does not make these guards obsolete.
  Reassess a targeted defensive port separately. No live crash reproduced.

- **#8888** Jupyter versioned-kernel update awareness — **KEEP, super low priority**
  (Harald). Nothing in `frontend/jupyter/kernelspecs.ts` / `jupyter/util/misc.ts`;
  self-contained, ~1000 lines, no blockers. Conceptually relevant given cocalc-ai's
  rootfs image lineages (a notebook pins `sage-10.5` and never learns a newer image
  exists), so worth keeping on the list — just not competing for a slot.
- **#8686** rework the assignment student list — **UNCLEAR, needs a design call,
  not a port.** Harald: _"there was work in the student list."_ Confirmed — **both
  sides independently reworked the same UI after the fork**, which is exactly why
  this can't be cherry-picked:
  - cocalc-ai side (post-fork, June 2026): `9b9885ada6` "polish grade feedback layout
    and uploads" on `assignment-student-list.tsx`; `89fe68dd24` "tighten terminal and
    grade controls", `e2caae0c18` "clip assignment card overflow", `fef3182565`
    "simplify repeat assignment updates" on `common/student-assignment-info.tsx`.
    Plus its own `useProjectRunQuotaPrefetch` and `course_project_id` threading in
    `assignment-student-list.tsx`.
  - upstream side: #8686 _removed_ `StudentAssignmentInfoHeader` and `is_peer_graded`
    and **simplified** `common/progress.tsx` (40 lines) — cocalc-ai still has the old
    73-line version, untouched since before the fork (last commit `3ac3b67ab1`, 2024).
    So the two trees have diverged in overlapping but different directions. Decide what
    the assignment student list _should_ look like in cocalc-ai first, using #8686 as a
    design reference; only then decide which hunks (if any) survive.
- **#8777** preserve signed-in SSO link context — **label removed by Harald**, but the
  gap is real and now tracked only here: `server/auth/sso/` exists with
  `consts.ts`/`passport-login.ts`, but no short-lived link token, so linking an SSO
  identity to the _currently signed-in_ account still falls back to duplicate-email
  rejection when `remember_me` is unavailable. Revive from this file if it bites.
- **#8663** "Accessibility" mode account setting — **KEEP, low priority, approach
  unclear** (Harald). Absent from cocalc-ai. The open question is _whether a special
  mode is the right shape at all_: cocalc-ai already aims for good accessibility
  **by default**, without a mode to opt into — see PR #248 (VPAT), #249 (a11y
  guardrails), `src/.agents/accessibility.md`, and the `jsx-a11y` rules already
  enforced in `src/packages/.oxlintrc.jsonc`. It **also overlaps #8815**, whose
  dynamic color-theme system carries a **contrast parameter** — which is arguably
  where "accessibility mode" contrast belongs. Revisit only after #8815's foundation
  stage (§4) and #8636 Stage 1 (§3) have landed and the shape is clearer.
- **#8669** project collaborator **ownership management** — **PRIORITY 0 (very low),
  but KEEP on the list.** Harald: cocalc-ai has **exactly one owner per project**, so
  upstream's multi-owner / ownership-transfer model does not fit the current data
  model. Keeping it referenced because _"maybe we change that, or we want to start
  supporting moving the ownership in some way"_ — i.e. this is the reference design
  for a future ownership-transfer feature, not a port to schedule.
  State: absent (`util/project-ownership.ts`, `server/projects/ownership-checks.ts`
  missing; cocalc-ai only has the `"owner"` group string, e.g.
  `collaborators/current-collabs.tsx:47,99`). 69 files upstream. If it is ever
  revived it **needs a multibay / `owning_bay_id` review first** — see
  `src/.agents/scalable-architecture.md`.

---

## 3. #8636 (ARIA) — WANTED, but in stages

Upstream draft `aria-20251024`, +5963/-741. We want this, but **staged**, not as one port.

### Stage 1 (first, and the one Harald wants): the **quick navigation dialog**

The design goal, in Harald's words: a trigger like **double-tap Shift** pops a
keyboard-focused nav box in the middle of the screen listing recent files etc.,
usable **100% from the keyboard**. Once you've selected a file (open editor),
press a **number** to switch to a specific frame, or just **Return** for the most
recent frame in that editor. It also gives quick-jump access to all user account
settings (at minimum opening the relevant page). With **intelligent substring
matching** — e.g. `pr da` → profile/dark. There are several such gems in that
dialog to port forward and adapt.

Upstream files to extract (~84 KB total):

| File                                         | Size    | Role                                                                                                                                                  |
| -------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/app/hotkey/dialog.tsx`             | 29.1 KB | `QuickNavigationDialog` — the antd `Tree`-based box                                                                                                   |
| `frontend/app/hotkey/use-navigation-data.ts` | 26.1 KB | `useNavigationTreeData`, `useActiveFrameData`, `useEnhancedNavigationTreeData` — collects ProjectInfo / FileInfo / FrameInfo / AppPageInfo / FixedTab |
| `frontend/app/hotkey/build-tree.tsx`         | 13.8 KB | tree assembly                                                                                                                                         |
| `frontend/app/hotkey/detector.tsx`           | 5.3 KB  | `useShiftShiftDetector`                                                                                                                               |
| `frontend/app/hotkey/util.ts`                | 5.4 KB  | `resolveSpecLabel`, `ensureFrameFilePath`, `focusFrameWithRetry`                                                                                      |
| `frontend/app/hotkey/render-frame-tree.tsx`  | 4.2 KB  | frame-tree rendering                                                                                                                                  |
| `frontend/app/hotkey/index.ts`               | 0.6 KB  | barrel                                                                                                                                                |
| `frontend/app/hotkey/_hotkey.sass`           | —       | styles                                                                                                                                                |
| `frontend/account/hotkey-selector.tsx`       | —       | the `Hotkey` setting (incl. `"disabled"`)                                                                                                             |
| `frontend/account/hotkey-delay-test.tsx`     | —       | UI for tuning the double-tap delay                                                                                                                    |

Mechanics worth knowing before porting:

- **Trigger**: `useShiftShiftDetector(onDoubleShift, enabled, delayMs = 300, blocked)`.
  Two `Shift` keydowns within `delayMs`; any other key resets the counter; respects
  `e.defaultPrevented`; uses `performance.now()` for precision. Delay is
  user-configurable (hence `hotkey-delay-test.tsx`), and the hotkey can be disabled.
- **Matching is space-separated AND-substring, not fuzzy**: `matchesAllTerms()` splits
  the query on whitespace and requires _every_ term to appear. That is exactly what
  makes `pr da` → _profile_ / _dark_ work. `isCaseSensitive()` implements smart-case;
  `highlightSearchMatches()` does the highlighting.
- **Number shortcuts 1–9** map to frames of the _current_ editor (`shortcutNumber` on
  the node, assigned in a `Map<frame.id, n>`); arrows navigate the filtered list;
  Return opens.
- Expanded tree state persists to localStorage under `hotkey-nav-expanded`.

Adaptation notes for cocalc-ai: the nav data model reaches into `FixedTab` /
`project/page/file-tab`, `frame-tree/types` `EditorSpec`, and account settings pages —
all of which have diverged here (cocalc-ai has `frontend/public/*`, no
`frontend/compute/`, different account-settings routing). Expect `use-navigation-data.ts`
to be the bulk of the work; `detector.tsx` + `util.ts` should come across nearly clean.

### Later stages

The rest of #8636 (ARIA roles/labels across ~100+ frontend files) should be weighed
against cocalc-ai's **own** a11y track — PR #248 (VPAT), #249 (accessibility
guardrails), `src/.agents/accessibility.md`, and the `jsx-a11y` rules already enforced
in `src/packages/.oxlintrc.jsonc`. Likely divergent; re-triage when Stage 1 lands.

---

## 4. #8815 (dynamic color themes) — WANTED, deferred, staged

Harald: _"basically done, but I haven't merged it yet. will be a huge porting job in
stages, but later."_ Keep the label.

Upstream draft `claude/dynamic-theme-system-Bxqq9`, **539 changed files**,
+8388/-3173, last updated 2026-07-15.

Natural staging: the **foundation is small and separable** — `_colors.sass`,
`app/theme-context.tsx`, `account/dark-mode.ts`, `account/color-theme-selector.tsx`,
`account/types.ts`, plus `cdn/cm-custom-theme/{cocalc-auto,cocalc-dark}.css`. The
remaining ~500 files are mechanical color-literal → token conversions that split
cleanly by directory (churn clusters: `account` 21, `components` 19, `chat` 13,
`app` 11, `admin` 9 in the first hundred alone).

cocalc-ai specifics: the PR touches `frontend/compute/` which **doesn't exist** here
(those hunks drop); and the token layer has to reconcile with cocalc-ai's
`COLORS`-from-`@cocalc/util/theme` hard rule _and_ the `frontend/public` site surface
upstream doesn't have. The foundation stage is where the real design decisions are.

---

## 5. Verdicts: done or moot (with reasons)

> Per convention 2, this section is only for PRs that are genuinely **done** here or
> genuinely **moot** (nothing left for the idea to apply to). Anything merely
> _diverged_ stays on the list as a reference design.

### Already done in cocalc-ai

| PR        | Evidence                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8847     | Ported via cocalc-ai PR #225 — `frontend/chat/anchors.ts`, `jupyter/cell-chat-button.tsx` (`useAnchoredThreads`).                                                                           |
| #8703     | Both fixes present: `conat/core/server.ts:2801` address guard, `conat/persist/client.ts` `reconnectTimer`/`scheduleReconnect`.                                                              |
| #8745     | Moot — `app-framework/redux-hooks.ts` was rewritten (`resolveReduxPath`/`getReduxValue`) to always re-read from the store, which _is_ the fix.                                              |
| #8824     | `projects/projects-actions-menu-content.tsx:99` already uses the `useEffect` form, with a comment about the mount-vs-`onOpenChange` case. The `file-tabs.tsx` half doesn't apply.           |
| **#8744** | _(still labelled)_ `project/file-action-modal.tsx` exists and is wired at `project/page/page.tsx:151,1194`. Independently built.                                                            |
| **#8756** | _(still labelled)_ **Ported 2026-08-28** — `0ef98257c2` + `f5835d37c9` + `6402a1cadc`. Full detail in Tier 4. The `exec-stream`/`aggregate` half was **not** included and stays with #8795. |
| **#8830** | _(still labelled)_ **Ported 2026-08-28** — `b758416e55`, `93b975345d`, `732d864784`, `6e4b7611cd`, via the CLOSED-but-landed PR #297.                                                       |
| #8875     | Independently built: `cookie-consent/index.ts` `forceConsentCount`; `public/auth/forms.tsx` "Acknowledge cookie banner to continue".                                                        |
| #8676     | Fully ported: `util/consts/portnumber.ts`, `ConfigSSHFS.port`, and the UI (`datastore.tsx:87,120,334`).                                                                                     |
| #8689     | Cookie table present in `frontend/public/policies/privacy.tsx:354+`.                                                                                                                        |

### Not applicable — gone or structurally replaced

| PR                  | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8696               | `frontend/misc/llm.ts` and `numTokensEstimate` are gone.                                                                                                                                                                                                                                                                                                                                                                                           |
| **#8706**           | _(still labelled)_ **No async Python anywhere in the repo** — zero `async def`, zero `import asyncio` outside vendored code. Every `time.sleep` hit (`bootstrap.py`, dev scripts) is genuinely synchronous. No `_retry_with_backoff` in any language. Nothing for the fix to attach to. Worth a line in the Python-client guidance in case an async client ever appears.                                                                           |
| #8710, #8721, #8601 | `src/python/cocalc-api` is a thin sync client: no `mcp/`, no `cli`, no `tests/`.                                                                                                                                                                                                                                                                                                                                                                   |
| **#8731**, #8730    | _(#8731 still labelled)_ cocalc-ai replaced eslint with **oxlint** (`028904e049` "replace stale eslint setup with oxlint"). `react/rules-of-hooks` **is** enabled in `src/packages/.oxlintrc.jsonc` and the frontend passes **0 warnings / 0 errors over 3287 files**. The config's comment about an `.oxlintignore` backlog is **stale — no such file exists**; only `ignorePatterns` (dist, node_modules, codemirror/mode, e2e, `*.d.ts`) apply. |
| #8699               | No valkey/redis in `.github/workflows/*` at all.                                                                                                                                                                                                                                                                                                                                                                                                   |
| #8861               | Structurally moot — no `thirdparties` page; policies rewritten under `frontend/public/policies/`. **But the editorial substance still applies** and is worth keeping as reference: #8861 argued for naming vendors _without_ linking their privacy policies (they go stale). `privacy.tsx:502` still links Stripe's.                                                                                                                               |
| **#8691**           | _(still labelled)_ `components/setting-box.tsx` uses a different header layout (`<div>{title}</div>` + `marginRight`) that already keeps the title inline.                                                                                                                                                                                                                                                                                         |
| **#8704**           | _(still labelled)_ cocalc-ai's project-control layer no longer logs the status object — `multi-user.ts`/`single-user.ts` are gone and `base.ts` has no such debug line. Nothing leaks.                                                                                                                                                                                                                                                             |
| #8697 (Next half)   | `next/pages/api/v2/` doesn't exist — Conat RPC replaced it. **The project-side missing `await` is still real** (Tier 1).                                                                                                                                                                                                                                                                                                                           |

### Feature genuinely absent — KEEP the PR as reference (do not drop)

- **#8785 / #8792** — Gmail-style cut/copy/paste/delete for the file explorer and
  flyout. **Entirely absent** here: no `file-clipboard/` under any name, no `clipboard`
  key in `app/store.ts`, no i18n keys, no cut/copy/paste verbs in explorer or flyouts
  (the one `onPaste` is a terminal handler). Alive upstream. cocalc-ai _does_ have hover
  row-actions (`cc-explorer-hover-icon`, download + ellipsis at
  `file-listing.tsx:1444,1464`) — the surface exists, but not the clipboard model.
  38 files against a diverged explorer means this would be a **reimplementation using
  upstream as the design reference**, not a cherry-pick — which is exactly why the PR
  **stays on the list** (convention 2). #8792 folds in for free once the model exists.

### Deps-only

#8759 #8740 #8734 #8738 **#8751** #8718 #8694 #8667.

**Real finding underneath #8738/#8751:** cocalc-ai's `util/db-schema/ai-models.ts`
(upstream's `llm-utils.ts`, still actively imported by `components/ai-model-name.tsx`,
`purchases/purchases.tsx`, `frame-editors/ai/*`, …) **never got the Claude 4.5
generation at all** — `ANTHROPIC_MODELS` ends at `claude-4-opus-8k` (`:189`) and the
user-selectable filter still offers `claude-3-5-haiku-8k` / `claude-4-sonnet-8k` /
`claude-4-opus-8k` (`:275`). Gemini tops out at `gemini-2.5-pro`. Upstream hunks
**won't apply** — they patch entries that don't exist. **Open a separate issue:
refresh the LLM model registry** (add 4.5/4.6 tiers, retire dead aliases, refresh
Gemini/OpenAI, re-pick the user-selectable set). Users are picking from a stale menu
today. **Tracked here, not as a cocalc-ai issue** (convention 1) — see the task list
in §7.

---

## 6. Still open upstream

- **#8636**, **#8815** — open upstream drafts, both **wanted**, both to be taken in
  stages rather than ported wholesale. See §3 and §4.
- **#8783** OAuth2 provider — **label removed deliberately** (Harald): _"either way,
  if cocalc becomes an oauth2 provider, we'll do it differently."_ This is the one
  case where convention 2 does **not** apply: it is not that the code diverged, it is
  that the _design_ would be redone from scratch here — cocalc-ai's control plane is
  multibay (which bay is authoritative for a client, a grant, a consent record?) and
  routes through Conat RPC rather than the Next `/api/v2` routes the PR builds on
  (`next/pages/api/v2/oauth2/*`), which do not exist here at all. So upstream's
  ~7000-line implementation has little reference value beyond "cocalc once did this".
  If we ever want CoCalc to _be_ an authorization server, start from
  `src/.agents/scalable-architecture.md`, not from #8783.

---

## 7. Loose findings (no upstream PR — tracked here, per convention 1)

Things the triage turned up that aren't a port of any labelled PR. No cocalc-ai
issue tickets for these; this list _is_ the tracker.

1. **LLM model registry is badly stale.** `util/db-schema/ai-models.ts` (upstream's
   `llm-utils.ts`) never got the Claude 4.5 generation: `ANTHROPIC_MODELS` ends at
   `claude-4-opus-8k` (`:189`), and the user-selectable filter (`:275`) still offers
   `claude-3-5-haiku-8k` / `claude-4-sonnet-8k` / `claude-4-opus-8k`. Gemini tops out
   at `gemini-2.5-pro`. The file is live — imported by `components/ai-model-name.tsx`,
   `purchases/purchases.tsx`, `frame-editors/ai/*`, `account/avatar/avatar.tsx`, … —
   so users pick from a stale menu today. Upstream hunks (#8738/#8751) **will not
   apply**; this is a fresh pass, not a port.
2. **`project/exec_shell_code.ts:31` is missing an `await`** on
   `handleExecShellCode(mesg)`, so the response is a Promise and the `catch` never
   fires. From #8697, whose label is gone. One-word fix.
3. **SSO signed-in link context is absent** (`server/auth/sso/` has no short-lived link
   token). From #8777, whose label is gone.
4. **`.oxlintrc.jsonc` comment is stale** — it claims a legacy-violation backlog is
   "tracked in `.oxlintignore`", but no such file exists anywhere in the repo. Only
   `ignorePatterns` apply, and the frontend passes `react/rules-of-hooks` 0/0 over
   3287 files. Delete the sentence.
5. **`privacy.tsx:502` links Stripe's own privacy policy** — #8861's editorial rule was
   to name vendors without linking their policies, since those links go stale.
6. **Dead explorer files** — `project/explorer/file-listing/file-row.tsx` and
   `file-checkbox.tsx` are unused leftovers upstream deleted in #8768.
