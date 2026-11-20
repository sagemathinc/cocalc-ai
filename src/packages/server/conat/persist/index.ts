import { loadConatConfiguration } from "../configuration";
import {
  initPersistServer,
  initLoadBalancer,
  installPersistExitGuard,
  installPersistSignalFlush,
} from "@cocalc/backend/conat/persist";
import { conatPersistCount } from "@cocalc/backend/data";
import {
  createForkedPersistServer,
  getForkedPersistServerCount,
} from "./start-server";
import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import {
  createPersistMaintenanceCoordinator,
  type PersistMaintenanceCoordinator,
} from "@cocalc/backend/conat/persist-maintenance/coordinator";
import { loadPersistMaintenanceConfig } from "@cocalc/backend/conat/persist-maintenance/config";
import {
  getPersistentStreamDiagnostics,
  getPersistentStreamSqliteDiagnostics,
} from "@cocalc/conat/persist/storage";
import { getPersistStreamReleaseQueueDiagnostics } from "@cocalc/conat/persist/server";

const logger = getLogger("server:conat:persist");

export function getConatPersistDiagnostics(): {
  mode: "in-process" | "forked";
  configured_servers: number;
  child_processes: number;
  local_open_streams: number;
  local_streams: ReturnType<typeof getPersistentStreamDiagnostics>;
  stream_releases: ReturnType<typeof getPersistStreamReleaseQueueDiagnostics>;
} {
  const configured_servers = Math.max(1, conatPersistCount || 1);
  const local_streams = getPersistentStreamDiagnostics();
  return {
    mode: configured_servers > 1 ? "forked" : "in-process",
    configured_servers,
    child_processes: getForkedPersistServerCount(),
    local_open_streams: local_streams.open_total,
    local_streams,
    stream_releases: getPersistStreamReleaseQueueDiagnostics(),
  };
}

export function getConatPersistSqliteDiagnostics() {
  return getPersistentStreamSqliteDiagnostics();
}

export async function initConatPersist() {
  // 028 E-1: a natural exit must not close (and checkpoint) the disk streams
  installPersistExitGuard();
  // 028 B-3a: a signal commits the queued writes, then ends as before
  installPersistSignalFlush();
  logger.debug("initPersistServer: sqlite3 stream persistence", {
    conatPersistCount,
  });
  const ids = Array.from(
    { length: Math.max(1, conatPersistCount || 1) },
    (_, index) => `${index}`,
  );
  const maintenanceConfig = loadPersistMaintenanceConfig();
  let maintenance: PersistMaintenanceCoordinator | undefined;
  if (maintenanceConfig.enabled) {
    try {
      maintenance = createPersistMaintenanceCoordinator({
        expectedWorkerIds: ids,
        config: maintenanceConfig,
      });
      maintenance.start();
    } catch (err) {
      logger.error("failed starting persist maintenance coordinator", err);
    }
  }
  if (!conatPersistCount || conatPersistCount <= 1) {
    // only 1, so no need to use separate processes
    await loadConatConfiguration();
    const id = "0";
    initPersistServer({
      id,
      clusterMode: true,
      service: PERSIST_SERVICE,
      maintenance: maintenance?.createLocalHooks(id),
    });
    initLoadBalancer({ ids: [id], client: conat(), service: PERSIST_SERVICE });
    return;
  }

  // more than 1 so no possible value to multiple servers if we don't
  // use separate processes
  createPersistCluster(maintenance);
}

async function createPersistCluster(
  maintenance?: PersistMaintenanceCoordinator,
) {
  logger.debug(
    "initPersistServer: creating cluster with",
    conatPersistCount,
    "processes",
  );
  const ids: string[] = [];
  for (let i = 0; i < conatPersistCount; i++) {
    const id = `${i}`;
    ids.push(id);
    logger.debug("initPersistServer: starting node ", { id });
    createForkedPersistServer(id, maintenance);
  }
  initLoadBalancer({ ids, client: conat(), service: PERSIST_SERVICE });
}
