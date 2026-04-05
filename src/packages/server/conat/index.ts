import getLogger from "@cocalc/backend/logger";
import { initAPI } from "./api";
import { init as initChangefeedServer } from "@cocalc/database/conat/changefeed-api";
import { init as initLLM } from "./llm";
import { loadConatConfiguration } from "./configuration";
import { createTimeService } from "@cocalc/conat/service/time";
import { listenForUpdates as listenForProjectHostUpdates } from "./route-project";
export { initConatPersist } from "./persist";
import {
  conatApiCount,
  projectRunnerCount,
  conatChangefeedServerCount,
} from "@cocalc/backend/data";
import * as Module from "module";
import { conat } from "@cocalc/backend/conat";
import { initHostRegistryService } from "./host-registry";
import { initHostStatusService } from "./host-status";
import { startBackupLroWorker } from "@cocalc/server/projects/backup-worker";
import { startCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import { startProjectHardDeleteWorker } from "@cocalc/server/projects/hard-delete-worker";
import { startMoveLroWorker } from "@cocalc/server/projects/move-worker";
import { startRootfsPublishLroWorker } from "@cocalc/server/projects/rootfs-publish-worker";
import { startRestoreLroWorker } from "@cocalc/server/projects/restore-worker";
import { startHostLroWorker } from "@cocalc/server/hosts/start-worker";
import { isLaunchpadProduct } from "@cocalc/server/launchpad/mode";
import { startRootfsReleaseGcMaintenance } from "@cocalc/server/rootfs/gc-maintenance";
import { startBackgroundAutoGrowMaintenance } from "@cocalc/server/project-host/auto-grow-maintenance";
import { startAccountProjectIndexProjectionMaintenance } from "@cocalc/server/projections/account-project-index-maintenance";
import { startAccountCollaboratorIndexProjectionMaintenance } from "@cocalc/server/projections/account-collaborator-index-maintenance";
import { startAccountNotificationIndexProjectionMaintenance } from "@cocalc/server/projections/account-notification-index-maintenance";
import { enableDbCollaboratorAccountFeedPublishing } from "@cocalc/server/account/collaborator-feed";
import { enableDbProjectAccountFeedPublishing } from "@cocalc/server/account/project-feed";

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

export async function initConatChangefeedServer() {
  logger.debug(
    "initConatChangefeedServer: postgresql database changefeed server",
    { conatChangefeedServerCount },
  );
  await loadConatConfiguration();
  for (let i = 0; i < conatChangefeedServerCount; i++) {
    initChangefeedServer({ client: conat({ noCache: true }) });
  }
}

export async function initConatApi() {
  logger.debug("initConatApi: the central api services", {
    conatApiCount,
    projectRunnerCount,
  });
  await loadConatConfiguration();
  logProjectionReadModes();
  enableDbCollaboratorAccountFeedPublishing();
  enableDbProjectAccountFeedPublishing();

  // do not block on any of these!
  for (let i = 0; i < conatApiCount; i++) {
    initAPI();
  }
  startBackupLroWorker();
  startCopyLroWorker();
  startProjectHardDeleteWorker();
  startMoveLroWorker();
  startBackgroundAutoGrowMaintenance();
  startRootfsPublishLroWorker();
  startRootfsReleaseGcMaintenance();
  startRestoreLroWorker();
  startHostLroWorker();
  startAccountProjectIndexProjectionMaintenance();
  startAccountCollaboratorIndexProjectionMaintenance();
  startAccountNotificationIndexProjectionMaintenance();
  initLLM();
  if (!isLaunchpadProduct()) {
    const { init: initProjectRunner } = lazyRequire("./project/run") as {
      init: () => Promise<void>;
    };
    for (let i = 0; i < projectRunnerCount; i++) {
      initProjectRunner();
    }
    const { init: initProjectRunnerLoadBalancer } = lazyRequire(
      "./project/load-balancer",
    ) as {
      init: () => Promise<void>;
    };
    initProjectRunnerLoadBalancer();
  } else {
    logger.info("launchpad product: skipping project runner services");
  }
  createTimeService({ client: conat() });
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
