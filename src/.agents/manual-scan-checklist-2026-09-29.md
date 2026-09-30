# Manual Scan browser validation

Use a development site running the current implementation. Enable the admin
setting **Enable Manual People Scan**. The Collaborators workspace and its scan
worker must already be enabled on that development instance
(`collaborators_enabled` and `COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE=1`). This
checklist does not require changing production settings.

Record the site/build, the operation identifier shown in the Scan Files tab, and any
step that behaves differently from the expected result. No credentials are
needed in the report.

1. **Selection.** Open People → **Scan Files**. Search for a project, clear
   the search, and select two projects. Confirm the selected count is two. If
   you have more than 25 projects, use **Next project page**, then select an
   additional project; the count must retain selections from both pages.
   **Select all eligible projects** must show the account-wide count, including
   projects outside the search results/current page.
2. **Start and reload.** Click **Start scan** and expand **Operation identifier**.
   Switch to another People tab, return to **Scan Files**, and reload the browser. The same operation and fixed
   total must remain; reopening must not create another scan. Progress reports
   projects processed and separate outcomes, not an estimated percentage of files.
3. **Two tabs.** Before starting another batch, open **Scan Files** in two browser tabs with
   different selections. Start from one, then promptly start from the other if
   its button is still enabled. Both must show one operation ID and the first
   admitted selection; the second selection must not be added to it. If the
   second tab already observed the active batch, its Start button is disabled.
4. **Cancel.** Use enough test projects/files to keep a scan active, then click
   **Cancel scan**. It may finish quickly, or show **Cancelling** while waiting
   for running projects to stop. Reload during cancellation: the same operation
   must remain. A slow/unreachable host must not be reported stopped merely
   because a request timed out. If it cannot be reached, foreground processing
   ends with unavailable and a stop-unconfirmed explanation, allowing other
   projects to be scanned. The affected project's exact identity and reservation
   remain for background stop recovery. Already indexed resources remain available.
   Temporary service-busy responses may retain progress for up to 60 seconds
   without a successful host observation. After that, expect unavailable with
   busy/stop-unconfirmed wording and the same recovery protections.
5. **Results and retry.** Check that the per-project list and outcome counts
   agree. A project whose storage is unavailable should say **unavailable** and
   must not start compute. Excluded/inaccessible/limited paths may yield
   **truncated**, rather than success. After processing ends, click **Select
   unsuccessful projects for retry**. This selects them without starting work.
   Account cooldown is 60 seconds, charged before selection authorization even
   when that selection is rejected; an admitted project's cooldown is 5 minutes.
   A competing request during unfinished selection authorization may return the
   next eligible time; it must not launch a second authorization pass. Once an
   operation is admitted, replay returns that operation without another charge.
   A project with unresolved stop recovery instead remains deferred until its
   exact host/run stop is confirmed; a new batch must not replace that identity.
   Once eligible, explicitly click **Start scan**: it should create a new
   operation for your selected retry set. Selecting or reopening alone must
   never retry it. Record unavailable/truncated coverage as untested if your
   chosen projects do not exercise those cases.
6. **Disable and reenable.** While a batch is active, disable **Enable Manual
   People Scan** in another admin tab. Refresh scan status. New Start is disabled;
   current progress and Cancel remain available. Reenable the setting: no batch
   starts until you explicitly click Start. Ordinary indexing and existing
   resources remain usable throughout.
7. **Keyboard and display.** Use arrow keys, Home and End to select **Scan Files** in the
   People tab row. Tab enters its panel and controls; Enter and Space operate
   start/selection/cancel. Switch away and back without submitting new work. Repeat in dark
   mode and at 200% zoom/narrow width: controls and result details remain readable
   and reachable without losing actions offscreen.
8. **Ordinary collaboration.** Create/open a supported conversation normally,
   invite or link a second person, collaborate, then find it again in People.
   This must work without Scan. Opening People or logging in must not itself
   create a scan operation.

Reply with pass/fail for the steps you exercised, the operation ID for a failure,
and the visible error or unexpected behavior. Mark skipped cases as untested;
we will keep those validation gaps explicit.
