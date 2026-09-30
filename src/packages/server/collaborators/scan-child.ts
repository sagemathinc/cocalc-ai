/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import {
  prepareScanChild,
  finishScanChild,
  stageScanChildFinish,
  finishUnsubmittedScanChild,
} from "@cocalc/database/postgres/collaborators/collaborators-scan-child";
import type { CollaborationOwnerAuthority } from "@cocalc/database/postgres/collaborators/collaborators-owner";
import type {
  ScanChild,
  ScanChildRequest,
} from "@cocalc/util/collaboration-scan-batch";
import { scanChildTerminal } from "@cocalc/util/collaboration-scan-batch";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { dispatchCollaborationScan } from "./scan-dispatch";
import { retainUnavailableScanChild } from "@cocalc/database/postgres/collaborators/collaborators-scan-recovery";
import { ScanHostUnavailable, scanHostCall } from "./scan-host";

export async function stepScanChild(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
): Promise<ScanChild> {
  try {
    return await step(opts, authority);
  } catch (error) {
    if (!(error instanceof ScanHostUnavailable)) throw error;
    const result = await retainUnavailableScanChild(opts, authority);
    if (!result) throw error;
    return result;
  }
}

async function step(
  opts: ScanChildRequest,
  authority: CollaborationOwnerAuthority,
): Promise<ScanChild> {
  let child = await prepareScanChild(opts, authority);
  if (scanChildTerminal(child.state) || opts.action === "inspect") return child;
  let unavailable = false;
  let deferredUntil: number | undefined;
  if (child.state !== "cancelling" && !child.finish_result) {
    try {
      const dispatch = await dispatchCollaborationScan(
        { ...opts, job_id: opts.request_id },
        authority,
      );
      if ("host_deferred" in dispatch && dispatch.host_deferred)
        deferredUntil = Date.now() + (dispatch.retry_after_ms ?? 30000);
    } catch (error) {
      const unsubmitted = await finishUnsubmittedScanChild(opts, authority);
      if (unsubmitted) return unsubmitted;
      if (error instanceof ScanHostUnavailable) throw error;
      // Only a definitive host storage rejection can become unavailable. Fence
      // the exact run first so an earlier delayed submission cannot execute.
      unavailable = [
        "ENODEV",
        "PROJECT_UNAVAILABLE",
        "ESTALE",
        "ENOENT",
      ].includes((error as { code?: string })?.code ?? "");
      // A lost acknowledgement is neither failure nor permission for a new ID.
    }
    child = await prepareScanChild({ ...opts, action: "inspect" }, authority);
  }
  if (!child.host_id || !child.job_id) return child;
  const host_id = child.host_id;
  const host = await scanHostCall(() =>
    getRoutedHostControlClient({
      host_id,
      timeout: 30000,
    }),
  );
  const request = {
    protocol_version: 1 as const,
    project_id: opts.project_id,
    run_id: child.job_id,
  };
  async function finishAfterFence(result: ScanChild) {
    const pending = await stageScanChildFinish(opts, authority, result);
    const stopped = await scanHostCall(() =>
      host.cancelCollaborationReconciliation(request),
    );
    if (stopped.state !== "cancelled" || stopped.run_id !== request.run_id)
      throw Error("scan cancellation not acknowledged");
    return finishScanChild(opts, authority, pending, true);
  }
  if (child.finish_result) return finishAfterFence(child.finish_result);
  if (child.state === "cancelling" || unavailable || deferredUntil) {
    return finishAfterFence({
      project_id: opts.project_id,
      request_id: opts.request_id,
      entries: child.entries,
      candidates: child.candidates,
      state:
        child.state === "cancelling"
          ? "cancelled"
          : unavailable
            ? "unavailable"
            : "deferred",
      ...(deferredUntil
        ? {
            next_eligible_at: deferredUntil,
            message:
              "Host deferred this scan; retry explicitly after cooldown.",
          }
        : {}),
    });
  }
  const status = await scanHostCall(() =>
    host.getCollaborationReconciliationStatus(request),
  );
  if (status.state === "unknown") return child;
  if (status.run_id !== child.job_id)
    throw Error("scan host returned different run");
  if (status.state === "cancelled")
    return finishScanChild(opts, authority, { ...child, state: "cancelled" });
  const progress = { entries: status.entries, candidates: status.candidates };
  await getPool().query(
    "UPDATE collaboration_scan_jobs SET progress=$3::jsonb WHERE project_id=$1 AND job_id=$2 AND NOT cancel_requested",
    [opts.project_id, child.job_id, JSON.stringify(progress)],
  );
  if (status.state === "discovered" && status.pending_candidates === 0) {
    return finishScanChild(opts, authority, {
      project_id: opts.project_id,
      request_id: opts.request_id,
      ...progress,
      state: "successful",
    });
  }
  if (
    status.blocked_reason ||
    (status.traversal_complete && status.pending_candidates === 0) ||
    (status.blocked_directories &&
      status.completed_directories + status.blocked_directories ===
        status.directories)
  ) {
    // Bounded partial traversal is a terminal, honest outcome. Fence retries
    // before freeing admission; do not leave blocked traversal running forever.
    return finishAfterFence({
      project_id: opts.project_id,
      request_id: opts.request_id,
      ...progress,
      state: status.blocked_reason === "retry_limit" ? "failed" : "truncated",
      message:
        "Some paths were excluded, inaccessible, or exceeded traversal limits.",
    });
  }
  return { ...child, ...progress };
}
