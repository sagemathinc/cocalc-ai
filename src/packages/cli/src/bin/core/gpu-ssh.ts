/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, step 4: the project-side SSH files that let the
remote-Jupyter connector (reflect, which runs the project's own `ssh`) reach
a GPU pod. See ~/ops2/runpod/SSH-KERNEL.md.

- Each pod gets its own ed25519 key in ~/.ssh/cocalc-gpu/<handle>. The
  private key is made here and never leaves the project; only the public
  key is sent to launch. It is made under a pending name and renamed to the
  handle the launch returns.
- ~/.ssh/cocalc-gpu/config has one `Host <handle>` block per pod: only that
  key (IdentitiesOnly, no agent), and the host key the pod reported, pinned
  by HostKeyAlias so a new IP or port after a restart needs only a refresh.
- ~/.ssh/config starts with `Include "<home>/.ssh/cocalc-gpu/config"` (an
  absolute path: OpenSSH expands `~` from the account, not $HOME). It must
  be the first line: OpenSSH takes the first value it finds for an option, so a
  pod block after a `Host *` with `StrictHostKeyChecking no` or
  `UserKnownHostsFile /dev/null` would silently lose its pinned host key.

Every value written to the config is validated first, so nothing a provider
reports can inject a config line.
*/

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseEd25519PublicKey } from "@cocalc/util/gpu/ssh-key";

const execFileAsync = promisify(execFile);

export const GPU_SSH_DIR = ".ssh/cocalc-gpu";

const HANDLE = /^cc-[a-z2-7]{16}$/;
const PENDING = /^pending-[a-z2-7]{10}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface PodSshEndpoint {
  handle: string;
  host: string;
  port: number;
  user: string;
  // the pod's host public key, as it reported it: "ssh-ed25519 AAAA..."
  hostKey: string;
}

export interface GpuSshOptions {
  // for tests; defaults to the user's home directory
  home?: string;
}

function paths(opts: GpuSshOptions = {}) {
  const home = opts.home ?? homedir();
  const dir = join(home, GPU_SSH_DIR);
  return {
    home,
    sshDir: join(home, ".ssh"),
    dir,
    userConfig: join(home, ".ssh", "config"),
    config: join(dir, "config"),
    knownHosts: join(dir, "known_hosts"),
    registry: join(dir, "pods.json"),
    lock: join(dir, ".lock"),
    key: (handle: string) => join(dir, handle),
    include: `Include ${quote(join(dir, "config"))}`,
  };
}

export function gpuSshInclude(opts: GpuSshOptions = {}): string {
  return paths(opts).include;
}

export function checkHandle(handle: unknown): string {
  if (typeof handle !== "string" || !HANDLE.test(handle)) {
    throw new Error("invalid pod handle");
  }
  return handle;
}

export function checkEndpoint(e: PodSshEndpoint): PodSshEndpoint {
  checkHandle(e.handle);
  if (typeof e.host !== "string" || !HOST.test(e.host)) {
    throw new Error("invalid SSH host");
  }
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
    throw new Error("invalid SSH port");
  }
  if (typeof e.user !== "string" || !USER.test(e.user)) {
    throw new Error("invalid SSH user");
  }
  // One ed25519 key, strictly parsed (the shared validator); only its
  // canonical form, without any comment, is ever written.
  let hostKey: string;
  try {
    hostKey = parseEd25519PublicKey(e.hostKey).line;
  } catch {
    throw new Error("invalid host key: expected one ssh-ed25519 public key");
  }
  return {
    handle: e.handle,
    host: e.host,
    port: e.port,
    user: e.user,
    hostKey,
  };
}

// OpenSSH config values may be quoted; paths here never contain quotes.
function quote(path: string): string {
  if (/["\r\n]/.test(path)) throw new Error("unsupported path");
  return `"${path}"`;
}

export function renderPodSshConfig(
  pods: PodSshEndpoint[],
  opts: GpuSshOptions = {},
): string {
  const p = paths(opts);
  const blocks = pods.map((pod) => {
    const e = checkEndpoint(pod);
    return [
      `Host ${e.handle}`,
      `  HostName ${e.host}`,
      `  Port ${e.port}`,
      `  User ${e.user}`,
      `  IdentityFile ${quote(p.key(e.handle))}`,
      `  IdentitiesOnly yes`,
      `  IdentityAgent none`,
      `  HostKeyAlias ${e.handle}`,
      `  UserKnownHostsFile ${quote(p.knownHosts)}`,
      `  StrictHostKeyChecking yes`,
      `  ForwardAgent no`,
    ].join("\n");
  });
  return (
    "# Managed by CoCalc (cocalc gpu): one block per GPU pod. Do not edit.\n" +
    blocks.map((b) => b + "\n").join("\n")
  );
}

export function renderPodKnownHosts(pods: PodSshEndpoint[]): string {
  return pods
    .map((pod) => {
      const e = checkEndpoint(pod);
      return `${e.handle} ${e.hostKey}\n`;
    })
    .join("");
}

// ~/.ssh/config with our Include as its very first line, exactly once.
export function withIncludeFirst(config: string, include: string): string {
  const lines = config.split("\n").filter((line) => line.trim() !== include);
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  const rest = lines.join("\n");
  return `${include}\n${rest.length > 0 ? `\n${rest}` : ""}`;
}

async function writeAtomic(path: string, text: string, mode = 0o600) {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function ensureDirs(opts: GpuSshOptions) {
  const p = paths(opts);
  for (const dir of [p.sshDir, p.dir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}

// One writer at a time (two `cocalc gpu connect` runs at once must not lose
// a pod). A lock older than a minute is from a crashed run.
async function withLock<T>(opts: GpuSshOptions, fn: () => Promise<T>) {
  const p = paths(opts);
  await ensureDirs(opts);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const handle = await open(p.lock, "wx", 0o600);
      await handle.close();
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const held = await stat(p.lock).catch(() => undefined);
      // gone already: try again at once
      if (held == null) continue;
      if (Date.now() - held.mtimeMs > 60_000) {
        await rm(p.lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`another cocalc gpu command holds ${p.lock}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(p.lock, { force: true });
  }
}

async function readRegistry(opts: GpuSshOptions): Promise<PodSshEndpoint[]> {
  const p = paths(opts);
  let text: string;
  try {
    text = await readFile(p.registry, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data?.pods)) throw new Error(`malformed ${p.registry}`);
  // Anything that no longer validates is dropped rather than written out.
  const pods: PodSshEndpoint[] = [];
  for (const pod of data.pods) {
    try {
      pods.push(checkEndpoint(pod));
    } catch {}
  }
  return pods;
}

async function writeAll(pods: PodSshEndpoint[], opts: GpuSshOptions) {
  const p = paths(opts);
  pods.sort((a, b) => a.handle.localeCompare(b.handle));
  await writeAtomic(p.knownHosts, renderPodKnownHosts(pods));
  await writeAtomic(p.config, renderPodSshConfig(pods, opts));
  await writeAtomic(p.registry, JSON.stringify({ version: 1, pods }, null, 2));
  const current = (await exists(p.userConfig))
    ? await readFile(p.userConfig, "utf8")
    : "";
  const next = withIncludeFirst(current, p.include);
  if (next !== current) {
    const mode = (await exists(p.userConfig))
      ? (await stat(p.userConfig)).mode & 0o777
      : 0o600;
    await writeAtomic(p.userConfig, next, mode);
  }
}

// SHA256 fingerprint of a public key line, exactly as `ssh-keygen -lf`
// prints it ("SHA256:<unpadded base64>"). The server records this one for
// the pod, so a key left pending can be matched to its pod later.
export function keyFingerprint(publicKey: string): string {
  return parseEd25519PublicKey(publicKey).fingerprint;
}

export interface PodKey {
  // "pending-<random>" until the launch returns the pod's handle
  name: string;
  publicKey: string;
  fingerprint: string;
}

async function readPublicKey(key: string): Promise<string> {
  const pub = (await readFile(`${key}.pub`, "utf8")).trim();
  try {
    parseEd25519PublicKey(pub);
  } catch {
    throw new Error("unexpected public key file");
  }
  return pub;
}

// A new key pair for a pod about to be launched. The server makes the
// pod's handle, so the key starts under a pending name: send its public key
// with the launch, then adoptPendingKey() with the handle the launch
// returns. The private key never leaves the project.
export async function createPendingKey(
  opts: GpuSshOptions = {},
): Promise<PodKey> {
  await ensureDirs(opts);
  const name = `pending-${base32(10)}`;
  const key = paths(opts).key(name);
  await execFileAsync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "cocalc-gpu",
    "-f",
    key,
  ]);
  await chmod(key, 0o600);
  const publicKey = await readPublicKey(key);
  return { name, publicKey, fingerprint: keyFingerprint(publicKey) };
}

// Name a pending key after the pod it was launched with.
export async function adoptPendingKey(
  name: string,
  handle: string,
  opts: GpuSshOptions = {},
): Promise<void> {
  checkPendingName(name);
  checkHandle(handle);
  const p = paths(opts);
  const from = p.key(name);
  const to = p.key(handle);
  if (await exists(to)) throw new Error(`a key for ${handle} already exists`);
  await rename(`${from}.pub`, `${to}.pub`);
  await rename(from, to);
}

// Pending keys left by a launch that was interrupted after the server
// answered: match them to a pod by its recorded ssh_key_fingerprint.
export async function listPendingKeys(
  opts: GpuSshOptions = {},
): Promise<PodKey[]> {
  const p = paths(opts);
  let names: string[];
  try {
    names = await readdir(p.dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const keys: PodKey[] = [];
  for (const file of names.sort()) {
    if (!PENDING.test(file) || !(await exists(`${p.key(file)}.pub`))) continue;
    try {
      const publicKey = await readPublicKey(p.key(file));
      keys.push({
        name: file,
        publicKey,
        fingerprint: keyFingerprint(publicKey),
      });
    } catch {}
  }
  return keys;
}

export async function removePendingKey(
  name: string,
  opts: GpuSshOptions = {},
): Promise<void> {
  checkPendingName(name);
  const key = paths(opts).key(name);
  await rm(key, { force: true });
  await rm(`${key}.pub`, { force: true });
}

function checkPendingName(name: unknown): string {
  if (typeof name !== "string" || !PENDING.test(name)) {
    throw new Error("invalid pending key name");
  }
  return name;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(n: number): string {
  let s = "";
  for (const byte of randomBytes(n)) s += BASE32[byte % 32];
  return s;
}

// Add or refresh one pod's alias and pinned host key.
export async function writePodSsh(
  endpoint: PodSshEndpoint,
  opts: GpuSshOptions = {},
): Promise<void> {
  const e = checkEndpoint(endpoint);
  if (!(await exists(paths(opts).key(e.handle)))) {
    throw new Error(`no SSH key for ${e.handle}; it is made at launch`);
  }
  await withLock(opts, async () => {
    const pods = (await readRegistry(opts)).filter(
      (pod) => pod.handle !== e.handle,
    );
    pods.push(e);
    await writeAll(pods, opts);
  });
}

// Forget a pod: its alias, pinned host key and key pair.
export async function removePodSsh(
  handle: string,
  opts: GpuSshOptions = {},
): Promise<void> {
  checkHandle(handle);
  await withLock(opts, async () => {
    const pods = (await readRegistry(opts)).filter(
      (pod) => pod.handle !== handle,
    );
    await writeAll(pods, opts);
  });
  const key = paths(opts).key(handle);
  await rm(key, { force: true });
  await rm(`${key}.pub`, { force: true });
}

export async function listPodSsh(
  opts: GpuSshOptions = {},
): Promise<PodSshEndpoint[]> {
  return await readRegistry(opts);
}
