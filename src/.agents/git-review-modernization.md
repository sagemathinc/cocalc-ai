# Git review modernization

Status: implemented and validated on September 8, 2026. Pierre completely
replaces Classic across the planned diff surfaces. The implementation, live
acceptance, regression and packaging evidence is indexed in
`git-review-release-audit.md`. Hosted CI run `34189093152` passed all jobs for
implementation commit `fcbb10d077`. Definition lookup remains future work.

Maintainer decision (September 7, 2026): after the compatibility checks pass,
completely replace Classic with Pierre. Remove the Classic rendering path,
renderer selector and experimental preview; do not retain a rollback option or
release window. Preserve all reusable review logic and rich non-diff viewers.
This supersedes earlier chronological notes about a default/rollback period.
The maintainer describes this as effectively greenfield developer functionality,
with little existing adoption. Do not build a staged dual-renderer product for
an assumed installed base. Prioritize a coherent worktree-aware review tool,
while retaining correctness and personal review-data preservation checks.

## Current completion audit (2026-09-08)

The dated progress notes below are chronological; an old "pending" statement is
not a current checklist. The implementation objective is complete. The release
audit records the accepted scope, validation, and residual observations;
repository-wide absolute startup budgets are not claimed to pass. PR #420
contains the implementation; production merge/deployment remains a maintainer
action, not an automatic action taken by this goal.

Latest acceptance and residual observations (September 8):

- Archived originating-context acceptance passed in three consecutive fresh
  Chromium tabs with native keyboard activation, correct archived working
  directory, synchronized URL, a rendered Pierre diff, and no page errors.
  The synthetic fixture deliberately has a different current thread directory.
  Its disposable registered worktree was removed after the checks. The harness
  now waits for chat connection/hydration before testing the commit link, so an
  application still showing Connecting is not misreported as Git navigation.
  Evidence: `/tmp/cold-context-ready-{1,2,3}.log`. This closes the current
  originating-context acceptance gap, without claiming a root cause for the
  earlier unreproduced disappearance.
- The latest 768px light/dark review and selectable-comparison run passed
  (`/tmp/current-review-acceptance.log`), in addition to the two explicitly
  filtered endpoint runs described below. Retain bounded diagnostics for the
  earlier intermittent loading observation rather than asserting it was fixed.
- Commit details now remembers expanded/collapsed state in localStorage.
  Native keyboard toggling, commit switching, and reload pass in the live
  browser; storage failure and commit remounts pass in component tests. All
  remaining native Git review checkboxes now use Ant Design; 15 focused
  history, comparison and worktree-consent tests and frontend lint pass.
- Hosted run `34187801215` passed plan, checks, build, frontend tests and the
  rest-package lane; its server lane was cancelled. The new head has a new run,
  so this is useful prior-head evidence, not a claim of all-green current CI.
- Current local Git review, shared diff, TimeTravel and Git service regression:
  276 tests in 50 suites passed after the details/checkbox changes. Frontend
  `pnpm tsc --build` also passed. Activity producer/renderer coverage is recorded
  separately below and is not included in this 276-test count.

- Message anchor navigation follow-up: `gotoFragment` now publishes the
  message target into frame data without rewriting URL parameters, and the
  thread-selection hook persists its resolved thread rather than allowing
  later metadata hydration to restore the previous selection. Nine focused
  tests pass. The live `branch-review-live.browser-test.mjs` subsequently
  passed against `x.chat#chat=1788832135399` with no manual source-thread
  override: the commit link selected `test-worktree`, its URL contained that
  ref and working directory, and the selectable comparison produced a pinned
  comparison route. This closes the reported message-anchor selection case,
  not the separate intermittent cold-link lifecycle observation below.

- Comparison loading investigation: the 768px layout run against `3365e543`
  in the main checkout timed out waiting for branch history; the rendered
  status remained `Loading...`, before comparison endpoints could be selected.
  A preceding run reached comparison review but had no rendered file header.
  The test now captures rendered page text on failure. Do not conflate this
  unresolved loading issue with Pierre rendering or the verified reading
  viewport fix. The separate worktree comparison acceptance still passes.
  Follow-up instrumentation in an isolated tab measured discovery, HEAD
  resolution and history completing in about 201ms total, with no queued
  requests; the explicit `6057d353ea` to `3365e54323` comparison rendered 12
  files. Two subsequent fresh-tab runs with those explicitly filtered endpoints
  passed both themes. No root cause is claimed for the earlier transient stall.
  Inspection found a separate selection-reset bug: disabling controls while
  editing reloaded history and cleared both endpoints. Loading no longer depends
  on that editing lock, while a separate generation invalidates pending applies.
  A regression verifies endpoint retention and rejection of a late comparison
  after an edit-lock cycle. The wider pre-fix regression passed 273 tests in
  49 suites; the three focused comparison tests passed after the fix.

September 8 latest regression: 130 tests in 35 suites passed across Git drawer,
shared diff viewer, Git read service, and TimeTravel modules. The reading-view
layout now hands downward wheel/keyboard motion to the outer drawer before
scrolling Pierre, and Home returns to setup. Live light/dark checks passed,
including a multi-file commit at 768px viewport height. This is not a substitute
for the outstanding comparison-loading investigation above.

- Intermittent cold originating-link behavior: the archived-directory fixture
  and subsequent route tests pass, but an earlier disappearance and transient
  missing URL were not reproduced with a demonstrated production root cause.
  Keep the bounded navigation diagnostics rather than claiming this fixed.

Branch-first UX follow-up (September 8): message links carried a turn directory
hint that incorrectly disabled unique-worktree lookup. Treat this as an origin
hint, retaining explicit restored-history selection. Commit `01cab683` was
confirmed by Git to exist only in `test-worktree`; clicking its message link
now selects `/home/user/test-worktree` and `refs/heads/test-worktree` in live
acceptance. Selected commits outside the loaded log use their loaded subject
instead of a generic label. Branch selection immediately loads its pinned
history and uses a matching checkout when available; branches without checkouts
remain browsable. Comparison now offers a branch and two searchable commit
selectors with older-history pagination, comparing exact trees. Raw refs,
merge-base and parent selection remain under Advanced. Live commit selection
and comparison passed after explicitly choosing the source chat thread.

Cross-worktree execution verified (September 8): review feedback created thread
`7ca2b76d-c919-4a75-8eee-919527a1a019`, Codex session
`01a07ea4-c45b-73a1-bba9-3314feda0f6b`, with cwd
`/tmp/cocalc-review-worktrees-Cq4gOf/first`. Archived terminal events show `pwd`
and Git repository/HEAD checks executing there, exiting 0, with the worktree
path and expected HEAD in their output. The agent reported no file changes.
The disposable worktree was cleaned up after terminal completion. The initial
test assertion incorrectly required stdout to contain only the path; the
agent legitimately combined `pwd` with the requested Git checks. The harness
now correlates the successful output with the same terminal's `pwd` command.

Historical commit headers now expose More > Edit in this worktree when the
selected working copy is available, separately from historical revision views.
Live opening verified the selected worktree path, not the main checkout. Both
working-copy and history-ref selectors now support filtering by their labels.
The complete live worktree suite subsequently passed, including a second real
agent execution (thread `5afc7e55-b815-4493-9c28-5c823195e002`), historical and
current file opening, ambiguous/absent worktree notices, and moved-ref pinning
across reload until explicit refresh. Frontend typecheck, lint, and 54 focused
Git drawer tests passed for this change-set.

The standard live route suite was rerun against the current deployed build and
passed deep-link opening, selection, reload, Escape, Back/Forward, preservation
of unrelated parameters and absence of page errors. This does not substitute
for the cold originating-link case above. The remaining scope is still the
complete acceptance matrix below, not just these live checks.

Maintainer live acceptance (September 8): session
`01a07973-b604-7a00-b1d0-ec91e82a0520` in `x.chat`, thread
`e4dfbb94-1595-46d2-9f83-cd78f96eacbd`, message
`092d4110-2001-4c7a-bcaf-8f7de421a0e6`. The typed activity API confirms
persisted config cwd `/home/user/cocalc-ai`, an added-file source for `primes.pl`,
a sparse two-hunk unified source for `primes.py`, and terminal completion with
exit code 0 (Python/Perl outputs compared successfully). The maintainer confirms
the activity file diffs render nicely, the checkboxes work, and dark mode works.
This closes the missing completed activity-diff visual fixture gate. It does
not establish cross-worktree dispatch or a fix for intermittent cold links.

| Requirement                              | Current evidence and remaining work                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git/worktree/ref and comparison browsing | Facade, selectors, pinned endpoints, historical Git file loader, URL routes, and disposable real-Git tests exist. Live detached-worktree unique/ambiguous/absent cases, moved-ref pinning, and exact working-copy file opening in both renderers passed (details below). Actual agent dispatch remains a separate acceptance case.                                                                                                         |
| Review preservation                      | V2 adapters, comparison revisions, import recovery and account-scoped alias choices are implemented. Live independent/same-ID comment recovery, draft-alias choice, actual WebSocket disconnect/reconnect, and conflicting private-note reconciliation checks passed. Existing keys and recovered note alternatives remain intact. Details and test boundaries are recorded below.                                                         |
| Navigation and copy                      | Trees, sticky headers, keyboard handling, source-side copy, loaded-patch copy, search maps, and semantic scroll adapters are wired. Live drawer close/reopen preserves the source position within a few wrapped lines. Native mouse selection and exact clipboard copying across virtual windows passed after stabilizing Pierre options; retain those checks through Classic removal.                                                     |
| Rich comments                            | Active editors live outside recyclable rows. Real delayed HTTP upload, image rendering, undo/redo, theme changes, two-window inline recovery, simultaneous note/inline editor focus, and network reconnect passed.                                                                                                                                                                                                                         |
| TimeTravel                               | Live Git, patchflow, snapshot and backup comparisons passed through both renderers. Guarded rich Markdown restore tests passed for all four sources, preserving previous history (details below). Both rename sides and deleted-file viewing passed in Classic/Pierre.                                                                                                                                                                     |
| Agent context/activity                   | Validated worktree dispatch, immutable comparison prompts, retained sparse patches and bounded read/write observations are implemented and tested. Live UI submission created a separate thread with the selected worktree in both persisted thread config and Codex activity config. Execution stopped at the connected account's usage limit; actual command execution and originating-context links still need end-to-end confirmation. |
| Performance/theme/packaging              | Real Chromium fixtures cover themes, layout, worker failure/cleanup, native operator copying, an 18,001-line multi-file benchmark, a 19,000-line single file, and 128 KB minified lines. Production baseline deltas and eager-import guards are recorded below. Full-app appearance/editor and strict native-copy checks passed. Measured main-thread heap excludes worker heaps.                                                          |
| Default and cleanup                      | Git review, TimeTravel text comparison, and activity diffs now use Pierre only. Classic renderers, selectors and the experimental preview are deleted. Old activity entries without trustworthy source retain an explicit raw-data disclosure, not a second renderer. Final integration audit remains.                                                                                                                                     |

Browser access: local signed-in Chromium now exposes CDP on port 9222
(Chrome 149.0.7827.196), replacing the laptop forward. Earlier live checks
used Chrome 151.0.7922.71. Do not
use automatic account login inside this collaborative project or bypass its
credential-storage safeguard.

Continue live acceptance using the signed-in forward. Check these in
the actual application, not the service/Slate-stubbed harness:

1. Open the same review in two browser windows. Save independent comments,
   reconnect, and verify neither is lost; exercise an alias conflict and its
   explicit choice without modifying the alternative record.
2. Paste an image into a Slate review comment, scroll while uploading, then
   return, edit and undo. Change renderer/layout/appearance and close/reopen;
   verify draft content, image rendering, focus, and semantic scroll position.
3. Browse unique, ambiguous and absent-worktree history, then move a ref and
   verify pinned endpoints. Explicitly submit feedback to the chosen worktree
   and confirm the resulting agent thread uses that directory.
4. Compare Git, patchflow, snapshot and backup text versions in TimeTravel;
   verify rich historical viewers and source-specific restore behavior still
   work. Check both sides of a renamed/deleted file.
5. Verify activity provenance links and native partial selection while
   scrolling a long diff. Investigate any recurrence of the empty clipboard
   with the recorded copy-event selection diagnostics.

Only after these checks should the approved complete replacement proceed.
Missing live test evidence does not establish that these checks pass.

### Restored live-session checks

Source-change recovery audit: the shared activity/TimeTravel error boundary
previously remained failed after selecting different inputs. It now resets on
source changes only; healthy children are not keyed/remounted. The regression
checks retained healthy mounts, unchanged-input failure retention and recovery
with a changed source. Draft PR #420 remains open; its current check rollup has
only a skipped Codesmith check, not a successful hosted CI test run.

The September 8 combined regression passes 323 tests in 51 suites, covering
Git/review, shared diff, TimeTravel and activity modules. A new Pierre-only
live reconnect run also passed using disposable commit object
`2009f3cafd20d50f9fcaf768b18aec76b7a3f54c` in the remote acceptance repository.
No branch, index or working file was changed. The test left two private fixture
comments, interrupted only its second tab's real WebSockets, observed rejected
reconnect attempts and editor retention, then verified actual reconnection and
both comments after resave/reload and recovery-draft removal. This closes the
post-Classic-removal reconnect gap, not the separate quota-blocked agent gate.
Cleanup inspection removed obsolete Classic-recovery advice from renderer
failure and comparison-limit messages; a boundary regression covers the
available recovery wording.

Activity provenance audit found the last terminal/file cwd was applied to every
row in the log, redirecting earlier relative diff links. Context is now computed
chronologically: config changes set the agent directory, and terminal/file cwd
applies only to that event. A rendered activity regression verifies the earlier
diff link and its open-file action before/after a later terminal event arrives;
pure tests cover config boundaries, missing context and literal directory names.
This is component evidence, not yet a live activity-provenance acceptance pass.
Structured diff paths now also bypass prose fragment/line-suffix parsing and
slash/whitespace rewriting. Rendered open-file tests cover hash characters,
colon-number suffixes, backslashes and trailing spaces, including a trailing
space in the recorded worktree directory. Prose-path parsing remains unchanged;
the older HOME-relative producer compatibility rule remains in place.

September 8 follow-up: history has an immediate, remembered "Show merge commits"
checkbox, defaulting to hidden. Git filters merges before pagination rather
than filtering an already limited page. The option is independent of first-parent
traversal and does not replace the selected revision; direct merge links remain
valid. Focused tests cover keyboard toggling, preference storage failure, both
ancestry modes and real-Git filtered pages.

Cold originating-link probes now retain a bounded navigation trace on failure.
A correctly uploaded new scratch fixture passed. Another rendered the expected
worktree and diff but failed an immediate URL assertion; subsequent fresh-tab
runs passed. The assertion now waits for asynchronous URL synchronization, but
this is not evidence that the earlier disappearing drawer is fixed. No
production navigation change was made from this inconclusive observation.
The temporary archived-context worktree was removed after these checks.

Combined frontend Git/review/diff/TimeTravel regression run passed 259 tests
in 44 suites after the Pierre-only cleanup. Originating-context browser
acceptance uses an explicitly synthetic scratch chat, whose current thread cwd
is `/home/user`, referencing the existing terminated acceptance turn's archived
config. A temporarily restored detached worktree at that archived path allowed
the test to verify actual Git browsing without running an agent. Two fresh-tab
keyboard-link runs selected the archived directory and displayed Pierre rather
than using current settings. The worktree was removed afterward; the synthetic
`scratch/git-turn-context-acceptance-c39e95e2.chat` fixture remains.

The first probe lost its drawer after observing the expected directory, before
the diff became visible. Two reruns passed without a production change, so this
is not explained or claimed fixed; cold fixture/navigation lifecycle remains
an audit item. Inspection also found parent and drawer entry points trimming
literal directory overrides. Both now preserve the path, with an explicit
drawer-origin regression; the focused context suite passes 20 tests.

The real-agent retry created thread `2638a887-a81f-4db3-92b5-2a3e86bd69a6`
with directory `/tmp/cocalc-review-worktrees-tAjlSl/first`, then terminated at
the connected account's OpenAI usage limit (reset September 13, 2:51 PM).
No command execution was verified. The fixture was cleaned up after that
terminal error. Do not repeatedly submit against the same known quota limit.

Originating-context inspection found message commit links still used current
thread settings. They now prefer a config event from that turn and fetch its
archived log on explicit opening when the preview omits config. Reads use the
existing project Conat connection, not a new hub proxy or app-server startup.
Transport errors remain visible instead of silently redirecting; stale click
results are ignored. Old entries with no recorded config retain the existing
fallback hint. Nineteen focused context tests pass, including immutable values,
literal paths, omitted-preview config and transport failure. Live link opening
with changed thread settings remains an explicit acceptance case.

Selector-free browser acceptance passed for semantic drawer close/reopen,
both renamed-file sides and a deleted file, and the disposable-worktree matrix.
The scroll harness now intersects candidate rows with the actual browser
viewport, not just the nested scroll region: the same source line returned at
426.75px versus 426.35px before closing. Historical tests compare source contents
with remote `git show`, prove read-only behavior, and verify keyboard dismissal
and focus restoration. They explicitly scroll the target into view rather than
treating off-screen DOM visibility as keyboard usability.

The worktree matrix passed unique detached selection and exact working-file
opening in Pierre, ambiguous/absent cases, and moved-ref pinning across reload
until explicit refresh. Temporary worktrees/ref were cleaned up and the original
worktree listing restored. This run did not request the separate agent check.
The affected browser scripts no longer switch to Classic; frontend lint and
diff whitespace validation passed.

Activity diffs now render Pierre directly with no renderer selector. Removed
the Classic activity row renderer and its Prism dependency from the activity
module. Old/malformed entries that cannot supply trustworthy source coordinates
show an explicit warning and a keyboard-accessible raw-data disclosure, retaining
their recorded fields without inventing a file or offering another renderer.
This supersedes earlier notes about Classic-only old events. The focused activity
and source tests passed 51 cases, including literal text preservation and
keyboard disclosure; frontend typecheck, lint and development build passed.
Reconnect and worktree-agent browser entry points now wait for Pierre directly;
only syntax checks were rerun for those two harness changes in this step.

Deleted the now-unused Classic `DiffBlock`/`DiffFileSection` implementation,
its test-only drawer exports and implementation-specific tests. Deleted the
experimental Pierre preview, trigger and prototype-only tests/harness; reusable
production diff components remain. The focused drawer/Pierre/header suite
passed 73 tests, with frontend typecheck, lint and development build passing.
The live deep-link test now targets the actual Git diff region and asserts that
both renderer selector and preview trigger are absent. Commit selection,
reload, Escape, Back/Forward, unrelated URL parameters and no-page-error checks
passed. Activity rendering and remaining switch-based browser harnesses still
need cleanup; this is not the full completion claim.

The Git drawer now loads Pierre directly with no renderer selector. Removed
the Classic virtualized panel and renderer-switch scroll implementation; Pierre
retains its own semantic restoration and working-patch generation scopes.
Obsolete Classic panel tests were removed rather than retaining a test-only
renderer. The remaining drawer/Pierre tests (77), header keyboard tests (4),
frontend TypeScript build, lint and development build passed. Live native
partial-text copy passed in four virtual windows, and simultaneous real Slate
note/inline focus, scrolling and Light/Dark checks passed on the sole-renderer
build. Further cleanup still includes the unused Classic diff block and its
test exports, older browser harnesses that switch renderers, and the preview.

TimeTravel text comparisons now use Pierre exclusively. Removed the Classic
component, its CodeMirror diff helper/tests, and the renderer selector. Rich
historical viewers and restore actions are unchanged. The focused test,
frontend TypeScript build, lint and development build passed. Read-only live
comparisons passed for Git, patchflow, snapshots and backups with no selector,
no CodeMirror diff, no restore action in comparison mode and no page errors.
The external Markdown fixture had only one backup, so backup comparison used
the multi-version `src/package.json` fixture instead; no new archive was needed.

Simultaneous-editor/focus check passed with `REVIEW_FOCUS=1` in the real Slate
smoke script: private-note and inline-comment editors were both mounted, native
CDP text input went only to the focused editor, and independent content survived
scrolling and Light/Dark changes. After returning, focus transferred back to
the note and further input did not alter the inline comment. Both edits were
cancelled without saving. The first probe selected an unrelated Edit button;
scoping it to the private review card fixed the harness ambiguity.

Live reconnect recovery passed with `REVIEW_RECONNECT=1` in
`inline-concurrency-live.browser-test.mjs` on disposable commit
`4c4402247549c991c3edb1f9ddb7a0b73c3e20b5`. Only the second tab's WebSockets
were routed, forwarding real server traffic unchanged. Existing sockets were
closed, at least one retry was rejected, and the real Slate editor retained its
text. After reopening transport the save settled; reload and resave retained
both independently authored comments, including another reload after the
local recovery draft was cleared. This verifies tab transport loss/reconnect,
not a hub restart or whole-machine network partition. The first attempt hit
the development warning overlay; a later attempt's fixed stale-error assertion
was inappropriate for the reconnect outcome. The final test instead requires
settled saving and exact durable content. Small disposable fixtures remain.

Live private-note recovery passed with `REVIEW_NOTE_RECOVERY=1` in
`review-concurrency-live.browser-test.mjs` on disposable commit
`dc94e484ef3665b80c47f89b3942d80c5cd52d92`. Two real application tabs loaded
the same empty review. The first saved; the second's stale save was rejected
while retaining its Slate draft. Reload exposed both notes, then saving a
reconciled note and reloading again retained both originals in the read-only
recovery section. The small fixture is intentionally retained; no existing
branch, worktree or user review was changed. Lint and script syntax checks pass.
This closes the live note reconciliation case, not the separate network
disconnect/reconnect gate.

Native-selection fix: pointer diagnostics reproduced replacement of the selected
text node during interaction. The Pierre React wrapper compares options and
forces a render when they change; our fresh onPostRender callback and metrics
object changed on incidental renders. Memoizing the options by their actual
inputs preserves the DOM during selection while still updating font, layout,
theme and search. A focused test checks identity across selection and parent
rerenders and invalidation for font changes. The real native mouse/Ctrl+C test
then passed at four scroll positions on Chromium 149, with the original source
node retained and exact expected substring copied. Eight panel tests, typecheck,
lint and the development build pass. The probe measures the selected substring's
rectangle so wrapped full lines do not incorrectly disqualify visible text.
This closes the reproduced native partial-selection failure; it does not claim
unloaded lines can be selected across a virtualization gap.

Local Chromium native-copy follow-up: the probe now explicitly sets its page
viewport (BrowserContext.newPage does not accept viewport options), scrolls the
diff region onto the screen and dismisses the development stale-build banner
through its accessible button in its own tab. Diagnostics proved that the
previous coordinates were below the screen or covered by that banner. After
those corrections the hit target is a Pierre source span, but native dragging
still produces an empty or overlong selection rather than the expected partial
substring. The probe remains failing/unverified; do not call this a clipboard
handler bug until selection stability and browser behavior are isolated.
No production behavior was changed in this diagnostic follow-up.

Private-note recovery follow-up: regression tests reproduced timestamp selection
dropping the other note from the recovered record. Recovery now retains distinct
private `note_versions`, including empty notes, without changing the existing
active-note selection policy. Versions survive resave, export and import; repeat
recovery deduplicates them. A collapsed, keyboard-accessible "Recovered private
note versions" section exposes the alternatives as read-only Markdown for manual
reconciliation in the existing note editor. They are not inline comments and
are not sent to agents. Both timestamp orders, image Markdown, empty notes,
persistence and keyboard/read-only behavior pass in 39 focused tests; frontend
typecheck, lint and development build pass (Rspack 3.28 s). Live two-window note reconciliation remains to be
checked when the signed-in Chrome forward returns. This is preservation, not
an automatic three-way text merge or a claim to infer author intent.

Disconnect storage follow-up: focused tests inject failure before a conditional
write and after storage commits but before its acknowledgement arrives. Both
retain the exact local draft, including image Markdown. An old-sequence retry
after a lost acknowledgement is rejected; reload and resave retain exactly one
comment and clear the acknowledged draft. All 31 store tests, frontend typecheck
and lint pass. These are simulated transport failures at the store boundary,
not live browser reconnect evidence. The latest continuation independently
rechecked port 9222; `/json/version` still timed out after five seconds.

Upload-in-flight follow-up: `REVIEW_IMAGE=1 REVIEW_UPLOAD_DELAY_MS=3000` in the
real Slate smoke script pauses the actual `/blobs?project_id=...` POST with CDP
Fetch interception in its isolated target. The request was confirmed paused;
after three seconds scrolled away, the same editor remained mounted with no
completed image. Releasing the POST produced the real blob image, which passed
scroll/theme/undo/redo checks. No review comment was saved. This closes the
previous short-upload timing caveat without replacing the uploader with a mock.

`native-copy-live.browser-test.mjs` is an unverified diagnostic probe, not a
passing gate. It uses native mouse dragging and Ctrl+C and overwrites a test
clipboard marker before reading output. An initial copy-event-only assertion
was invalid because browser-default copy text is not exposed there. Subsequent
pointer coordinates selected underlying chat text rather than the intended
source; hit-test validation was added. Before that revision could be checked,
the forwarded CDP port stopped responding (connect timeout and independent
five-second `/json/version` timeout). Do not count this as a viewer regression
or successful native-copy validation. The clipboard-read permission is restored
to its prior state by the probe's cleanup.

Alias-choice live follow-up: `alias-choice-live.browser-test.mjs` seeds guarded,
account-scoped full-hash and 12-character draft aliases for a disposable commit.
Native Enter on Use selected review selects the full-hash note; it remains
selected after reload. Both draft strings remain byte-for-byte identical.
Changing only the unselected draft and reloading reopens the conflict; choosing
that alias displays its changed note while preserving both strings. This passed
on `1563e4d67b27586fa00ffe4efb57b9d68662fb8a`. Cleanup removed only its known
unchanged fixture drafts; the tiny account choice metadata remains. The live
fixture exercises draft aliases and durable choice metadata, complementing the
store tests for persisted-record aliases; it does not mutate user review keys.

Same-comment recovery follow-up: without a common-ancestor snapshot, timestamps
cannot safely decide between differing same-ID bodies. Recovery now leaves the
persisted version unchanged and creates a stable-ID local alternative with
status `conflict`. The card labels it "Recovered local alternative" and explains
Edit/Resolve; draft-only agent submission excludes it until explicitly edited.
Repeated recovery reuses the alternative, and hash collisions retain additional
versions rather than overwriting them. Unique local comments also survive an
older overall draft timestamp. Existing note/reviewed timestamp policy is
unchanged. Tests cover both timestamp orders, collision handling, persistence,
idempotence and keyboard actions. All 104 focused tests, typecheck/lint and the
development build passed. The real two-window same-ID edit check passed on
`2214b54a4b37d4d95b84fb8aed2ec342c5d682d4`: stale edit rejected, reload showed
both bodies and the recovery label. These are retained alternatives, not an
automatic textual merge or a claim that every note-field conflict is resolved.

Independent-comment recovery follow-up: a focused regression proved that a
newer local draft replaced the entire persisted comment map on reload, dropping
independently created remote comments. Recovery and subsequent save-state
resolution now union IDs, retaining local precedence for IDs present in the
draft. The test covers load, save-state construction, resave and fresh load.
The expanded live two-window check passed on disposable commit
`70a21fd8c63075aa4b393b8bd5c5a52fe90246db`: stale save retained the editor,
retry retained its ID, reload showed both comments, and resave followed by
another reload retained both after local recovery storage was cleared. Ninety-
seven focused tests, frontend typecheck/lint and the development build passed.
This verifies independent additions with a newer draft, not conflicting edits
to the same comment or older-draft timestamp behavior; those and explicit alias
choices remain distinct recovery cases.

Inline conflict follow-up: the real two-window test reproduced an editor-loss
bug. `saveReview` returned false on stale-write rejection, but inline creation
and editing discarded that result and closed the editor anyway. The boolean
now reaches the submit handlers; they close only on success and only if the
same editor generation is still active. Creation retries reuse their comment
ID, preserving the local recovery entry rather than duplicating it.
`inline-concurrency-live.browser-test.mjs` failed before the fix when the error
was visible but the Slate editor had disappeared. After the fix it passed on
disposable commit `5514715c29062271765dd81648eacf9bfc04232a`: real editor/text
retained, repeated rejection did not create a second ID. Eighty focused tests,
frontend typecheck/lint, and the development build passed. Fixture comments and
local drafts remain for inspection. Reload/reconciliation is still a distinct
gate: inspect how independent remote comments combine with the retained draft,
rather than counting conflict rejection as proof that both are recoverable.

Agent dispatch follow-up: `REVIEW_AGENT=1 worktree-live.browser-test.mjs` uses
the chat thread's Git button (a direct review URL intentionally has no agent
binding), selects the disposable worktree, checks explicit consent, saves a real
Slate inline comment and submits it. The comment requests only `pwd`, with no
file changes. This created thread `9bf15c21-40b7-40cd-bab6-6ae12bc87cae` in
`x.chat`; persisted thread config and activity config both specify
`/tmp/cocalc-review-worktrees-xMX9YF/first`. Codex session
`01a07d5d-9554-77e1-b394-65517b18ee81` returned a terminal usage-limit error before
executing a command. Do not count this as successful execution. The small audit
thread and submitted comment remain. Ten focused routing/dispatch tests pass.
The harness preserves worktrees if completion is uncertain, and distinguishes
terminal errors from successful summaries. Further live execution needs an
account with available usage; unrelated acceptance can continue meanwhile.
After verifying the terminal quota error, the disposable worktree, temporary
ref (with expected-tip protection), and empty fixture directory were removed.

Working-copy opening follow-up: `worktree-live.browser-test.mjs` now populates
one text file in its disposable detached worktree and adds a working change.
The intentionally unpopulated files are marked skip-worktree in that temporary
index, avoiding an unrelated huge deletion diff. In working-copy mode, both
Classic and Pierre's Open action navigated to the exact selected worktree path,
not the original checkout. Historical commit mode intentionally offers the
pinned revision viewer instead of Open. Unique/ambiguous/absent selection and
moved-ref checks also passed in this run; cleanup restored the original worktree
list. This does not establish actual agent dispatch or editor content fidelity.

Historical side-opening follow-up: commit and comparison review now expose
"View before this change" when both pinned sources exist (under Pierre's More
file actions menu). The previous path/revision is selected explicitly, including
renames; an explicitly unavailable side never falls back to another source or
the working copy. The existing revision action still opens the new side, or the
old side for a deletion. The More menu has an overlay keyboard boundary and
returns modal focus to its persistent trigger. Native Enter required preventing
the remaining browser default action after rc-menu's keydown activation moved
focus; without that, the historical dialog did not stay open despite the action
callback running.

`git/historical-file.browser-test.mjs` can compare the displayed path, revision,
and full source with remote `git show` using `REVIEW_SOURCE_COMMIT` and
`REVIEW_SOURCE_PATH`; `REVIEW_SIDE=old` exercises the new action. Both rename sides
passed in Classic and Pierre against commit
`4bd4d826e83f64901f54761799bec53629beb9ea` and parent
`e696ab2aaba94cedb1a5765ccc51de7be5941cdc`. These checks include rich Markdown,
read-only source, native keyboard activation, Escape and focus return, and
unchanged review routing. Pierre also passed deleted-file viewing with exact
parent contents from `202bc869cf2774a6964ab8f687718383ab3ef7ae`. The Classic deletion fixture at
`50a46a2af102d80c97c2560117370a29831e7957` subsequently passed after correcting
file-dropdown navigation: it requested a smooth scroll to an estimated offset,
then list measurement increased the scrollable height from about 42,000 to
107,000 pixels while the scroll stayed at that obsolete offset. File selection
now requests an immediate jump, as Trees and search already do. Explicit Classic
navigation also cancels pending semantic/drawer restoration; a focused test
checks that a late completion cannot override the new destination. The live
historical test now activates its page before layout and verifies the trigger
is actually in the viewport, not merely mounted in overscan. No fixture files
were changed or restored by these historical-viewing checks.

Semantic scroll follow-up: `git/review-scroll-live.browser-test.mjs` switches
Pierre -> Classic -> Pierre and closes/reopens the actual drawer, checking the
first visible file/source line after layout settles. This exposed a real
Classic restoration race: Virtuoso retries file alignment after measuring newly
mounted items, overwriting a source-row scroll performed on the first frame.
Restoration now waits for `scrollIntoView` completion when materialization is
needed, retains user-input cancellation, and ignores late callbacks after
cleanup. Unrelated parent rerenders no longer restart the effect. Focused tests
cover delayed completion, cancellation, and rerendering during materialization.
Live checks passed on the fixture below; they allow three source lines of
wrapping/header variation, not arbitrary pixel or file movement.

The real application smoke script passed on the maintainer-provided `x.chat`
in project `1ce4fe78-19c7-40a8-a598-947975744cd9` at commit
`3365e54323ddcc71dda4fe8577cbfec75bdfb587`:

- Pierre gutter selection opened the real Slate editor. Its DOM identity and
  draft text survived scrolling away/back and explicit Light/Dark transitions;
  the draft was cancelled without saving. The maintainer also independently
  confirmed Pierre dark mode works properly.
- `REVIEW_HISTORY_REF=refs/heads/main` pinned the selected ref and restored its
  context and URL on page reload. An initial test using `main` was invalid
  because the selector uses full ref names; the harness now rejects missing
  options immediately instead of silently setting an empty value.
- `REVIEW_COMPARE=1` passed for identical endpoints and for the nonempty base
  `6057d353ea327374e288eed0f543c48199866ddd`. Controls, pinned endpoints,
  account review loading, diff search on nonempty input, and local-draft close
  worked without remote review writes.

These DOM-driven checks do not prove native clipboard behavior, upload/undo,
multi-window persistence, moved-ref handling, or agent dispatch. Keep those
acceptance items open. Each run closes only its own browser target and restores
the previous appearance preference.

Live image/undo follow-up: `REVIEW_IMAGE=1` now generates a 64x64 PNG and feeds
its File/DataTransfer through the real Slate `insertData` upload plugin. It
scrolls immediately, waits for a loaded `/blobs/` image, changes appearance,
returns to the editor and verifies positive rendered image height. Calling the
real editor's undo/redo changes then exactly restores its serialized document,
and the image loads again. This passed with the review draft cancelled. Small
test blobs are uploaded; no remote review comment is saved.

This also corrected a weakness in the earlier harness: `execCommand` inserted
DOM text while leaving Slate's placeholder visible, and synthetic paste did
not start an upload. The harness now inserts through the actual Slate instance
and tests its document state, not just DOM text. This is editor/plugin-level
integration, not native clipboard/keyboard evidence. It scrolls after starting
the upload but does not deliberately stall the network to prove a prolonged
in-flight upload. Saved semantic scroll can omit line 10 from the virtual DOM,
so gutter selection now uses a currently rendered row rather than that fixed
line. Prior DOM-only retention evidence should be interpreted with this caveat.

Concurrent-save implementation follow-up: commit review loads now carry a
transport-only account-store sequence token. Saves and legacy migration use
conditional writes; stale windows receive an error without clearing their
drafts, instead of replacing newer remote comments. Tokens are stripped from
stored/exported records. Deleted-key recreation reads the tombstone's sequence.
The persistence layer now treats an absent key as sequence zero for atomic
creation (previously that path destructured an absent SQLite row).

Real SQLite tests cover create/update/stale-write rejection; frontend store
tests cover two stale writers, retained local drafts, token-free export, and
deleted-key recreation. This is conflict rejection, not automatic comment
merging. Full-app concurrent-save/reconnect acceptance is still required,
including the user recovery flow. Deploy the persistence-service change with
the frontend before testing creation; a frontend-only rebuild is insufficient.

Live two-window follow-up: the hub/bays and host managed components were
upgraded successfully (host operation `049c1d26-4f20-4e76-8311-d25b57a68005`).
The host step initially inherited stale token-file environment overrides;
rerunning only that step with fresh hub environment and without those overrides
succeeded. Post-upgrade Slate image/undo/theme smoke passed.

`review-concurrency-live.browser-test.mjs <chat-url> <full-hash>` now opens two
isolated real-app targets, requires an initially empty private note, saves the
first window, rejects the stale second save, and verifies its Slate draft is
retained. It restores the empty note and confirms it after reload. This passed
against the deployed account persistence service. It found that the note UI
closed optimistically before a failed save; the editor now closes only after a
successful save, provided the commit and draft still match. The script has a
`REVIEW_CLEANUP=1` mode for a failed run's explicitly identified smoke note.
No agent turn was dispatched. Concurrent comment merging, reconnect scenarios,
and stale-draft reconciliation remain distinct from this save-rejection check.

Live historical Git Markdown follow-up: `historical-file.browser-test.mjs`
passed against the same pinned commit and `src/.agents/git-review-modernization.md`
with both `REVIEW_RENDERER=legacy` and `REVIEW_RENDERER=pierre`. Each checks rich
Markdown rendering, read-only original source, source-line positioning, keyboard
close with focus restored to the opener, and an unchanged review URL. The harness
explicitly selects and restores the renderer and resets saved scroll before
finding the header. An initial attempt could not find a virtualized header at the
saved scroll position; that was a harness assumption, not a historical-loader
failure. These checks do not cover patchflow/snapshot/backup restore or
renamed/deleted files.

Live route follow-up: `review-route.browser-test.mjs` passed deep-link opening,
Older selection, reload, Escape, reopening, Back/Forward and preservation of an
unrelated query parameter, with no page errors. The readiness locator now uses
the current Diff renderer selector rather than the experiment's preview button.
This checks URL/drawer lifecycle, not semantic scroll restoration or agent
working-directory dispatch.

Live worktree follow-up: `worktree-live.browser-test.mjs <chat-url> <repo-path>`
uses project-scoped CLI execution to create a test-only commit and disposable
detached `--no-checkout` worktrees in the actual browser project's repository.
One matching tree was automatically selected and pinned in the URL. Adding a
second produced the explicit ambiguity notice instead of selecting either;
removing both produced the historical-only notice with the commit still open.
A disposable ref moved after browsing stayed pinned across reload and adopted
its new tip only after explicit Browse / Refresh. The full live test passed.

Cleanup removes only its own worktrees and temporary ref (with expected-tip
checking), then verifies the original worktree list is unchanged. User branches,
index and checkout are not modified; unreachable test commit objects remain for
normal Git garbage collection. No review or agent turn is submitted. Because
these worktrees deliberately have no checked-out files, this proves discovery,
selection and pinning, not working-copy file opening or agent execution.

TimeTravel selection-safety follow-up: document and diff loads are now keyed to
the exact source, version pair, document path/extension and actions instance.
The previous implementation retained the old document during loading and let
late requests overwrite newer results. The shared loader immediately hides a
different selection's content and ignores cancelled results. This also removes
the old document from Restore while a replacement is pending. Load errors are
shown without reusing old content. Deferred-response hook tests cover stale
snapshot responses arriving after a backup selection, failed/missing results,
and immediate invalidation. All 22 TimeTravel tests passed. This is targeted
race-regression coverage, not a substitute for the source-specific live restore
acceptance still listed above.

Live TimeTravel initialization follow-up: opening the registered `.time-travel`
route for the plan file remained on Loading indefinitely. Inspection showed Git
versions were available but no main editor actions/sync document existed.
TimeTravel's background source open was lazy, while its initializer waited for
that editor forever. TimeTravel now requests `wait_for_ready: true`, and that
explicit readiness request initializes background editor Redux without bringing
the tab forward. Ordinary lazy background opens still do not hydrate.

The added readiness assertion failed before the fix and passed afterward;
63 focused open-file/TimeTravel tests, frontend lint and the development build
passed. Reloading the same live page then displayed TimeTravel controls and its
revision log. This removes an acceptance blocker, but is not source-specific
comparison/restore evidence. The isolated browser target was closed; no restore
was performed.

Live Git TimeTravel comparison follow-up: `timetravel-live.browser-test.mjs`
passed against `src/packages/frontend/package.json` in the browser project's
repository. It opens the registered TimeTravel route, selects Git history and
Compare Changes, renders actual document changes through Pierre, then switches
back to Classic. Restore is absent while comparing, and no page errors occurred.
It closes only its own target and never invokes Restore or writes file content.
The harness uses Ant Design's visible option rows/radio labels because its
accessibility proxy options and radio inputs are hidden. This proves the live
Git-source renderer integration, not snapshot/backup loading or restore behavior.

Live archive comparison follow-up: the same script now accepts
`REVIEW_HISTORY_SOURCE=Snapshots|Backups|TimeTravel` (Git remains the default).
Snapshots and Backups both passed on the package.json fixture through Pierre
and Classic, with source/mode assertions and no file writes. The first backup
attempt clicked Compare Changes before it became enabled, leaving Single
Version displayed; the harness now waits for the visible option to be enabled
and confirms the selected mode. A subsequent full backup run passed. This was
not evidence of a missing backup fixture or a renderer failure. Failure
diagnostics include available version counts. Archive restoration and live
patchflow comparison remain separate acceptance items.

Live patchflow/restore follow-up: the package.json fixture has only one patchflow
version (confirmed by the live store), so comparison is correctly disabled.
Created `/home/user/scratch/git-review-timetravel-20260907-a4e319.md` in the same
browser project through the live text API, with Alpha/Beta/Gamma Markdown
versions. `REVIEW_HISTORY_SOURCE=TimeTravel` passed comparison through Pierre and
Classic on this fixture.

`timetravel-restore-live.browser-test.mjs` only accepts explicitly named scratch
fixtures and checks their expected text before mutating. It selected rich Beta
Markdown, activated Restore with the keyboard, verified Beta and a new version
ID through the live text API, then read the previous Gamma version successfully
through the history API. Cleanup returned the fixture to Gamma with a guarded
live write; the file and history remain as reusable test evidence. This passed
with frontend lint. Git/snapshot/backup restoration uses the separate external
document branch and is not proved by this patchflow restore test.

Live Git restore follow-up: created the isolated repository
`/home/user/scratch/git-review-repo-20260907-41b85f` in the browser project,
with `git-review-timetravel-external.md` and Alpha/Beta/Gamma commits. Live text
API writes supplied each committed version; no application repository branch
or user document was changed. The guarded restore harness now accepts an
explicit history source and fixtures inside similarly named scratch repos.
`REVIEW_HISTORY_SOURCE=Git` passed rich Beta selection, keyboard Restore, new
live version verification, historical Gamma preservation, and guarded cleanup
back to Gamma. The repository/file remain as reusable acceptance fixtures.
Frontend lint passed. This verifies the external Git restore branch, but does
not yet establish snapshot/backup restoration end to end.

Live archive restore follow-up: captured the isolated fixture at Beta with one
project snapshot and one successful backup (operation
`d30dc57a-4ac1-460f-9623-5fdbdd912f1b`), then changed only the live fixture back
to Gamma. `REVIEW_RESTORE_LATEST=1` lets the guarded test select that sole Beta
archive instead of requiring a second archive just for navigation.
`REVIEW_HISTORY_SOURCE=Snapshots` and `Backups` both passed rich Markdown
selection, keyboard Restore, new live version checks and preservation of the
prior Gamma history. Each run returned the fixture to Gamma with a guarded
live API write. No whole-project restore or retention change was performed;
the created archives remain subject to existing retention. Frontend lint passed.
This completes the four source-specific comparison/Markdown-restore checks;
it does not stand in for renamed/deleted file or agent-dispatch acceptance.

### Single-file stress evidence (2026-09-07)

Run `STRESS=1 node src/packages/frontend/components/diff-viewer/pierre-preview.browser-test.mjs`
from the repository root. This adds two real Chromium/Pierre fixtures before
the existing browser suite: one 19,000-line file (414,859-byte patch) and two
128,000-character minified changed lines (256,107-byte patch). Both remain
within the existing Git transport limits. They verify End/Home navigation,
visible final content, bounded mounted rows, page-width containment, and worker
termination after closing. Two runs opened the huge file in about 1.03 seconds
with 36 rows mounted at the end; minified input opened in 0.93 seconds with
four rows. These are development modal-open measurements, not production
highlight-completion or worker-memory measurements.

The first run subsequently failed the existing native clipboard assertion
(empty clipboard); the second full run passed unchanged. Preserve this as an
intermittent acceptance issue rather than treating the rerun as proof of
reliable native selection. The standalone harness still stubs Slate and app
services and does not replace signed-in drawer acceptance.

Native-copy follow-up: the harness now accepts `COPY_CYCLES=N` to repeat fresh
preview openings and native clipboard checks on both panes, and records the
selection seen by the copy event for failure diagnostics. Twenty cycles with
the tree/preview suite and thirty cycles after the stress/full suite passed
without reproducing the earlier empty clipboard. Added partial-line source
selection across syntax-token text nodes; ten full-suite cycles passed with
both whole-line and partial-line assertions. No production copy handler was
changed, and this does not yet cover selection across recycled virtual windows
or explain the original intermittent failure.

### Production packaging evidence (2026-09-07)

`pnpm analyze` in `src/packages/static` passed at `979a8358e2`, producing
`dist-prod-measure/chunk-stats.json`. The main lazy Diffs chunk measured
471,646 bytes raw / 120,202 gzip / 107,302 Brotli; the Trees chunk measured
241,440 / 68,356 / 65,631 bytes respectively. The shared Pierre theming chunk
was 161,900 / 52,890 / 51,371 bytes, and the named highlighting-worker chunk
was 48,085 / 16,484 / 15,941 bytes. These are whole emitted chunks, not
package-exclusive byte counts or total cold-viewer transfer: shared dependencies,
language/theme chunks and application adapters also contribute.

Added explicit `@pierre/diffs/` and `@pierre/trees/` prohibitions to the existing
app/load/embed and signed-in startup-route module guards. The real production
stats passed all guards (931 chunks, two preexisting grandfathered matches).
Injecting either library into the app chunk in memory correctly failed the
guard. This protects lazy loading without relying on source-level import
inspection alone. An equivalent before/after production build is still needed
for the requested initial/lazy bundle-size _delta_; these absolute measurements
must not be presented as that delta.

### Production baseline comparison (2026-09-07)

Built the unchanged `origin/main` baseline `a447e89fab` in the detached worktree
`/home/user/scratch/cocalc-git-review-bundle-baseline` and compared its production
`chunk-stats.json` with the `979a8358e2` production build above. Both used
`pnpm analyze`, the same static build configuration and host. Fresh workspace
bootstrap required building `apps/document-build` and `cdn` before retrying
analysis; no baseline source changes were made. The baseline contains no
Pierre modules.

| JavaScript output                    | Baseline gzip bytes | Current gzip bytes |      Delta |
| ------------------------------------ | ------------------: | -----------------: | ---------: |
| load                                 |              84,524 |             88,927 |     +4,403 |
| app                                  |             981,993 |            983,638 |     +1,645 |
| embed                                |           1,009,903 |          1,011,330 |     +1,427 |
| All initial chunks, unique assets    |           3,547,705 |          3,555,221 |     +7,516 |
| All noninitial chunks, unique assets |          10,679,087 |         13,019,132 | +2,340,045 |
| All emitted JS, unique assets        |          14,226,792 |         16,574,353 | +2,347,561 |

The total raw-JS delta is +12,018,402 bytes; Brotli is +2,108,747 bytes.
Sum `assets` with `.js` suffix by unique filename, using the `initial` flag
for the split above. Initial totals include distinct application entrypoints,
not one page load. Noninitial totals include all emitted optional modules and
worker dependencies, not one review's network transfer. In particular, zero
eager Pierre modules does not mean zero initial-byte growth: runtime chunk
maps and integration code also change. These measured deltas close the static
packaging comparison; full-app network and editor acceptance remain separate.

## Objective

Make reading and discussing agent-produced code reliable across branches,
worktrees, historical documents, and long-running agent activity. Preserve rich
Slate comments with image paste, personal review records, keyboard navigation,
and responsiveness on large reviews.

## Existing surfaces

| Surface                                         | Input and current rendering                                                                                     | Integration constraint                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Git browser (`chat/git-commit-drawer.tsx`)      | `git show` / `git diff`, parsed patches, Prism, Virtuoso over files                                             | Comments, selected commits, review persistence, agent actions, search, scroll restoration                 |
| TimeTravel (`frame-editors/time-travel-editor`) | Two document versions, line-diff utility and CodeMirror                                                         | Preserve patchflow, Git, snapshots, backups, and specialized notebook/chat/Markdown viewers               |
| Codex activity (`chat/codex-activity.tsx`)      | `LineDiffResult` with content, operations, formatted line-number gutters and chunk boundaries; Prism/React rows | Often partial and uncommitted; cannot infer a Git revision or reconstruct complete files from these hunks |

The inline Markdown activity body also supports rich copy/paste. Replacing that
body's Slate renderer is not part of adopting a code diff renderer.

The Git browser's copy issue concerns copied `+`/`-` patch markers, not line
numbers. Clean source copying must preserve literal leading operators in the
source; stripping every leading plus/minus from selected text is incorrect.

TimeTravel already has `gitDoc`, `gitChangedFiles`, `openGitCommitFile`, and
specialized historical document viewers. However, `updateGitVersions` follows
the current checkout's file history, and `openGitCommitFile` requires the hash to
appear in that file's loaded history. Arbitrary-revision viewing must also work
when the file was unchanged in that commit, is off-branch, renamed, deleted, or
absent from the current checkout. Reuse and extend these APIs rather than
assuming the existing navigation method covers those cases.

## Phase 0: Pierre feasibility

Use `@pierre/diffs` through a small rendering adapter. The experimental preview
accepts either a patch or two complete text documents. It is loaded on demand
from the Git browser and TimeTravel. Opening freezes the input so an incoming
update cannot move temporary comments to a different revision. Its comments
are explicitly temporary and never enter the existing review store.

The preview is pinned to **1.4.1**. It initially used 1.3.6 because the 1.4
releases were younger than the repository's three-day dependency age rule.
The maintainer approved an exception after review on 2026-09-06, scoped to
`@pierre/diffs@1.4.1` only. Future versions remain subject to the age rule.

Dependency review for that exception:

- Compared the published 1.3.6 and 1.4.1 artifacts and upstream
  [release changes](https://github.com/pierrecomputer/pierre/compare/diffs-v1.3.6...diffs-v1.4.1),
  focusing on patch parsing, React CodeView integration, virtualization, cache
  identity, and worker initialization. This is a scoped dependency review,
  not a comprehensive security audit of the upstream editor.
- The published 1.4.1 manifest has an empty `scripts` object, no bundled
  dependencies, and no root `binding.gyp` implicit install hook. Its runtime
  dependencies are identical to 1.3.6; retain their existing lockfile versions.
  Inspection of that existing 51-package runtime graph found no
  preinstall/install/postinstall hooks. The unchanged `regex-utilities@2.3.0`
  has a development `prepare: npm test`, not a registry-tarball install hook.
  Use `--ignore-scripts` during the upgrade; do not add build permissions.
- Verified the downloaded tarball's SHA-512 against registry metadata; its
  integrity is pinned in `packages/pnpm-lock.yaml`.
- Relevant changes include collision-safe cache keys, large-diff stack-overflow
  avoidance, bounded worker initialization, and virtualized layout fixes.
  Prefer the 1.4.1 fixes over the initial 1.4.0 release.
- The larger built-in editor API redesign is not used by the preview. Keep
  CoCalc's Slate editor in React annotations; do not adopt Pierre editing or
  edit-state persistence implicitly. Validate annotation slots, selection,
  scrolling, file/mode changes, and themes against the actual new package.
- The parser now attempts more recovery in permissive mode. Continue passing
  `throwOnError: true` for patches so truncated/malformed review data is not
  silently repaired. Keep old/new line-anchor regression tests.

Upgrade validation passed: frozen workspace install with scripts disabled,
frontend typecheck/lint, six preview Jest tests, three real-package parser
tests, the standalone Chromium checks below, dependency consistency, and the
development frontend bundle. The adapter required only the explicit second
`CodeViewHandle<string, undefined>` type argument for unused caret metadata.
The browser harness still substitutes a textarea for Slate, so this upgrade
does not close the full Slate/image-paste acceptance gate.

The initial preview exercises CodeView, word highlighting, unified/split views,
old/new line navigation, and React annotations containing CoCalc's Markdown
editor. Full-document comparisons show expanded (virtualized) context so line
navigation reveals the requested line rather than a collapsed separator. Patch previews reject
line targets absent from supplied hunks; they do not read the working copy as
a substitute. The original renderer remains available for comparison.

### Acceptance gates

- Real large commits with many files, one huge file, long/minified lines,
  renames, deletions, Unicode paths, and malformed/truncated patches.
- Cold and warm opening latency, long main-thread tasks, memory, DOM size,
  scroll smoothness, and added lazy/initial bundle sizes on the same fixtures.
  Retain the existing 4 MB / 20,000-line Git transport/render limits until a
  separate bounded loading design is validated. A fast renderer alone does not
  eliminate transport/parsing limits.
- Configure and measure a bounded shared highlighting worker pool before
  concluding performance parity. The first integration uses the package's
  default highlighting path; its parse timer is not an end-to-end benchmark.
- Copy source text without patch markers/numbers, including actual leading
  operators, partial lines, old/new panes, and selection across virtual windows.
  Keep an explicit copy-patch action separate from source copying.
- Paste formatted Markdown and an image into an annotation; scroll it away and
  back, resize, change layout, and continue editing. Check text, upload
  completion, focus, and undo history separately. Surviving draft text does not
  prove that an unmounted editor's undo history or upload survives.
- Keyboard access to controls/annotations, Escape and focus restoration,
  account animation preference, zoom/reflow, and light/dark themes.
- Preserve existing comment anchors and saved reviews. Unmatched anchors must
  be visible as unmatched, never silently attached to the nearest line.
- Preserve safe treatment of untrusted code, paths, and commit descriptions.
  Syntax highlighting is not Markdown sanitization. Do not weaken existing
  sanitizer boundaries to accommodate the renderer.

Only after these gates pass, replace rendering and delete obsolete code.

### Manual evaluation and integration decision

The maintainer's initial hands-on evaluation found Pierre's diffs attractive,
fast enough for the tested reviews, and the side-by-side view particularly useful.
This supports proceeding with integration, not discarding CoCalc's review UI.
It is user acceptance evidence, not a large-file benchmark or full feature-parity
result.

Preserve the existing review shell and replace its rendering boundary. Track
parity explicitly: sticky current-file names, keyboard scrolling, commit
navigation (`j`/`k`), marking reviewed (`y`), diff search (`/` and find shortcut),
context expansion, font-size shortcuts, help, scroll restoration, saved review
anchors, and Slate comments including image paste and local undo. These are
existing product features, not optional polish to rediscover after migration.
The same command should target whichever renderer is active, not both.

The preview now enables Pierre's sticky headers and reuses CoCalc's scrolling
commands: Space/Shift+Space, Page Down/Up, arrow keys, and Home. The viewport is
keyboard focusable; comments and controls retain native key handling. Other
preview keys cannot invoke the underlying drawer's commit/review shortcuts;
Escape still closes the modal and restores trigger focus. Commit/review/search
commands belong in the integrated review shell, not this frozen-input modal.
Use Pierre's `github-light` / `github-dark` themes, following CoCalc's resolved
appearance (the OS preference applies only in System mode). The browser regression checks actual rendered background colors in
both modes, not merely the React options.

## Implementation readiness

Search highlighting follow-up (2026-09-07): Pierre now marks all matching loaded
code rows, including both coordinates of context lines, using a semantic warning
outline without replacing syntax colors or modifying copied text. Its public
post-render callback reapplies marks after virtualization; query changes clear
obsolete marks. Comparison reviews now supply the same match maps as commit
reviews. Focused tests cover coordinate mapping and comparison wiring, and real
Chromium verifies marking/clearing against Pierre shadow rows. This is row-level
highlighting, not substring highlighting or search of omitted historical content.

### CoCalc appearance integration

Pierre and Trees must follow CoCalc's resolved appearance, not independently
follow the operating system. Use `useAppearance().resolved` so explicit Light,
explicit Dark, and System preferences update an already-open review without
remounting the renderer or resetting selection, scroll, comments, or tree state.
Use Pierre's `github-light` / `github-dark` themes with an explicit `themeType`.
Trees supports inherited CSS `color-scheme` and theme variables; set the resolved
scheme on its host and use semantic CoCalc surface/text/border tokens around it.
Keep standard Ant Design controls on the application theme. All custom headers,
annotation cards, search/status/error panels, and historical-source wrappers
must pair theme-aware foreground/background tokens.

Acceptance: test CoCalc Light with a dark OS and CoCalc Dark with a light OS,
System-mode changes, and live preference changes with a selected line and an
active Slate draft. Inspect actual rendered code/gutters/additions/deletions,
Trees selection/focus/search states, sticky headers, and comments in both modes.
This applies to Git review, TimeTravel text diffs, and Codex activity diffs.

### Changed-files navigation with Trees

Adopt `@pierre/trees` as a read-only changed-files navigator alongside the
Pierre diff renderer, not as a repository file manager. Review the exact
published version, license, runtime dependencies, and install hooks before
installing with scripts disabled. The Diffs 1.4.1 age exception does not extend
to Trees. Consult the pinned package rather than assuming beta APIs match main.

- Build the tree only from the selected review's loaded changed-file metadata.
  Do not walk the filesystem or load the whole repository. Keep a stable mapping
  from canonical tree paths to review file identities, including old/new rename
  paths, deletions, and unusual filenames; fail explicitly on collisions.
- Use a collapsible, resizable desktop sidebar and a compact alternative for
  narrow drawers. Retain flat navigation as a fallback/preference. Preserve the
  readable sticky diff header and copy/historical-open actions.
- Selecting a file navigates the existing diff adapter. Scrolling updates the
  active-file indicator without stealing focus or causing navigation loops.
  Preserve directory expansion across layout changes, scoped by review target.
- Include filename filtering and accessible Git status labels, then comment
  counts and reviewed-file indicators where backed by actual review state.
  No rename, move, drag/drop mutation, checkout, or writable context menus.
- Explicitly update the Trees model when the review changes; hook initialization
  options are not reactive. Test empty reviews, switching commits/targets,
  stale asynchronous updates, keyboard traversal/activation, search, focus
  restoration, long paths, 320px reflow, and large changed-file sets.
- Integrate in delivery change-set 2, with renderer-neutral file-selection
  callbacks so the navigator also works with the legacy rollback renderer.

Maintainer decision: omit visible diff line-jump controls (including the
prototype's Side/Old/New selector). Keep numeric old/new navigation internally
for search hits, comments, semantic restoration, and deep links. Historical
source viewers are separate from the diff toolbar.

### Implementation progress (2026-09-06)

Durable-comment integration groundwork:

- Extracted `InlineReviewCards` from the legacy renderer. Both renderers can
  now share the saved-comment display, draft/edit Slate inputs, stable legacy
  cache IDs, and create/update/resolve/reopen callbacks. The original renderer
  already uses the extracted component; no review-store schema change occurred.
- Numeric old/new selections map back to exact legacy anchors. Selecting an
  old-side context line retains the same V2 context anchor as its new-side
  counterpart, even when their line numbers differ. Ambiguous or absent rows
  do not create anchors. Annotation grouping retains original comment objects
  and exposes unmatched records separately rather than silently attaching them.
- The production parser entry point validates one parsed file per legacy file,
  identical filename interpretation, and aggregate 4 MB / 20,000-line limits.
  It rejects known truncation. Filename disagreement requires staying with the
  original renderer until authoritative Git metadata replaces the legacy parser.
- Focused coverage checks keyboard comment actions, buffered edit saves across
  layout changes, cache IDs, unchanged submitted records, context coordinates,
  and real-Pierre rename/deletion parsing and limits. This is not yet a wired
  production Pierre toggle and does not establish the pending-upload/undo gate.

Shared highlighting pool wired into the preview:

- `DiffHighlightingProvider` uses Pierre's shared singleton lifecycle, capped
  at two workers with a five-second initialization deadline and 16 entries per
  file/diff AST cache. Cache limits are entry counts, not byte limits; retained
  memory still requires measurement against the large review fixtures.
- Rspack bundles a literal worker entry URL and its dependencies. No runtime
  third-party CDN code is fetched. Uses the GitHub themes and JavaScript regex
  highlighter, with 1,000-character token/word-diff limits for pathological lines.
- The adapter observes the pending initialization promise explicitly: in 1.4.1
  the constructor starts an inner promise without returning it on that first
  call. Without a subsequent observer, blocked worker downloads can produce an
  unhandled rejection. Worker failure remains visible as a fallback status; only
  the redundant browser uncaught worker-error event is suppressed, not the
  pool's failure/cleanup listener.
- Real Chromium tests verify two concurrent providers share two initialized
  workers, removing one consumer retains them, removing the last terminates
  them, reopening starts a fresh bounded pool, and blocked worker downloads
  leave readable diff text without page errors. The standalone harness bundles
  the same upstream worker using esbuild. With CDP restored, the signed-in
  lite1b smoke test also passes against the actual Rspack build: exactly two
  named same-origin workers, highlighted source, no fallback status or page
  errors, and zero workers after dismissing the preview.
- Native Ctrl+C tests cover multi-line old/new split-view source copying,
  retaining literal leading plus/minus operators without gutters/patch markers.
  Cross-virtual-window selection and partial-token ranges remain separate gates.
  Nineteen focused preview/provider/model tests pass, with frontend types/lint
  and the development bundle. The default Git renderer is still unchanged.

Trees navigation implemented in the main drawer and Pierre preview:

- Pinned `@pierre/trees@1.0.0-beta.6` (published July 25; no age exception).
  Reviewed the published path normalization, React lifecycle, selection/search,
  reset, decoration, and disabled mutation APIs. The Apache-2.0 package and its
  three direct runtime dependencies have no preinstall/install/postinstall or
  root binding.gyp hooks. Preact's development prepare script is not a registry
  install hook. Installation and frozen-lock validation used `--ignore-scripts`.
  Verified the Trees tarball SHA-512 against registry metadata. Preserved all
  unrelated lockfile entries; only the four-package closure was added.
- The lazy sidebar accepts renderer-neutral file IDs, paths, optional change
  status, and comment counts. It never queries Git or the filesystem. Filtering,
  keyboard activation, active-file indication, collapse, and keyboard-operable
  width adjustment coexist with the existing sticky copy/open headers. Below
  800px of available component width it yields to the compact file selector;
  layout changes do not remount the diff or comment editors.
- The old unbounded changed-files button list is now a compact selector. Both
  that selector and Trees navigate the same legacy Virtuoso list. Scrolling
  updates tree selection without dispatching another navigation or stealing
  focus. The Pierre preview uses the same sidebar around CodeView.
- Replacing paths explicitly resets the model and ends the prior search session
  before applying the new filter. Otherwise clearing a filter could restore old
  expansion state and hide new folders. Comment-count-only updates refresh row
  decorations without resetting paths. Duplicate/colliding file-directory paths
  show an explanation and retain the independent flat selector.
- Real Chromium covers keyboard activation, filtered target replacement, live
  comment counts, empty reviews, search/select among 10,000 virtualized files,
  and preview reflow at 1200/600/320px. Signed-in lite1b smoke tests cover the main
  drawer's tree selection/active highlight, hide/show preserving filter, compact
  navigation, unchanged target URL, and historical rich/source opening. Run
  `git/changed-files.browser-test.mjs <chat-url> <commit>` for the main drawer.
  Focused suites: 86 tests; frontend typecheck/lint, version consistency, and
  development bundle passed.
- Remaining Trees work: persist target-scoped expansion/preferences across
  closing/reopening, derive legacy status/rename metadata from the new Git
  facade, and revalidate against the production Pierre adapter. Existing review
  store schema and default diff renderer are unchanged. No reviewed-file badge
  is invented from commit-level review state.
- The maintainer also reports that the file tree works well in manual use.

Foundation implemented without changing the default renderer or V2 persistence:

- `components/diff-viewer/review-model.ts` defines repository, pinned/working
  target, historical source, numeric side/location, file/hunk, capabilities,
  semantic scroll, adapter, and request-generation contracts. New target keys
  deliberately do not replace V2 commit-review keys.
- `git/read-service.ts` and `project-read-service.ts` provide the existing
  project-host exec transport with a four-command concurrency bound, 30-second
  coalesced discovery, byte-bounded immutable blob cache, explicit parent and
  tree/merge-base comparisons, paged first-parent/all-ancestor history, and
  NUL-delimited path metadata. Reads reject truncation, ambiguous refs,
  unsupported historical binary/symlink content, and unavailable exact paths.
  No checkout, fetch, dependency installation, or new hub API is introduced.
- `chat/git-commit/legacy-locations.ts` bridges V2 comment/search positions
  without rewriting records. Context comments preserve both source coordinates;
  missing/ambiguous provenance is returned as unmatched with the original
  comment. Source-range extraction preserves literal leading operators and
  rejects absent patch context. Native clipboard integration remains untested.
- Disposable real-Git fixtures cover divergent worktrees, detached/prunable
  paths, root/merge parents, refs moving after pinning, odd filenames, deleted
  and renamed sources, SHA-256, cache expiry/eviction, bounded concurrency, and
  unchanged checkout/index/dirty state after reads. Foundation plus existing
  drawer/store regression suites: 100 tests passed; frontend types/lint passed.

Custom-header integration spike completed:

- `ReviewFileHeader` is renderer-neutral and renders through Pierre's
  `renderCustomHeader` in the preview. It uses a fixed two-row layout and
  matching `itemMetrics.diffHeaderHeight`; long paths ellipsize with full text
  available for selection/copy and in the accessible name/title. Extra actions
  use a menu rather than unbounded height changes.
- Historical opening and working-copy editing are separate callbacks. Without
  an exact source/open callback there is no misleading Open fallback. The
  frozen preview currently offers repository-relative copy only.
- Real Chromium verifies pinned headers across files, 14-to-22px font changes,
  narrow containment, keyboard activation with actual clipboard reads, and
  preserving clipboard content when path text is selected. Three header Jest
  tests cover callbacks and unavailable-action behavior. Native multi-line
  diff-text copying (especially across virtualization) remains a separate gate.
- Local dev fresh-auth elevation succeeded but subsequent browser discovery
  still encountered stale master-host tokens; the cookie-only attempt reported
  no auth cookie and disabled automatic login in the project environment.
  Do not work around that restriction or call the stubbed Slate tests full-app
  validation. Arrange a supported session or maintainer-driven editor checks.

Chat review URL navigation implemented:

- `git-hash=<commit>` (or `HEAD` for working changes) opens the matching chat's
  drawer; optional `git-cwd` retains its repository/worktree locator. Commit
  navigation replaces the selection in the URL, opening adds a history entry,
  and dismissal removes only review parameters. No repository scan or checkout.
- Direct landing state survives the app's intermediate project-directory URL
  during startup, but ordinary navigation does not carry it to another file.
  Back/Forward restore drawer state; unrelated query/fragment updates do not
  reset its thread association. URL inputs use the existing drawer's validated
  commit parser; SHA-256 UI support still belongs to the pending facade wiring.
- A URL does not authorize association with the currently selected agent:
  submission/activity/logging callbacks are unavailable until opened from a
  thread. Full validated worktree-aware agent routing remains pending.
- Real signed-in Chrome tests cover initial deep links, commit navigation,
  reload, Escape dismissal, opening from the Git button and Back, and preserving
  unrelated parameters. Run `git/review-route.browser-test.mjs` with an explicit
  chat URL and commit; it uses CDP and creates/closes only its own test tab.

Exact historical file opening implemented in the existing Git drawer:

- `git/historical-file.ts` resolves abbreviated requests through the Git facade,
  pins the commit, resolves NUL-delimited changed-file paths, and reads the exact
  blob. Deletions explicitly show the parent revision; explicit old/new GitSource
  descriptors retain their side. Unchanged files do not need a file-log entry.
  Missing/unsupported objects and ambiguous path matches fail without a live-file
  fallback. Expected blob IDs are checked when supplied.
- `time-travel-editor/git-revision-modal.tsx` uses TimeTravel's read-only rich
  viewers directly, without initializing a sync document or opening/creating a
  working file. Original source text has a validated source-line jump. Linked
  resources are explicitly labeled as potentially live/external; the historical
  document itself is immutable. Stale successes/errors cannot replace a new
  target, and closing/changing the owning review dismisses the modal.
- Historical sticky-header and copy-notification actions now say "View at this
  revision". Working changes retain "Open". A separate historical working-copy
  edit action remains unavailable until selected-worktree validation is wired.
- Real-Git fixtures cover off-branch unchanged Markdown, deleted and renamed
  paths, explicit old sides, missing files, expected-blob mismatch, and unchanged
  checkout/index/dirty state. Focused suites: 90 tests passed. Signed-in Chrome
  verifies actual historical Markdown, original CodeMirror source/read-only
  behavior, line-50 navigation, Escape/focus restoration, and unchanged review
  URL. Run `git/historical-file.browser-test.mjs <chat-url> <commit> <md-path>`.

Production-shell integration started (2026-09-07): the existing drawer now offers
an explicit Classic/Pierre renderer selector, with Classic still the default.
Pierre uses V2 comment anchors and persistence callbacks, the existing source
coordinate mapping for search, file navigation, exact historical opening, custom
sticky headers, the shared highlighting pool, and CoCalc-resolved appearance.
Unmatched saved comments remain visible and actionable rather than being moved.
Active comment editors live in a labeled, sticky editor area outside recyclable
diff rows. Changing renderer is disabled until that editor is saved/cancelled;
switching to a different comment is guarded for the same reason.

Focused tests cover exact selection anchors, retained editor identity/buffer
through simulated recycling/layout/theme changes, unmatched records, and the
existing drawer regressions. Frontend typecheck/lint and the real-renderer
Chromium suite pass. A live lite1b smoke test using actual Slate verifies gutter
selection, editor identity/text through scrolling and Light/Dark changes, and
Cancel without creating a review comment. Its input is DOM-driven because the
forwarded Chrome session acknowledged native input commands without delivering
them; it is not native pointer or clipboard evidence. Run
`git/pierre-review-live.browser-test.mjs <chat-url> <commit>` with an isolated
signed-in Chrome target. Actual upload completion, local undo, and target-switch
draft behavior remain separate acceptance gates.

Read-only history controls started (2026-09-07): the drawer now discovers
registered worktrees and refs through the bounded Git service, with explicit
Browse / Refresh to validate the locator and pin its ref tip. History is paged
and defaults to first-parent, with all-ancestor browsing available. Changing
selectors does not check out a branch. Active edits disable context changes;
cross-worktree and bare working views disable write/agent actions until routing
is implemented. Real-Git and keyboard tests cover detached/unavailable worktrees,
unchanged checkout/index state, explicit application, and stale responses.
Frontend typecheck and lint pass. A live test correctly rejected a worktree
present only on the development machine, not in the browser project's separate
checkout; successful live cross-worktree validation remains pending.
Review URLs now retain the selected locator independently of the originating
agent thread, and explicit history selections retain their pinned tip, ref label,
and ancestry mode through reload. New commit-link request tokens invalidate the
previous worktree selection even within the same repository. Deleted ref labels
remain visible for pinned history; only explicit Refresh resolves them again.
The live lite1b ref-selection/reload smoke passes against its own `main` ref,
along with 82 focused tests, frontend typecheck/lint, and a static dev build.
Run the live smoke with `REVIEW_HISTORY_REF=refs/heads/main` and the existing
`git/pierre-review-live.browser-test.mjs <chat-url> <commit>` harness.

Still pending: remaining Slate lifecycle checks and native diff clipboard tests;
semantic scroll restoration and remaining renderer parity; comparison controls;
historical source integration in the new renderer; comparison persistence and canonical-key
migration; validated agent routing; activity adaptation; release acceptance and
default/cleanup. Discovery/history and immutable commit patch loading use the
service; working-change loading still uses the legacy path. Incoming-commit
containment routing remains pending.

Immutable loader integration (2026-09-07): drawer commits now pin a full commit
and explicit zero-based parent before reading metadata/patch/summary. NUL-delimited
metadata supplies literal paths and source/blob identities; historical opening
uses those descriptors directly. Mismatched metadata/patch counts and truncated
combined output fail visibly rather than yielding a partially mapped review.
The target store's parent convention now matches the reader (first parent = 0).
Real-Git fixtures cover root and merge diffs, unusual literal filenames, and empty
two-tree comparisons. Selecting nondefault parents/comparisons in the UI remains
pending.

Comparison storage foundation (2026-09-07): `git-target-review-store.ts` adds an
account-scoped namespace keyed by repository and pinned target identity. Each
save creates an immutable revision with the parent revisions actually loaded by
the editor. Concurrent saves retain separate heads instead of overwriting one
another; explicit reconciliation can supersede both. Export retains all revisions,
and import validates ancestry before writing with fresh IDs, preserving existing
conflicts. Tests cover account/repository/mode/parent separation, shared worktree
identity, SHA-1/SHA-256 pins, unavailable parents, failed saves, image Markdown,
submission identifiers, and corrupt ancestry. V2 records are not migrated or
modified by this store. Wiring comparison controls, drafts, conflict selection,
and store export/import into the drawer remains pending at this foundation stage.

Initial comparison UI (2026-09-07): **Compare revisions...** opens a separately
scoped review using explicit base/head refs or a numbered merge parent. The
controls revalidate the repository, pin endpoints, reject late results while
editing, and never assume `main` or perform checkout. The pane reuses Pierre,
Trees, exact historical sources, and retained Slate inline editors. Notes,
reviewed status, and inline comments save to target snapshots, never V2 commit
records. Concurrent versions are visible and reconciliation is explicit.
Per-writer local drafts survive closing/reopening; recovery remains available
after a remote review-load failure. Active editors block context changes, and
an explicit keep-draft close is available after finishing the editor.
The live empty-tree comparison/account-load/local-close smoke passes without
remote writes (`REVIEW_COMPARE=1` with the existing live harness). Full comparison
URL routing, export/import controls, search parity, agent submission, and live
nonempty comment-save/reconnect acceptance remain pending.

Comparison navigation/archive integration (2026-09-07): the pane now searches
filenames and loaded patch lines using the shared search index, with scoped
Ctrl/Cmd-F, Enter/Shift-Enter, previous/next controls, and Pierre source-location
navigation. The scope label makes omitted context explicit. Export downloads
all saved revisions (not unsaved local drafts); import validates the current
target through the snapshot store and never silently replaces the visible body.
Import is disabled while editing, and archives over 10 MB are rejected before
parsing. Keyboard/search and archive-transfer tests cover these controls. Full
all-match highlighting remains pending; comparison URL routing is implemented below.

View preference persistence (2026-09-07): shared device-local preferences now
retain split/unified mode, wrapping, file-tree visibility, and tree width across
the commit viewer, comparison viewer, and preview. Same-tab and cross-tab updates
use a subscribed store, without recreating editor instances. Malformed values
fall back independently; unavailable/quota-limited storage retains usable
in-memory controls. Existing drawer font-size persistence remains separate.
Focused tests cover keyboard changes, reopening, cross-tab updates, retained
children, and storage failures. The real Pierre browser suite verifies split
mode survives reload before running its unified-layout checks. Per-target tree
expansion and semantic scroll restoration remain pending.

Comparison links (2026-09-07): applying a comparison writes `git-compare` alongside
the existing drawer/history route. It records the common Git directory, full
head/base object IDs, and trees/merge-base mode or zero-based merge-parent index.
Reload restores the modal and its controls automatically, revalidating the
repository before resolving the immutable endpoints. Missing objects or a
different repository produce an explicit error, never a working-copy fallback.
Closing the comparison removes only its route state; unrelated query parameters,
chat fragment, and underlying history selection survive. Explicitly opening a
new comparison does not reuse a previously dismissed landing target.
Focused parser/service/modal tests cover invalid routes, repository mismatch,
parent numbering, and keyboard dismissal. A live nonempty comparison on lite1b
passed reload, account review loading, scoped search, and local-draft close
without remote review writes. Semantic scroll/selection links and full live
comment-save/reconnect remain separate acceptance gates.

TimeTravel text integration (2026-09-07): the Changes view now offers an inline
Classic/Pierre selector instead of only a frozen experimental popup. The shared
document adapter receives both selected document strings directly, follows slider
updates using versioned Pierre items, expands complete-document context, and uses
the shared highlighting pool, split/wrap preferences, and CoCalc appearance.
It has a bounded independent keyboard-scroll viewport and explicitly refuses
inputs over 4 MB or 100,000 combined lines rather than silently truncating.
Classic remains available and the default during the acceptance window. Rich
Markdown/chat/notebook/whiteboard/task viewers and source restore actions are
unchanged; this integration performs no repository or file writes.

The new document browser fixture verifies actual 5,000-line scrolling, live
version replacement, split mode, 1200/600/320px containment, explicit appearance
overriding the OS, and rendered font-size updates. Pierre code font sizes require
shadow-root CSS variables, now shared with the Git renderer and preview and
paired with virtual line-height estimates. Focused tests cover keyboard renderer
switching, exact history/JSON inputs, size limits, and existing rich-viewer paths.
Live source-specific TimeTravel checks (Git, patchflow, snapshot, backup) and
restore-action regression remain release acceptance work; the standalone browser
fixture does not claim to verify those storage integrations.

Activity integration (2026-09-07): new app-server file-change events retain the
original unified patch or added/deleted text in an optional `LineDiffResult.source`
field. Existing display arrays remain intact for compatibility. This preserves
empty-side hunk coordinates and final-newline evidence that cannot be recovered
reliably from legacy gutters. Old events without this source retain Classic;
the UI does not guess missing coordinates or fetch current file contents.
New events offer an inline Classic/Pierre selector using the shared bounded
read-only renderer, with explicit recorded-activity/missing-context labeling.
Patch adaptation verifies hunk counts, coordinate ranges and newline markers,
preserves source carriage returns, and keeps sparse hunks sparse. Progressive
event replacement updates versioned renderer items without remounting the view.
The rich Markdown activity body remains untouched.

The app-server producer suite (70 tests), frontend adapter/keyboard tests, real
Pierre sparse-parser fixtures, and Chromium activity switching/update checks
pass. The frontend build can display new source-bearing events; existing running
project services need their normal code upgrade/reload before emitting that new
field. Live end-to-end recorded-session/streaming acceptance and the older
non-app-server producer path still need release review; do not infer those from
the standalone source-bearing fixture.

Bare commit containment (2026-09-07): the drawer now uses the existing ancestry
reader for an initial commit link without explicit cwd/history context. It
preserves the current checkout when that checkout contains the commit, selects
only a unique available containing worktree otherwise, and leaves the requested
commit selected while pinning that worktree's history tip. Ambiguous/no-match
cases remain historical-only with an explanation and the existing working-copy
chooser. Fresh registration/common-directory/HEAD validation precedes selection;
there is no checkout, branch switch, or project-wide directory search.
Explicit originating contexts are not overridden. Starting feedback or a write
operation cancels pending selection, and a later response cannot move context.
Uncertain contexts do not offer agent mutation actions. Automatic cross-worktree
selection remains read-only pending validated agent routing.

Real Git fixtures cover current, unique, merged/ambiguous, unreferenced, and
concurrently moved-HEAD cases while verifying checkout/index/dirty state.
React tests cover StrictMode replay, one lookup per request, interruption by
feedback, stale navigation results, and ambiguity. A live unique-worktree
fixture in the browser project remains an acceptance check; local worktrees in
the development checkout are not assumed to exist in that separate project.

Agent directory routing (2026-09-07): `sendGitCommitAgentTurn` no longer discards
the requested working directory when a Codex thread already exists. It reuses
that thread only if the effective configuration matches the requested literal
directory (or no directory was requested). A different or unknown directory
creates a fresh thread with the requested cwd and never mutates the original
session, whether idle or running. Immutable configuration and metadata are
normalized through field access; directory whitespace is preserved. Tests
cover matching/mismatching/unknown directories, effective config overriding
stale metadata, and literal path preservation. Cross-worktree drawer writes
remain disabled until request-time repository/worktree validation and the
explicit routing UI are integrated; this helper fix alone does not satisfy
that full release gate.

Validated worktree feedback (2026-09-07): immutable cross-worktree commit reviews
now offer an explicit, context-scoped opt-in for agent feedback. Before dispatch,
refresh repository discovery and verify common-directory identity, registered
worktree availability, checked-out branch, pinned HEAD, and reviewed-commit
ancestry. Recheck worktree identity/HEAD/branch after ancestry validation. Closing
or changing the review while validation is pending cancels dispatch. The agent
receives the validated context and an instruction to verify it again before
editing, since validation cannot lock an externally mutable working copy.
The directory-routing helper creates a new thread on a cwd mismatch. Direct
staging/commit actions remain read-only; comparison-pane agent submission is
still pending. Real-Git validation, stale-dispatch cancellation, and keyboard
opt-in tests pass; live end-to-end agent creation remains an acceptance check.

The renderer choice is settled sufficiently to start. Do not spend another
iteration comparing libraries. The phases below describe capabilities; the
delivery order at the end of this section describes independently reviewable
changes. Implement the new renderer inside the existing review shell, not by
turning the experimental modal into a second complete Git browser.

### Remaining targeted investigations

Large-review benchmark (2026-09-07): run
`BENCHMARK=1 node src/packages/frontend/components/diff-viewer/pierre-preview.browser-test.mjs`.
The deterministic fixture is 80 files, 18,001 patch lines, 395,500 UTF-8 bytes;
Chromium 149.0.7827.196, 1200x900, development bundle. Five open/navigate/close
cycles measured 941 ms cold opening and 834-866 ms warm opening (including modal
animation and keyboard positioning), and 46-61 ms to select/render the last
file. Only 79 code rows were mounted at that position. All workers terminated
after every close. Forced-GC main-thread heap was 11.6 MB after the first close
and 13.3 MB after the fifth; DOM nodes (1,196) and event listeners (586) remained
constant across closes. These are local measurements, not production latency
guarantees or worker-heap measurements. The test guards virtualized row counts,
worker teardown, and excessive retained main-thread heap/DOM/listener growth.

The benchmark caught a warm-open correctness regression: Pierre measured rows
while Ant Design's modal scale animation was active, leaving line 54 at
scrollTop zero after reopening. Preview and comparison modals now wait for
`afterOpenChange` before mounting the virtualized renderer. This does not remount
an active editor on theme/layout changes. The repeated-open benchmark and the
existing keyboard/focus tests pass with the fix. Full-app editor and historical
restore acceptance still requires the live browser; port 9222 currently resets.

Legacy activity producer (2026-09-07): the ACP handler now attaches bounded
complete read/write observations to its diff events. The read baseline is the
complete adapter result before optional line slicing, and it is cleared when a
new turn stream begins. The pair is not claimed to be an atomic filesystem
snapshot: an external edit may have occurred since the read. Complete inputs
are included only up to 256 KiB combined UTF-8 size; larger entries retain
Classic display rows without an invented source. The frontend preserves exact
newlines, labels the observation provenance, and feeds the pair to the shared
read-only Pierre renderer. Producer tests cover slicing, turn reset and byte
bounds; adapter tests and the full Chromium suite cover the new source kind.
Previously stored events without lossless input remain Classic-only.

Comparison agent submission (2026-09-07): saved, single-head comparison reviews
now expose an explicit working-directory opt-in and Send saved review to agent.
Submission requires no active editor or unsaved changes, reloads saved review
heads, validates the registered checkout at the comparison head, and includes
the immutable target and draft comment locations in the prompt. The existing
agent helper creates a fresh thread when cwd differs. Pending validation is
cancelled by unmount/target changes. After dispatch, submitted comments and a
receipt are persisted in a new review revision; a failed receipt save retains
a local draft and explicitly warns not to resend. Tests cover keyboard opt-in,
endpoint provenance, changed saved heads, and failed receipt persistence. Live
end-to-end agent dispatch is not yet verified. Historical comparisons whose
head is not the selected working copy's HEAD fail with an explicit mismatch;
they never silently target another checkout.

Tree expansion persistence (2026-09-07): changed-file navigation now saves
expanded directories per account/repository/review scope, including comparison
targets. Restore all-collapsed state explicitly (Trees' open initialization
otherwise treats an empty expansion array as open). Ignore temporary search
expansion and flush pending user changes before filtering or unmounting.
Storage failures do not disable navigation. Focused tests cover target isolation,
filtering, cleanup, and invalid/unavailable storage. The real Chromium tree test
collapses by keyboard, reloads, and expands by keyboard; it passes with
`TREE_ONLY=1 node src/packages/frontend/components/diff-viewer/pierre-preview.browser-test.mjs`.
That mode skips the preceding activity/document/pool scenarios, not the tree or
subsequent preview checks.

Semantic Pierre scroll restoration (2026-09-07): commit and comparison review
views now persist a visible file/side/line anchor and within-line offset under an
account/repository/target scope. Capture inspects mounted code rows inside
Pierre's shadow roots, not comment cards or placeholder heights. Restore uses
the public line-scroll API and refuses missing files/lines instead of guessing
another revision. Writes are debounced and flushed on teardown; active search
navigation takes precedence. Focused tests verify old-side capture, invalid
storage, restoration, and missing-line rejection. The full Chromium suite also
verifies capture from real scrolled Pierre output. A live drawer close/reopen
matrix across split/wrap/font changes remains an acceptance check. Classic now
uses the same persisted anchor as described below, retaining legacy pixels only
when a semantic position is unavailable.

Renderer-switch handoff (2026-09-07): the renderer selector now captures a
semantic file/side/line/offset before unmounting Classic or Pierre. Classic rows
expose their parsed source coordinates; header/metadata rows are excluded.
Pierre prefers this handoff over older persisted view state. Switching back
validates a unique patch row, expands Classic's line limit if necessary, and
uses Virtuoso file navigation before positioning that row below the sticky
header. Delayed restoration is bounded and cancelled by viewport interaction;
changed target scopes and active search never inherit the old position.
Focused tests cover coordinate capture, ambiguous/missing targets, handoff
precedence, selector focus and edit-time disabling. This is the switch seam;
live two-renderer layout acceptance remains a separate check.

Classic close/reopen (2026-09-07): Classic now debounces semantic anchor writes
and flushes the last captured position on unmount under the same target scope
used by Pierre. A valid restored row explicitly claims restoration from the
outer drawer; queued pixel restoration checks that claim rather than racing
the child renderer. Old pixel state remains a fallback when no valid semantic
anchor exists. Tests cover close-time persistence, scope isolation, restoration
ownership and active-search precedence. Neither renderer reuses persisted
unversioned coordinates for uncommitted working changes. Immediate renderer
handoff is still supported. Full live close/reopen and layout-change testing is
pending.

Working scroll identity (2026-09-07): the drawer now derives a SHA-256 view-state
generation from the exact loaded paths and patch lines, including their order
and coordinate headers. Both renderers use a separate scope containing this
generation. An unchanged patch can restore after reopening; changed content
cannot inherit the old coordinates. Hashing follows the existing 20,000-line /
4 MiB bounds, declines truncated input, and discards stale async results. If
Web Crypto is unavailable, reading still works without working-scroll
persistence. This identity does not authorize mutations or certify an atomic
filesystem snapshot. Tests cover exact-input stability, changed paths/lines,
byte/line bounds, stale results, and integration with distinct storage scopes.

Equal-document rendering fix (2026-09-07): the full browser suite exposed a
genuine empty viewport when changing a comparison to identical contents. DOM
inspection showed no rendered code and only a 44-pixel item at scrollTop zero;
this was not merely a locator or offscreen-line failure. Identical full-document
sources now use Pierre's plain-file item with an explicit "Identical versions"
status, preserving the complete historical text without inventing changes.
The full standalone browser suite passes, including scrolling the equal file
and transitioning back to a changed diff, plus the existing theme/layout and
tree tests. This does not replace the outstanding live source-specific
TimeTravel restore checks.

| Investigation                           | Evidence required before the affected feature replaces existing behavior                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real Slate annotation lifecycle         | Use the actual editor, upload service, and review store. Paste rich content and an image; edit, undo, scroll the editor offscreen/back, change layout/font size, switch files/commits, and reopen. Check focus, selection, upload completion, draft persistence, and undo separately. Test two simultaneous drafts. The standalone stub cannot satisfy this gate.                          |
| Custom sticky header                    | Render the existing copy-path/open controls through `renderCustomHeader`. Verify click and keyboard activation while pinned, text selection without accidental copy, long/renamed paths, narrow widths, font changes, and header-height accounting in Pierre's virtualizer. Decide fixed measured layout versus dynamic measurement from this test, not CSS guesswork.                     |
| Anchors, search, and source copying     | Map real parsed patch rows to old/new source coordinates. Test saved legacy comments, context lines with unequal old/new numbers, changed hunk context, renamed/deleted files, search hits beyond the rendered window, and copying across a virtualization boundary. Native clipboard selection must be tested in Chromium and a maintainer browser; a DOM text assertion is insufficient. |
| Read-only Git discovery and comparisons | Build a temporary-repository fixture with two worktrees, detached HEAD, divergent branches, merge commits, and deleted worktree paths. Prove branch browsing and revision reads do not change either checkout, index, or dirty files. Verify ambiguous hashes and containment do not silently select a worktree.                                                                           |
| Arbitrary-revision TimeTravel           | Open an unchanged file at an off-branch commit, an old renamed path, and a deleted file at its parent. None may require creating a current file or finding the commit in the current slider. Include a rich document, not just text, and duplicate commit timestamps.                                                                                                                      |
| Activity input provenance               | Trace producers of `LineDiffResult` to distinguish complete documents, sparse hunks, and incomplete events. Save fixtures including multiple chunks, missing final newline, and streamed updates. Establish a lossless adapter or extend the producer before replacing activity rendering.                                                                                                 |

These are bounded integration checks, not requests to implement semantic code
navigation, a language server, or an unbounded indexing service. Read-only Git
model/service work can proceed while Slate/header investigations are underway.

### Contracts to establish first

Use a renderer-neutral model rather than exposing Pierre types to the review
store, project APIs, or agent prompts. Settle exact TypeScript names in the first
implementation commit; the required distinctions are:

- `RepositoryContext`: project ID, canonical common Git directory, and a
  usable repository locator. A worktree path is not repository identity. Treat
  relocation as locator re-resolution, not proof that two repositories match.
- `ReviewTarget`: a pinned commit with selected parent, pinned base/head tree
  comparison, or a selected worktree's index/worktree state. Keep the user-chosen
  branch label separate from the resolved object IDs. Live working state carries
  a generation/fingerprint and must never masquerade as immutable history.
- `DiffFile`: stable identity within the target; old and new paths and sources;
  change kind including rename, delete, mode-only, binary, and submodule; hunks
  with explicit numeric old/new positions; and completeness/truncation state.
  The existing `GitShowFile {path, lines}` is insufficient for all these cases.
- `DiffLocation`: target identity, file identity, side, source line/column and
  optional range. Context lines retain both old and new positions. Never persist
  a Pierre item index, DOM node, current pixel offset, or synthesized display row
  as the sole review anchor.
- `DiffViewAdapter`: navigate to file/location, capture/restore a semantic
  scroll anchor, update selected ranges/search highlights, and render headers
  and annotations. Emit locations and user intents; the shell owns clipboard,
  file opening, persistence, shortcuts, and agent submission.
- `capabilities`: distinguish available historical content, additional context,
  working-copy opening, comments, and mutations. Missing capabilities explain
  themselves in the UI; they must not silently fall back to another source.

Pierre item IDs derive from stable file identity, not the array index. Item
versions change when the payload/anchors change; typing into a draft must not
reparse the patch or recreate all file items. Keep editor state above the
virtualizer. If the Slate test shows that remounting loses undo/uploads, preserve
the active editor instance outside recyclable rows, or retain its session through
the existing editor API. Persisting only the Markdown string is not a fix for
editor-session loss.

### Preserve reviews before extending them

Import recovery hardening (2026-09-07): V2 imports retain browser drafts until
the account DKV flush completes, then recheck draft timestamps so edits made
during the write survive. Failed writes no longer discard recovery drafts.
Duplicate commit keys in one archive choose the newest timestamp independent of
input order, with unique imported counts. Focused tests cover failed flush,
in-flight edits, and both duplicate orders. This does not reconcile separate
short/full legacy keys or replace the required conflict-preserving migration.

Object-format prerequisites (2026-09-07): legacy commit input, chat links, Git
log/show parsing, review URLs, and V2 records/drafts now retain up to 64-character
object IDs, rather than rejecting or truncating SHA-256 identities. Repository
resolution must still establish whether an input is a full or abbreviated ID.
V2 comment sanitization now preserves literal leading/trailing filename whitespace.
Round-trip tests cover SHA-256 export/import, drafts, image Markdown and submission
metadata; this does not migrate short-key records or enable canonical-only writes.
The conflict-preserving ownership policy below governs existing aliases.

Alias-aware storage bridge (2026-09-07): the drawer now resolves review input
through the selected repository before loading or saving. New records use full
IDs. Existing account-scoped V1/V2 keys and account drafts whose IDs prefix the
resolved commit are independently verified by Git, never associated on prefix
alone. A single existing key remains the storage owner; short/full conflicts
fail explicitly and remain exportable without overwriting or deleting either
record. Draft edits follow the loaded storage key, not the displayed input, and
cannot create a competing key while resolution is pending. Tests cover new
canonical writes, legacy alias edits, ambiguous prefixes, and conflict-preserving
exports. The explicit ownership chooser described below now handles multiple
keys; reading alone still never chooses a winner or rewrites them.

Explicit alias reconciliation (2026-09-07): conflicts discovered during load or
save show all candidate records for inspection and require an active-record
choice. The store re-resolves Git identities and checks the observed snapshots
before recording that choice in a separate account-scoped namespace. No review,
comment ID, submission metadata, draft, or reviewed flag is merged, overwritten,
or deleted. Existing keys remain the owners of their contents; new reviews still
use full IDs. The selected record can evolve normally, but any new/removed alias
or changed alternative invalidates the choice and exposes the conflict again.
Exports retain both V2 records; imports do not silently import a winner. Deleting
all reviews also clears choice metadata. Tests cover stale choices, active and
alternative edits, export preservation, draft retention, cleanup, and keyboard
selection/reload. This is non-destructive logical reconciliation, not a physical
canonical-key rewrite. Full live conflict recovery remains an acceptance case.

`chat/git-review-store.ts` currently stores account-scoped V2 commit records and
local drafts, with `file_path`, `side` (`old`, `new`, `context`), line, hunk hash,
snippet, revision, and submission identifiers. Keys accept abbreviated hashes;
there is no comparison identity or selected merge parent. Therefore:

1. The renderer-only migration keeps V2 storage, exports, submission IDs, and
   local drafts unchanged. Add adapter fixtures proving old records still
   display and save without losing fields. A renderer switch cannot itself mark
   a review dirty, reviewed, submitted, or resolved.
2. Resolve new abbreviated commit inputs to full object IDs before persistence.
   Resolve legacy abbreviations only against the explicitly selected repository;
   ambiguity is an error. Do not overwrite conflicting full/short-key records or
   delete old records on read. Define a conflict-preserving migration and export
   test before enabling canonical-key writes for existing records. Account for
   the repository's object format rather than assuming every full ID is 40 chars.
3. New comparison reviews need a versioned namespace keyed by account,
   repository context, pinned endpoints, comparison mode, and selected parent
   where applicable. Preserve current commit-review sharing across worktrees.
   A reviewed commit does not imply a reviewed branch range or merge resolution.
   Do not automatically copy V2's reviewed flag into new comparison scopes.
4. Legacy `context` anchors require both line maps plus snippet/hunk evidence.
   If the side or merge-parent provenance cannot be established, show the
   original comment in an unmatched/legacy section. No nearest-line guessing.
5. Target changes first flush/retain drafts under the old target, then load the
   new one. Test close/reopen, reload, offline/reconnect, and concurrent windows
   using the existing store's conflict behavior. Do not introduce last-write-wins
   loss while adding comparison records.

Live index/worktree reviews stay separate from commit reviews. Refresh explicitly
reanchors against a new generation; ambiguous comments remain visible and
unmatched. Do not mark newly changed content reviewed because a previous working
diff was reviewed.

### Navigation and action defaults

- Offer a working-copy selector, history ref selector, and comparison selector
  as separate controls. Browsing a ref never checks it out. Default history to
  the selected checkout's HEAD when no explicit origin/target was supplied.
- For an explicit agent commit link, prefer its validated origin context. For
  a bare hash in a known repository, resolve the commit independently of the
  currently listed history; then apply the containment heuristic in Phase 1.
  Do not scan the user's filesystem to guess an unrelated repository.
- History can include merge commits through the remembered "Show merge commits"
  checkbox (hidden by default per the September 8 request). Default the selected history view to
  first-parent with an explicit all-ancestors option. Reviewing an unmerged
  branch contribution uses its chosen base's merge-base and the pinned head;
  an explicit two-tree comparison remains a separate mode. If no unique base
  can be established, ask the user to choose instead of assuming `main`.
- An already merged branch can have an empty merge-base diff. Offer the merge
  commit versus its first parent, another selected parent, or saved original
  endpoints. Squash/rebase history cannot reliably reconstruct original PR
  boundaries without saved metadata. Explain this rather than inventing them.
- Preserve the readable sticky header. Clicking its path copies the absolute
  project-filesystem path when a working-copy locator is known; provide a
  repository-relative copy action too. The current implementation actually
  copies `file.path`, generally repository-relative. Do not label a historical
  deleted path as an existing current file. Include revision/context explicitly
  in a separate copy-review-reference action useful for agent prompts.
- In a historical review the primary opening action is "View at this revision".
  Offer "Edit in this worktree" separately when a working copy is selected.
  Working changes may use "Open". Deletions use the old source; renames expose
  both paths. Unsupported binary/submodule entries show metadata, not fake text.
- Before a write-oriented agent request, resolve and verify the selected
  worktree again. Reuse an existing thread only when its effective project and
  working directory match; otherwise offer a new correctly rooted thread or
  cancel. Do not change a running thread's directory or infer it from prompt
  text. Read-only feedback may describe history, but it must not promise an
  editable historical checkout.
- Persist view preferences separately from review data: unified/split, wrap,
  and font size. Preserve per-target location using semantic anchors. A changed
  ref offers Refresh; it must not silently replace a review while typing.

### Git access and asynchronous state

Start with a typed Git-read facade over the existing
`webapp_client.project_client.exec` path used by `runGitCommand`. Share it with
TimeTravel instead of adding more unrelated shell-command builders. Keep argv
separate from user input, use literal path handling and appropriate separators,
and make external diff/text-conversion behavior explicit. Before any new project
API, read `scalable-architecture.md`; use the existing authorized project-host
route, not a new hub-mediated file-data path.

The facade needs operations for repository/worktree discovery, ref resolution,
paged history, comparisons, changed-file metadata, and immutable blob reads.
Use machine-readable/NUL-delimited output for paths; include fixtures for spaces,
Unicode, tabs/newlines, leading dashes, and pathspec-like names. Treat symlinks,
submodules, inaccessible paths, missing objects, shallow clones, and removed
worktrees explicitly. No automatic fetch, checkout, stash, worktree creation, or
dependency installation as a side effect of viewing a review.

Cache discovery briefly (initial target: 30 seconds) and coalesce identical
requests. Immutable contents use a byte-bounded LRU keyed by project/repository,
object ID, and source identity. Bound concurrent reads and history pages; retain
the current output limits initially. Ref/worktree Refresh invalidates mutable
metadata, not already pinned review contents. Reject truncated command output
as incomplete rather than parsing it as a complete repository/diff.

Every asynchronous result carries a target/request generation. Switching refs,
files, projects, or closing the viewer invalidates stale results, including
errors. Unsupported operation, missing object, unavailable project, empty diff,
and transport failure are distinct UI states. Never replace a failed revision
read with the current file or reset a branch selector to HEAD after a timeout.

Search indexes the loaded normalized diff, not rendered DOM. Retain filename
matches and map line matches to source coordinates before navigating/highlighting
through the adapter. Missing context can be fetched only from the exact source;
label the search scope and truncation. Side-by-side source copying uses the chosen
side/range, excluding gutters and patch markers but preserving real operators.
Keep explicit Copy patch separate; do not silently hijack normal partial-text
selection with a whole-file or whole-hunk copy.

### Delivery order and release gates

| Change-set                         | Boundary and evidence                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Fixtures and contracts          | Extract renderer-neutral models/command interfaces and capture legacy review/search/scroll behavior. Add disposable Git repositories and the real-editor/header lifecycle checks. No default renderer change.                                                                                        |
| 2. Git renderer integration        | Put Pierre behind a renderer toggle inside the existing shell. Reuse the custom header, command dispatcher, durable comments, review actions, search, and semantic scroll state. Do not run two active keyboard handlers or render two full diffs. Pass legacy-record and real Slate/copy checks.    |
| 3. Read-only worktree/ref browsing | Add the Git facade and independent selectors, pinned commit resolution, stale-result protection, and immutable file opening in TimeTravel. Test the same commit across worktrees, no-worktree history, and no checkout/index changes. Keep cross-worktree write actions disabled until change-set 5. |
| 4. Range and merge review          | Add explicit base/head/parent UI and versioned comparison records with non-destructive legacy handling. Test divergent, merged, squash/rebase, root-commit, empty, and force-moved-ref cases.                                                                                                        |
| 5. Agent context                   | Carry validated project/repository/worktree/target through links, feedback, and new turns; reject mismatched existing-thread mutation routing. Test busy threads and a worktree disappearing or changing branch between selection and submission.                                                    |
| 6. Other diff surfaces             | Reuse the adapter for TimeTravel text comparisons, preserving rich historical viewers and restore semantics. Then add the proven sparse-hunk activity adapter with bounded streaming updates. Do not change inline Slate activity Markdown rendering.                                                |
| 7. Default and cleanup             | After the compatibility matrix passes, make Pierre the only renderer. Delete Classic rendering, its selector and the experimental modal, retaining reusable review logic and rich non-diff viewers. The maintainer explicitly rejected a rollback window on September 7.                             |

For every change-set run package-local types/tests and frontend lint where
applicable. For each interactive milestone run the real-renderer browser suite
plus the full-app cases it cannot cover. Resolve dev browser targeting through
the supported CLI/auth flow early, or arrange a maintainer-driven checklist;
do not call stubbed editor tests full-app validation. Record fixture versions,
browser/viewport, cold/warm measurements, and observed regressions. The positive
manual performance result permits integration work now; it does not justify
unbounded loads or a worker pool per component. Share a bounded worker pool and
verify packaging/CSP behavior before adopting it by default.

Acceptance matrix: Git commit and working changes; branch/range/merge review;
TimeTravel Git, patchflow, snapshot and backup text diffs plus rich-document
regression checks; sparse and streaming activity diffs; existing and new reviews;
copy/open/agent actions; focus/keyboard/narrow layout; old and new source sides.
At each milestone verify the exact target remains correct after changing refs,
switching worktrees, reopening, and receiving late network results. No plan or
test can promise zero bugs; these are the gates for confident staged delivery.

Excluded from this implementation: semantic definition lookup/LSP, automatic
checkout/stash/merge/branch creation, filesystem-wide repo discovery, and GitHub
PR API synchronization. Reserve the contracts for future definition previews as
described below, but do not make them prerequisites for this release.

## Phase 1: repository, history target, and working copy

Separate these identities:

- Repository: project plus resolved Git common directory.
- History target: full commit ID, branch tip, or pinned comparison endpoints.
- Working copy: optional registered worktree, needed for working changes and
  editing/actions, not for reading history.

Discover worktrees with `git worktree list --porcelain -z`, refs with
`for-each-ref`, and repository identity with `rev-parse`. Cache discovery briefly
per repository, refresh on demand, and inspect status only for the selected
worktree. Avoid recursive project-directory scanning and per-render ancestry
walks. Resolve abbreviated hashes to full object IDs before saving reviews.

Browsing refs must not run checkout/switch. A branch with no available worktree
still supports read-only historical viewing. Handle detached, locked, stale,
and removed worktrees explicitly. Cross-project discovery requires explicit
project context and normal access checks; a shared remote URL is not proof
that two directories are the same local repository.

For bare commit links, show the commit immediately. Prefer explicit originating
context; otherwise select a uniquely matching worktree when the current
checkout does not contain the commit. Show a chooser on ambiguity. Containment
after merging does not identify the original branch. Never switch contexts
silently while the user is composing review feedback.

Name both actions: "View at this revision" and "Edit in this worktree".
Review/commit agent requests carry the repository, selected worktree, commit or
comparison, and paths explicitly. The thread helper now routes directory
mismatches to a new thread; request-time worktree validation and explicit
routing controls must still precede cross-worktree mutations. Do not silently
repurpose a running agent's worktree.

## Phase 2: comparisons and TimeTravel

Offer combined diffs and individual commits against an explicit base. Pin the
resolved base/head IDs for the review, with explicit refresh when refs move.
Use merge-base comparisons for unmerged branch review, and recorded merge
parents or saved review endpoints to review an already integrated change.
Handle merge conflict resolutions explicitly; `--no-merges` must not hide them
from a complete release review. Branch upstream is not necessarily the PR base.

A shared historical source descriptor should identify:

```ts
type HistoricalLocation = {
  projectId: string;
  source: GitRevision | PatchflowRevision | SnapshotRevision | BackupRevision;
  path: string;
  line?: number;
  column?: number;
};
```

These are conceptual types, not a new production API. GitRevision includes
repository identity and full commit ID. Other variants include their source's
stable version identifier. Diff sides each have their own descriptor; deleted
files and renamed paths use the old side's location.

Extend TimeTravel to open an arbitrary descriptor without first finding it in
the current file-history slider. For missing diff context, load immutable file
contents lazily through existing project access/routing. Preserve rich document
viewers; Pierre would replace text diff rendering only. Snapshot/backup sources
retain their source-specific restore semantics.

## Phase 3: activity diffs and durable agent context

Keep explicit activity provenance: project, working directory, session/turn,
event ID/sequence, path, and known before/after content or blob identifiers.
An activity event is not automatically a Git commit and the live file may have
changed since it occurred. Do not synthesize complete document contents by
concatenating the existing sparse LineDiffResult lines.

Prefer a structured hunk adapter with numeric old/new line positions, or retain
the original unified patch upstream. Existing formatted gutters need an
explicit tested legacy adapter if reused. Incomplete events show their
limitations; lazy expansion must never fetch unrelated current contents.
Streaming updates should be coalesced and must not rebuild an entire multi-day
log or launch a new worker pool per event.

Agent commit links should carry originating repository/worktree/branch context
and a full hash. Review status is shared for the same immutable commit; a
changed/rebased commit or changed comparison requires review again. Later,
range-diff can help explain changes between reviewed versions.

## Future: definition lookup (not part of this implementation)

Reserve a renderer-independent token interaction that passes HistoricalLocation,
diff side, token range, and identifier to a resolver. The renderer knows where
the click occurred; it does not decide what the symbol means.

For `withBackupEvidenceAbort`, the eventual experience is a definition preview
with signature, source, revision, and an action to open that version in
TimeTravel. Deleted lines resolve against the old revision; added lines against
the new revision. For merge reviews, the old side is the selected parent/base.

Implementation stages, in increasing cost:

1. Search declarations in the exact historical file/tree, using syntax-aware
   indexing where available. Label candidates as search results when ambiguous;
   name matching alone is not semantic go-to-definition.
2. Resolve imports/exports for selected languages, initially TypeScript and
   JavaScript, against the same tree and configuration.
3. Provide semantic lookup with a language service over an isolated immutable
   revision filesystem or a bounded materialized workspace. Cache by repository,
   revision, language configuration, and dependency state. Account for missing
   generated sources, dependencies, and monorepo project references.

Do not send historical positions to an LSP attached to today's checkout and
present the answer as exact. Do not automatically checkout, install dependencies,
or execute repository setup to answer a read-only lookup. Unsupported languages
can offer honest revision-scoped search. Patchflow file revisions may lack a
consistent whole-project snapshot; activity patches may lack complete old/new
trees. In those cases, limit claims to available content and label any separately
requested working-copy lookup as current, not historical.

## Evaluation record

The initial prototype passed frontend TypeScript build and lint, the development
Rspack build, four focused Jest tests, and three Node tests against the real
pinned Pierre parser. Jest covers keyboard line navigation, missing-context
feedback, temporary draft state across layout changes, frozen preview input,
Escape dismissal, and trigger focus restoration. The renderer and Markdown
editor are mocked in Jest; those tests do not validate actual editor portals or
virtualization. The separate parser tests exercise sparse old/new coordinates,
full-document context, and a truncated hunk.

Run the focused tests with:

```sh
pnpm -C src/packages/frontend exec jest --runInBand components/diff-viewer
pnpm -C src/packages/frontend exec node --experimental-strip-types --test components/diff-viewer/pierre-model.test.mjs
```

The initial manual trial exposed missing viewport overflow styling and a file
selector that changed only the line-jump target. The follow-up gives CodeView its
own bounded scroll viewport, navigates immediately on file selection, and wraps
long lines by default with an explicit toggle. Split/unified settings update in
place; no renderer remount workaround is used. Annotation additions also publish
an item version: Pierre otherwise retains the old payload despite new React
item objects. Draft body edits remain React-only and do not change that version.

A standalone Chromium regression now exercises the actual React/Ant Design/Pierre
integration: wheel scrolling, file selection, line jumping, split/unified and
wrap updates, annotation draft preservation across a layout change, and width
containment at 1200, 600, and 320 pixels. It also verifies sticky filenames across
files, focused keyboard scrolling, editable spaces, background shortcut isolation,
and Escape/focus restoration using the real keyboard boundary. Only application services and the rich
editor are stubbed, so it does not validate real Slate behavior. Run it with:

```sh
node src/packages/frontend/components/diff-viewer/pierre-preview.browser-test.mjs
```

It defaults to `/usr/bin/chromium`; override with `CHROMIUM_PATH`. Full live-app
automation is still outstanding: hub discovery returned no active sessions and
dedicated spawning could not obtain cookie-backed authentication in this runtime.
The maintainer subsequently supplied an isolated signed-in Chrome through CDP
on port 9222, and live preview inspection now works. The disappearing comment
image was observed with naturalWidth 1194 but rendered width/height zero and an
inline width of 0px, while its Markdown source remained present. A regression
test confirms the old image-load handler overwrote dimensions with zero when
layout was unavailable. The handler now ignores zero-size measurements.
The maintainer confirmed the fix; the rebuilt frontend also passed 15 real
Slate/Pierre unmount/remount cycles with the same image in a temporary comment
(final rendered size 694x838). That automated trial inserted the image through
Markdown mode, not the upload pipeline. In-flight uploads and local undo remain
separate acceptance gates; do not infer them from image rendering persistence.

Large-diff benchmarks, real Slate image-paste/undo, and virtualized source copying
remain acceptance gates. The preview is not a production renderer replacement.

Initial plan sources: https://diffs.com/, Pierre's package source and
https://pierre.computer/writing/on-rendering-diffs. Consult the installed pinned
version's APIs rather than assuming the latest main-branch documentation matches.
