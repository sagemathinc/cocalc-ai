/*
Test overlayfs xattr preservation through rustic backup/restore.
*/

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { rustic as rusticPath } from "./install";

const execFileAsync = promisify(execFile);

const OVERLAY_OPTS = [
  "lowerdir={lower}",
  "upperdir={upper}",
  "workdir={work}",
  "metacopy=on",
  "redirect_dir=on",
  "index=on",
].join(",");

function supportsOverlayMounts(): boolean {
  if (process.platform !== "linux") return false;
  const base = mkdtempSync(join(tmpdir(), "cocalc-rustic-overlay-probe-"));
  const lower = join(base, "lower");
  const upper = join(base, "upper");
  const work = join(base, "work");
  const merged = join(base, "merged");
  try {
    mkdirSync(lower, { recursive: true });
    mkdirSync(upper, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(merged, { recursive: true });
    const opts = OVERLAY_OPTS.replace("{lower}", lower)
      .replace("{upper}", upper)
      .replace("{work}", work);
    execFileSync(
      "sudo",
      ["-n", "mount", "-t", "overlay", "overlay", "-o", opts, merged],
      {
        stdio: "pipe",
      },
    );
    return true;
  } catch {
    return false;
  } finally {
    try {
      execFileSync("sudo", ["-n", "umount", "-l", merged], {
        stdio: "pipe",
      });
    } catch {}
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {}
  }
}

const describeIfOverlayMountsSupported =
  process.platform === "linux" && supportsOverlayMounts()
    ? describe
    : describe.skip;

type CommandResult = {
  stdout: string;
  stderr: string;
};

async function run(
  command: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function runSudo(
  args: string[],
  opts?: { cwd?: string },
): Promise<CommandResult> {
  return await run("sudo", ["-n", ...args], opts);
}

async function writeRusticProfile(pathBase: string, repoPath: string) {
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    `${pathBase}.toml`,
    `[repository]\nrepository = "${repoPath}"\npassword = ""\n`,
  );
}

async function rustic({
  profileBase,
  args,
  cwd,
  asRoot = false,
}: {
  profileBase: string;
  args: string[];
  cwd?: string;
  asRoot?: boolean;
}): Promise<CommandResult> {
  const fullArgs = [rusticPath, "-P", profileBase, ...args];
  return asRoot
    ? await runSudo(fullArgs, { cwd })
    : await run(rusticPath, ["-P", profileBase, ...args], { cwd });
}

async function getfattrRecursive(
  path: string,
  asRoot = false,
): Promise<string> {
  const result = asRoot
    ? await runSudo(["getfattr", "-d", "-m", "-", "-R", path])
    : await run("getfattr", ["-d", "-m", "-", "-R", path]);
  return result.stdout + result.stderr;
}

// rustic init, backup and restore take seconds each; a test that times out
// keeps running in the background after afterEach, so it must not time out.
const TEST_TIMEOUT_MS = 120_000;

// Mount points at or below dir, deepest first (from this process's view).
// Fails if the mount table can't be read: "no evidence" must never count as
// "no mounts" before a recursive delete.
function mountsUnder(dir: string): string[] {
  const text = readFileSync("/proc/self/mountinfo", "utf8");
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
  return text
    .split("\n")
    .map((line) => decode(line.split(" ")[4] ?? ""))
    .filter((mount) => mount === dir || mount.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length);
}

export type OverlayMountOps = {
  mount: (merged: string, opts: string) => Promise<void>;
  umount: (path: string) => Promise<void>;
  list: (dir: string) => string[];
  remove: (dir: string) => Promise<void>;
};

const isUnder = (path: string, dir: string) =>
  path === dir || path.startsWith(`${dir}/`);

// Every overlay mount of these tests goes through one tracker, so that no
// mount can outlive its test's cleanup (a leaked mount makes the CI runner's
// workspace cleanup fail with EBUSY for every later job):
// - a mount attempt is registered in the same synchronous step as the check
//   that its directory is still open, so once cleanup closes a directory no
//   new attempt can start there;
// - cleanup closes the directory, waits for every registered attempt under
//   it (an attempt that completes after closing undoes itself), unmounts all
//   that remains, verifies nothing is mounted, and only then deletes.
export class OverlayMountTracker {
  private closed = new Set<string>();
  private attempts = new Map<Promise<void>, string>();

  constructor(private ops: OverlayMountOps) {}

  private isClosed(path: string): boolean {
    for (const dir of this.closed) {
      if (isUnder(path, dir)) return true;
    }
    return false;
  }

  // Not async: the closed check and the registration happen synchronously.
  mount(merged: string, opts: string): Promise<void> {
    if (this.isClosed(merged)) {
      return Promise.reject(
        new Error(`test cleanup already started; not mounting ${merged}`),
      );
    }
    const attempt = (async () => {
      await this.ops.mount(merged, opts);
      if (this.isClosed(merged)) {
        await this.ops.umount(merged);
        throw new Error(`test cleanup already started; unmounted ${merged}`);
      }
    })();
    this.attempts.set(attempt, merged);
    attempt.then(
      () => this.attempts.delete(attempt),
      () => this.attempts.delete(attempt),
    );
    return attempt;
  }

  private async unmountAndVerify(dir: string): Promise<void> {
    for (const mount of this.ops.list(dir)) {
      await this.ops.umount(mount);
    }
    const left = this.ops.list(dir);
    if (left.length > 0) {
      throw new Error(`overlay mounts still present: ${left.join(", ")}`);
    }
  }

  async cleanup(dir: string): Promise<void> {
    this.closed.add(dir);
    const pending = [...this.attempts]
      .filter(([, path]) => isUnder(path, dir))
      .map(([attempt]) => attempt);
    await Promise.allSettled(pending);
    await this.unmountAndVerify(dir);
    await this.ops.remove(dir);
  }

  // A last check over every cleaned-up directory: unmount, then verify.
  async sweep(): Promise<void> {
    await Promise.allSettled([...this.attempts.keys()]);
    for (const dir of this.closed) {
      await this.unmountAndVerify(dir);
    }
  }
}

async function umountOverlay(path: string) {
  try {
    await runSudo(["umount", path]);
  } catch {
    await runSudo(["umount", "-l", path]).catch(() => {});
  }
}

const mounts = new OverlayMountTracker({
  mount: async (merged, opts) => {
    await runSudo(["mount", "-t", "overlay", "overlay", "-o", opts, merged]);
  },
  umount: umountOverlay,
  list: mountsUnder,
  remove: async (dir) => {
    await runSudo(["rm", "-rf", dir]).catch(async () => {
      await rm(dir, { recursive: true, force: true });
    });
  },
});

async function mountOverlay({
  lower,
  upper,
  work,
  merged,
}: {
  lower: string;
  upper: string;
  work: string;
  merged: string;
}) {
  const opts = OVERLAY_OPTS.replace("{lower}", lower)
    .replace("{upper}", upper)
    .replace("{work}", work);
  await mounts.mount(merged, opts);
}

async function chownToCurrentUser(paths: string[]) {
  await runSudo([
    "chown",
    "-R",
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    ...paths,
  ]);
}

async function createOverlayFixture(base: string): Promise<{
  lower: string;
  upper: string;
  work: string;
  merged: string;
}> {
  const lower = join(base, "lower");
  const upper = join(base, "upper");
  const work = join(base, "work");
  const merged = join(base, "merged");
  await mkdir(join(lower, "dir"), { recursive: true });
  await mkdir(upper, { recursive: true });
  await mkdir(work, { recursive: true });
  await mkdir(merged, { recursive: true });
  await writeFile(join(lower, "dir", "file.txt"), "hello\n");
  await chownToCurrentUser([lower, upper, work, merged]);
  await mountOverlay({ lower, upper, work, merged });
  await readFile(join(merged, "dir", "file.txt"), "utf8");
  await writeFile(join(merged, "created.txt"), "created\n");
  await rm(join(merged, "created.txt"));
  await run("chmod", ["600", join(merged, "dir", "file.txt")]);
  await rm(join(merged, "dir", "new.txt"), { force: true });
  await run("mv", [join(merged, "dir"), join(merged, "dir2")]);
  const mergedContent = await readFile(
    join(merged, "dir2", "file.txt"),
    "utf8",
  );
  expect(mergedContent).toBe("hello\n");
  await umountOverlay(merged);
  return { lower, upper, work, merged };
}

describeIfOverlayMountsSupported(
  "overlayfs xattrs through rustic backup/restore",
  () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "cocalc-rustic-overlay-"));
    });

    afterEach(async () => {
      if (tempDir) await mounts.cleanup(tempDir);
    });

    afterAll(async () => {
      await mounts.sweep();
    });

    it(
      "loses trusted overlay xattrs through the current unprivileged backup path",
      async () => {
        const { lower, upper } = await createOverlayFixture(tempDir);
        const initialXattrs = await getfattrRecursive(upper, true);
        expect(initialXattrs).toContain("trusted.overlay.metacopy");
        expect(initialXattrs).toContain("trusted.overlay.redirect");

        const profileBase = join(tempDir, "unpriv");
        const repo = join(tempDir, "repo-unpriv");
        await writeRusticProfile(profileBase, repo);
        await rustic({ profileBase, args: ["init"] });

        const { stdout } = await rustic({
          profileBase,
          args: [
            "backup",
            "--json",
            "--no-scan",
            "--host",
            "overlay-unpriv",
            ".",
          ],
          cwd: upper,
        });
        const snapshotId = JSON.parse(stdout).id as string;
        const restoredUpper = join(tempDir, "restored-upper-unpriv");
        await mkdir(restoredUpper, { recursive: true });
        await rustic({
          profileBase,
          args: ["restore", snapshotId, restoredUpper],
        });

        const restoredXattrs = await getfattrRecursive(restoredUpper, true);
        expect(restoredXattrs).not.toContain("trusted.overlay.metacopy");
        expect(restoredXattrs).not.toContain("trusted.overlay.redirect");

        const restoredWork = join(tempDir, "restored-work-unpriv");
        const restoredMerged = join(tempDir, "merged-restored-unpriv");
        await mkdir(restoredWork, { recursive: true });
        await mkdir(restoredMerged, { recursive: true });
        await chownToCurrentUser([restoredUpper, restoredWork, restoredMerged]);
        await mountOverlay({
          lower,
          upper: restoredUpper,
          work: restoredWork,
          merged: restoredMerged,
        });
        const restoredContent = await readFile(
          join(restoredMerged, "dir2", "file.txt"),
        );
        expect(restoredContent.equals(Buffer.from("hello\n"))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "preserves trusted overlay xattrs when rustic backup and restore run as root",
      async () => {
        const { lower, upper } = await createOverlayFixture(tempDir);
        const initialXattrs = await getfattrRecursive(upper, true);
        expect(initialXattrs).toContain("trusted.overlay.metacopy");
        expect(initialXattrs).toContain("trusted.overlay.redirect");

        const profileBase = join(tempDir, "root");
        const repo = join(tempDir, "repo-root");
        await writeRusticProfile(profileBase, repo);
        await rustic({ profileBase, args: ["init"], asRoot: true });

        const { stdout } = await rustic({
          profileBase,
          args: [
            "backup",
            "--json",
            "--no-scan",
            "--host",
            "overlay-root",
            ".",
          ],
          cwd: upper,
          asRoot: true,
        });
        const snapshotId = JSON.parse(stdout).id as string;
        const restoredUpper = join(tempDir, "restored-upper-root");
        await mkdir(restoredUpper, { recursive: true });
        await rustic({
          profileBase,
          args: ["restore", snapshotId, restoredUpper],
          asRoot: true,
        });
        await chownToCurrentUser([restoredUpper]);

        const restoredXattrs = await getfattrRecursive(restoredUpper, true);
        expect(restoredXattrs).toContain("trusted.overlay.metacopy");
        expect(restoredXattrs).toContain("trusted.overlay.redirect");

        const restoredWork = join(tempDir, "restored-work-root");
        const restoredMerged = join(tempDir, "merged-restored-root");
        await mkdir(restoredWork, { recursive: true });
        await mkdir(restoredMerged, { recursive: true });
        await chownToCurrentUser([restoredUpper, restoredWork, restoredMerged]);
        await mountOverlay({
          lower,
          upper: restoredUpper,
          work: restoredWork,
          merged: restoredMerged,
        });
        await expect(
          readFile(join(restoredMerged, "dir2", "file.txt"), "utf8"),
        ).resolves.toBe("hello\n");
      },
      TEST_TIMEOUT_MS,
    );
  },
);

// The cleanup protocol itself, with fake mounts: it runs everywhere.
describe("OverlayMountTracker", () => {
  function fakeOps() {
    const mounted = new Set<string>();
    const events: string[] = [];
    let releaseMount: (() => void) | undefined;
    let pauseMounts = false;
    const ops: OverlayMountOps = {
      mount: async (merged) => {
        events.push(`mount start ${merged}`);
        if (pauseMounts) {
          await new Promise<void>((resolve) => (releaseMount = resolve));
        }
        mounted.add(merged);
        events.push(`mounted ${merged}`);
      },
      umount: async (path) => {
        mounted.delete(path);
        events.push(`umount ${path}`);
      },
      list: (dir) => [...mounted].filter((path) => isUnder(path, dir)),
      remove: async (dir) => {
        events.push(`remove ${dir}`);
      },
    };
    return {
      ops,
      mounted,
      events,
      pause: () => (pauseMounts = true),
      release: () => releaseMount?.(),
    };
  }

  it("waits for a mount in flight before it unmounts, verifies and removes", async () => {
    const fake = fakeOps();
    const tracker = new OverlayMountTracker(fake.ops);
    fake.pause();
    const attempt = tracker.mount("/t/a/merged", "opts");
    const cleanup = tracker.cleanup("/t/a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // cleanup is still waiting for the paused mount
    expect(fake.events).toEqual(["mount start /t/a/merged"]);

    fake.release();
    await cleanup;
    await expect(attempt).rejects.toThrow("cleanup already started");
    expect(fake.mounted.size).toBe(0);
    expect(fake.events).toEqual([
      "mount start /t/a/merged",
      "mounted /t/a/merged",
      "umount /t/a/merged",
      "remove /t/a",
    ]);
  });

  it("never starts a mount in a directory whose cleanup started", async () => {
    const fake = fakeOps();
    const tracker = new OverlayMountTracker(fake.ops);
    await tracker.cleanup("/t/a");
    await expect(tracker.mount("/t/a/merged", "opts")).rejects.toThrow(
      "not mounting",
    );
    expect(fake.events).toEqual(["remove /t/a"]);
  });

  it("refuses to remove when the mount table can't be read", async () => {
    const fake = fakeOps();
    const tracker = new OverlayMountTracker({
      ...fake.ops,
      list: () => {
        throw new Error("EACCES /proc/self/mountinfo");
      },
    });
    await expect(tracker.cleanup("/t/a")).rejects.toThrow("EACCES");
    expect(fake.events).toEqual([]);
  });

  it("refuses to remove, and the sweep fails, while a mount can't be unmounted", async () => {
    const fake = fakeOps();
    const tracker = new OverlayMountTracker({
      ...fake.ops,
      umount: async () => {},
    });
    await tracker.mount("/t/a/merged", "opts");
    await expect(tracker.cleanup("/t/a")).rejects.toThrow("still present");
    expect(fake.events).not.toContain("remove /t/a");
    await expect(tracker.sweep()).rejects.toThrow("still present");
  });
});
