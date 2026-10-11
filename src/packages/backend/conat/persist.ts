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
import { readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { syncFiles } from "@cocalc/backend/data";
import ensureContainingDirectoryExists from "@cocalc/backend/misc/ensure-containing-directory-exists";
import { statSync, copyFileSync } from "node:fs";
import type { PersistMaintenanceHooks } from "@cocalc/conat/persist/maintenance/types";

// Copy a stream's database next to it as <name>.db.oversized-<time>, using
// SQLite's online backup (consistent, and does not block the event loop the
// way a VACUUM INTO of a large file would).  At most one copy per database:
// if one exists already, return it.
async function archiveDatabase(
  db: InstanceType<typeof sqlite.DatabaseSync>,
  dbPath: string,
): Promise<string | undefined> {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.oversized-`;
  const existing = (await readdir(dir))
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        !name.endsWith(".tmp") &&
        !name.endsWith("-wal") &&
        !name.endsWith("-shm") &&
        !name.endsWith("-journal"),
    )
    .sort();
  if (existing.length > 0) {
    return join(dir, existing[existing.length - 1]);
  }
  const dest = join(
    dir,
    `${prefix}${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const tmp = `${dest}.tmp`;
  await (sqlite as any).backup(db, tmp);
  await rename(tmp, dest);
  return dest;
}

initContext({
  sqlite,
  archiveDatabase,
  compress: zstdCompressSync,
  decompress: zstdDecompressSync,
  // runs in the libuv threadpool
  decompressAsync: promisify(zstdDecompress),
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
