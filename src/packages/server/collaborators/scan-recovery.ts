/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  claimScanRecoveries,
  finishScanRecovery,
} from "@cocalc/database/postgres/collaborators/collaborators-scan-recovery";

const logger = getLogger("server:collaborators:scan-recovery");
const running = new Set<string>();

/** Bounded recovery of previously authorized executions, never new admission.
 * Durable leases/backoff survive worker restart and admission being disabled.
 */
export async function runScanRecoveryPass(active: () => boolean = () => true) {
  const authority = { owning_bay_id: getConfiguredBayId() };
  const result = { attempted: 0, stopped: 0, unknown: 0 };
  if (
    !active() ||
    process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE !== "1" ||
    running.has(authority.owning_bay_id)
  )
    return result;
  running.add(authority.owning_bay_id);
  try {
    const jobs = await claimScanRecoveries(authority);
    await Promise.all(
      jobs.map(async (job) => {
        if (!active()) return;
        result.attempted++;
        try {
          const host = await getRoutedHostControlClient({
            host_id: job.host_id,
            timeout: 30000,
          });
          const stopped = await host.cancelCollaborationReconciliation({
            protocol_version: 1,
            project_id: job.project_id,
            run_id: job.job_id,
          });
          if (stopped.state !== "cancelled" || stopped.run_id !== job.job_id)
            throw Error("scan cancellation not acknowledged");
          if (await finishScanRecovery(job, authority)) result.stopped++;
        } catch {
          result.unknown++;
          logger.debug(
            "scan stop remains unconfirmed; project reservation retained",
            { job_id: job.job_id },
          );
        }
      }),
    );
    return result;
  } finally {
    running.delete(authority.owning_bay_id);
  }
}
