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
  if (hostOwnership != null && hostOwnership.bay_id !== getConfiguredBayId()) {
    const bridge = getInterBayBridge().hostControl(hostOwnership.bay_id, {
      timeout_ms: timeout,
    });
    return {
      probePublicRouteOrigin: async () =>
        await bridge.probePublicRouteOrigin({ host_id }),
      restartCloudflared: async (restart) =>
        await bridge.restartCloudflared({ host_id, restart }),
      runSyntheticRuntimeProbe: async () =>
        await bridge.runSyntheticRuntimeProbe({ host_id }),
      applyExamRun: async (apply) =>
        await bridge.applyExamRun({ host_id, apply }),
      getExamRunStatus: async (get) =>
        await bridge.getExamRunStatus({ host_id, get }),
      openExamRun: async (open) => await bridge.openExamRun({ host_id, open }),
      updateExamRunDeadline: async (update) =>
        await bridge.updateExamRunDeadline({ host_id, update }),
      increaseExamRunCapacity: async (increase) =>
        await bridge.increaseExamRunCapacity({ host_id, increase }),
      rotateExamRunToken: async (rotate) =>
        await bridge.rotateExamRunToken({ host_id, rotate }),
      closeAndCleanupExamRun: async (close) =>
        await bridge.closeAndCleanupExamRun({ host_id, close }),
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
      startProjectIdempotent: async (start) =>
        await bridge.startProjectIdempotent({ host_id, start }),
      stopProject: async (stop) => await bridge.stopProject({ host_id, stop }),
      getProjectStatus: async (get) =>
        await bridge.getProjectStatus({ host_id, get }),
      updateAuthorizedKeys: async (update) =>
        await bridge.updateAuthorizedKeys({ host_id, update }),
      updateProjectUsers: async (update) =>
        await bridge.updateProjectUsers({ host_id, update }),
      updateProjectRunQuota: async (update) =>
        await bridge.updateProjectRunQuota({ host_id, update }),
      syncProjectSecretsCache: async (sync) =>
        await bridge.syncProjectSecretsCache({ host_id, sync }),
      setupProjectSecretSshKey: async (setup) =>
        await bridge.setupProjectSecretSshKey({ host_id, setup }),
      applyPendingCopies: async (apply) =>
        await bridge.applyPendingCopies({ host_id, apply }),
      deleteProjectData: async (del) =>
        await bridge.deleteProjectData({ host_id, del }),
      deleteProjectDataAfterBackup: async (del) =>
        await bridge.deleteProjectDataAfterBackup({ host_id, del }),
      releaseProjectDataArchiveFreeze: async (release) =>
        await bridge.releaseProjectDataArchiveFreeze({ host_id, release }),
      upgradeSoftware: async (upgrade) =>
        await bridge.upgradeSoftware({ host_id, upgrade }),
      stageProjectHostArtifact: async (stage) =>
        await bridge.stageProjectHostArtifact({ host_id, stage }),
      rolloutManagedComponents: async (rollout) =>
        await bridge.rolloutManagedComponents({ host_id, rollout }),
      growBtrfs: async (grow) => await bridge.growBtrfs({ host_id, grow }),
      growSharedScratch: async (grow) =>
        await bridge.growSharedScratch({ host_id, grow }),
      unmountSharedScratch: async (unmount) =>
        await bridge.unmountSharedScratch({ host_id, unmount }),
      getRuntimeLog: async (get) =>
        await bridge.getRuntimeLog({ host_id, get }),
      getProcessSnapshot: async (get) =>
        await bridge.getProcessSnapshot({ host_id, get }),
      getAbuseProcessSnapshot: async (get) =>
        await bridge.getAbuseProcessSnapshot({ host_id, get }),
      getAbuseFilesystemSnapshot: async (get) =>
        await bridge.getAbuseFilesystemSnapshot({ host_id, get }),
      getNetworkSnapshot: async (get) =>
        await bridge.getNetworkSnapshot({ host_id, get }),
      getFilesystemSnapshot: async () =>
        await bridge.getFilesystemSnapshot({ host_id }),
      getIntrusionSnapshot: async () =>
        await bridge.getIntrusionSnapshot({ host_id }),
      getPodmanSnapshot: async (get) =>
        await bridge.getPodmanSnapshot({ host_id, get }),
      getProjectRuntimeLog: async (get) =>
        await bridge.getProjectRuntimeLog({ host_id, get }),
      startRootfsBuild: async (start) =>
        await bridge.startRootfsBuild({ host_id, start }),
      getRootfsBuildStatus: async (get) =>
        await bridge.getRootfsBuildStatus({ host_id, get }),
      getRootfsBuildLog: async (get) =>
        await bridge.getRootfsBuildLog({ host_id, get }),
      cancelRootfsBuild: async (cancel) =>
        await bridge.cancelRootfsBuild({ host_id, cancel }),
      listRootfsImages: async () => await bridge.listRootfsImages({ host_id }),
      pullRootfsImage: async (pull) =>
        await bridge.pullRootfsImage({ host_id, pull }),
      deleteRootfsImage: async (del) =>
        await bridge.deleteRootfsImage({ host_id, del }),
      scanRootfsRelease: async (scan) =>
        await bridge.scanRootfsRelease({ host_id, scan }),
      scanProjectRootfs: async (scan) =>
        await bridge.scanProjectRootfs({ host_id, scan }),
      listHostSshAuthorizedKeys: async () =>
        await bridge.listHostSshAuthorizedKeys({ host_id }),
      addHostSshAuthorizedKey: async (add) =>
        await bridge.addHostSshAuthorizedKey({ host_id, add }),
      removeHostSshAuthorizedKey: async (remove) =>
        await bridge.removeHostSshAuthorizedKey({ host_id, remove }),
      getBackupExecutionStatus: async () =>
        await bridge.getBackupExecutionStatus({ host_id }),
      querySqlite: async (query) =>
        await bridge.querySqlite({ host_id, query }),
      invalidateBackupConfig: async (invalidate) =>
        await bridge.invalidateBackupConfig({ host_id, invalidate }),
      getManagedComponentStatus: async () =>
        await bridge.getManagedComponentStatus({ host_id }),
      getInstalledRuntimeArtifacts: async (get) =>
        await bridge.getInstalledRuntimeArtifacts({ host_id, get }),
      getHostAgentStatus: async () =>
        await bridge.getHostAgentStatus({ host_id }),
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
