import { localPathFileserver } from "../local-path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "path";
import { client } from "@cocalc/backend/conat/test/setup";
import { randomId } from "@cocalc/conat/names";

const tempDirs: string[] = [];
const servers: any[] = [];
export async function createPathFileserver({
  service = `fs-${randomId()}`,
  unsafeMode = false,
  allowSafeModeHardlink = true,
  allowSafeModeSymlink = true,
}: {
  service?: string;
  unsafeMode?: boolean;
  allowSafeModeHardlink?: boolean;
  allowSafeModeSymlink?: boolean;
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), `cocalc-${randomId()}0`));
  tempDirs.push(tempDir);
  const server = await localPathFileserver({
    client,
    service,
    path: tempDir,
    unsafeMode,
    allowSafeModeHardlink,
    allowSafeModeSymlink,
  });
  servers.push(server);
  return server;
}

// clean up any
export async function cleanupFileservers() {
  for (const server of servers.splice(0, servers.length)) {
    try {
      await server.close();
    } catch {}
  }
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    try {
      await rm(tempDir, { force: true, recursive: true });
    } catch {}
  }
}
