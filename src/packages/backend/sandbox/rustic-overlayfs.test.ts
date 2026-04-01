/*
Test overlayfs xattr preservation through rustic backup/restore.
*/

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { rustic as rusticPath } from "./install";

const execFileAsync = promisify(execFile);

const describeIfLinux = process.platform === "linux" ? describe : describe.skip;

const OVERLAY_OPTS = [
  "lowerdir={lower}",
  "upperdir={upper}",
  "workdir={work}",
  "metacopy=on",
  "redirect_dir=on",
  "index=on",
].join(",");

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
  await runSudo(["mount", "-t", "overlay", "overlay", "-o", opts, merged]);
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

describeIfLinux("overlayfs xattrs through rustic backup/restore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cocalc-rustic-overlay-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await umountOverlay(join(tempDir, "merged"));
      await umountOverlay(join(tempDir, "merged-restored-unpriv"));
      await umountOverlay(join(tempDir, "merged-restored-root"));
      await runSudo(["rm", "-rf", tempDir]).catch(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });
    }
  });

  it("loses trusted overlay xattrs through the current unprivileged backup path", async () => {
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
      args: ["backup", "--json", "--no-scan", "--host", "overlay-unpriv", "."],
      cwd: upper,
    });
    const snapshotId = JSON.parse(stdout).id as string;
    const restoredUpper = join(tempDir, "restored-upper-unpriv");
    await mkdir(restoredUpper, { recursive: true });
    const restore = await rustic({
      profileBase,
      args: ["restore", snapshotId, restoredUpper],
    });
    expect(restore.stderr).toContain("setting extended attributes failed");

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
  });

  it("preserves trusted overlay xattrs when rustic backup and restore run as root", async () => {
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
      args: ["backup", "--json", "--no-scan", "--host", "overlay-root", "."],
      cwd: upper,
      asRoot: true,
    });
    const snapshotId = JSON.parse(stdout).id as string;
    const restoredUpper = join(tempDir, "restored-upper-root");
    await mkdir(restoredUpper, { recursive: true });
    const restore = await rustic({
      profileBase,
      args: ["restore", snapshotId, restoredUpper],
      asRoot: true,
    });
    expect(restore.stderr).not.toContain("setting extended attributes failed");
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
  });
});
