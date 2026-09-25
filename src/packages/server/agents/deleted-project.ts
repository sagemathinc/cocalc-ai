import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterBayIdsForStaticEnumerationOnly } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getAuthoritativeProjectHardDeleteStatus } from "@cocalc/server/projects/hard-delete-evidence";
import { mapParallelLimit } from "@cocalc/util/async-utils";

// Deletion removes directory ownership. This exceptional repair path therefore
// checks tombstones across bays, never interpreting a routing miss as deletion.
export async function agentProjectWasDeleted(
  project_id: string,
): Promise<boolean> {
  const local = getConfiguredBayId();
  const bays = [
    ...new Set([
      local,
      ...getConfiguredClusterBayIdsForStaticEnumerationOnly(),
    ]),
  ];
  try {
    const evidence = await mapParallelLimit(
      bays,
      (bay) =>
        bay === local
          ? getAuthoritativeProjectHardDeleteStatus({ project_id })
          : getInterBayBridge()
              .projectControl(bay, { timeout_ms: 2000 })
              .hardDeleteStatus({ project_id }),
      4,
    );
    return (
      evidence.every(
        (entry, index) =>
          entry.project_id === project_id &&
          entry.bay_id === bays[index] &&
          entry.status !== "live",
      ) && evidence.some((entry) => entry.status === "hard-deleted")
    );
  } catch {
    // An unreachable bay is not evidence that its projects have been deleted.
    return false;
  }
}
