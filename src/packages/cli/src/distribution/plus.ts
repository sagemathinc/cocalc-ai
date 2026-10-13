/*
 * CoCalc Plus (cocalc-lite) on this machine, distribution Phase A.
 *
 * The same transaction as the CLI (local.ts): the numbered-slot lock, floors
 * before the journaled switch of `active`, and rollback with a hold. Plus
 * differs in three ways:
 *
 * - A release is several zstd-compressed tars (app for this platform, static,
 *   public, tools). They are kept by hash in blobs/, so unchanged parts are
 *   never downloaded twice, and unpacked once into apps/<manifest>/, which is
 *   verified when it is assembled (like Node), not on every start.
 * - Lite is a long-running server that must never be restarted for an
 *   update. Every running Plus process holds a pin (running/<pid>), and
 *   garbage collection keeps whatever a live pin uses. A new release takes
 *   effect the next time Lite starts.
 * - Lite has local data. Before a different release first runs, the data
 *   directory is copied to one snapshot (the previous version only), so a
 *   rollback can bring the matching data back.
 *
 * The `active` line is `v1 <R> <N> <B> <R>`: the fourth hash names the
 * assembled release directory apps/<R>.
 */

import { spawn } from "node:child_process";
import { constants, createReadStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import {
  type ActivePointer,
  currentPlatform,
  formatActiveLine,
  isSha256,
  parseActiveLine,
} from "@cocalc/util/cli-distribution/schema";
import {
  type PlusReleaseManifest,
  parsePlusManifest,
  plusManifestFiles,
} from "@cocalc/util/cli-distribution/plus-schema";
import {
  type CliState,
  type FaultPoint,
  type FetchFile,
  checkRelease,
  fault,
  fsyncPath,
  installNode,
  installTarget,
  isDirectory,
  nodeIntact,
  processAlive,
  readActive,
  readState,
  readText,
  recordRelease,
  recover,
  sha256,
  sha256File,
  switchActive,
  withLock,
  writeFileAtomic,
  writeState,
} from "./local";

export const PLUS_ORIGIN = "https://software.cocalc.ai/software/plus";

export function plusRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COCALC_PLUS_DIST_ROOT) return env.COCALC_PLUS_DIST_ROOT;
  const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "cocalc", "plus");
}

export function plusActiveLine(
  manifest: string,
  node: string,
  bootstrap: string,
): string {
  return formatActiveLine({ manifest, node, bootstrap, bundle: manifest });
}

export async function readPlusManifest(
  root: string,
  hash: string,
): Promise<PlusReleaseManifest> {
  const text = await readFile(join(root, "manifests", `${hash}.json`), "utf8");
  if (sha256(text) !== hash) {
    throw new Error(`the local manifest ${hash} is damaged`);
  }
  return parsePlusManifest(text);
}

export async function plusActiveRelease(
  root: string,
): Promise<{ release: number; version: string; manifest: string } | undefined> {
  const active = await readActive(root).catch(() => undefined);
  if (active == null) return undefined;
  const manifest = await readPlusManifest(root, active.pointer.manifest).catch(
    () => undefined,
  );
  if (manifest == null) return undefined;
  return {
    release: manifest.release,
    version: manifest.version,
    manifest: active.pointer.manifest,
  };
}

// --- parts: blobs and the assembled release directory ---

async function ensureBlob(
  root: string,
  staging: string,
  ref: { sha256: string; size: number },
  fetchFile: FetchFile,
): Promise<string> {
  const blobs = join(root, "blobs");
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  const path = join(blobs, ref.sha256);
  try {
    const info = await lstat(path);
    if (
      info.isFile() &&
      info.size === ref.size &&
      (await sha256File(path)) === ref.sha256
    ) {
      return path;
    }
  } catch {
    // not there yet
  }
  const file = join(staging, `blob-${ref.sha256}`);
  await fetchFile(ref.sha256, file, ref.size);
  await fsyncPath(file);
  await rm(path, { force: true });
  await rename(file, path);
  await fsyncPath(blobs);
  return path;
}

// Unpack a zstd-compressed tar with Node's own zstd and the system tar (no
// xz needed).
export async function unpackZstdTar(file: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const tar = spawn("tar", ["-xf", "-", "-C", dest], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  tar.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<void>((resolve, reject) => {
    tar.on("error", reject);
    tar.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)),
    );
  });
  await pipeline(createReadStream(file), createZstdDecompress(), tar.stdin);
  await exited;
}

export async function appIntact(root: string, R: string): Promise<boolean> {
  const dir = join(root, "apps", R);
  return (
    (await isDirectory(dir)) &&
    (await readText(join(dir, ".complete")).catch(() => undefined)) ===
      `${R}\n` &&
    existsSync(join(dir, "bundle", "index.js"))
  );
}

async function installApp(
  root: string,
  staging: string,
  manifest: PlusReleaseManifest,
  R: string,
  fetchFile: FetchFile,
): Promise<void> {
  if (await appIntact(root, R)) return;
  const platform = currentPlatform();
  const app = platform ? manifest.app[platform] : undefined;
  if (platform == null || app == null) {
    throw new Error(
      `CoCalc Plus release ${manifest.release} has no build for ${process.platform}-${process.arch}`,
    );
  }
  const dir = join(staging, "app");
  await mkdir(dir);
  const parts = [app, manifest.static, manifest.public];
  const tools = manifest.tools[platform];
  if (tools) parts.push(tools);
  for (const part of parts) {
    await unpackZstdTar(await ensureBlob(root, staging, part, fetchFile), dir);
  }
  if (!existsSync(join(dir, "bundle", "index.js"))) {
    throw new Error("the app part has no bundle/index.js");
  }
  await writeFileAtomic(join(dir, ".complete"), `${R}\n`);
  await mkdir(join(root, "apps"), { recursive: true, mode: 0o700 });
  await rm(join(root, "apps", R), { recursive: true, force: true });
  await rename(dir, join(root, "apps", R));
  await fsyncPath(join(root, "apps"));
}

// --- running pins ---

// Pins hold the active line as the launcher exports it (no newline).
function pinPointer(line: string): ActivePointer {
  return parseActiveLine(line.endsWith("\n") ? line : `${line}\n`);
}

export interface RunningPin {
  pid: number;
  line: string;
  role: "server" | "command";
}

export async function livePins(root: string): Promise<RunningPin[]> {
  const pins: RunningPin[] = [];
  for (const name of await readdir(join(root, "running")).catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const path = join(root, "running", name);
    if (!processAlive(pid)) {
      await unlink(path).catch(() => {});
      continue;
    }
    try {
      const pin = JSON.parse(await readFile(path, "utf8"));
      pinPointer(pin.line);
      pins.push({ pid, line: pin.line, role: pin.role });
    } catch {
      // a pin being written, or damaged: ignore it
    }
  }
  return pins;
}

// Mark this process's pin (written by the bootstrap) as a server.
export async function markServerPin(root: string, line: string): Promise<void> {
  await mkdir(join(root, "running"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    join(root, "running", `${process.pid}`),
    JSON.stringify({ line, role: "server" }) + "\n",
  );
}

// --- garbage collection, integrity, rollback ---

// Keep what active, previous and every live pin use.
export async function collectPlusGarbage(root: string): Promise<void> {
  const pointers: ActivePointer[] = [];
  for (const name of ["active", "previous"] as const) {
    const entry = await readActive(root, name).catch(() => undefined);
    if (entry) pointers.push(entry.pointer);
  }
  for (const pin of await livePins(root)) {
    pointers.push(pinPointer(pin.line));
  }
  if (pointers.length === 0) return;
  const keep = new Set<string>();
  for (const pointer of pointers) {
    keep.add(pointer.manifest);
    keep.add(pointer.node);
    keep.add(pointer.bootstrap);
    const manifest = await readPlusManifest(root, pointer.manifest).catch(
      () => undefined,
    );
    for (const hash of manifest ? plusManifestFiles(manifest).keys() : []) {
      keep.add(hash);
    }
  }
  for (const dir of ["node", "targets", "apps", "blobs"]) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (isSha256(name) && !keep.has(name)) {
        await rm(join(root, dir, name), { recursive: true, force: true });
      }
    }
  }
  for (const name of await readdir(join(root, "manifests")).catch(() => [])) {
    const hash = name.replace(/\.json$/, "");
    if (isSha256(hash) && !keep.has(hash)) {
      await rm(join(root, "manifests", name), { force: true });
    }
  }
}

export async function plusPointerIntact(
  root: string,
  pointer: ActivePointer,
): Promise<boolean> {
  try {
    if (pointer.bundle !== pointer.manifest) return false;
    const manifest = await readPlusManifest(root, pointer.manifest);
    const platform = currentPlatform();
    const archive = platform ? manifest.node.platforms[platform] : undefined;
    if (
      archive == null ||
      archive.sha256 !== pointer.node ||
      manifest.bootstrap.sha256 !== pointer.bootstrap
    ) {
      return false;
    }
    return (
      (await nodeIntact(join(root, "node", pointer.node), archive.binary)) &&
      (await sha256File(
        join(root, "targets", pointer.bootstrap, "bootstrap.js"),
      )) === pointer.bootstrap &&
      (await appIntact(root, pointer.manifest))
    );
  } catch {
    return false;
  }
}

// --- install ---

export interface PlusInstallResult {
  release: number;
  version: string;
  changed: boolean;
}

export async function installPlusRelease({
  root,
  origin,
  manifestText,
  manifestHash,
  fetchFile,
  launcherBytes,
  prepareState,
  log = () => {},
  faultAt,
}: {
  root: string;
  origin: string;
  manifestText: string;
  manifestHash: string;
  fetchFile: FetchFile;
  launcherBytes?: Buffer;
  prepareState: (state: CliState | undefined) => CliState;
  log?: (message: string) => void;
  faultAt?: FaultPoint;
}): Promise<PlusInstallResult> {
  if (sha256(manifestText) !== manifestHash) {
    throw new Error("the release manifest does not match its hash");
  }
  const manifest = parsePlusManifest(manifestText);
  return await withLock(
    root,
    async () => {
      await recover(root);
      const state = prepareState(await readState(root));
      checkRelease(state, origin, manifest.release, manifestHash);
      await mkdir(join(root, "staging"), { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(root, "staging", "update-"));
      try {
        const node = await installNode(root, staging, manifest, fetchFile);
        await installTarget(
          root,
          staging,
          manifest.bootstrap,
          "bootstrap.js",
          fetchFile,
        );
        await installApp(root, staging, manifest, manifestHash, fetchFile);
        await mkdir(join(root, "manifests"), { recursive: true, mode: 0o700 });
        await writeFileAtomic(
          join(root, "manifests", `${manifestHash}.json`),
          manifestText,
        );

        let launcher: { path: string; bytes: Buffer } | undefined;
        const installed = existsSync(state.launcher)
          ? await sha256File(state.launcher)
          : undefined;
        if (installed !== manifest.launcher.sha256) {
          let bytes = launcherBytes;
          if (bytes == null) {
            const file = join(staging, "launcher");
            await fetchFile(
              manifest.launcher.sha256,
              file,
              manifest.launcher.size,
            );
            bytes = await readFile(file);
          }
          if (sha256(bytes) !== manifest.launcher.sha256) {
            throw new Error("the launcher does not match the release manifest");
          }
          launcher = { path: state.launcher, bytes };
        }

        recordRelease(state, origin, manifest.release, manifestHash);
        await writeState(root, state);
        fault(faultAt, "after-floors");
        if ((await readText(join(root, "origin"))) !== `${state.origin}\n`) {
          await writeFileAtomic(
            join(root, "origin"),
            `${state.origin}\n`,
            0o644,
          );
        }
        const to = plusActiveLine(
          manifestHash,
          node,
          manifest.bootstrap.sha256,
        );
        const current = await readText(join(root, "active"));
        if (current === to && launcher == null) {
          return {
            release: manifest.release,
            version: manifest.version,
            changed: false,
          };
        }
        await switchActive(root, to, launcher, faultAt);
        await collectPlusGarbage(root);
        log(
          `CoCalc Plus release ${manifest.release} (version ${manifest.version}) is installed; it takes effect the next time CoCalc Plus starts.`,
        );
        return {
          release: manifest.release,
          version: manifest.version,
          changed: current !== to,
        };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    log,
  );
}

/*
 * Go back to the previous release, with a hold so automatic updates don't
 * undo it. Refused while a Lite server is running. If the data snapshot
 * belongs to that release, it is restored too (see restoreDataSnapshot).
 */
export async function plusRollback(
  root: string,
  log: (message: string) => void = () => {},
): Promise<{ release: number; version: string; manifest: string }> {
  return await withLock(
    root,
    async () => {
      await recover(root);
      const servers = (await livePins(root)).filter(
        (pin) => pin.role === "server" && pin.pid !== process.pid,
      );
      if (servers.length > 0) {
        throw new Error(
          `CoCalc Plus is running (process ${servers[0].pid}); stop it first, then roll back.`,
        );
      }
      const state = await readState(root);
      if (state == null) throw new Error("CoCalc Plus is not installed here");
      const previous = await readActive(root, "previous");
      if (previous == null) {
        throw new Error("there is no previous release to go back to");
      }
      if (!(await plusPointerIntact(root, previous.pointer))) {
        throw new Error("the previous release is no longer intact on disk");
      }
      const manifest = await readPlusManifest(root, previous.pointer.manifest);
      state.held_at = manifest.release;
      await writeState(root, state);
      await switchActive(root, previous.line);
      log(
        `Rolled back to CoCalc Plus release ${manifest.release} (version ${manifest.version}). Automatic updates are held; run \`cocalc-plus update --resume\` to resume.`,
      );
      return {
        release: manifest.release,
        version: manifest.version,
        manifest: previous.pointer.manifest,
      };
    },
    log,
  );
}

// --- the data snapshot (one previous version) ---

export interface DataRelease {
  manifest: string | null;
  release: number | null;
  version: string;
}

export interface DataPaths {
  // COCALC_PLUS_HOME: holds data/, the snapshot and the markers.
  home: string;
  data: string;
}

const marker = (paths: DataPaths) => join(paths.home, "data-release.json");
const snapshotDir = (paths: DataPaths) => join(paths.home, "data.snapshot");
const snapshotInfo = (paths: DataPaths) =>
  join(paths.home, "data.snapshot.json");

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/*
 * Before Lite opens its data: if this data was last used by a different
 * release (or by a build that kept no record, such as the old single-file
 * executable), copy it to the snapshot, replacing the previous one. Copies
 * use reflinks where the filesystem supports them (APFS, btrfs, XFS), so
 * they are cheap there. Call only when no other Lite server is running.
 */
export async function snapshotDataIfNewRelease(
  paths: DataPaths,
  running: DataRelease,
): Promise<"snapshot" | "unchanged" | "no-data"> {
  const last = await readJson<DataRelease>(marker(paths));
  if (last?.manifest != null && last.manifest === running.manifest) {
    return "unchanged";
  }
  let result: "snapshot" | "no-data" = "no-data";
  if (existsSync(paths.data) && (await readdir(paths.data)).length > 0) {
    const temp = `${snapshotDir(paths)}.tmp`;
    await rm(temp, { recursive: true, force: true });
    await cp(paths.data, temp, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
    await rm(snapshotDir(paths), { recursive: true, force: true });
    await rename(temp, snapshotDir(paths));
    await writeFileAtomic(
      snapshotInfo(paths),
      JSON.stringify(
        {
          ...(last ?? { manifest: null, release: null, version: "unknown" }),
          taken_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    result = "snapshot";
  }
  await writeFileAtomic(marker(paths), JSON.stringify(running, null, 2) + "\n");
  return result;
}

/*
 * After a rollback to `to`: if the snapshot is the data `to` last used,
 * put it back. The data it replaces is kept once as data.replaced, so
 * nothing is lost. Call only when Lite is not running.
 */
export async function restoreDataSnapshot(
  paths: DataPaths,
  to: DataRelease,
): Promise<"restored" | "no-snapshot" | "other-release"> {
  const info = await readJson<DataRelease>(snapshotInfo(paths));
  if (info == null || !existsSync(snapshotDir(paths))) return "no-snapshot";
  if (info.manifest !== to.manifest) return "other-release";
  const replaced = join(paths.home, "data.replaced");
  await rm(replaced, { recursive: true, force: true });
  if (existsSync(paths.data)) await rename(paths.data, replaced);
  await rename(snapshotDir(paths), paths.data);
  await unlink(snapshotInfo(paths));
  await writeFileAtomic(marker(paths), JSON.stringify(to, null, 2) + "\n");
  return "restored";
}
