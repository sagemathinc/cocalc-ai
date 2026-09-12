import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { btrfs, sudo } from "../util";
import {
  queueSetSubvolumeQuota,
  getBtrfsQuotaQueueStatus,
} from "../quota-queue";

// Requires a Linux VM with sudo, loop mounts, and Btrfs simple-quota support.
// Uses only its own disposable image; never uses the host's project filesystem.
describe("upgrading an over-quota subvolume", () => {
  let dir: string;
  let mount: string;
  let mounted = false;
  const originalSqlite = process.env.COCALC_LITE_SQLITE_FILENAME;
  const originalWrapper = process.env.COCALC_RUNTIME_STORAGE_WRAPPER;
  const originalDisable = process.env.COCALC_DISABLE_BTRFS_QUOTAS;

  beforeAll(async () => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    process.env.COCALC_RUNTIME_STORAGE_WRAPPER = "0";
    delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    dir = await mkdtemp(join(tmpdir(), "cocalc-quota-upgrade-"));
    mount = join(dir, "mnt");
    await mkdir(mount);
    const image = join(dir, "btrfs.img");
    await sudo({ command: "truncate", args: ["-s", "1G", image] });
    await sudo({ command: "mkfs.btrfs", args: ["-q", "-f", image] });
    await sudo({ command: "mount", args: ["-o", "loop", image, mount] });
    mounted = true;
    await btrfs({ args: ["quota", "enable", "--simple", mount] });
  });

  afterAll(async () => {
    try {
      if (mounted) await sudo({ command: "umount", args: [mount] });
      if (dir) await rm(dir, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries({
        COCALC_LITE_SQLITE_FILENAME: originalSqlite,
        COCALC_RUNTIME_STORAGE_WRAPPER: originalWrapper,
        COCALC_DISABLE_BTRFS_QUOTAS: originalDisable,
      })) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("raises the limit without deleting live files or snapshot-retained data", async () => {
    const project = join(mount, "project");
    const neighbor = join(mount, "neighbor");
    const snapshot = join(mount, "snapshot");
    for (const path of [project, neighbor]) {
      await btrfs({ args: ["subvolume", "create", path] });
      await sudo({
        command: "chown",
        args: [`${process.getuid!()}:${process.getgid!()}`, path],
      });
    }
    const set = (path: string, size: string) =>
      queueSetSubvolumeQuota({ mount, path, size, wait: true });
    const sync = () => btrfs({ args: ["filesystem", "sync", mount] });
    const limits = async () => {
      const { stdout } = await btrfs({
        args: ["qgroup", "show", "-re", "--raw", mount],
      });
      return stdout.split("\n").map((line) => line.trim().split(/\s+/));
    };
    await set(project, "128M");
    await set(neighbor, "16M");
    const data = randomBytes(64 * 1024 * 1024);
    await writeFile(join(project, "data"), data);
    await writeFile(join(project, "keep.txt"), "keep me");
    await sync();
    await btrfs({ args: ["subvolume", "snapshot", "-r", project, snapshot] });
    await unlink(join(project, "data"));
    await sync();

    // Lowering below retained usage reproduces the state that blocks upgrades.
    await set(project, "32M");
    await sync();
    const before = await limits();
    const projectBefore = before.find((row) => row.at(-1) === "project")!;
    expect(Number(projectBefore[1])).toBeGreaterThan(32 * 1024 * 1024);
    expect(projectBefore[3]).toBe(`${32 * 1024 * 1024}`);

    await set(project, "128M");
    await sync();
    const after = await limits();
    expect(after.find((row) => row[0] === projectBefore[0])?.[3]).toBe(
      `${128 * 1024 * 1024}`,
    );
    for (const row of before.filter((row) => /^0\//.test(row[0]))) {
      if (row[0] === projectBefore[0]) continue;
      expect(after.find((other) => other[0] === row[0])?.[3]).toBe(row[3]);
    }
    const digest = (value: Buffer) =>
      createHash("sha256").update(value).digest("hex");
    expect(digest(await readFile(join(snapshot, "data")))).toBe(digest(data));
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("keep me");
    await writeFile(join(project, "new-data"), randomBytes(8 * 1024 * 1024));
    await sync();
    expect(getBtrfsQuotaQueueStatus(mount)).toMatchObject({
      mode: "simple",
      queued_count: 0,
      running_count: 0,
      failed_count: 0,
    });
  }, 60_000);
});
