/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createHostControlClient,
  type HostControlApi,
} from "@cocalc/conat/project-host/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveHostBayAcrossCluster } from "@cocalc/server/inter-bay/directory";
import { getExplicitHostControlClient } from "@cocalc/server/conat/route-client";

export async function getRoutedHostControlClient({
  host_id,
  timeout,
  fresh = false,
  account_id,
}: {
  host_id: string;
  timeout?: number;
  fresh?: boolean;
  account_id?: string;
}): Promise<HostControlApi> {
  const hostOwnership = await resolveHostBayAcrossCluster(host_id);
  if (
    hostOwnership != null &&
    hostOwnership.bay_id !== getConfiguredBayId()
  ) {
    const bridge = getInterBayBridge().hostControl(hostOwnership.bay_id, {
      timeout_ms: timeout,
    });
    return {
      createProject: async (create) => {
        if (!account_id) {
          throw new Error(
            `remote host createProject for ${host_id} requires account_id`,
          );
        }
        return await bridge.createProject({
          account_id,
          host_id,
          create,
        });
      },
      startProject: async (start) =>
        await bridge.startProject({ host_id, start }),
      stopProject: async (stop) => await bridge.stopProject({ host_id, stop }),
      updateAuthorizedKeys: async (update) =>
        await bridge.updateAuthorizedKeys({ host_id, update }),
      updateProjectUsers: async (update) =>
        await bridge.updateProjectUsers({ host_id, update }),
      applyPendingCopies: async (apply) =>
        await bridge.applyPendingCopies({ host_id, apply }),
      deleteProjectData: async (del) =>
        await bridge.deleteProjectData({ host_id, del }),
      upgradeSoftware: async (upgrade) =>
        await bridge.upgradeSoftware({ host_id, upgrade }),
      growBtrfs: async (grow) => await bridge.growBtrfs({ host_id, grow }),
      getRuntimeLog: async (get) => await bridge.getRuntimeLog({ host_id, get }),
      getProjectRuntimeLog: async (get) =>
        await bridge.getProjectRuntimeLog({ host_id, get }),
      listRootfsImages: async () => await bridge.listRootfsImages({ host_id }),
      pullRootfsImage: async (pull) =>
        await bridge.pullRootfsImage({ host_id, pull }),
      deleteRootfsImage: async (del) =>
        await bridge.deleteRootfsImage({ host_id, del }),
      listHostSshAuthorizedKeys: async () =>
        await bridge.listHostSshAuthorizedKeys({ host_id }),
      addHostSshAuthorizedKey: async (add) =>
        await bridge.addHostSshAuthorizedKey({ host_id, add }),
      removeHostSshAuthorizedKey: async (remove) =>
        await bridge.removeHostSshAuthorizedKey({ host_id, remove }),
      getBackupExecutionStatus: async () =>
        await bridge.getBackupExecutionStatus({ host_id }),
      inspectStaticAppPath: async (inspect) =>
        await bridge.inspectStaticAppPath({ host_id, inspect }),
      buildRootfsImageManifest: async (build) =>
        await bridge.buildRootfsImageManifest({ host_id, build }),
      buildProjectRootfsManifest: async (build) =>
        await bridge.buildProjectRootfsManifest({ host_id, build }),
    };
  }
  return createHostControlClient({
    host_id,
    client: await getExplicitHostControlClient({ host_id, fresh }),
    timeout,
  });
}
