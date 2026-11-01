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

// Test directories whose cleanup has started.  A test body that is still
// running (e.g. after a timeout) must not mount there any more: such a mount
// would outlive the cleanup and leak onto the machine (a leaked mount makes
// the CI runner's workspace cleanup fail with EBUSY for every later job).
const closedDirs = new Set<string>();

function isClosed(path: string): boolean {
  for (const dir of closedDirs) {
    if (path === dir || path.startsWith(`${dir}/`)) return true;
  }
  return false;
}

// Mount points at or below dir, deepest first (from this process's view).
function mountsUnder(dir: string): string[] {
  let text = "";
  try {
    text = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return [];
  }
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
  if (isClosed(merged)) {
    throw new Error(`test cleanup already started; not mounting ${merged}`);
  }
  const opts = OVERLAY_OPTS.replace("{lower}", lower)
    .replace("{upper}", upper)
    .replace("{work}", work);
  await runSudo(["mount", "-t", "overlay", "overlay", "-o", opts, merged]);
  if (isClosed(merged)) {
    // cleanup started while mounting: undo it here
    await umountOverlay(merged);
    throw new Error(`test cleanup already started; unmounted ${merged}`);
  }
}

async function umountOverlay(path: string) {
  try {
    await runSudo(["umount", path]);
  } catch {
    await runSudo(["umount", "-l", path]).catch(() => {});
  }
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
      if (!tempDir) return;
      closedDirs.add(tempDir);
      for (const mount of [
        ...mountsUnder(tempDir),
        join(tempDir, "merged"),
        join(tempDir, "merged-restored-unpriv"),
        join(tempDir, "merged-restored-root"),
      ]) {
        await umountOverlay(mount);
      }
      const leaked = mountsUnder(tempDir);
      if (leaked.length > 0) {
        // never delete through a live mount; fail loudly instead
        throw new Error(`overlay mounts still present: ${leaked.join(", ")}`);
      }
      await runSudo(["rm", "-rf", tempDir]).catch(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });
    });

    afterAll(async () => {
      // a last sweep, in case a test body mounted after its cleanup ran
      for (const dir of closedDirs) {
        for (const mount of mountsUnder(dir)) {
          await umountOverlay(mount);
        }
      }
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
