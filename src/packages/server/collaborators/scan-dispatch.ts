/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  startCollaborationScan,
  settleCollaborationScanDiscovery,
  claimCollaborationScanDispatch,
  releaseCollaborationScanDispatch,
  adoptCollaborationScanPredecessor,
  deferCollaborationScanDispatch,
  markCollaborationScanHostRequest,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import type { CollaborationOwnerAuthority } from "@cocalc/database/postgres/collaborators/collaborators-owner";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { scanHostCall } from "./scan-host";

/** One internal dispatch step, not a public admission endpoint or scheduler.
 * Transport failures propagate as unknown outcomes; never settle them as failed.
 */
export async function dispatchCollaborationScan(
  request: {
    project_id: string;
    account_id: string;
    request_id: string;
    job_id: string;
    batch_id?: string;
  },
  authority: CollaborationOwnerAuthority,
) {
  if (process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE !== "1")
    throw Error("scan dispatch disabled");
  const run = await startCollaborationScan(request, authority);
  if (!run) return { state: "deferred" as const };
  const token = await claimCollaborationScanDispatch(request, authority);
  if (!token) return { state: "deferred" as const };
  // On transport failure leave the lease to expire, avoiding immediate retry
  // storms while the remote result is unknown. Successful steps release it.
  const result = await step();
  await releaseCollaborationScanDispatch({ ...request, token }, authority);
  return result;

  async function step() {
    if (!run) throw Error("missing scan run");
    const host = await scanHostCall(() =>
      getRoutedHostControlClient({
        host_id: run.host_id,
        timeout: 30000,
      }),
    );
    const scan = {
      protocol_version: 1 as const,
      project_id: request.project_id,
      run_id: run.job_id,
      expected_run_id: run.expected_run_id,
    };
    const status = await scanHostCall(() =>
      host.getCollaborationReconciliationStatus(scan),
    );
    if (status.state !== "unknown") {
      if (status.run_id !== run.job_id)
        throw Error("scan host returned a different run");
      if (status.state === "discovered" && status.pending_candidates === 0) {
        if (request.batch_id) return { state: "discovered" as const };
        const settled = await settleCollaborationScanDiscovery(
          {
            project_id: request.project_id,
            job_id: run.job_id,
            state: "discovered",
          },
          { ...authority, host_id: run.host_id },
        );
        return {
          state: settled ? ("discovered" as const) : ("deferred" as const),
        };
      }
      if (
        !request.batch_id &&
        (status.state === "cancelled" ||
          status.blocked_reason ||
          (status.traversal_complete && status.pending_candidates === 0) ||
          (status.blocked_directories &&
            status.completed_directories + status.blocked_directories ===
              status.directories))
      ) {
        // Retained pre-batch receipts only distinguish discovered/failed. A
        // partial traversal must not reserve the project forever, but its exact
        // run must be fenced before releasing the old execution boundary.
        if (status.state !== "cancelled") {
          const stopped = await scanHostCall(() =>
            host.cancelCollaborationReconciliation(scan),
          );
          if (stopped.state !== "cancelled" || stopped.run_id !== run.job_id)
            throw Error("legacy scan cancellation not acknowledged");
        }
        const settled = await settleCollaborationScanDiscovery(
          {
            project_id: request.project_id,
            job_id: run.job_id,
            state: "failed",
          },
          { ...authority, host_id: run.host_id },
        );
        return { state: settled ? ("failed" as const) : ("deferred" as const) };
      }
      return { state: "running" as const };
    }
    if (status.current_run_id !== scan.expected_run_id) {
      const adopted = await adoptCollaborationScanPredecessor(
        {
          project_id: request.project_id,
          job_id: run.job_id,
          token: token!,
          predecessor: status.current_run_id ?? null,
        },
        { ...authority, host_id: run.host_id },
      );
      if (!adopted) return { state: "deferred" as const };
      scan.expected_run_id = status.current_run_id;
    }
    if (
      !(await markCollaborationScanHostRequest(
        { ...request, token: token! },
        authority,
      ))
    )
      return { state: "deferred" as const };
    const admission = await scanHostCall(() =>
      host.requestCollaborationReconciliation(scan),
    );
    if (admission.admission === "accepted" && admission.run_id !== run.job_id)
      throw Error("scan host accepted a different run");
    if (admission.admission !== "accepted") {
      await deferCollaborationScanDispatch(
        {
          project_id: request.project_id,
          job_id: run.job_id,
          token: token!,
          reason:
            admission.admission === "throttled"
              ? "host_throttled"
              : admission.reason === "BUSY"
                ? "host_busy"
                : admission.reason === "REPORT_PENDING"
                  ? "report_pending"
                  : "host_deferred",
          retry_after_ms:
            admission.admission === "throttled"
              ? admission.retry_after_ms
              : 30000,
        },
        { ...authority, host_id: run.host_id },
      );
    }
    return {
      ...(request.batch_id && admission.admission !== "accepted"
        ? {
            host_deferred: true,
            retry_after_ms:
              admission.admission === "throttled"
                ? admission.retry_after_ms
                : 30000,
          }
        : {}),
      state:
        admission.admission === "accepted"
          ? ("running" as const)
          : ("deferred" as const),
    };
  }
}
