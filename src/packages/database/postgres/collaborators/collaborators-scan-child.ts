/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import { transaction, uuid } from "./collaborators-common";
import { assertCollaborationOwnerAuthority } from "./collaborators-owner";
import type { CollaborationOwnerAuthority } from "./collaborators-owner";
import type {
  ScanChild,
  ScanChildRequest,
} from "@cocalc/util/collaboration-scan-batch";
import { SCAN_PROJECT_INTERVAL_MS } from "@cocalc/util/collaboration-scan-batch";

/** Adapt batch children to the existing owner jobs and receipts. A child never
 * coalesces with another account's work, and terminal/cancel receipts fence late
 * starts even if the home worker lost an RPC acknowledgement.
 */
export async function prepareScanChild(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
): Promise<
  ScanChild & { host_id?: string; job_id?: string; finish_result?: ScanChild }
> {
  uuid(opts.account_id, "scan account");
  uuid(opts.request_id, "scan request");
  uuid(opts.batch_id, "scan batch");
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const project = (
      await db.query(
        "SELECT host_id,users,deleted,archived_at,state FROM projects WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows[0];
    const prior = (
      await db.query(
        `SELECT r.receipt,r.result,j.state,j.host_id,j.cancel_requested,j.progress,j.finish_result,j.host_request_started
      FROM collaboration_scan_receipts r LEFT JOIN collaboration_scan_jobs j ON j.job_id::text=r.receipt->>'job_id'
      WHERE r.project_id=$1 AND r.account_id=$2 AND r.request_id=$3`,
        [opts.project_id, opts.account_id, opts.request_id],
      )
    ).rows[0];
    const base = { project_id: opts.project_id, request_id: opts.request_id };
    if (prior && prior.receipt.batch_id !== opts.batch_id)
      throw Error("scan child identity conflict");
    if (prior?.result) return { ...base, ...prior.result };
    const member =
      !project.deleted &&
      ["owner", "collaborator"].includes(
        project.users?.[opts.account_id]?.group,
      );
    const cancelling =
      opts.action === "cancel" ||
      !member ||
      !!project.archived_at ||
      project.state?.state === "archived" ||
      prior?.cancel_requested ||
      (prior?.host_id && prior.host_id !== project.host_id);
    if (
      prior?.state === "running" &&
      !(cancelling && prior.host_request_started === false)
    ) {
      if (cancelling)
        await db.query(
          "UPDATE collaboration_scan_jobs SET cancel_requested=true WHERE job_id=$1",
          [prior.receipt.job_id],
        );
      return {
        ...base,
        ...prior.progress,
        state: cancelling ? "cancelling" : "running",
        host_id: prior.host_id,
        job_id: prior.receipt.job_id,
        finish_result: prior.finish_result ?? undefined,
      };
    }
    if (cancelling || (prior && !project.host_id)) {
      const result: ScanChild = {
        ...base,
        state: opts.action === "cancel" ? "cancelled" : "unavailable",
      };
      await receipt(db, opts, result);
      if (prior)
        await db.query(
          "DELETE FROM collaboration_scan_jobs WHERE job_id=$1 AND (state='queued' OR NOT host_request_started)",
          [prior.receipt.job_id],
        );
      return result;
    }
    if (prior)
      return { ...base, state: "queued", job_id: prior.receipt.job_id };
    if (opts.action === "inspect") return { ...base, state: "queued" };
    const now = (
      await db.query("SELECT clock_timestamp() AS now")
    ).rows[0].now.getTime();
    const budget = (
      await db.query(
        "SELECT GREATEST(last_started_at,last_admitted_at) AS last_started_at FROM collaboration_scan_budget WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows[0];
    const eligible =
      (budget?.last_started_at?.getTime() ?? 0) + SCAN_PROJECT_INTERVAL_MS;
    const conflict = (
      await db.query(
        "SELECT recovery_pending FROM collaboration_scan_jobs WHERE project_id=$1 LIMIT 1",
        [opts.project_id],
      )
    ).rows[0];
    if (!project.host_id || conflict || eligible > now) {
      const result: ScanChild = {
        ...base,
        state: !project.host_id ? "unavailable" : "deferred",
        message: !project.host_id
          ? "Project storage is unavailable; compute was not started."
          : conflict
            ? conflict.recovery_pending
              ? "An earlier scan's stop remains unconfirmed. This project stays reserved until host recovery confirms the stop."
              : "Another scan owns this project."
            : "Project scan cooldown.",
        next_eligible_at: conflict
          ? Math.max(eligible, now + SCAN_PROJECT_INTERVAL_MS)
          : eligible,
      };
      await receipt(db, opts, result);
      return result;
    }
    await db.query(
      `INSERT INTO collaboration_scan_budget(project_id,tokens,updated_at) VALUES($1,0,clock_timestamp()) ON CONFLICT(project_id) DO NOTHING`,
      [opts.project_id],
    );
    await db.query(
      "UPDATE collaboration_scan_budget SET last_admitted_at=clock_timestamp() WHERE project_id=$1",
      [opts.project_id],
    );
    await db.query(
      `INSERT INTO collaboration_scan_jobs(project_id,slot,job_id,state,created_at,batch_id,host_request_started) VALUES($1,0,$2,'queued',clock_timestamp(),$3,false)`,
      [opts.project_id, opts.request_id, opts.batch_id],
    );
    await receipt(db, opts);
    return { ...base, state: "queued", job_id: opts.request_id };
  });
}

/** Persist pressure across workers/restarts. Only a successful host observation
 * clears it; user inspection must not extend the 60-second foreground budget.
 */
export async function recordScanChildBusy(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
  busy: boolean,
): Promise<boolean> {
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `UPDATE collaboration_scan_jobs SET busy_since=CASE WHEN $4::boolean
         THEN COALESCE(busy_since,clock_timestamp()) ELSE NULL END
       WHERE project_id=$1 AND job_id=$2 AND batch_id=$3
         AND ($4::boolean OR busy_since IS NOT NULL)
       RETURNING COALESCE(clock_timestamp()>=busy_since+interval '60 seconds',false) AS exhausted`,
      [opts.project_id, opts.request_id, opts.batch_id, busy],
    );
    return rows[0]?.exhausted ?? false;
  });
}

/** A failed read-only probe can end unavailable only while the durable job
 * proves that no start RPC was sent. Never infer this from a transport error.
 */
export async function finishUnsubmittedScanChild(
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
        `DELETE FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2
         AND NOT host_request_started AND finish_result IS NULL
         RETURNING cancel_requested`,
        [opts.project_id, opts.request_id],
      )
    ).rows[0];
    if (!job) return;
    const result: ScanChild = {
      project_id: opts.project_id,
      request_id: opts.request_id,
      state: job.cancel_requested ? "cancelled" : "unavailable",
      message:
        reason === "busy"
          ? "Scan services remained busy before submission; no scan was submitted and compute was not started. Retry explicitly after cooldown."
          : "Storage could not be reached before scan submission; compute was not started.",
    };
    await receipt(db, opts, result);
    return result;
  });
}
async function receipt(
  db: PoolClient,
  opts: ScanChildRequest,
  result?: ScanChild,
) {
  await db.query(
    `INSERT INTO collaboration_scan_receipts(project_id,account_id,request_id,mode,receipt,expires_at,result)
    VALUES($1,$2,$3,'reconcile',$4::jsonb,'infinity',$5::jsonb)
    ON CONFLICT(project_id,account_id,request_id) DO UPDATE SET result=EXCLUDED.result`,
    [
      opts.project_id,
      opts.account_id,
      opts.request_id,
      JSON.stringify({
        job_id: opts.request_id,
        batch_id: opts.batch_id,
        admission: "accepted",
      }),
      result ? JSON.stringify(result) : null,
    ],
  );
}
/** Persist why the exact run is being fenced before sending the RPC. A host
 * tombstone cannot reconstruct partial results after its acknowledgment is lost. */
export async function stageScanChildFinish(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
  result: ScanChild,
): Promise<ScanChild> {
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const prior = (
      await db.query(
        `SELECT receipt,result FROM collaboration_scan_receipts WHERE project_id=$1 AND account_id=$2 AND request_id=$3`,
        [opts.project_id, opts.account_id, opts.request_id],
      )
    ).rows[0];
    if (!prior || prior.receipt.batch_id !== opts.batch_id)
      throw Error("scan child receipt missing");
    if (prior.result) return prior.result;
    const job = (
      await db.query(
        `UPDATE collaboration_scan_jobs SET finish_result=COALESCE(finish_result,$3::jsonb)
       WHERE project_id=$1 AND job_id=$2 AND state='running' RETURNING finish_result`,
        [opts.project_id, opts.request_id, JSON.stringify(result)],
      )
    ).rows[0];
    if (!job) throw Error("scan execution missing before fence");
    return job.finish_result;
  });
}
/** Only after the host has acknowledged the fence (or bounded traversal ended).
 * Hold the same project lock as dispatch and admission, preserving cooldown.
 */
export async function finishScanChild(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
  result: ScanChild,
  fenced = false,
) {
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const prior = (
      await db.query(
        `SELECT receipt,result FROM collaboration_scan_receipts WHERE project_id=$1 AND account_id=$2 AND request_id=$3`,
        [opts.project_id, opts.account_id, opts.request_id],
      )
    ).rows[0];
    if (!prior || prior.receipt.batch_id !== opts.batch_id)
      throw Error("scan child receipt missing");
    if (prior.result) return prior.result as ScanChild;
    const pending = (
      await db.query(
        "SELECT finish_result FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2",
        [opts.project_id, opts.request_id],
      )
    ).rows[0]?.finish_result;
    if (pending) {
      if (!fenced) throw Error("scan terminal fence not acknowledged");
      result = pending;
    }
    await receipt(db, opts, result);
    await db.query(
      "DELETE FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2",
      [opts.project_id, opts.request_id],
    );
    return result;
  });
}
