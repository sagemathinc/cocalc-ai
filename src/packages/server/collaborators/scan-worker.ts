/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getLogger from "@cocalc/backend/logger";
import { listCollaborationScanDispatchCandidates } from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { dispatchCollaborationScan } from "./scan-dispatch";

const logger = getLogger("server:collaborators:scan-worker");
const running = new Set<string>();

/** Explicit prototype pass only; intentionally not installed on a timer yet.
 * Local overlap exclusion complements durable cross-process job leases.
 */
export async function runCollaborationScanPass() {
  const result = {
    attempted: 0,
    discovered: 0,
    deferred: 0,
    pending: 0,
    unknown: 0,
  };
  if (process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE !== "1") return result;
  const owning_bay_id = getConfiguredBayId();
  if (running.has(owning_bay_id)) return result;
  running.add(owning_bay_id);
  const deadline = Date.now() + 60_000;
  try {
    const authority = { owning_bay_id };
    const candidates = await listCollaborationScanDispatchCandidates(authority);
    for (const request of candidates.slice(0, 20)) {
      // This bounds new starts, not the duration of an already in-flight RPC.
      if (
        Date.now() >= deadline ||
        process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE !== "1"
      )
        break;
      result.attempted++;
      try {
        const step = await dispatchCollaborationScan(request, authority);
        if (step.state === "discovered") result.discovered++;
        else if (step.state === "deferred") result.deferred++;
        else result.pending++;
      } catch {
        // The stored identity/lease is retained; no new request or failure
        // settlement is inferred from an exception (including timeouts).
        result.unknown++;
        logger.debug("scan dispatch outcome unknown", {
          job_id: request.job_id,
        });
      }
    }
    return result;
  } finally {
    running.delete(owning_bay_id);
  }
}
