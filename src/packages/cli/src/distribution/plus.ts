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
import { randomBytes } from "node:crypto";
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
  stat,
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
  const tools = platform ? manifest.tools[platform] : undefined;
  if (platform == null || app == null || tools == null) {
    throw new Error(
      `CoCalc Plus release ${manifest.release} has no build for ${process.platform}-${process.arch}`,
    );
  }
  const dir = join(staging, "app");
  await mkdir(dir);
  const parts = [app, manifest.static, manifest.public, tools];
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

/*
 * Pins of live processes. A pin is published atomically (written to a
 * temporary name, then renamed), so a readable file is complete. A pin of a
 * live process that can't be read makes this throw: garbage collection must
 * then keep everything rather than guess.
 */
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
    let pin: any;
    try {
      pin = JSON.parse(await readFile(path, "utf8"));
      pinPointer(pin.line);
    } catch (err: any) {
      if (err?.code === "ENOENT") continue; // the process just exited
      throw new Error(`the pin of running process ${pid} is unreadable`);
    }
    pins.push({ pid, line: pin.line, role: pin.role });
  }
  return pins;
}

async function writePin(
  root: string,
  pid: number,
  line: string,
  role: RunningPin["role"],
): Promise<void> {
  await mkdir(join(root, "running"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    join(root, "running", `${pid}`),
    JSON.stringify({ line, role }) + "\n",
  );
}

// --- garbage collection and integrity ---

/*
 * Keep what active and previous use, what every live pin uses, and the
 * releases the data needs for a rollback: the one that last used the data
 * (its owner) and the one whose data is in the snapshot. Called with the
 * lock held. An unreadable live pin stops collection entirely.
 */
export async function collectPlusGarbage(root: string): Promise<void> {
  let pins: RunningPin[];
  try {
    pins = await livePins(root);
  } catch {
    return;
  }
  const manifests = new Set<string>();
  const keep = new Set<string>();
  const keepPointer = (pointer: ActivePointer) => {
    manifests.add(pointer.manifest);
    keep.add(pointer.node);
    keep.add(pointer.bootstrap);
  };
  for (const name of ["active", "previous"] as const) {
    const entry = await readActive(root, name).catch(() => undefined);
    if (entry) keepPointer(entry.pointer);
  }
  for (const pin of pins) keepPointer(pinPointer(pin.line));
  const data = await readDataState(root);
  if (data?.owner?.manifest) manifests.add(data.owner.manifest);
  const snapshot = data ? await readSnapshotInfo(data.home) : undefined;
  if (snapshot?.manifest) manifests.add(snapshot.manifest);
  if (manifests.size === 0) return;
  for (const hash of manifests) {
    keep.add(hash);
    const manifest = await readPlusManifest(root, hash).catch(() => undefined);
    for (const file of manifest ? plusManifestFiles(manifest).keys() : []) {
      keep.add(file);
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

// The active line that runs the release with this manifest here.
async function lineForManifest(
  root: string,
  manifestHash: string,
): Promise<string> {
  const manifest = await readPlusManifest(root, manifestHash);
  const platform = currentPlatform();
  const archive = platform ? manifest.node.platforms[platform] : undefined;
  if (archive == null) throw new Error("no Node for this platform");
  return plusActiveLine(
    manifestHash,
    archive.sha256,
    manifest.bootstrap.sha256,
  );
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
      // A pending data change (snapshot or rollback) is finished first, so
      // this update neither switches past it nor collects what it needs.
      await recoverData(root);
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

// --- the data: who owns it, one snapshot, and a journal ---
//
// Lite's data directory belongs to the release that last ran on it (its
// owner, in <root>/data.json). When a different release starts, the data is
// first copied to the snapshot, which records inside its own tree which
// release it belongs to, so the bytes and the label can never disagree.
// Starting a server, taking a snapshot and rolling back (code and data
// together) all happen under the update lock, and each multi-step change is
// journaled (<root>/data-journal.json) and rolled forward or undone by
// recoverData, so a crash at any point leaves code and data that match.

export interface DataRelease {
  manifest: string | null;
  release: number | null;
  version: string;
}

export interface DataPaths {
  // COCALC_PLUS_HOME, which holds data/ and data.snapshot/
  home: string;
  data: string;
}

interface DataState {
  schema: "cocalc-plus-data/1";
  home: string;
  data: string;
  owner: DataRelease | null;
}

interface SnapshotInfo extends DataRelease {
  id: string;
  taken_at: string;
}

// Each journal names the data paths it acts on, so any operation (an update
// too) can finish it without knowing them.
type DataJournal = DataPaths &
  (
    | {
        op: "snapshot";
        id: string;
        from: DataRelease | null;
        to: DataRelease;
        temp: string;
      }
    | {
        op: "rollback";
        to: DataRelease;
        line: string;
        // The snapshot to restore (its id), or null for a code-only rollback.
        restore: string | null;
      }
  );

export type DataFault =
  | "snapshot-copied"
  | "snapshot-renamed"
  | "data-replaced"
  | "snapshot-restored"
  | "code-switched";

const SNAPSHOT_INFO = ".cocalc-snapshot.json";
const snapshotDir = (home: string) => join(home, "data.snapshot");
const journalPath = (root: string) => join(root, "data-journal.json");

function dataFault(at: DataFault | undefined, point: DataFault): void {
  if (at === point) throw new Error(`injected fault: ${point}`);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readDataState(
  root: string,
): Promise<DataState | undefined> {
  return await readJson<DataState>(join(root, "data.json"));
}

async function writeDataState(root: string, state: DataState): Promise<void> {
  await writeFileAtomic(
    join(root, "data.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export async function readSnapshotInfo(
  home: string,
): Promise<SnapshotInfo | undefined> {
  return await readJson<SnapshotInfo>(join(snapshotDir(home), SNAPSHOT_INFO));
}

// Only a missing directory is empty; anything unreadable stops the caller.
async function hasContent(dir: string): Promise<boolean> {
  let info;
  try {
    info = await stat(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  return (await readdir(dir)).length > 0;
}

// The release that last used the data at these paths. Ownership recorded
// for other paths (COCALC_PLUS_HOME or the data directory moved) does not
// carry over: that data's owner is unknown.
async function ownerOf(
  root: string,
  paths: DataPaths,
): Promise<DataRelease | null> {
  const state = await readDataState(root);
  return state != null && state.home === paths.home && state.data === paths.data
    ? state.owner
    : null;
}

async function setOwner(
  root: string,
  paths: DataPaths,
  owner: DataRelease,
): Promise<void> {
  await writeDataState(root, {
    schema: "cocalc-plus-data/1",
    home: paths.home,
    data: paths.data,
    owner,
  });
}

async function finishSnapshot(
  root: string,
  paths: DataPaths,
  journal: Extract<DataJournal, { op: "snapshot" }>,
  faultAt?: DataFault,
): Promise<void> {
  const old = `${snapshotDir(paths.home)}.old`;
  await rm(old, { recursive: true, force: true });
  if (existsSync(snapshotDir(paths.home))) {
    await rename(snapshotDir(paths.home), old);
  }
  await rename(journal.temp, snapshotDir(paths.home));
  dataFault(faultAt, "snapshot-renamed");
  await rm(old, { recursive: true, force: true });
  await setOwner(root, paths, journal.to);
  await unlink(journalPath(root));
}

async function takeSnapshot(
  root: string,
  paths: DataPaths,
  from: DataRelease | null,
  to: DataRelease,
  faultAt?: DataFault,
): Promise<void> {
  const id = randomBytes(8).toString("hex");
  const journal: DataJournal = {
    op: "snapshot",
    home: paths.home,
    data: paths.data,
    id,
    from,
    to,
    temp: `${snapshotDir(paths.home)}.tmp-${id}`,
  };
  await writeFileAtomic(journalPath(root), JSON.stringify(journal) + "\n");
  await cp(paths.data, journal.temp, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
  const info: SnapshotInfo = {
    ...(from ?? { manifest: null, release: null, version: "unknown" }),
    id,
    taken_at: new Date().toISOString(),
  };
  await writeFileAtomic(
    join(journal.temp, SNAPSHOT_INFO),
    JSON.stringify(info, null, 2) + "\n",
  );
  dataFault(faultAt, "snapshot-copied");
  await finishSnapshot(root, paths, journal, faultAt);
}

async function finishRollback(
  root: string,
  paths: DataPaths,
  journal: Extract<DataJournal, { op: "rollback" }>,
  faultAt?: DataFault,
): Promise<void> {
  if (journal.restore != null) {
    const snapshot = await readSnapshotInfo(paths.home);
    if (snapshot?.id === journal.restore) {
      const replaced = join(paths.home, "data.replaced");
      if (existsSync(paths.data)) {
        await rm(replaced, { recursive: true, force: true });
        await rename(paths.data, replaced);
      }
      dataFault(faultAt, "data-replaced");
      await rename(snapshotDir(paths.home), paths.data);
    }
    dataFault(faultAt, "snapshot-restored");
    await rm(join(paths.data, SNAPSHOT_INFO), { force: true });
  }
  if ((await readText(join(root, "active"))) !== `${journal.line}\n`) {
    await switchActive(root, `${journal.line}\n`);
  }
  dataFault(faultAt, "code-switched");
  const state = await readState(root);
  if (state != null && journal.to.release != null) {
    state.held_at = journal.to.release;
    await writeState(root, state);
  }
  await setOwner(root, paths, journal.to);
  await unlink(journalPath(root));
}

function validJournal(value: any): value is DataJournal {
  const release = (r: any) =>
    r != null &&
    (r.manifest === null || isSha256(r.manifest)) &&
    typeof r.version === "string";
  if (
    value == null ||
    typeof value.home !== "string" ||
    typeof value.data !== "string"
  ) {
    return false;
  }
  if (value.op === "snapshot") {
    return (
      typeof value.id === "string" &&
      typeof value.temp === "string" &&
      (value.from === null || release(value.from)) &&
      release(value.to)
    );
  }
  if (value.op === "rollback") {
    try {
      pinPointer(value.line);
    } catch {
      return false;
    }
    return (
      release(value.to) &&
      (value.restore === null || typeof value.restore === "string")
    );
  }
  return false;
}

/*
 * Finish or undo an interrupted data change. Call with the lock held, before
 * anything that changes `active` or collects garbage. A journal that exists
 * but can't be read or validated stops everything and is kept: only a
 * missing journal means there is nothing to recover.
 */
export async function recoverData(root: string): Promise<void> {
  let journal: unknown;
  try {
    journal = await readJson<unknown>(journalPath(root));
  } catch (err) {
    throw new Error(
      `the data journal ${journalPath(root)} can't be read (${err instanceof Error ? err.message : err}); it was kept. Fix or remove it by hand.`,
    );
  }
  if (journal === undefined) return;
  if (!validJournal(journal)) {
    throw new Error(
      `the data journal ${journalPath(root)} is damaged; it was kept. Fix or remove it by hand.`,
    );
  }
  const paths = { home: journal.home, data: journal.data };
  if (journal.op === "rollback") {
    await finishRollback(root, paths, journal);
    return;
  }
  // A snapshot: done once the snapshot directory carries this journal's id.
  if ((await readSnapshotInfo(paths.home))?.id === journal.id) {
    await rm(`${snapshotDir(paths.home)}.old`, {
      recursive: true,
      force: true,
    });
    await setOwner(root, paths, journal.to);
  } else {
    await rm(journal.temp, { recursive: true, force: true });
    const old = `${snapshotDir(paths.home)}.old`;
    if (existsSync(old) && !existsSync(snapshotDir(paths.home))) {
      await rename(old, snapshotDir(paths.home));
    }
    await rm(old, { recursive: true, force: true });
  }
  await unlink(journalPath(root));
}

/*
 * Before Lite opens its data, with the update lock held:
 *   - refuse if another Lite server is running (it owns the data);
 *   - revalidate this release on disk and pin this process as its server;
 *   - if a different release last used the data (or a build that kept no
 *     record, like the old single-file executable), snapshot it first.
 * Any failure stops the start: Lite must not open data it can't protect.
 */
export async function prepareServer({
  root,
  line,
  paths,
  faultAt,
}: {
  root: string;
  line: string;
  paths: DataPaths;
  faultAt?: DataFault;
}): Promise<"snapshot" | "unchanged" | "no-data"> {
  return await withLock(root, async () => {
    await recover(root);
    await recoverData(root);
    // The launcher chose this release before the lock: if an update or a
    // recovered rollback changed `active` since, this process runs the
    // wrong code for the data. Stop; the next start picks the right one.
    if ((await readText(join(root, "active"))) !== `${line}\n`) {
      throw new Error(
        "CoCalc Plus changed while starting (an update or a rollback finished); start it again",
      );
    }
    const others = (await livePins(root)).filter(
      (pin) => pin.role === "server" && pin.pid !== process.pid,
    );
    if (others.length > 0) {
      throw new Error(
        `CoCalc Plus is already running (process ${others[0].pid}) and owns the data. Stop it first.`,
      );
    }
    const pointer = pinPointer(line);
    if (!(await plusPointerIntact(root, pointer))) {
      throw new Error(
        "this CoCalc Plus release is incomplete or was removed; start CoCalc Plus again",
      );
    }
    await writePin(root, process.pid, line, "server");
    const manifest = await readPlusManifest(root, pointer.manifest);
    const running: DataRelease = {
      manifest: pointer.manifest,
      release: manifest.release,
      version: manifest.version,
    };
    const owner = await ownerOf(root, paths);
    if (owner?.manifest === running.manifest) return "unchanged";
    if (!(await hasContent(paths.data))) {
      await setOwner(root, paths, running);
      return "no-data";
    }
    await takeSnapshot(root, paths, owner, running, faultAt);
    return "snapshot";
  });
}

/*
 * Roll back code and data together, with the lock held and no Lite running:
 *   - if newer releases were installed but the data still belongs to an
 *     older one (it never ran them), go back to that owner, code only;
 *   - otherwise go back to the release whose data is in the snapshot, and
 *     restore that data (the newer data is kept once as data.replaced);
 *   - with no data yet, go back to the previous release.
 * Anything else is refused: older code must never run on newer data.
 */
export async function plusRollback({
  root,
  paths,
  log = () => {},
  faultAt,
}: {
  root: string;
  paths: DataPaths;
  log?: (message: string) => void;
  faultAt?: DataFault;
}): Promise<DataRelease> {
  return await withLock(
    root,
    async () => {
      await recover(root);
      await recoverData(root);
      const servers = (await livePins(root)).filter(
        (pin) => pin.role === "server" && pin.pid !== process.pid,
      );
      if (servers.length > 0) {
        throw new Error(
          `CoCalc Plus is running (process ${servers[0].pid}); stop it first, then roll back.`,
        );
      }
      if ((await readState(root)) == null) {
        throw new Error("CoCalc Plus is not installed here");
      }
      const active = await readActive(root);
      const owner = await ownerOf(root, paths);
      const snapshot = await readSnapshotInfo(paths.home);
      let target: string;
      let restore: string | null = null;
      if (
        owner?.manifest != null &&
        active != null &&
        owner.manifest !== active.pointer.manifest
      ) {
        target = owner.manifest;
      } else if (snapshot?.manifest != null) {
        target = snapshot.manifest;
        restore = snapshot.id;
      } else if (!(await hasContent(paths.data))) {
        const previous = await readActive(root, "previous");
        if (previous == null) {
          throw new Error("there is no previous release to go back to");
        }
        target = previous.pointer.manifest;
      } else {
        throw new Error(
          "there is no snapshot of your data from an older release, so rolling back would run older code on newer data. Nothing was changed.",
        );
      }
      if (target === active?.pointer.manifest) {
        throw new Error("that release is already active");
      }
      const line = (await lineForManifest(root, target)).trimEnd();
      if (!(await plusPointerIntact(root, pinPointer(line)))) {
        throw new Error("that release is no longer complete on disk");
      }
      const manifest = await readPlusManifest(root, target);
      const to: DataRelease = {
        manifest: target,
        release: manifest.release,
        version: manifest.version,
      };
      const journal: DataJournal = {
        op: "rollback",
        home: paths.home,
        data: paths.data,
        to,
        line,
        restore,
      };
      await writeFileAtomic(journalPath(root), JSON.stringify(journal) + "\n");
      await finishRollback(root, paths, journal, faultAt);
      log(
        `Rolled back to CoCalc Plus ${to.version} (release ${to.release})${
          restore != null
            ? `, with the data it last used. The newer data is kept once in ${paths.home}/data.replaced`
            : ""
        }. Automatic updates are held; run \`cocalc-plus update --resume\` to resume.`,
      );
      return to;
    },
    log,
  );
}
