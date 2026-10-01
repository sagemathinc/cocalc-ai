/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
export const SCAN_FILES_BODY = String.raw`
## When you need a scan

**People** brings conversations and other supported project resources together
without moving their files. Conversations still use CoCalc's existing chat
files, and project access still determines what you can see.

Normal supported open and write activity updates the index automatically. If
you work through People and CoCalc's editors, you ordinarily do not need to
scan. Scanning is an explicit recovery tool for resources created or changed
outside those paths, such as chat files copied into project storage by an
external tool. It is never an automatic sweep of your project filesystem.

## Choose projects

Open **People -> Scan Files**. Projects appear with the most recently edited
first. Type in **Search projects** to filter the list; there is no need to
press Enter. Selections remain when you change the filter. Use **Shift-click**
on a checkbox to select or clear a range in the visible filtered order. You
can also move between checkboxes with the arrow keys, Home, and End, and
select with Space.

**Changed since last scan** selects projects whose last edit is newer than
the start of their most recent successful scan, plus projects that have never
been successfully scanned. This is a useful shortcut, not proof that a scan
is needed: ordinary indexed work also updates edit times, while some external
filesystem changes may not update them. Edits during a scan remain candidates
for another scan. Failed, unavailable, cancelled, or partial scans do not move
this successful-scan baseline forward. The history is for scans you requested;
another collaborator's scan does not change your shortcut.

**All eligible projects** selects every project available for scanning,
including those hidden by your current filter. **Changed since last scan**
also uses the full project list. Individual selections use the filtered list.

## Run a scan

Select projects and choose **Start scan**. The server fixes and authorizes the
selection when the request is admitted, and checks access again when executing
each project. New scans prioritize recent edits; projects can finish in a
different order. Scanning reads supported resources from project storage and
**does not start project compute**. Storage must still be available.

The operation continues independently of the page. Reopening Scan Files or
refreshing status observes that operation; it does not start another scan.
Resources found by a scan may take a moment to appear in People. Files can
change during a scan, so it is not an atomic snapshot of all your projects.

## What is searched

Each selected project runs a host-side filename search for current **.chat** files. Legacy **.sage-chat** files are not scanned. Hidden files and files excluded by Git or other ignore
rules are included. **.snapshots** directories are excluded, symbolic links
are not followed, and the search stays on the project filesystem.

Matching JSONL chat files are parsed to extract conversations and agents, their titles and stable identities, human participants, latest message activity, references, and published artifact metadata. Archived chat history is included when available so older participants are preserved. Metadata-only edits do not count as new conversation activity.

Scans are incremental per project: only chat files with modification times at or after the start of the last successful scan are indexed. Changes to registered archived history also select their chat files. A first scan reads all matching files. This uses modification times; preserving or manually changing timestamps can hide external changes.

Unreadable, malformed, oversized, or conflicting chat files are reported as skipped. They do not prevent a scan from succeeding. Temporary storage or service failures prevent success, and the next scan uses the unchanged successful-scan baseline. Cancellation also leaves that baseline unchanged. Last successful and failed scan times refer to when each scan started, so edits made during a scan remain eligible next time.

Matching changed files are read and parsed through the normal indexing pipeline. A
scan finishes successfully after changed files are either acknowledged as indexed or reported as skipped; finding filenames alone is not completion. Details show how many chat files were indexed and list up to five files needing attention. A failed result means a temporary service problem or incomplete filename search prevented completion; successful results are kept. Duplicate or copied identities must be resolved before those files can be indexed. Search time, output size, and
candidate counts are bounded. An incomplete search is never reported as a
complete scan. Unrelated files are not read or parsed.

## Understand the results

The number of **projects scanned** counts complete and partial scans. A
project that is unavailable, deferred, cancelled, or failed is not counted as
scanned just because its request has finished. Expand **Scan details** for
project titles, outcomes, and any available explanation.

- **Scanned:** the scan completed successfully.
- **Partial:** a bounded scan ended before covering all eligible resources;
  results already indexed are retained.
- **Unavailable:** the service could not confirm access to the needed storage
  or execution state. This does not mean that the project is empty.
- **Deferred:** cooldown or admission limits prevented this attempt.
- **Cancelled:** the remaining scan work was cancelled; any results already
  indexed are retained.
- **Failed:** the scan reported an execution failure.

Choosing **Cancel scan** requests cancellation of running work and prevents
remaining queued work from starting. Cancellation is an ordinary action;
a neutral progress bar accompanies the final cancellation result. If a host
is unreachable, its state can remain unavailable rather than confirming that
it stopped. Cancellation does not undo indexed results.

**Select unsuccessful projects for retry** prepares a selection. It does not
start a scan until you choose **Start scan**, and any remaining cooldown still
applies. If a submission's outcome is unknown, use **Refresh scan status** or
**Retry same scan request** to recover the saved request rather than admitting
a replacement operation.

An administrator may disable new scans. Existing status and cancellation
remain available.
`;
