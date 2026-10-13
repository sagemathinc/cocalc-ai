/*
 * The installed CLI on this machine (distribution Phase A):
 *
 *   <root>/active             v1 <manifest> <node> <bootstrap> <bundle>
 *   <root>/previous           the line before the last switch (rollback)
 *   <root>/transition.json    journal of an in-progress switch
 *   <root>/state.json         origin, update settings, per-origin floors
 *   <root>/check.json         when the site was last asked (no lock needed)
 *   <root>/origin             the origin, one line, for the launcher's errors
 *   <root>/lock               the update lock
 *   <root>/node/<sha256>/     Node runtimes, by archive hash
 *   <root>/targets/<sha256>/  bootstrap.js or cocalc.js, by file hash
 *   <root>/manifests/<sha256>.json
 *
 * <root> is ${XDG_DATA_HOME:-~/.local/share}/cocalc/cli, or COCALC_CLI_ROOT.
 * Every switch is journaled so that a crash at any point leaves either the old
 * or the new active release, with floors at least as high as before.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type ActivePointer,
  type CliReleaseManifest,
  currentPlatform,
  formatActiveLine,
  isRelease,
  isSha256,
  parseActiveLine,
  parseManifest,
} from "@cocalc/util/cli-distribution/schema";

const execFile = promisify(execFileCb);

export const STATE_SCHEMA = "cocalc-cli-state/1";
export const DEFAULT_AUTO_UPDATE = true;
const MAX_SEEN_PER_ORIGIN = 64;
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 120_000;

export interface OriginFloors {
  highest_seen: number;
  // release number -> manifest sha256; one number names one manifest.
  seen: Record<string, string>;
}

export interface CliState {
  schema: typeof STATE_SCHEMA;
  origin: string;
  mode: "origin-trust";
  auto: boolean;
  held_at: number | null;
  launcher: string;
  origins: Record<string, OriginFloors>;
}

export function cliRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COCALC_CLI_ROOT) return env.COCALC_CLI_ROOT;
  const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "cocalc", "cli");
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function fsyncPath(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (err: any) {
    // Some platforms can't fsync a directory; the rename is still atomic.
    if (!["EISDIR", "EINVAL", "EPERM", "EBADF"].includes(err?.code)) throw err;
  } finally {
    await handle?.close();
  }
}

export async function writeFileAtomic(
  path: string,
  data: Buffer | string,
  mode = 0o600,
): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, mode);
  await rename(temp, path);
  await fsyncPath(dirname(path));
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

export function validOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]/_-]+$/.test(value)) return false;
  return !value.endsWith("/");
}

export function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error(`not a site URL: ${input}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`not a site URL: ${input}`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      `a site URL has no query, fragment or credentials: ${input}`,
    );
  }
  const origin = `${url.protocol}//${url.host}${url.pathname}`.replace(
    /\/+$/,
    "",
  );
  if (!validOrigin(origin)) throw new Error(`not a site URL: ${input}`);
  return origin;
}

export function parseState(text: string): CliState {
  const o = JSON.parse(text);
  const bad = (what: string): never => {
    throw new Error(`invalid CLI state (${what})`);
  };
  if (o?.schema !== STATE_SCHEMA) bad("schema");
  if (!validOrigin(o.origin)) bad("origin");
  if (o.mode !== "origin-trust") bad("mode");
  if (typeof o.auto !== "boolean") bad("auto");
  if (o.held_at != null && !isRelease(o.held_at)) bad("held_at");
  if (typeof o.launcher !== "string" || !o.launcher.startsWith("/")) {
    bad("launcher");
  }
  const origins: Record<string, OriginFloors> = {};
  for (const [origin, floors] of Object.entries(o.origins ?? {})) {
    const f = floors as any;
    if (!validOrigin(origin) || !isRelease(f?.highest_seen)) bad("origins");
    const seen: Record<string, string> = {};
    for (const [release, hash] of Object.entries(f.seen ?? {})) {
      if (!isRelease(Number(release)) || !isSha256(hash)) bad("seen");
      seen[release] = hash as string;
    }
    origins[origin] = { highest_seen: f.highest_seen, seen };
  }
  return {
    schema: STATE_SCHEMA,
    origin: o.origin,
    mode: "origin-trust",
    auto: o.auto,
    held_at: o.held_at ?? null,
    launcher: o.launcher,
    origins,
  };
}

export async function readState(root: string): Promise<CliState | undefined> {
  const text = await readText(join(root, "state.json"));
  return text == null ? undefined : parseState(text);
}

export async function writeState(root: string, state: CliState): Promise<void> {
  await writeFileAtomic(
    join(root, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export async function readActive(
  root: string,
  name: "active" | "previous" = "active",
): Promise<{ line: string; pointer: ActivePointer } | undefined> {
  const line = await readText(join(root, name));
  if (line == null) return undefined;
  return { line, pointer: parseActiveLine(line) };
}

export async function readLocalManifest(
  root: string,
  hash: string,
): Promise<CliReleaseManifest> {
  const text = await readFile(join(root, "manifests", `${hash}.json`), "utf8");
  if (sha256(text) !== hash) {
    throw new Error(`the local manifest ${hash} is damaged`);
  }
  return parseManifest(text);
}

// Record a release (number -> manifest) for an origin, refusing a number
// that already names a different manifest.
export function recordRelease(
  state: CliState,
  origin: string,
  release: number,
  manifestHash: string,
): void {
  const floors = (state.origins[origin] ??= {
    highest_seen: release,
    seen: {},
  });
  const known = floors.seen[`${release}`];
  if (known != null && known !== manifestHash) {
    throw new Error(
      `${origin} offered release ${release} with a different manifest than before; refusing it.`,
    );
  }
  floors.seen[`${release}`] = manifestHash;
  floors.highest_seen = Math.max(floors.highest_seen, release);
  const releases = Object.keys(floors.seen)
    .map(Number)
    .sort((a, b) => b - a);
  for (const old of releases.slice(MAX_SEEN_PER_ORIGIN)) {
    delete floors.seen[`${old}`];
  }
}

export function checkRelease(
  state: CliState | undefined,
  origin: string,
  release: number,
  manifestHash: string,
): void {
  const known = state?.origins[origin]?.seen[`${release}`];
  if (known != null && known !== manifestHash) {
    throw new Error(
      `${origin} offered release ${release} with a different manifest than before; refusing it.`,
    );
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export async function withLock<T>(
  root: string,
  fn: () => Promise<T>,
  log: (message: string) => void = () => {},
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "lock");
  const start = Date.now();
  let told = false;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      await handle.close();
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const [pid, at] = `${(await readText(path)) ?? ""}`
        .trim()
        .split(" ")
        .map(Number);
      const stale =
        !Number.isSafeInteger(pid) ||
        !processAlive(pid) ||
        !(Date.now() - at < LOCK_STALE_MS);
      if (stale) {
        await unlink(path).catch(() => {});
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error(
          `another CLI update (process ${pid}) holds ${path}; try again later`,
        );
      }
      if (!told) {
        log("Waiting for another CLI update to finish...");
        told = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}

// Finish or discard an interrupted switch. Call with the lock held.
export async function recover(root: string): Promise<void> {
  await rm(join(root, "staging"), { recursive: true, force: true });
  const journal = await readText(join(root, "transition.json"));
  if (journal == null) return;
  let from: string | null = null;
  let to: string | null = null;
  try {
    ({ from, to } = JSON.parse(journal));
  } catch {
    // A torn journal: the switch itself never started.
  }
  const active = await readText(join(root, "active"));
  if (to != null && active === to && from != null && from !== to) {
    await writeFileAtomic(join(root, "previous"), from);
  }
  await unlink(join(root, "transition.json"));
  await fsyncPath(root);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pointerComplete(
  root: string,
  pointer: ActivePointer,
): Promise<boolean> {
  return (
    existsSync(join(root, "node", pointer.node, "bin", "node")) &&
    existsSync(join(root, "targets", pointer.bootstrap, "bootstrap.js")) &&
    existsSync(join(root, "targets", pointer.bundle, "cocalc.js")) &&
    existsSync(join(root, "manifests", `${pointer.manifest}.json`)) &&
    (await isDirectory(join(root, "node", pointer.node))) &&
    (await isDirectory(join(root, "targets", pointer.bundle)))
  );
}

// Writes the journal, switches `active` (and the launcher, if it changed),
// records `previous`, and clears the journal.
async function switchActive(
  root: string,
  to: string,
  launcher?: { path: string; bytes: Buffer },
): Promise<string | undefined> {
  const from = (await readText(join(root, "active"))) ?? null;
  await writeFileAtomic(
    join(root, "transition.json"),
    JSON.stringify({ from, to }) + "\n",
  );
  if (launcher != null) {
    await mkdir(dirname(launcher.path), { recursive: true });
    await writeFileAtomic(launcher.path, launcher.bytes, 0o755);
  }
  await writeFileAtomic(join(root, "active"), to, 0o644);
  if (from != null && from !== to) {
    await writeFileAtomic(join(root, "previous"), from);
  }
  await unlink(join(root, "transition.json"));
  await fsyncPath(root);
  return from ?? undefined;
}

export type FetchFile = (
  hash: string,
  dest: string,
  size: number,
) => Promise<void>;

async function installNode(
  root: string,
  staging: string,
  manifest: CliReleaseManifest,
  fetchFile: FetchFile,
): Promise<string> {
  const platform = currentPlatform();
  const archive = platform ? manifest.node.platforms[platform] : undefined;
  if (archive == null) {
    throw new Error(
      `release ${manifest.release} has no Node for ${process.platform}-${process.arch}`,
    );
  }
  const target = join(root, "node", archive.sha256);
  if (existsSync(join(target, "bin", "node")) && (await isDirectory(target))) {
    return archive.sha256;
  }
  const file = join(staging, "node.tar.gz");
  await fetchFile(archive.sha256, file, archive.size);
  const unpack = join(staging, "node-unpack");
  await mkdir(unpack);
  await execFile("tar", [
    "-xzf",
    file,
    "-C",
    unpack,
    `${archive.dir}/bin/node`,
    `${archive.dir}/LICENSE`,
  ]);
  const binary = join(unpack, archive.dir, "bin", "node");
  const info = await lstat(binary);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("the Node archive has no regular bin/node");
  }
  const tree = join(staging, "node-tree");
  await mkdir(join(tree, "bin"), { recursive: true });
  await rename(binary, join(tree, "bin", "node"));
  await rename(join(unpack, archive.dir, "LICENSE"), join(tree, "LICENSE"));
  await chmod(join(tree, "bin", "node"), 0o700);
  await fsyncPath(join(tree, "bin", "node"));
  await rm(target, { recursive: true, force: true });
  await mkdir(join(root, "node"), { recursive: true, mode: 0o700 });
  await rename(tree, target);
  await fsyncPath(join(root, "node"));
  return archive.sha256;
}

async function installTarget(
  root: string,
  staging: string,
  ref: { sha256: string; size: number },
  name: "bootstrap.js" | "cocalc.js",
  fetchFile: FetchFile,
): Promise<void> {
  const target = join(root, "targets", ref.sha256);
  const file = join(target, name);
  if (existsSync(file) && (await isDirectory(target))) {
    const info = await stat(file);
    if (info.size === ref.size && (await sha256File(file)) === ref.sha256) {
      return;
    }
  }
  const dir = join(staging, `target-${ref.sha256}`);
  await mkdir(dir);
  await fetchFile(ref.sha256, join(dir, name), ref.size);
  await fsyncPath(join(dir, name));
  await rm(target, { recursive: true, force: true });
  await mkdir(join(root, "targets"), { recursive: true, mode: 0o700 });
  await rename(dir, target);
  await fsyncPath(join(root, "targets"));
}

export interface InstallResult {
  release: number;
  version: string;
  changed: boolean;
  launcherChanged: boolean;
}

/*
 * Install a release and make it active. With the lock held:
 *   1. recover an interrupted switch;
 *   2. stage and verify every missing file, then rename it into place;
 *   3. raise the floors (state.json) before exposing the new code;
 *   4. journal, switch the launcher if it changed, switch `active`.
 * `prepareState` sets the origin and settings (first install, --from).
 */
export async function installRelease({
  root,
  origin,
  manifestText,
  manifestHash,
  fetchFile,
  launcherBytes,
  prepareState,
  log = () => {},
}: {
  root: string;
  origin: string;
  manifestText: string;
  manifestHash: string;
  fetchFile: FetchFile;
  launcherBytes?: Buffer;
  prepareState: (state: CliState | undefined) => CliState;
  log?: (message: string) => void;
}): Promise<InstallResult> {
  if (sha256(manifestText) !== manifestHash) {
    throw new Error("the release manifest does not match its hash");
  }
  const manifest = parseManifest(manifestText);
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
        await installTarget(
          root,
          staging,
          manifest.bundle,
          "cocalc.js",
          fetchFile,
        );
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
        if ((await readText(join(root, "origin"))) !== `${state.origin}\n`) {
          await writeFileAtomic(
            join(root, "origin"),
            `${state.origin}\n`,
            0o644,
          );
        }

        const to = formatActiveLine({
          manifest: manifestHash,
          node,
          bootstrap: manifest.bootstrap.sha256,
          bundle: manifest.bundle.sha256,
        });
        const current = await readText(join(root, "active"));
        if (current === to && launcher == null) {
          return {
            release: manifest.release,
            version: manifest.version,
            changed: false,
            launcherChanged: false,
          };
        }
        await switchActive(root, to, launcher);
        await collectGarbage(root);
        log(
          `CoCalc CLI release ${manifest.release} (version ${manifest.version}) is now active.`,
        );
        return {
          release: manifest.release,
          version: manifest.version,
          changed: current !== to,
          launcherChanged: launcher != null,
        };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    log,
  );
}

/*
 * Go back to the previous release. Local only: it never lowers the floors,
 * keeps the launcher (launchers read every earlier pointer format) and
 * places a hold, so automatic updates don't undo it.
 */
export async function rollback(
  root: string,
  log: (message: string) => void = () => {},
): Promise<{ release: number; version: string }> {
  return await withLock(
    root,
    async () => {
      await recover(root);
      const state = await readState(root);
      if (state == null) throw new Error("the CLI is not installed here");
      const previous = await readActive(root, "previous");
      if (previous == null) {
        throw new Error("there is no previous release to go back to");
      }
      if (!(await pointerComplete(root, previous.pointer))) {
        throw new Error("the previous release is no longer complete on disk");
      }
      const manifest = await readLocalManifest(root, previous.pointer.manifest);
      state.held_at = manifest.release;
      await writeState(root, state);
      await switchActive(root, previous.line);
      log(
        `Rolled back to CoCalc CLI release ${manifest.release} (version ${manifest.version}). Automatic updates are held; run \`cocalc update --resume\` to resume.`,
      );
      return { release: manifest.release, version: manifest.version };
    },
    log,
  );
}

// Keep only what `active` and `previous` reference.
export async function collectGarbage(root: string): Promise<void> {
  const keep = new Set<string>();
  for (const name of ["active", "previous"] as const) {
    const entry = await readActive(root, name).catch(() => undefined);
    if (entry == null) continue;
    for (const hash of Object.values(entry.pointer)) keep.add(hash);
  }
  if (keep.size === 0) return;
  for (const dir of ["node", "targets"]) {
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

export async function activeRelease(
  root: string,
): Promise<{ release: number; version: string; manifest: string } | undefined> {
  const active = await readActive(root).catch(() => undefined);
  if (active == null) return undefined;
  const manifest = await readLocalManifest(root, active.pointer.manifest).catch(
    () => undefined,
  );
  if (manifest == null) return undefined;
  return {
    release: manifest.release,
    version: manifest.version,
    manifest: active.pointer.manifest,
  };
}
