/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
When an exec stream ends without a "done" event, the job in the project is
usually still running, so the client re-attaches to it by job id and keeps
showing progress. This module holds the decision of whether re-attaching is
allowed, which has more conditions than it looks.

See docs/build-coordinator.md ("Long builds and disconnected clients").
*/

// The service reports this when the job is not in its cache. Attaching is
// the only way that error can occur, and it can never succeed later.
const JOB_GONE = "no such job";

export function isJobGoneError(error: unknown): boolean {
  return `${error}`.includes(JOB_GONE);
}

export function shouldReattach({
  jobId,
  canAttach,
  jobIsGone,
  now,
  deadline,
}: {
  // The job id from the "job" event; without it there is nothing to attach to.
  jobId?: string;
  // Whether the project runtime advertised attach support on that event.
  // An older runtime does not know attach_job_id and would treat the
  // reconnect as a fresh request, running the build a SECOND time.
  canAttach: boolean;
  // The service already told us the job is gone: retrying until the deadline
  // would just delay reporting the failure by many minutes.
  jobIsGone: boolean;
  now: number;
  // Past its own timeout the job cannot still be running.
  deadline: number;
}): boolean {
  if (!jobId || !canAttach || jobIsGone) return false;
  return now < deadline;
}
