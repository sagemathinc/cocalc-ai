# cocalc → cocalc-ai port backlog (`PR-TODO-cocalc2`)

**This is the working notes file for the cocalc→cocalc-ai porting effort.**
Keep all triage decisions, findings and staging plans here. Started 2026-08-27,
re-verified against `cocalc-ai/main` on **2026-08-28**.

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

**Keep on the list, but parked** (Tier 7): **#8888** super low priority;
**#8663** low priority and the _approach_ is unresolved (overlaps #8815's contrast
parameter); **#8686** blocked on a design call, since both trees reworked the same
student list after the fork.

Opportunistic, whenever convenient: the Tier 2 small-bug batch.

---

## 2. Recommended next actions (priority order)

### Tier 1 — do now: small, unambiguous, high value

| PR    | What                                                                     | Evidence it's missing                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #8697 | `project/exec_shell_code.ts` awaits nothing, so its `catch` never fires. | `project/exec_shell_code.ts:31` still calls `handleExecShellCode(mesg)` without `await`. One-word fix. The label is already removed (the Next `/api/v2/exec` half is moot); don't lose it. |

### Tier 2 — small bug batch, one PR

| PR    | What                                                                                   | State in cocalc-ai                                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8692 | Crash when collaborator avatar has no cursor `locs`                                    | No null guard in `code-editor/actions.ts`; `jupyter-editor/actions.ts:790 gotoUser` is the old `.toJS()` form.                                                                                                                                       |
| #8701 | Synctex jumps into non-source files; `sync-doc` throwing on missing `syncstring_table` | Neither `SYNCTEX_SOURCE_EXTS` nor the guards exist.                                                                                                                                                                                                  |
| #8700 | LLM history event-emitter leak                                                         | Upstream's `use-llm-history.ts` is `frame-editors/ai/use-ai-history.ts` here, still the **pre-fix per-hook `listenerRef`** shape (`:139` on / `:151` off). Upstream replaced it with one shared listener + subscriber set. Real leak, still present. |
| #8693 | knitr time-travel frame path                                                           | No `set_frame_type` override in latex actions.                                                                                                                                                                                                       |
| #8705 | Synctex RegExp recompiled per call                                                     | `synctex.ts:119` still inside `parse_synctex_output`. Trivial.                                                                                                                                                                                       |
| #8655 | Starred-projects bar re-measures on every `project_map` change                         | `projects-starred.tsx:214` still depends on `[starredProjects]`.                                                                                                                                                                                     |
| #8714 | Peer grading serial loop                                                               | `course/assignments/actions.ts:1931` still a `for` loop.                                                                                                                                                                                             |
| #8723 | Email-address field keeps edited value after Cancel                                    | `email-address-setting.tsx:50 cancel_editing()` does **not** reset `email_address` — the exact bug. (cocalc-ai has diverged: fresh-auth `runSecurityAction`, `Alert`, still `Card` not `Modal` — port the state fix only, not the Modal rework.)     |

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

| PR                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8847             | Ported via cocalc-ai PR #225 — `frontend/chat/anchors.ts`, `jupyter/cell-chat-button.tsx` (`useAnchoredThreads`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #8703             | Both fixes present: `conat/core/server.ts:2801` address guard, `conat/persist/client.ts` `reconnectTimer`/`scheduleReconnect`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| #8745             | Moot — `app-framework/redux-hooks.ts` was rewritten (`resolveReduxPath`/`getReduxValue`) to always re-read from the store, which _is_ the fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| #8824             | `projects/projects-actions-menu-content.tsx:99` already uses the `useEffect` form, with a comment about the mount-vs-`onOpenChange` case. The `file-tabs.tsx` half doesn't apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **#8744**         | _(still labelled)_ `project/file-action-modal.tsx` exists and is wired at `project/page/page.tsx:151,1194`. Independently built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **#8756**         | _(still labelled)_ **Ported 2026-08-28** — `0ef98257c2` + `f5835d37c9` + `6402a1cadc`. Full detail in Tier 4. The `exec-stream`/`aggregate` half was **not** included and stays with #8795.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **#8830**         | _(still labelled)_ **Ported 2026-08-28** — `b758416e55`, `93b975345d`, `732d864784`, `6e4b7611cd`, via the CLOSED-but-landed PR #297.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **#8724 + #8733** | _(still labelled)_ **Ported 2026-08-28** — `0db5f990c8`. Combined end state only: #8733 fixes a bypass that remained after #8724 (the live-`NamedNodeMap` skip predates both — jQuery's `$.each` snapshots `length` once), so porting #8724 alone would have shipped the hole. `util/misc.ts` `sanitize_html_attributes` now lowercases attribute names, strips whitespace + ASCII 0-31 from values before the protocol test, blocks `vbscript:` as well as `javascript:`, and snapshots the live `NamedNodeMap` with `Array.from` so consecutive `on*` attributes are no longer skipped. New `util/test/sanitize_html_attributes.test.ts` (17 tests). **Two divergences from upstream, and one attempted divergence that was withdrawn** — see §9 for both, including the SVG `animate` payload that killed the second one. Kept: `hasProtocolInAnySegment` matches per `;`-separated segment — upstream tests only the start of the whole attribute and is **still vulnerable** to `values="https://ok;javascript:..."` on SVG `animate` (§9a-bis) — and it scans in place, bailing at the first mismatching character, instead of upstream's `replace(...).toLowerCase()` over the whole value — 52ms → 5ms over twenty passes on a 4MB `data:` URI, on a path `components/html.tsx:165` already warns can crash on big documents. Do not reintroduce a fixed-size prefix window: padding with ignored characters would push the scheme past it and bypass the check. Re-verified live before porting, _not_ dead code: `util/misc.ts` → `frontend/misc/sanitize.ts:46` → `frontend/components/html.tsx:184` (`safeHTML` defaults true) and `markdown.tsx`, plus a direct call in `frontend/chat/history.tsx:76`. |
| **#8698**         | _(still labelled)_ **Ported 2026-08-28** — `ea22ca2957`. `secure_random_token` uses `globalThis.crypto.getRandomValues`; dep gone from `util/package.json`, and `get-random-values` + `global` + `min-document` + `dom-walk` + `process` gone from the lockfile — five package nodes, which `pnpm` reports as −6 because the importer link counts too. `process` was orphaned once `global` went; upstream's diff kept it, so their tree must have had another consumer. The `min-document@<=2.19.0` override in `pnpm-workspace.yaml` stays as a supply-chain guard. `packages/mobile`'s `react-native-get-random-values` is untouched — different package, and it is what supplies the global under React Native. Upstream's README / node-version / `.claude/settings.json` hunks did not apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| #8875             | Independently built: `cookie-consent/index.ts` `forceConsentCount`; `public/auth/forms.tsx` "Acknowledge cookie banner to continue".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #8676             | Fully ported: `util/consts/portnumber.ts`, `ConfigSSHFS.port`, and the UI (`datastore.tsx:87,120,334`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #8689             | Cookie table present in `frontend/public/policies/privacy.tsx:354+`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
7. **Sanitizer policy** — two open items in §9: the protocol check deletes prose
   such as `title="JavaScript: The Good Parts"` (fails safe; scoping it to
   url-valued attributes is **not** the fix — that is an XSS regression), and the
   legacy jQuery path filters protocols but never tags, so `<iframe srcdoc=...>`
   and `<iframe src="data:text/html,...">` pass through. The second is a
   **confirmed live cross-user XSS** — reproduced firing in a real chat message
   2026-08-28 — caused by `project/page/content.tsx:318` setting `noSanitize: true`
   for every editor tab, which switches `html-ssr`'s sanitization off entirely.
   Pre-existing, unrelated to this port, and worth fixing promptly.
8. **Retire the jQuery HTML pipeline** (`components/html.tsx` and its
   `sanitize_html_attributes`). `components/html-ssr.tsx:11` already carries the
   TODO: _"This should eventually completely replace ./html.tsx"_. Investigated
   2026-08-28 and **deliberately deferred** — a spike showed it typechecks
   repo-wide and passes 790 frontend tests, but two hazards make it its own PR,
   not a rider on the sanitize port. See §8.

---

## 8. Retiring the jQuery HTML pipeline (deferred, own PR)

**Why it is worth doing.** `components/html-ssr.tsx:11` says it should replace
`components/html.tsx`. The jQuery path is nearly orphaned already: every `<HTML>`
render site in the tree imports `html-ssr` **except** `components/markdown.tsx`.

**Full consumer inventory** of `util/misc.ts sanitize_html_attributes` <-
`frontend/misc/sanitize.ts` <- `components/html.tsx` (verified 2026-08-28):

| via                                                     | sites                                                                                                                                                                                              | props actually passed              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `<Markdown>` (`components/markdown` <- `lazy-markdown`) | 10 occurrences in 8 files: markdown TOC, LaTeX TOC, project title + description, invite messages (x2), Jupyter confirm dialog, admin site-setting hints, data-editor hint, LaTeX PDF error message | `value` only (one also `style`)    |
| `<HTML>` directly                                       | `frame-editors/frame-tree/print.ts:96`, via `renderToStaticMarkup`                                                                                                                                 | `value`, `project_id`, `file_path` |
| direct `sanitize_html_safe`                             | `chat/history.tsx:76`. **Not redundant** — see the `noSanitize` note below; inside a project editor this pre-pass is the only attribute/protocol sanitization chat history gets.                   | —                                  |

**Two supporting findings.** The prop surface used by the legacy `<Markdown>`
callers is `value` + `style`; `post_hook`, `content_editable`, `href_transform`,
`reload_images`, `smc_image_scaling`, `safeHTML={false}` and `auto_render_math`
have no caller anywhere. (`print.ts` does pass `project_id` and `file_path`, but
their effects live in a `useEffect` that never runs under `renderToStaticMarkup`.)
And
`is_share_server()` is permanently false — `set_share_server` is never called
anywhere — so html.tsx's entire unsanitized share-server branch is dead code.

**The two hazards that deferred this.**

1. **Do not route markdown through `html-ssr`.** Markdown converges on Slate
   `StaticMarkdown`; only _raw HTML_ converges on `html-ssr`. Going
   `markdown_to_html` -> `html-ssr` loses behaviour, because
   `components/sanitize-html.ts:95` deliberately strips most `class`, `id`,
   `style`, `data-*`, checkbox `<input>` and mention attributes. Slate understands
   checkboxes, hashtags, mentions and other markdown tokens structurally.
2. **`print.ts` is not an import swap.** Pointing it at `html-ssr` would strip user
   HTML classes, ids and inline styles from printed documents. It needs a
   deliberate print sanitization policy — decide which formatting attributes to
   keep — and should be migrated on its own.

**A third thing to settle while doing it:** `project/page/content.tsx:318` sets
`noSanitize: true` for everything rendered inside a project page (with its own
"temporary for backward compat" TODO). The in-project `<Markdown>` sites (both
TOCs, Jupyter confirm dialog, data-editor hint, LaTeX PDF error) currently sanitize
regardless; after migrating they would inherit `noSanitize`. Arguably that just
makes them consistent with the file body they describe — a heading you can inject
into is in a document whose body is already unsanitized — but it is a real
behaviour change and should be an explicit decision, not a side effect. The
out-of-project sites (project title/description, invite messages, admin hints) keep
html-ssr's allowlist and are unaffected.

The same flag is why `chat/history.tsx:76` must keep its `sanitize_html_safe` call
for now. Chat renders under the project page's `FileContext`, so raw HTML in a
message reaches `editors/slate/elements/html` -> `components/html-ssr`, and
`html-ssr.tsx:110` skips `sanitizeHtmlAttributes` entirely when `noSanitize` is set.
Verified live in Lite 2026-08-28: a `vbscript:` href survives in the editor. So that
pre-pass is load-bearing, not belt-and-braces, until `noSanitize` is dealt with.

**Order of work.**

1. Move the 10 legacy `<Markdown>` occurrences to `StaticMarkdown`, keeping lazy
   loading (repointing `components/lazy-markdown.tsx` at `static-markdown` covers
   all 10 call sites without touching them; note its test mocks `./markdown` and
   its plain-text fallback uses `id`/`onClick`, which `StaticMarkdown` does not
   take).
2. Drop chat history's `sanitize_html_safe` pass **only after** the `noSanitize`
   policy above is resolved. Under `noSanitize: true` it is not redundant: it is
   the only thing sanitizing attributes and protocols in chat edit history
   inside a project editor. Removing it first would reopen raw-HTML XSS there.
3. Migrate `print.ts` separately, with an explicit attribute policy.
4. Then delete `html.tsx`, `markdown.tsx`, `misc/sanitize.ts`,
   `sanitize_html_attributes` + its test, and the unused share-server flag.

**Visual checks required** (this is a UI-visible change): both TOCs, project title
and description, invite messages, modal/alert content, checkboxes, mentions, math,
and print formatting.

**Until this lands, the #8724/#8733 hardening in §5 is the safety net** — that is
why it was kept rather than folded into this removal.

---

## 9. Sanitizer policy: two open questions from the #8724/#8733 review

### 9a. WITHDRAWN: do not scope the protocol check to url-valued attributes

Review of PR #324 flagged, correctly, that the upstream end state deletes prose:
`title="JavaScript: The Good Parts"` normalizes to `javascript:thegoodparts` and
the attribute is dropped. Case-folding is what made this reachable — before the
port only a literal lowercase `javascript:` at position 0 matched.

The obvious fix — only run the protocol test on `href` / `src` / `action` /
`formaction` / `data` / `xlink:href` / … — was implemented, pushed, and then
**withdrawn: it is an XSS regression.** Codex found the counter-example, and it
was reproduced through the real jQuery parse → sanitize → serialize pipeline in
Chrome:

```html
<svg>
  <a>
    <animate
      attributeName="href"
      values="javascript:alert(42)"
      dur="1s"
      fill="freeze"
    />
    <text>click</text>
  </a>
</svg>
```

`values` is not an "obvious" url attribute, but `animate` assigns it to `href` at
runtime, so clicking the text runs the script. Under the upstream every-attribute
check the payload is neutralized; under the allowlist it survived intact. The same
applies to `to`, `from`, `by`, `srcset`, `ping`, `imagesrcset`. **Any such list is
incomplete** — the test file carries a regression test for the `animate` case and
the function carries a comment saying why the list is not safe.

### 9a-bis. FIXED: `values` is a list, so the payload need not come first

A second round of review found that restoring the every-attribute check was still
not enough. `values` is a **`;`-separated animation list**, and upstream (like the
first fix) only tested the start of the whole attribute, so this survived both:

```html
<animate
  attributeName="href"
  values="https://example.com;javascript:alert(99)"
  dur="200ms"
  calcMode="discrete"
  repeatCount="indefinite"
/>
```

The animation assigns each value to `href` in turn, so the payload runs on click
from the second value onward. Reproduced through the real jQuery pipeline in
Chrome. **This one is inherited from upstream** — cocalc.com is vulnerable to it
today.

Fixed by matching per `;`-separated segment (`hasProtocolInAnySegment`). Segmenting
is applied to **every** attribute, not just the ones known by name to hold
animation lists — the whole lesson of §9a is that such lists are incomplete.

Two implementations were rejected on the way, both recorded in comments on the
function so they are not tried again:

- a **regex** built from the protocol (`j[\s]*a[\s]*v...`) backtracks
  quadratically on input like `";".repeat(100k) + " ".repeat(100k)` — a ReDoS;
- normalizing a **fixed-size prefix** lets padding push the scheme past the window.

The shipped scanner bails at the first mismatching character within a segment and
jumps to the next `;` with a native `indexOf`, so it is linear with no
backtracking. Measured: 20 passes over a 4MB `data:` URI = 5ms (upstream's
`replace().toLowerCase()` alone = 52ms), 20 passes over 200k segments = 136ms, 20
passes over the ReDoS input = 68ms, and a payload buried after 50k safe segments is
still caught.

### 9c. OPEN (pre-existing, wider than this port): the legacy path only filters

protocols, never tags

An adversarial sweep through the live jQuery pipeline on 2026-08-28 confirmed the
hardened matcher holds up: entity-encoded schemes (`&#106;avascript:`,
`&#x6a;`, `javascript&colon;`), every C0 control and space both leading and
interior, `xlink:href`, `<set>`, `animate` `to`/`from`/`by`, a payload in the third
`;` segment, and an empty first segment are all neutralized.

But three payloads sail straight through, because `sanitize_html_attributes` only
ever filtered _attribute values_ for two pseudo-protocols and has nothing to say
about dangerous _tags_:

```html
<iframe src="data:text/html,<script>alert(1)</script>"></iframe>
<iframe srcdoc="<script>alert(1)</script>"></iframe>
<form action="data:text/html,<script>alert(1)</script>">
  <button>go</button>
</form>
```

`jQuery.parseHTML(..., keepScripts=false)` drops `<script>` elements but not
iframes, so these survive `sanitize_html_safe` intact. **`components/html-ssr.tsx`
is not affected**: it has a tag allowlist, restricts `iframe` `src` to
`IFRAME_HOSTNAMES` (YouTube/Vimeo), and does not allow `srcdoc` at all
(`components/sanitize-html.ts:78,89,100`).

**CONFIRMED EXPLOITABLE 2026-08-28.** Harald reproduced both payloads firing in a
real chat message in local dev. This is a live cross-user XSS in cocalc-ai, not a
theoretical gap, and it is pre-existing — nothing to do with the #8724/#8733 port.

**Root cause: the sanitizer is not wrong, it is switched off.** With sanitization
enabled, `components/sanitize-html.ts` blocks both payloads — `srcdoc` is not in
`ALLOWED_ATTRIBUTES.iframe` (`:99`), and `iframe` `src` must pass
`isAllowedIframeSrc`, i.e. YouTube/Vimeo only (`:89`, `:161`). But
`components/html-ssr.tsx:110` puts that whole branch behind `if (!noSanitize)`, and
`project/page/content.tsx:318` sets **`noSanitize: true` unconditionally** for every
`editor-*` tab, with its own comment: "TODO: temporary for backward compat for now".
So everything rendered inside a project page — chat messages, chat edit history,
markdown, notebook output — renders with sanitization disabled.

**Fix options**, in increasing order of blast radius:

1. **A floor that applies even when `noSanitize` is set** — always drop `srcdoc`,
   iframes whose `src` is not allowlisted, and the other script-executing tags
   (`object`, `embed`, `form action="data:..."`), while still letting trusted
   content keep its classes and styles. Surgical, preserves the backward compat
   the TODO is protecting, and is what actually closes the hole.
2. **Scope `noSanitize` to file content**, leaving chat — which is cross-user —
   sanitized.
3. **Remove `noSanitize: true`.** Correct in principle, but this is the flag's
   entire reason for existing: Jupyter HTML output and similar rich content would
   lose the classes/styles `sanitize-html.ts` strips.

Option 1 is the recommendation: small, needs no policy decision, no rendering
regression. Options 2 and 3 are the real cleanup and belong with §8.

This also settles the `chat/history.tsx` question from §9's work order: its
`sanitize_html_safe` pre-pass does not help against this either, since that helper
only filters attribute _values_ for two pseudo-protocols and says nothing about
tags. It is still load-bearing for protocol payloads, but it is not a defence here.

It is also the strongest argument yet for §8: the legacy path is not merely
redundant, it is materially weaker than the renderer meant to replace it.

### 9b. OPEN: the prose false positive

Still real, now recorded by a test that asserts the current (wrong-ish) behaviour:
an attribute whose value reads "JavaScript: …" is deleted, including `title` and
`alt`. It fails safe — text is lost, nothing is executed — so it is not urgent.

Fixing it properly is a **sanitizer-policy** question, not a one-line patch, and
the obvious shapes each have a catch:

- allowlist of url attributes — **unsafe**, see §9a;
- denylist of never-resolved attributes (`title`, `alt`) — keeps the default
  "check everything", so it is safe in a way §9a is not, but it is a guess about
  which attributes browsers will never resolve, and that set is not fixed;
- match the browser's actual URL-scheme grammar instead of over-approximating
  (upstream strips _all_ whitespace anywhere, where a browser only strips leading
  C0/space and removes tab/CR/LF) — narrower and principled, but a behaviour
  change to the security-relevant matcher.

The right time to settle it is when the jQuery pipeline is retired (§8), since
`components/sanitize-html.ts` already has to answer the same question for
`html-ssr` and should not answer it twice.
