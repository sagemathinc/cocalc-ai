/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Bounds shared by every collaborative build (LaTeX, RMarkdown, Quarto).

These two belong together: the stale-entry cutoff must stay above the job
timeout, or a late joiner would mark a build that is still running as
finished. Deriving one from the other keeps that guarantee when the timeout
changes. See docs/build-coordinator.md.
*/

// The longest we let a build job run before the backend kills it.
export const TIMEOUT_BUILD_JOB_S = 15 * 60;

// Margin on top of the job timeout before a "running" entry in the build
// DKV is considered stranded (its originator died without publishing
// "finished"), which is generous because the job's own kill path, the final
// result write, and the DKV round trip all happen after the timeout.
const STALE_ENTRY_MARGIN_S = 5 * 60;

export const STALE_RUNNING_ENTRY_MS =
  (TIMEOUT_BUILD_JOB_S + STALE_ENTRY_MARGIN_S) * 1000;
