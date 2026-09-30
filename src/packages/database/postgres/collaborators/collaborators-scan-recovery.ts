/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { transaction } from "./collaborators-common";
import { assertCollaborationOwnerAuthority } from "./collaborators-owner";
import type { CollaborationOwnerAuthority } from "./collaborators-owner";
import { scanJobPage } from "./collaborators-scan";
import type {
  ScanChild,
  ScanChildRequest,
} from "@cocalc/util/collaboration-scan-batch";

/** End foreground observation, NOT execution. Keep the project reservation and
 * exact host/run identity until a real stop acknowledgment arrives. No lifecycle
 * label or transport error authorizes deleting these execution records.
 */
export async function retainUnavailableScanChild(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
  reason: "unreachable" | "busy" = "unreachable",
): Promise<ScanChild | undefined> {
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const prior = (
      await db.query(
        `SELECT receipt,result FROM collaboration_scan_receipts
       WHERE project_id=$1 AND account_id=$2 AND request_id=$3`,
        [opts.project_id, opts.account_id, opts.request_id],
      )
    ).rows[0];
    if (!prior || prior.receipt.batch_id !== opts.batch_id)
      throw Error("scan child receipt missing");
    if (prior.result) return prior.result;
    const job = (
      await db.query(
        `UPDATE collaboration_scan_jobs SET cancel_requested=true,
         recovery_pending=true,recovery_after=COALESCE(recovery_after,clock_timestamp())
       WHERE project_id=$1 AND job_id=$2 AND state='running' AND host_request_started
       RETURNING progress,finish_result`,
        [opts.project_id, opts.request_id],
      )
    ).rows[0];
    if (!job) return;
    const result: ScanChild = {
      project_id: opts.project_id,
      request_id: opts.request_id,
      ...job.progress,
      ...(job.finish_result ?? {}),
      state: ["truncated", "failed"].includes(job.finish_result?.state)
        ? job.finish_result.state
        : "unavailable",
      message:
        (reason === "busy"
          ? "Scan services remained busy; stop was not confirmed. "
          : "Host unavailable; stop was not confirmed. ") +
        "This project's scan identity is retained for recovery. Other projects can be scanned; this project stays reserved until its host confirms the stop.",
    };
    await db.query(
      `UPDATE collaboration_scan_receipts SET result=$4::jsonb
       WHERE project_id=$1 AND account_id=$2 AND request_id=$3`,
      [
        opts.project_id,
        opts.account_id,
        opts.request_id,
        JSON.stringify(result),
      ],
    );
    return result;
  });
}

export interface ScanRecovery {
  project_id: string;
  job_id: string;
  host_id: string;
  token: string;
}

/** The cursor advances across all jobs, including unavailable/ineligible ones.
 * Selection never depends on current membership or admission being enabled:
 * revocation and project reassignment must not erase an old stop obligation.
 */
export async function claimScanRecoveries(
  authority: CollaborationOwnerAuthority,
): Promise<ScanRecovery[]> {
  return transaction(async (db) => {
    const page = await scanJobPage(
      db,
      `scan-recovery:${authority.owning_bay_id}`,
    );
    const token = randomUUID();
    return (
      await db.query(
        `WITH due AS (
       SELECT j.job_id FROM collaboration_scan_jobs j
       JOIN projects p ON p.project_id=j.project_id WHERE p.owning_bay_id=$1
         AND j.job_id=ANY($2::uuid[]) AND j.recovery_pending AND j.cancel_requested
         AND j.host_id IS NOT NULL
         AND (j.recovery_until IS NULL OR j.recovery_until<=clock_timestamp())
         AND (j.recovery_after IS NULL OR j.recovery_after<=clock_timestamp())
       ORDER BY j.recovery_after NULLS FIRST,j.job_id LIMIT 2 FOR UPDATE OF j SKIP LOCKED
       ) UPDATE collaboration_scan_jobs j SET recovery_token=$3,
         recovery_until=clock_timestamp()+interval '90 seconds',
         recovery_after=clock_timestamp()+interval '5 minutes'
       FROM due WHERE j.job_id=due.job_id
       RETURNING j.project_id,j.job_id,j.host_id,j.recovery_token AS token`,
        [authority.owning_bay_id, page.map((row) => row.job_id), token],
      )
    ).rows;
  });
}

/** Called only after cancellation of this exact run has been acknowledged.
 * A stale recovery worker cannot release a newer reservation or overwrite the
 * foreground unavailable result. Receipts remain durable after cleanup.
 */
export async function finishScanRecovery(
  recovery: ScanRecovery,
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, recovery.project_id, authority);
    const { rows } = await db.query(
      `DELETE FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2
         AND host_id=$3 AND recovery_token=$4 AND recovery_pending AND cancel_requested
         AND recovery_until>clock_timestamp() RETURNING job_id`,
      [recovery.project_id, recovery.job_id, recovery.host_id, recovery.token],
    );
    return rows.length === 1;
  });
}
