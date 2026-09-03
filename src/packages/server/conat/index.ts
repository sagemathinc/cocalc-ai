import getLogger from "@cocalc/backend/logger";
import { initAPI } from "./api";
import { loadConatConfiguration } from "./configuration";
import { createTimeService } from "@cocalc/conat/service/time";
import { listenForUpdates as listenForProjectHostUpdates } from "./route-project";
export {
  getConatPersistDiagnostics,
  getConatPersistSqliteDiagnostics,
  initConatPersist,
} from "./persist";
import { conatApiCount, projectRunnerCount } from "@cocalc/backend/data";
import * as Module from "module";
import { conat } from "@cocalc/backend/conat";
import { initHostRegistryService } from "./host-registry";
import { initHostStatusService } from "./host-status";
import { startBackupLroWorker } from "@cocalc/server/projects/backup-worker";
import { startCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import { startCourseCollectLroWorker } from "@cocalc/server/projects/course-collect-worker";
import { startCourseReconfigureLroWorker } from "@cocalc/server/projects/course-reconfigure-worker";
import { startProjectHardDeleteWorker } from "@cocalc/server/projects/hard-delete-worker";
import { startMoveLroWorker } from "@cocalc/server/projects/move-worker";
import { startRootfsPublishLroWorker } from "@cocalc/server/projects/rootfs-publish-worker";
import { startRestoreLroWorker } from "@cocalc/server/projects/restore-worker";
import { startHostLroWorker } from "@cocalc/server/hosts/start-worker";
import { startHostRuntimeFleetRolloutWorker } from "@cocalc/server/hosts/runtime-fleet-rollout-worker";
import { startComputeVmWorker } from "@cocalc/server/compute/worker";
import { startLegacyMigrationProjectRestoreWorker } from "@cocalc/server/legacy-migration/restore-worker";
import { startLegacyMigrationArtifactRefreshMaintenance } from "@cocalc/server/legacy-migration/artifact-refresh-maintenance";
import { getProjectRuntimeMode } from "@cocalc/server/launchpad/project-runtime";
import { startRootfsReleaseGcMaintenance } from "@cocalc/server/rootfs/gc-maintenance";
import { startRootfsScanMaintenance } from "@cocalc/server/rootfs/scan-maintenance";
import { startBackgroundAutoGrowMaintenance } from "@cocalc/server/project-host/auto-grow-maintenance";
import { startDedicatedHostSpendMaintenance } from "@cocalc/server/project-host/spend-maintenance";
import { startExamHostMaintenance } from "@cocalc/server/project-host/exam";
import { startAccountProjectIndexProjectionMaintenance } from "@cocalc/server/projections/account-project-index-maintenance";
import { startAccountCollaboratorIndexProjectionMaintenance } from "@cocalc/server/projections/account-collaborator-index-maintenance";
import { startAccountNotificationIndexProjectionMaintenance } from "@cocalc/server/projections/account-notification-index-maintenance";
import { startNotificationEmailOutboxMaintenance } from "@cocalc/server/notifications/email-outbox-maintenance";
import { enableDbAccountRowFeedPublishing } from "@cocalc/server/account/account-row-feed";
import { enableDbCollaboratorAccountFeedPublishing } from "@cocalc/server/account/collaborator-feed";
import { enableDbProjectAccountFeedPublishing } from "@cocalc/server/account/project-feed";
import {
  startBayBackupHealthMaintenance,
  startBayBackupMaintenance,
  startBayWalArchiveMaintenance,
} from "@cocalc/server/bay-backup";
import { initInterBayServices } from "@cocalc/server/inter-bay/service";
import { startMembershipSideEffectsMaintenance } from "@cocalc/server/membership/side-effects";
import { startSiteLicenseAffiliationReleaseMaintenance } from "@cocalc/server/membership/site-license-affiliation-maintenance";
import { configureHubServiceAdmissionDenialRecorder } from "./api/service-admission-denials";
import { startConatAdmissionSettingsRefresh } from "./admission-settings";
import { startHostAvailabilityMaintenance } from "@cocalc/server/hosts/availability";
import { startHostIntrusionMonitor } from "@cocalc/server/hosts/intrusion-monitor";
import { startGlobalConfigMirrorRepairMaintenance } from "@cocalc/server/global-config-mirror-maintenance";
import { startAiSessionReconciliationMaintenance } from "@cocalc/server/ai/acp-sessions";
import { startSiteFundedCodexMaintenance } from "@cocalc/server/ai/site-funded-codex-maintenance";
import startPurchasesMaintenanceLoop from "@cocalc/server/purchases/maintenance";
import { startLroExpirationMaintenance } from "@cocalc/server/lro/expiration-maintenance";
import { startUsageRetentionMaintenance } from "@cocalc/server/membership/usage-retention-maintenance";
import { startActiveUserMapHistoryMaintenance } from "@cocalc/server/active-user-map-history";
import { startGrowthAnalyticsMaintenance } from "@cocalc/server/growth-analytics/maintenance";
import { startFrontendAssetHealthMaintenance } from "@cocalc/server/monitoring/frontend-assets";
import { startProjectArchiveLifecycleMaintenance } from "@cocalc/server/projects/archive-lifecycle-maintenance";
import { startCommercialReceivablesMaintenance } from "@cocalc/server/commercial-orders/maintenance";
import { startCrmOutreachWorker } from "@cocalc/server/crm/outreach/worker";

export { loadConatConfiguration };

const logger = getLogger("server:conat");

type GuardedReadMode = "off" | "prefer" | "only";

function normalizeGuardedReadMode(raw: string | undefined): GuardedReadMode {
  const value = `${raw ?? ""}`.trim().toLowerCase();
  if (
    value === "1" ||
    value === "true" ||
    value === "on" ||
    value === "prefer"
  ) {
    return "prefer";
  }
  if (value === "only" || value === "strict" || value === "required") {
    return "only";
  }
  return "off";
}

function logProjectionReadModes(): void {
  logger.info("projection-backed read modes", {
    account_project_index_project_list_reads: normalizeGuardedReadMode(
      process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS,
    ),
    account_collaborator_index_collaborator_reads: normalizeGuardedReadMode(
      process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS,
    ),
  });
}

function isPrimaryBayWorker(): boolean {
  const workerId = `${process.env.COCALC_BAY_WORKER_ID ?? ""}`.trim();
  return !workerId || workerId === "1";
}

let conatApiBackgroundWorkersStarted = false;

export function startConatApiBackgroundWorkers(): void {
  if (conatApiBackgroundWorkersStarted) return;
  conatApiBackgroundWorkersStarted = true;

  logger.info("starting Conat API background workers");
  startBackupLroWorker();
  startCopyLroWorker();
  startCourseCollectLroWorker();
  startCourseReconfigureLroWorker();
  if (isPrimaryBayWorker()) {
    startProjectHardDeleteWorker();
  } else {
    logger.info(
      "project hard-delete worker skipped on non-primary bay worker",
      {
        worker_id: process.env.COCALC_BAY_WORKER_ID,
      },
    );
  }
  startMoveLroWorker();
  startBackgroundAutoGrowMaintenance();
  startDedicatedHostSpendMaintenance();
  startHostAvailabilityMaintenance();
  if (isPrimaryBayWorker()) {
    startHostIntrusionMonitor();
  }
  startRootfsPublishLroWorker();
  startRootfsReleaseGcMaintenance();
  startRootfsScanMaintenance();
  startRestoreLroWorker();
  if (isPrimaryBayWorker()) {
    startLegacyMigrationProjectRestoreWorker();
    startLegacyMigrationArtifactRefreshMaintenance();
  } else {
    logger.info("legacy migration workers skipped on non-primary bay worker", {
      worker_id: process.env.COCALC_BAY_WORKER_ID,
    });
  }
  startHostLroWorker();
  if (isPrimaryBayWorker()) {
    startProjectArchiveLifecycleMaintenance();
    startComputeVmWorker();
    startLroExpirationMaintenance();
    startUsageRetentionMaintenance();
    startActiveUserMapHistoryMaintenance();
    startGrowthAnalyticsMaintenance();
    startHostRuntimeFleetRolloutWorker();
    startExamHostMaintenance();
  }
  startAccountProjectIndexProjectionMaintenance();
  if (isPrimaryBayWorker()) {
    startAccountCollaboratorIndexProjectionMaintenance();
  } else {
    logger.info(
      "account collaborator index projector skipped on non-primary bay worker",
      {
        worker_id: process.env.COCALC_BAY_WORKER_ID,
      },
    );
  }
  startAccountNotificationIndexProjectionMaintenance();
  startNotificationEmailOutboxMaintenance();
  startMembershipSideEffectsMaintenance();
  startSiteLicenseAffiliationReleaseMaintenance();
  startGlobalConfigMirrorRepairMaintenance();
  startAiSessionReconciliationMaintenance();
  if (isPrimaryBayWorker()) {
    startSiteFundedCodexMaintenance();
    startFrontendAssetHealthMaintenance();
    startCommercialReceivablesMaintenance();
    startCrmOutreachWorker();
  }
  if (isPrimaryBayWorker()) {
    startPurchasesMaintenanceLoop();
  } else {
    logger.info("purchase maintenance loop skipped on non-primary bay worker", {
      worker_id: process.env.COCALC_BAY_WORKER_ID,
    });
  }
  if (isPrimaryBayWorker()) {
    startBayBackupHealthMaintenance();
    startBayBackupMaintenance();
    startBayWalArchiveMaintenance();
  } else {
    logger.info("bay backup maintenance skipped on non-primary bay worker", {
      worker_id: process.env.COCALC_BAY_WORKER_ID,
    });
  }
}

export async function initConatApi({
  startBackgroundWorkers = true,
}: {
  startBackgroundWorkers?: boolean;
} = {}) {
  logger.debug("initConatApi: the central api services", {
    conatApiCount,
    projectRunnerCount,
  });
  await loadConatConfiguration();
  configureHubServiceAdmissionDenialRecorder();
  startConatAdmissionSettingsRefresh();
  logProjectionReadModes();
  enableDbAccountRowFeedPublishing();
  enableDbCollaboratorAccountFeedPublishing();
  enableDbProjectAccountFeedPublishing();

  // do not block on any of these!
  for (let i = 0; i < conatApiCount; i++) {
    initAPI();
  }
  initInterBayServices().catch((err) => {
    logger.warn("failed to initialize inter-bay services", { err: `${err}` });
  });
  const projectRuntime = getProjectRuntimeMode();
  if (projectRuntime === "workspace" && !isPrimaryBayWorker()) {
    logger.info(
      "workspace project runtime skipped on non-primary Launchpad worker",
      {
        worker_id: process.env.COCALC_BAY_WORKER_ID,
      },
    );
  } else if (projectRuntime !== "external") {
    const { init: initProjectRunner } = lazyRequire("./project/run") as {
      init: (count?: number) => Promise<void>;
    };
    const runnerCount = projectRuntime === "workspace" ? 1 : projectRunnerCount;
    const { init: initProjectRunnerLoadBalancer } = lazyRequire(
      "./project/load-balancer",
    ) as {
      init: () => Promise<void>;
    };
    void (async () => {
      await initProjectRunner(runnerCount);
      await initProjectRunnerLoadBalancer();
      logger.info("embedded project runtime services initialized", {
        runtime: projectRuntime,
        runner_count: runnerCount,
      });
    })().catch((err) => {
      logger.error("failed to initialize embedded project runtime services", {
        runtime: projectRuntime,
        runner_count: runnerCount,
        err: `${err}`,
      });
    });
  } else {
    logger.info("external project runtime: skipping embedded runner services");
  }
  createTimeService({ client: conat() });
  if (startBackgroundWorkers) {
    startConatApiBackgroundWorkers();
  }
}

export async function initConatHostRegistry() {
  logger.debug("initHostRegistryService");
  await loadConatConfiguration();
  await initHostRegistryService();
  await initHostStatusService();
  listenForProjectHostUpdates();
}

const moduleRequire: NodeRequire | undefined =
  typeof require === "function"
    ? require
    : typeof (Module as { createRequire?: (path: string) => NodeRequire })
          .createRequire === "function"
      ? (
          Module as { createRequire: (path: string) => NodeRequire }
        ).createRequire(__filename)
      : undefined;

function lazyRequire<T = any>(moduleName: string): T {
  if (!moduleRequire) {
    throw new Error("require is not available in this runtime");
  }
  return moduleRequire(moduleName) as T;
}
