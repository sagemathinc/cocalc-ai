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
  path,
  unsafeMode = false,
  rootfs,
  allowSafeModeHardlink = true,
  allowSafeModeSymlink = true,
  disableOpenAt2 = true,
  homeAliases,
}: {
  service?: string;
  path?: string;
  unsafeMode?: boolean;
  rootfs?: string;
  allowSafeModeHardlink?: boolean;
  allowSafeModeSymlink?: boolean;
  disableOpenAt2?: boolean;
  homeAliases?: string[];
} = {}) {
  const tempDir =
    path ?? (await mkdtemp(join(tmpdir(), `cocalc-${randomId()}0`)));
  tempDirs.push(tempDir);
  const server = await localPathFileserver({
    client,
    service,
    path: tempDir,
    unsafeMode,
    rootfs,
    allowSafeModeHardlink,
    allowSafeModeSymlink,
    disableOpenAt2,
    homeAliases,
    jupyter: {
      async importIpynb({ ipynb }) {
        return { ipynb };
      },
      async saveIpynb({ path, ipynb, fs }) {
        const serialized = JSON.stringify(ipynb, undefined, 2);
        await fs.writeFile(path, serialized, true);
        return {
          ipynb,
          bytes: Buffer.byteLength(serialized),
          converted: false,
        };
      },
    },
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
