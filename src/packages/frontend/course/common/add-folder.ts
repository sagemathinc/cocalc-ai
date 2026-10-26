/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared steps for adding assignment and handout folders to a course, so that
// adding always ends in the item appearing or a visible error.
//
// Every stage is bounded by its own timeout and by an absolute deadline for
// the whole add (or batch of adds). A stage that times out is not cancelled,
// but nothing is chained after it: the course record is only written after
// all stages finished in time, so a timeout is never followed by a late item.
// (A late mkdir can still create the empty folder, which is harmless.)

import { exec } from "../../frame-editors/generic/client";
import { projectRunWaitReason } from "../../project/project-start-warning";

export const ADD_FOLDER_TIMEOUT_MS = 60_000;
// The whole add of one or more folders.
export const ADD_DEADLINE_MS = 2 * ADD_FOLDER_TIMEOUT_MS;

// The course project or the course file is unavailable, or the add ran out
// of time: adding any other folder now would fail the same way.
export class CourseUnavailableError extends Error {}

export function addDeadline(): number {
  return Date.now() + ADD_DEADLINE_MS;
}

// Resolve or reject as promise does, or reject with timeoutError() after
// timeoutMs or at the deadline, whichever comes first.
async function bounded<T>(
  promise: Promise<T>,
  {
    timeoutMs,
    deadline,
    timeoutError,
  }: {
    timeoutMs: number;
    deadline?: number;
    timeoutError: (waitedMs: number) => Error;
  },
): Promise<T> {
  const ms = Math.max(
    0,
    Math.min(timeoutMs, deadline == null ? Infinity : deadline - Date.now()),
  );
  if (!Number.isFinite(ms)) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Create the folder in the course project. exec first waits for the project
// to be running, and that wait has no limit (a stopped project, or one whose
// host is unavailable, may never get there), so bound the whole step.
export async function ensureCourseFolder({
  project_id,
  path,
  itemName,
  timeoutMs = ADD_FOLDER_TIMEOUT_MS,
  deadline,
}: {
  project_id: string;
  path: string;
  itemName: string;
  timeoutMs?: number;
  deadline?: number;
}): Promise<void> {
  const output = await bounded(
    exec({
      project_id,
      command: "mkdir",
      args: ["-p", path],
      err_on_exit: true,
    }),
    {
      timeoutMs,
      deadline,
      timeoutError: (waitedMs) => {
        const reason = {
          "not-running": "the course project is not running",
          "host-unavailable": "the course project's host is not reachable",
        }[projectRunWaitReason(project_id) ?? ""];
        return new CourseUnavailableError(
          `${reason ?? "the course project did not answer"} (waited ${Math.round(
            waitedMs / 1000,
          )} seconds), so the ${itemName} "${path}" was not added. Reload the page or restart the course project, then try again.`,
        );
      },
    },
  );
  // exec returns (rather than throws) a failed result when the project was
  // not started, e.g. the user declined to start it.
  if (output?.exit_code) {
    throw new CourseUnavailableError(
      `${output.stderr || "the course project is not running"} -- the ${itemName} "${path}" was not added.`,
    );
  }
}

// Wait (bounded) until the course file is loaded, so the new item is saved
// now rather than silently queued.
export async function waitForCourseData({
  syncdb,
  timeoutMs = ADD_FOLDER_TIMEOUT_MS,
  deadline,
}: {
  syncdb?: { get_state: () => string; wait_until_ready: () => Promise<void> };
  timeoutMs?: number;
  deadline?: number;
}): Promise<void> {
  if (syncdb?.get_state() === "ready") return;
  const notLoaded = () =>
    new CourseUnavailableError(
      "the course file has not finished loading. Reload the page, then try again.",
    );
  if (syncdb == null || syncdb.get_state() === "closed") throw notLoaded();
  await bounded(syncdb.wait_until_ready(), {
    timeoutMs,
    deadline,
    timeoutError: notLoaded,
  });
}

// Add each path, continuing past failures, and report every failure at once.
// The whole batch shares one deadline, passed to each add (whose stages are
// bounded by it) and also enforced on each add while it runs. Stop early when
// the course is unavailable or the deadline has passed.
export async function addEachPath(
  paths: string[],
  add: (path: string, deadline: number) => Promise<void>,
  deadline: number = addDeadline(),
): Promise<void> {
  const errors: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    try {
      if (Date.now() >= deadline) {
        throw new CourseUnavailableError(
          `"${paths[i]}" was not added in time.`,
        );
      }
      await bounded(add(paths[i], deadline), {
        timeoutMs: Infinity,
        deadline,
        timeoutError: () =>
          new CourseUnavailableError(`"${paths[i]}" was not added in time.`),
      });
    } catch (err) {
      errors.push(`${err instanceof Error ? err.message : err}`);
      if (err instanceof CourseUnavailableError) {
        if (i + 1 < paths.length) {
          errors.push(`not added: ${paths.slice(i + 1).join(", ")}`);
        }
        break;
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
