/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getLogger from "@cocalc/backend/logger";
import { pruneCollaborationRevisionReceivers } from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import {
  demandSchedulingEnabled,
  pruneCollaborationProjectDemand,
} from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { indexingWork } from "./indexing-metrics";
import {
  readCollaborationRevisionExpiryPage,
  pruneCollaborationRevisionInterests,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import type { RevisionInterestExpiryCursor } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";

const logger = getLogger("server:collaborators:revision-maintenance");
let running = false;
let nextCleanup = 0;
let ownerRunning = false;
let nextOwnerCleanup = 0;
let ownerCursor: RevisionInterestExpiryCursor | undefined;

/** Bounded restartable expiry traversal. Cursor is an optimization only: store
 * ownership checks and exact expiry checks remain authoritative after restart.
 */
export async function runRevisionInterestCleanup(): Promise<number> {
  if (
    ownerRunning ||
    performance.now() < nextOwnerCleanup ||
    !demandSchedulingEnabled() ||
    process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE !== "1"
  )
    return 0;
  ownerRunning = true;
  let deleted = 0;
  try {
    nextOwnerCleanup = performance.now() + 30000;
    if (!(await getServerSettings()).collaborators_enabled) return 0;
    const owning_bay_id = getConfiguredBayId();
    const deadline = performance.now() + 5000;
    const page = await readCollaborationRevisionExpiryPage(
      owning_bay_id,
      ownerCursor,
    );
    const visited = new Set<string>();
    let processed = 0;
    for (const candidate of page.candidates) {
      if (performance.now() >= deadline) break;
      const project_id = candidate.cursor.project_id;
      if (candidate.local_owner && !visited.has(project_id)) {
        visited.add(project_id);
        try {
          deleted += await pruneCollaborationRevisionInterests(project_id, {
            owning_bay_id,
          });
        } catch {
          indexingWork.inc({ kind: "revision_interest_cleanup_failed" });
          // Advance past fenced/busy projects; a later traversal retries them.
        }
      }
      ownerCursor = candidate.cursor;
      processed++;
    }
    if (processed === page.candidates.length && page.complete)
      ownerCursor = undefined;
    indexingWork.inc({ kind: "revision_interest_expiry_examined" }, processed);
    indexingWork.inc({ kind: "revision_interests_pruned" }, deleted);
  } catch {
    logger.warn("revision interest cleanup failed; expired state retained");
    indexingWork.inc({ kind: "revision_interest_cleanup_failed" });
  } finally {
    ownerRunning = false;
  }
  return deleted;
}

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
    try {
      indexingWork.inc(
        { kind: "project_demand_pruned" },
        await pruneCollaborationProjectDemand(),
      );
    } catch {
      indexingWork.inc({ kind: "project_demand_cleanup_failed" });
      logger.warn("project demand cleanup failed; expired hints retained");
    }
    return count;
  } catch {
    indexingWork.inc({ kind: "revision_receiver_cleanup_failed" });
    logger.warn("revision receiver cleanup failed; expired state retained");
    return 0;
  } finally {
    running = false;
  }
}
