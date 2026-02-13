# Make Opening Files Fast

## Motivation

Planning - no code yet.  OK, moving on, I want to discuss a core performance problem in CoCalc, and see what _you_ think about it.

As one navigates a workspace, it's very common of course to open and read files.  Sometimes you actually edit those files, run code in them (jupyter notebooks), type chat messages, etc.

PROBLEM: Right now in cocalc-plus (lite mode) it takes about 1 second to open a text file.   With Cocalc launchpad it typically takes 2 seconds the first time.

This is really, really bad.  E.g., with cocalc-plus, the file is right there on the same computer as the web browser, so the "ping time" is a few ms, if that. It should take a few ms, plus whatever React/UI time there is, not 1 seconds.

This file open speed problem is very likely "make or break" for cocalc-ai as a product.

It is also probably quite easy to fix.  The reason opening files is slow is because of our full realtime collaboration and TimeTravel history system.  Opening a file means setting up a realtime collaboration (RTC) session (which involves creating or opening one or more new sqlite db's), then loading the last snapshot (if there is one), then replaying the edit history from that snapshot until now, and finally showing the file in the browser. 

RTC is setup here: `build/cocalc-lite4/src/packages/sync/editor/generic/sync-doc.ts` 

In the frontend the core instantiation and wait is here; `/home/wstein/build/cocalc-lite4/src/packages/frontend/frame-editors/base-editor/actions-base.ts` 

But, here's the thing, I also wrote a fs RPC api, with a function `fs.readFile(path,'utf8')` that very efficiently returns the file's contents.  That's _usually_ (but not always) what RTC would show -- it only differs when there is active unsaved-to-disk editing happening, which is very rare.   And, in this new age of AI, it's extremely rare.  People do a lot of typing into chat boxes, Codex (you) edit files on disk, then people open and read those files.  They rarely edit them manually.

So I suspect this whole experience could be massively better if we did the following instead:

- have `build/cocalc-lite4/src/packages/sync/editor/generic/sync-doc.ts` simply read the file from disk immediately and claim it is 'ready' (but read only) with that value.
- then asynchronously actually do the exact current initialization,
- finally switch the live value over when it is known (e.g,. 2 seconds later).

Question: what do you think of this?

I've never actually tried this, but done very carefully, it has to work. And given that ping times globally to cocalc hosts will be at most about 100ms, it should keep the file open time well under 300ms.   But maybe I'm missing something?

Optimally the above might be done via a wrapper object or a derived class, so that the sync-doc.ts code is unchanged.

Note also that sync-doc.ts really is an abstract base class, and one of the ones that is really used is in `/home/wstein/build/cocalc-lite4/src/packages/sync/editor/string/doc.ts` for plain text.  We could focus on that first.

I also do know for sure that initializing the syncdoc is most of the time to open a file -- I checked that.

Thoughts?

## Commit-by-Commit Checklist

1. **(done) Commit 1: Add open latency instrumentation**
   - Files:
     - [src/packages/frontend/project/open-file.ts](./src/packages/frontend/project/open-file.ts)
     - [src/packages/frontend/frame-editors/base-editor/actions-base.ts](./src/packages/frontend/frame-editors/base-editor/actions-base.ts)
     - [src/packages/sync/editor/generic/sync-doc.ts](./src/packages/sync/editor/generic/sync-doc.ts)
   - Add timing marks/events for:
     - `open_start`
     - `optimistic_ready`
     - `sync_ready`
     - `handoff_done`
     - `handoff_differs`
   - Keep behavior unchanged.

2. **(done) Commit 2: Add feature flag and optimistic read-only bootstrap for plain text**
   - Files:
     - [src/packages/frontend/frame-editors/base-editor/actions-base.ts](./src/packages/frontend/frame-editors/base-editor/actions-base.ts)
     - [src/packages/frontend/frame-editors/base-editor/actions-text.ts](./src/packages/frontend/frame-editors/base-editor/actions-text.ts)
   - Only for `syncstring` docs:
     - Start `fs.readFile(path, "utf8")` immediately.
     - Set `value` and `is_loaded = true` from disk result.
     - Force read-only while live sync is still loading.
   - On bootstrap read failure, fall back to current behavior.

3. **Commit 3: Deterministic handoff to live sync value**
   - Files:
     - [src/packages/frontend/frame-editors/base-editor/actions-base.ts](./src/packages/frontend/frame-editors/base-editor/actions-base.ts)
     - [src/packages/frontend/frame-editors/frame-tree/editor.tsx](./src/packages/frontend/frame-editors/frame-tree/editor.tsx)
   - When syncdoc becomes ready:
     - Compare optimistic value vs live `to_str()`.
     - If equal, clear loading status and restore normal read-only rules.
     - If different, atomically switch to live value and show a subtle status/notice.
   - Keep edit actions gated until live sync is ready.

4. **Commit 4: Add frontend unit tests for fast-open state machine**
   - Files:
     - [src/packages/frontend/frame-editors/base-editor/tests/actions-fast-open.test.ts](./src/packages/frontend/frame-editors/base-editor/__tests__/actions-fast-open.test.ts) (new)
     - [src/packages/frontend/frame-editors/base-editor/tests/actions-structure.test.ts](./src/packages/frontend/frame-editors/base-editor/__tests__/actions-structure.test.ts)
   - Cover:
     - optimistic load sets `is_loaded` early
     - read-only enforced before live ready
     - equal-content handoff
     - differing-content handoff
     - fallback when optimistic read fails

5. **Commit 5: Add sync-doc coverage for divergence assumptions**
   - Files:
     - [src/packages/backend/conat/test/sync-doc/syncstring.test.ts](./src/packages/backend/conat/test/sync-doc/syncstring.test.ts)
     - [src/packages/backend/conat/test/sync-doc/syncstring-bench.test.ts](./src/packages/backend/conat/test/sync-doc/syncstring-bench.test.ts)
   - Add tests for:
     - disk content diverges from live unsaved state
     - handoff correctness assumptions remain valid
   - Keep benchmark tests informative, not flaky.

6. **Commit 6: Add rollout controls and monitoring hooks**
   - Files:
     - [src/packages/frontend/frame-editors/base-editor/actions-base.ts](./src/packages/frontend/frame-editors/base-editor/actions-base.ts)
     - [src/packages/frontend/project/open-file.ts](./src/packages/frontend/project/open-file.ts)
   - Feature flag defaults to off.
   - Log counters/distributions for:
     - optimistic open success rate
     - handoff diff rate
     - fallback/error rate

7. **Commit 7: Enable in lite mode first**
   - Scope:
     - Toggle flag on for lite, keep launchpad default off.
   - Validate:
     - local p50 open &lt; 300ms
     - no regressions in save/history/readonly behavior

8. **Commit 8: Enable in launchpad after validation**
   - Scope:
     - Gradual enable for launchpad.
   - Validate:
     - p50/p95 improvement vs baseline
     - no increase in file-open failures

9. **Commit 9 (optional cleanup): encapsulate as wrapper/facade**
   - Files (proposed):
     - [src/packages/sync/editor/string/fast-open-sync.ts](./src/packages/sync/editor/string/fast-open-sync.ts) (new)
     - [src/packages/conat/sync-doc/syncstring.ts](./src/packages/conat/sync-doc/syncstring.ts)
   - Move optimistic-first orchestration into a dedicated wrapper so [src/packages/sync/editor/generic/sync-doc.ts](./src/packages/sync/editor/generic/sync-doc.ts) remains unchanged.

## Current Status (Updated)

Completed and validated in this branch:

- Fast open for syncstring text files is implemented and enabled by default.
- Users see file content quickly from `fs.readFile`, then handoff to live RTC.
- Open-phase timings are logged and rendered in project log entries.
- Handoff-diff behavior is implemented and tested.
- Regressions fixed:
  - ctrl/cmd+click behavior in explorer/flyout.
  - project log crash for missing filename.
  - open-event updates now preserve filename/action/path metadata.

Still pending:

1. Additional polish/testing for edge cases (background tabs, refresh behavior, remote-host latency).
2. Extend fast-open pattern to non-text editors (likely notebook-related first).
3. Tune RTC indicator wording/placement based on real usage feedback.

## Next Commit Checklist

1. Add targeted tests for RTC indicator state transitions and non-regression.
2. Design and implement fast-open for one non-text editor path as pilot.
3. Add focused telemetry/bench script for launchpad p50/p95 initial-visible and live-ready timings.
