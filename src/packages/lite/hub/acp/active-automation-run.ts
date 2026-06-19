/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  decodeAcpJobRequest,
  listQueuedAcpJobsForThread,
  listRunningAcpJobs,
  type AcpJobRow,
} from "../sqlite/acp-jobs";
import type { AcpAutomationRow } from "../sqlite/acp-automations";
import { listRunningAcpTurnLeases } from "../sqlite/acp-turns";

function acpJobMatchesAutomation(
  job: AcpJobRow,
  row: Pick<
    AcpAutomationRow,
    | "automation_id"
    | "project_id"
    | "path"
    | "thread_id"
    | "last_job_op_id"
    | "last_message_id"
  >,
): boolean {
  if (
    job.project_id !== row.project_id ||
    job.path !== row.path ||
    job.thread_id !== row.thread_id
  ) {
    return false;
  }
  const automationId = `${row.automation_id ?? ""}`.trim();
  const lastJobOpId = `${row.last_job_op_id ?? ""}`.trim();
  const lastMessageId = `${row.last_message_id ?? ""}`.trim();
  if (lastJobOpId && job.op_id === lastJobOpId) return true;
  if (lastMessageId && job.assistant_message_id === lastMessageId) return true;
  try {
    return (
      automationId.length > 0 &&
      `${decodeAcpJobRequest(job).chat?.automation_id ?? ""}`.trim() ===
        automationId
    );
  } catch {
    return false;
  }
}

export function automationHasActiveBackendRun(row: AcpAutomationRow): boolean {
  const queued = listQueuedAcpJobsForThread({
    project_id: row.project_id,
    path: row.path,
    thread_id: row.thread_id,
  });
  if (queued.some((job) => acpJobMatchesAutomation(job, row))) {
    return true;
  }
  if (listRunningAcpJobs().some((job) => acpJobMatchesAutomation(job, row))) {
    return true;
  }
  const lastMessageId = `${row.last_message_id ?? ""}`.trim();
  if (!lastMessageId) return false;
  return listRunningAcpTurnLeases().some(
    (lease) =>
      lease.project_id === row.project_id &&
      lease.path === row.path &&
      lease.thread_id === row.thread_id &&
      `${lease.message_id ?? ""}`.trim() === lastMessageId,
  );
}
