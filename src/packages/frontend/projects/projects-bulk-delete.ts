/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type LeaveOrDeleteProjectResult = {
  project_id: string;
  action:
    | "removed_self"
    | "transferred"
    | "hard_deleted"
    | "hard_delete_queued"
    | "error";
  new_owner_account_id?: string;
  op_id?: string;
  error?: string;
};

export type BulkLeaveOrDeleteProgressPhase = "submitting" | "waiting" | "done";

export type BulkLeaveOrDeleteProgress = {
  phase: BulkLeaveOrDeleteProgressPhase;
  project_id?: string;
  op_id?: string;
  current: number;
  total: number;
  completed: number;
  failed: number;
};

export async function runLeaveOrDeleteProjectsSequentially({
  project_ids,
  submitProject,
  waitForQueuedDelete,
  onProgress,
}: {
  project_ids: string[];
  submitProject: (project_id: string) => Promise<LeaveOrDeleteProjectResult[]>;
  waitForQueuedDelete: (opts: {
    project_id: string;
    op_id: string;
  }) => Promise<void>;
  onProgress?: (progress: BulkLeaveOrDeleteProgress) => void;
}): Promise<{ results: LeaveOrDeleteProjectResult[]; stopped: boolean }> {
  const results: LeaveOrDeleteProjectResult[] = [];
  let stopped = false;

  for (let i = 0; i < project_ids.length; i++) {
    const project_id = project_ids[i];
    onProgress?.({
      phase: "submitting",
      project_id,
      current: i + 1,
      total: project_ids.length,
      completed: successfulResults(results).length,
      failed: failedResults(results).length,
    });

    let projectResults: LeaveOrDeleteProjectResult[];
    try {
      projectResults = await submitProject(project_id);
    } catch (err) {
      results.push({
        project_id,
        action: "error",
        error: `${err}`,
      });
      continue;
    }

    const result =
      projectResults.find((entry) => entry.project_id === project_id) ??
      projectResults[0];
    if (!result) {
      results.push({
        project_id,
        action: "error",
        error: "No result was returned.",
      });
      continue;
    }

    if (result.action === "hard_delete_queued" && result.op_id) {
      onProgress?.({
        phase: "waiting",
        project_id,
        op_id: result.op_id,
        current: i + 1,
        total: project_ids.length,
        completed: successfulResults(results).length,
        failed: failedResults(results).length,
      });
      try {
        await waitForQueuedDelete({ project_id, op_id: result.op_id });
        results.push(result);
      } catch (err) {
        results.push({
          project_id,
          action: "error",
          op_id: result.op_id,
          error: `${err}`,
        });
        stopped = true;
        break;
      }
    } else {
      results.push(result);
    }
  }

  onProgress?.({
    phase: "done",
    current: project_ids.length,
    total: project_ids.length,
    completed: successfulResults(results).length,
    failed: failedResults(results).length,
  });

  return { results, stopped };
}

function successfulResults(results: LeaveOrDeleteProjectResult[]) {
  return results.filter((result) => result.action !== "error");
}

function failedResults(results: LeaveOrDeleteProjectResult[]) {
  return results.filter((result) => result.action === "error");
}
