/*

To test having multiple persist servers at once in dev mode, start
up your dev server.  Then do the following in nodejs to create an
additional persist server:

   require("@cocalc/backend/conat/persist").initPersistServer()

*/

import "./index";
import sqlite from "node:sqlite";
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
import { assertSafePersistDatabasePath } from "./persist-path-safety";

const zstdDecompressAsync = promisify(zstdDecompress);

initContext({
  sqlite,
  compress: zstdCompressSync,
  // stored data is not trusted: always limit the output
  decompress: (data: Buffer, maxOutputLength?: number) =>
    zstdDecompressSync(data, maxOutputLength ? { maxOutputLength } : {}),
  // runs in the libuv threadpool
  decompressAsync: (data: Buffer, maxOutputLength?: number) =>
    zstdDecompressAsync(data, maxOutputLength ? { maxOutputLength } : {}),
  assertSafeDatabasePath: (path: string) => assertSafePersistDatabasePath(path),
  syncFiles,
  ensureContainingDirectoryExists,
  statSync,
  copyFileSync,
});

export { pstream } from "@cocalc/conat/persist/storage";
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
