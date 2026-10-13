/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  QuotaReliefUnavailableError,
  withSubvolumeQuotaRelief,
  type QuotaRelief,
} from "@cocalc/file-server/btrfs/subvolume-snapshots";
import {
  ProjectWriteFenceUnavailableError,
  withProjectWriteFence,
} from "./project-write-fence";
import { getProject } from "./sqlite/projects";

// A scheduled snapshot of a project at its quota needs a little room in the
// project's qgroup. It only gets it while the project is stopped and fenced
// against every writer on this host (file API, copies, restores, starts), so
// that the room cannot be kept as storage.
const SCHEDULED_SNAPSHOT_QUOTA_RELIEF_BYTES = 64 * 1024 * 1024;

export function stoppedProjectSnapshotQuotaRelief(
  project_id: string,
  volume: Parameters<typeof withSubvolumeQuotaRelief>[0]["subvolume"],
): QuotaRelief {
  return async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await withProjectWriteFence(project_id, async () => {
        const state = getProject(project_id)?.state;
        if (state !== "opened") {
          throw new QuotaReliefUnavailableError(
            `project ${project_id} is ${state ?? "in an unknown state"}`,
          );
        }
        return await withSubvolumeQuotaRelief({
          subvolume: volume,
          operation: "scheduled-snapshot-create",
          run,
          reliefBytes: SCHEDULED_SNAPSHOT_QUOTA_RELIEF_BYTES,
        });
      });
    } catch (err) {
      if (err instanceof ProjectWriteFenceUnavailableError) {
        throw new QuotaReliefUnavailableError(err.message);
      }
      throw err;
    }
  };
}
