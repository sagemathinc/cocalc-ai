/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getLogger from "@cocalc/backend/logger";
import { pruneCollaborationRevisionReceivers } from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import { demandSchedulingEnabled } from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { indexingWork } from "./indexing-metrics";

const logger = getLogger("server:collaborators:revision-maintenance");
let running = false;
let nextCleanup = 0;

/** Called by the existing maintenance lifecycle. No independent timer and no
 * membership enumeration; the store deletes at most 100 expired local rows.
 */
export async function runRevisionReceiverCleanup(): Promise<number> {
  if (
    running ||
    performance.now() < nextCleanup ||
    !demandSchedulingEnabled() ||
    process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE !== "1"
  )
    return 0;
  running = true;
  try {
    // Back off failures too, rather than hammering a locked or unavailable DB.
    nextCleanup = performance.now() + 30000;
    if (!(await getServerSettings()).collaborators_enabled) return 0;
    const count =
      await pruneCollaborationRevisionReceivers(getConfiguredBayId());
    indexingWork.inc({ kind: "revision_receivers_pruned" }, count);
    return count;
  } catch {
    indexingWork.inc({ kind: "revision_receiver_cleanup_failed" });
    logger.warn("revision receiver cleanup failed; expired state retained");
    return 0;
  } finally {
    running = false;
  }
}
