import {
  filesystem,
  type Filesystem,
} from "@cocalc/file-server/btrfs/filesystem";
import { chmod, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "path";
import { until } from "@cocalc/util/async-utils";
import { ensureMoreLoopbackDevices, sudo } from "../util";
export { sudo };
export { delay } from "awaiting";

export let fs: Filesystem;
let tempDir;

const TEMP_PREFIX = "cocalc-test-btrfs-";
jest.setTimeout(30_000);

export async function before() {
  const tmp = tmpdir();
  try {
    // Attempt to unmount any mounts left from previous runs.
    // TODO: this could impact runs in parallel.
    const entries = await readdir(tmp, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const mount = join(tmp, entry.name, "mnt");
      try {
        await sudo({ command: "umount", args: ["-l", mount] });
      } catch {
        // ignore stale/non-mounted paths
      }
    }
  } catch {}
  await ensureMoreLoopbackDevices();
  tempDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  // Set world read/write/execute
  await chmod(tempDir, 0o777);
  const mount = join(tempDir, "mnt");
  await mkdir(mount);
  await chmod(mount, 0o777);
  fs = await filesystem({
    image: join(tempDir, "btrfs.img"),
    size: "1G",
    mount: join(tempDir, "mnt"),
    rustic: join(tempDir, "rustic"),
  });
  return fs;
}

export async function after() {
  try {
    fs?.close?.();
  } catch {
    // best effort
  }
  const mount = tempDir ? join(tempDir, "mnt") : undefined;
  await until(
    async () => {
      try {
        await fs.unmount();
        return true;
      } catch {
        if (mount) {
          await sudo({ command: "umount", args: ["-l", mount] });
          return true;
        }
        return false;
      }
    },
    { timeout: 20_000, start: 100, max: 2000 },
  );
  await rm(tempDir, { force: true, recursive: true });
}
