/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared steps for adding assignment and handout folders to a course, so that
// adding always ends in the item appearing or a visible error.

import { exec } from "../../frame-editors/generic/client";
import { projectRunWaitReason } from "../../project/project-start-warning";

export const ADD_FOLDER_TIMEOUT_MS = 60_000;

// The course project or the course file is unavailable: adding any other
// folder now would fail the same way.
export class CourseUnavailableError extends Error {}

// Create the folder in the course project. exec first waits for the project
// to be running, and that wait has no limit (a stopped project, or one whose
// host is unavailable, may never get there), so bound the whole step.
export async function ensureCourseFolder({
  project_id,
  path,
  itemName,
  timeoutMs = ADD_FOLDER_TIMEOUT_MS,
}: {
  project_id: string;
  path: string;
  itemName: string;
  timeoutMs?: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      const reason = {
        "not-running": "the course project is not running",
        "host-unavailable": "the course project's host is not reachable",
      }[projectRunWaitReason(project_id) ?? ""];
      reject(
        new CourseUnavailableError(
          `${reason ?? "the course project did not answer"} (waited ${seconds} seconds), so the ${itemName} "${path}" was not added. Reload the page or restart the course project, then try again.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const output = await Promise.race([
      exec({
        project_id,
        command: "mkdir",
        args: ["-p", path],
        err_on_exit: true,
      }),
      timeout,
    ]);
    // exec returns (rather than throws) a failed result when the project was
    // not started, e.g. the user declined to start it.
    if (output?.exit_code) {
      throw new CourseUnavailableError(
        `${output.stderr || "the course project is not running"} -- the ${itemName} "${path}" was not added.`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

// Wait (bounded) until the course file is loaded, so the new item is saved
// now rather than silently queued.
export async function waitForCourseData({
  syncdb,
  timeoutMs = ADD_FOLDER_TIMEOUT_MS,
}: {
  syncdb?: { get_state: () => string; wait_until_ready: () => Promise<void> };
  timeoutMs?: number;
}): Promise<void> {
  if (syncdb?.get_state() === "ready") return;
  const notLoaded = new CourseUnavailableError(
    "the course file has not finished loading. Reload the page, then try again.",
  );
  if (syncdb == null || syncdb.get_state() === "closed") throw notLoaded;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      syncdb.wait_until_ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(notLoaded), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Add each path, continuing past failures, and report every failure at once.
// Stop early when the course is unavailable, or once the whole batch has
// taken longer than deadlineMs, so a batch is bounded and not N timeouts.
export async function addEachPath(
  paths: string[],
  add: (path: string) => Promise<void>,
  deadlineMs: number = 2 * ADD_FOLDER_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  const errors: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    if (i > 0 && Date.now() > deadline) {
      errors.push(`not added (took too long): ${paths.slice(i).join(", ")}`);
      break;
    }
    try {
      await add(paths[i]);
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
