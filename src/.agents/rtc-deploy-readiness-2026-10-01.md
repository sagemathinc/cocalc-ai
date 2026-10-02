# Realtime Collaboration: Deploy Readiness (2026-10-01)

Goal: make CoCalc realtime collaboration rock solid, and know that it is.
This page is the checklist for deciding to deploy #751 + #760 with the
patchflow fixes. Details are in the two plans:
[Markdown](./harden-realtime-collaborative-editing-plan-2026-09-30.md),
[Jupyter](./harden-jupyter-collaborative-editing-plan-2026-09-30.md).

Legend: ✅ done and verified · 🟡 partly done · ❌ not started · ⛔ deploy blocker

## What is in flight

| PR | What | State |
|---|---|---|
| patchflow #10–#15 | Snapshot-before-patch fix, value hashes, merge performance (notebook stall), same-word typing merges | ✅ merged, released as **0.10.0** |
| patchflow #16 | Merge commits record their merged value, so changing merge3 later never changes history; histories written by 0.8 (production) keep their values | open |
| cocalc #751 | Markdown/Slate hardening, fuzzer, replay kit | draft; on patchflow `^0.10.0` |
| cocalc #760 | Jupyter hardening, notebook fuzzer, browser meeting tests, ipynb import fix, stores merge commits' merged value | draft; on patchflow `^0.10.0`; the merge-commit storage commit waits for the release with #16 |
| cocalc #827 | Parallel dev build (bundles, ncc, tools): `dev:hub:build` 6 → 3.3 min | open |

lite2b runs #751 + #760 with patchflow 0.10.0 (deployed 2026-10-02).

## 1. Monitoring: will we know?

| | Item | State |
|---|---|---|
| ✅ | Value hashes: any client that computes a different document than its author reports it (log, hub client error log, `inconsistency` event, counter) | in #11 + #760 |
| ✅ | Snapshots are only written when their value matches the hash; a bad snapshot is reported and not used | in #11 |
| ✅ | Reading `inconsistency` reports: `cocalc admin db query` (after `cocalc auth elevate`) over `client_error_log` where `error like '%sync-inconsistency%'`; an agent can investigate them | no dashboard needed |
| ❌ | An alert when reports appear | |
| ❌ | Counters for: notebook file imported over a live notebook, own-save import skipped, merge time p99, words lost on reload | debug events exist (`jupyter_run_debug`), not production telemetry |
| ❌ | Workstream 4 guards: refuse a suspicious automatic save (reverts a just-received remote patch, duplicates a large block) and resync | not built; hashes detect divergence, not every bad edit |

## 2. Audit and bug fixes

Fixed (each with a regression test):

- ✅ Core merge: exact three-way merges over the patch DAG (patchflow #2, #4, #6, #8) instead of fuzzy patch application. Pomegranates-style anomalies resolved.
- ✅ Markdown integration: 7 fuzzer-found bugs (base tracking, stale `syncCausedUpdate`, canonicalized base, fuzzy rebase, deferred-merge reverts, render candidates), caret mapping, Slate whitespace normalization saved as an edit.
- ✅ Notebook: merge-patch storm, cell-editor races, db `merge3`, ghost cells.
- ✅ Snapshot-before-patch duplication cascade (patchflow #10).
- ✅ Notebook stall in long meetings: cache bound and exponential recomputation (patchflow #12), faster record lookup.
- ✅ A reloading tab imported the `.ipynb` over newer live edits (#760, 97ea318a1d).

Known open issues, in order of importance:

| | Issue | Impact | Plan |
|---|---|---|---|
| 🟡 | Typing in the last ~0.5 s before a reload or tab close is never sent | 7–8 words per 30-min 10-tab test (with heavy reloads) | `pagehide` flush + localStorage of unconfirmed patches (designed, not built) |
| 🟡 | Every open tab writes the `.ipynb`; tabs react to each other's saves (save storm, half-written reads) | wasteful; was a source of imports, now guarded | one writer (backend or elected tab) |
| 🟡 | 10 people typing concurrently in one notebook: merge cost grows with many concurrent heads | stall in the 10-typist test; 3 typists + 7 observers is fine | acceptable for now (10 simultaneous typists is unrealistic for a notebook); revisit merge of many heads later |
| 🟡 | Markdown: remaining "removed by a Slate commit" losses (serializer canonicalization treated as an edit), ordered-list start numbers, `slateDiff` math delimiters in some list/table transitions | ~1.75% of extreme 400-seed sweeps | Workstream 3 (edits carry their base version) |
| 🟡 | Two people inserting at the same spot can split a word | rare, visible, nothing lost | caret/merge tie-break |
| 🟡 | project-host server-side notebook flush does not record its saves | rare (explicit flushes only) | record via runtime state |
| ❓ | One import that erased a word at 314 s in a run cut short by a spot reboot | not reproduced in 3 later runs (0 unrecognized files in 190 reloads) | `watch.load.not_own_save` debug event in place |
| 🟡 | 18 failed reads of a half-written `.ipynb` per 30-min run (tabs reading while another tab saves) | harmless now (no import), but wasteful | single writer |

## 3. Fuzz testing

| | Item | State |
|---|---|---|
| ✅ | Markdown/Slate multi-client fuzzer with token oracle (real `EditableMarkdown`, real patchflow sessions, seeded network) | in #751; pinned seeds run with the test suite |
| ✅ | Notebook multi-client fuzzer (real notebook codec, backend writer, structural edits) | in #760; 60 seeds clean |
| ✅ | patchflow property/fuzz tests: merges, undo (300 sessions), snapshots, value hashes | in patchflow |
| 🟡 | Large random sweeps on a schedule (nightly) | run by hand; not scheduled |

## 4. Integration harnesses (real browsers)

| | Item | State |
|---|---|---|
| ✅ | Playwright meeting tests on a Lite server: Markdown (rich, source, mixed views) and notebook, N users, reloads, token oracle, inconsistency counting | in #760 |
| ✅ | Passive observers (`COLLAB_OBSERVERS`) and disk-load logging (`COLLAB_LOAD_DEBUG`) | in #760 |
| ✅ | Markdown, 10 users, 15 min with reloads: 0 duplicated, 0 inconsistencies; losses only unsent-before-reload | measured |
| ✅ | Notebook, 3 typists + 7 observers, 10 min, 3× reloads (81): 0 erased, 0 inconsistencies; losses only unsent-before-reload | measured after the import fix |
| ✅ | Notebook, 3 typists + 7 observers, 30 min, 86 reloads, after the import fix: 7 recorded saves skipped, 0 imports over the live notebook, 0 erased, 0 duplicated, 0 inconsistencies; the 7 lost words were never sent (typed just before a reload) | measured |
| ❌ | Network faults (CDP throttling/offline), mixed old/new client versions in a browser | not done; patchflow has an opt-in mixed-version test |
| ❌ | Run the browser suite on a schedule | manual on bench-1 |
| ❌ | Whiteboards, slides, tasks, chat in the browser suite | headless coverage only |

## 5. RTC algorithm semantics

| | Item | State |
|---|---|---|
| ✅ | Exact merge from maximal common ancestors; concurrent heads merged deterministically | patchflow 0.9.x |
| ✅ | Merge policy: no fuzzy relocation, word-level, an edit beats a concurrent delete, conflicts keep both | patchflow #2, #8 |
| ✅ | Value hashes on every patch and snapshot | patchflow #11 |
| 🟡 | The values of a history never depend on the merge algorithm: a merge commit records its merged value (like a git merge commit records its tree), so merge3 can still be improved after deploy | patchflow #16 + #760 |
| 🟡 | Production histories (patchflow 0.8, no hashes) keep the values their authors saw: their merge commits are read the way 0.8 computed them. Replay of this project's real histories: 0.10.0 changed 306 of 4,342 checked chat/notebook patch values, #16 reproduces every one of them, except 32 in `lite2.chat` where 0.8 started from a snapshot taken after concurrent edits (29 of its 115 snapshots), which drops those edits; there #16 gives the value of the full history | patchflow #16 |
| 🟡 | Edits carry their base version; canonicalization is not a user edit (Workstream 3) | not started; addresses remaining Markdown losses |
| 🟡 | Single authority for the notebook file on disk | see open issues |

## Deploy blockers (⛔) and recommendation

Before deploying:

1. ✅ patchflow 0.10.0 released; #751 and #760 bumped.
2. ⛔ Merge patchflow #16, release, bump #760 (its merge-commit storage commit is ready).
3. ⛔ Merge #751, then #760 (rebase #760 onto main after #751).
4. ⛔ Old and new clients during rollout: force all browser clients to reload on deploy. (With #16, a new merge commit's `patch` keeps its old meaning, so an old client still reads it as before.)
5. ✅ `inconsistency` reports are readable with the admin CLI on day one.

Not blockers (deploy, then fix): unsent-on-reload loss, single ipynb writer,
many-typist merge cost, Workstream 3, Workstream 4 guards, scheduled suites,
an alert on inconsistency reports.

Recommendation: deploy once 2–4 are done. The remaining issues are rarer and
less severe than what production has today (fuzzy merges that duplicate and
lose text, no detection at all), and the value hashes mean anything new will
be reported instead of silent.
