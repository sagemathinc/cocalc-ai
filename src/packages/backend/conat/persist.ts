/*

To test having multiple persist servers at once in dev mode, start
up your dev server.  Then do the following in nodejs to create an
additional persist server:

   require("@cocalc/backend/conat/persist").initPersistServer()

*/

import "./index";
import { DatabaseSync } from "@cocalc/backend/sqlite";
import { initContext } from "@cocalc/conat/persist/context";
const {
  zstdCompressSync,
  zstdDecompressSync,
  zstdDecompress,
} = require("node:zlib");
import { promisify } from "node:util";
import { syncFiles } from "@cocalc/backend/data";
import ensureContainingDirectoryExists from "@cocalc/backend/misc/ensure-containing-directory-exists";
import { statSync, copyFileSync } from "node:fs";
import type { PersistMaintenanceHooks } from "@cocalc/conat/persist/maintenance/types";
import {
  assertSafePersistDatabasePath,
  projectRootForPersistPath,
} from "./persist-path-safety";
import { persistWriteCounter } from "./persist-write-rate";
import {
  integrityCheckClosedDatabase,
  persistDurabilityRecords,
  persistStartupCheck,
} from "./persist-durability";
import { persistOpenBarrier } from "./persist-open-barrier";
import {
  checkedVerifiedEviction,
  recoverPoisonedProject,
} from "./persist-verified-eviction";

const zstdDecompressAsync = promisify(zstdDecompress);

// exported for the tests' statement guard (028)
export const persistContextOptions: Parameters<typeof initContext>[0] = {
  sqlite: { DatabaseSync },
  compress: zstdCompressSync,
  // stored data is not trusted: always limit the output
  decompress: (data: Buffer, maxOutputLength?: number) =>
    zstdDecompressSync(data, maxOutputLength ? { maxOutputLength } : {}),
  // runs in the libuv threadpool
  decompressAsync: (data: Buffer, maxOutputLength?: number) =>
    zstdDecompressAsync(data, maxOutputLength ? { maxOutputLength } : {}),
  assertSafeDatabasePath: (path: string) => assertSafePersistDatabasePath(path),
  isProjectOwnedDatabasePath: (path: string) =>
    projectRootForPersistPath(path) != null,
  syncFiles,
  ensureContainingDirectoryExists,
  statSync,
  copyFileSync,
  writeCounter: persistWriteCounter,
  durability: persistDurabilityRecords(),
  openBarrier: persistOpenBarrier,
  verifiedEviction: checkedVerifiedEviction,
  integrityCheck: integrityCheckClosedDatabase,
  projectRecovery: (owner, storeRoot) => recoverPoisonedProject(owner, storeRoot),
  startupCheck: persistStartupCheck,
};
initContext(persistContextOptions);

export {
  pstream,
  closeDurably,
  flushAllPersistWrites,
  installPersistExitGuard,
  installPersistSignalFlush,
  prepareDurableOpen,
  clearOpenBarrierPass,
} from "@cocalc/conat/persist/storage";
import { server } from "@cocalc/conat/persist/server";
export { server };
import { conat } from "./conat";
export { initLoadBalancer } from "@cocalc/conat/persist/load-balancer";

const persistServers: any[] = [];

export function initPersistServer({
  id,
  clusterMode,
  service,
  maintenance,
}: {
  id?: string;
  clusterMode?: boolean;
  service?: string;
  maintenance?: PersistMaintenanceHooks;
}) {
  const persistServer = server({
    client: conat({ noCache: persistServers.length > 0 }),
    id,
    clusterMode,
    service,
    maintenance,
  });
  persistServers.push(persistServer);
  return persistServer;
}

export function close() {
  for (const persistServer of persistServers) {
    persistServer.end(); // end is a bit more graceful
  }
  persistServers.length = 0;
}
