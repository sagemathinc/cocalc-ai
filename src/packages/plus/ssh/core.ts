import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

type SshExecOptions = {
  inherit?: boolean;
  timeoutMs?: number;
  extraArgs?: string[];
};

export type SshOptions = {
  host: string;
  port: number | null;
  identity?: string;
  proxyJump?: string;
  sshArgs: string[];
};

export type RegistryEntry = {
  target: string;
  starred?: boolean;
  host?: string;
  port?: number | null;
  localPort?: number;
  tunnelPid?: number;
  lastUsed?: string;
  lastStopped?: string;
  identity?: string;
  proxyJump?: string;
  sshArgs?: string[];
};

export type ConnectionInfo = {
  port: number;
  token?: string;
  [key: string]: unknown;
};

export type VersionInfo = {
  version: string;
  os: string;
  arch: string;
  updatedAt?: string;
  source?: string;
};

export type UpgradeInfo = {
  currentVersion?: string;
  latestVersion?: string;
  upgradeAvailable: boolean;
  os?: string;
  arch?: string;
  checkedAt: string;
  error?: string;
};

export type ConnectOptions = {
  localPort?: string;
  remotePort?: string;
  noOpen?: boolean;
  noInstall?: boolean;
  upgrade?: boolean;
  forwardOnly?: boolean;
  identity?: string;
  proxyJump?: string;
  logLevel?: string;
  sshArg?: string[];
  localUrl?: string;
  waitForReady?: boolean;
  readyTimeoutMs?: number;
};

export type ConnectResult = {
  url: string;
  localPort: number;
  remotePort: number;
  info: ConnectionInfo;
  tunnel: ChildProcess;
};

export function parseTarget(raw: string) {
  const m = raw.match(/^(.*?)(?::(\d+))?$/);
  if (!m) throw new Error(`Invalid target: ${raw}`);
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : null };
}

export function infoPathFor(target: string) {
  const hash = crypto.createHash("sha1").update(target).digest("hex");
  const baseDir = path.join(
    os.homedir(),
    ".local",
    "share",
    "cocalc-plus",
    "ssh",
  );
  return {
    hash,
    baseDir,
    localDir: path.join(baseDir, hash),
    remoteDir: `$HOME/.local/share/cocalc-plus/ssh/${hash}`,
  };
}

export function registryPath() {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "cocalc-plus",
    "ssh",
    "registry.json",
  );
}

export function loadRegistry(): Record<string, RegistryEntry> {
  const file = registryPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const obj: Record<string, RegistryEntry> = {};
      for (const entry of parsed) {
        if (entry?.target) obj[entry.target] = entry;
      }
      return obj;
    }
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return {};
}

export function saveRegistry(registry: Record<string, RegistryEntry>) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

export function updateRegistry(target: string, data: Partial<RegistryEntry>) {
  const registry = loadRegistry();
  registry[target] = { ...(registry[target] || {}), ...data, target };
  saveRegistry(registry);
}

export function listSessions(): RegistryEntry[] {
  return Object.values(loadRegistry());
}

export function deleteSession(target: string) {
  const registry = loadRegistry();
  if (registry[target]) {
    delete registry[target];
    saveRegistry(registry);
  }
  const { localDir } = infoPathFor(target);
  try {
    fs.rmSync(localDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function isPidAlive(pid?: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(out.trim() || null);
    });
  });
}

function isManagedTunnelCommand(entry: RegistryEntry, cmd: string): boolean {
  if (!cmd.includes("ssh")) return false;
  if (entry.localPort && !cmd.includes(`${entry.localPort}:127.0.0.1:`)) {
    return false;
  }
  const { host } = parseTarget(entry.target);
  const hostNoUser = host.split("@").pop() ?? host;
  return cmd.includes(host) || cmd.includes(hostNoUser);
}

async function stopTunnelForEntry(
  entry: RegistryEntry,
  opts?: { force?: boolean },
): Promise<boolean> {
  const pid = entry.tunnelPid;
  if (!pid || !isPidAlive(pid)) return false;
  const cmd = await readProcessCommand(pid);
  if (!opts?.force && cmd && !isManagedTunnelCommand(entry, cmd)) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  return !isPidAlive(pid);
}

export async function stopRegisteredTunnel(target: string): Promise<boolean> {
  const registry = loadRegistry();
  const entry = registry[target];
  if (!entry) return false;
  const stopped = await stopTunnelForEntry(entry, { force: false });
  if (entry.tunnelPid) {
    delete entry.tunnelPid;
    entry.lastStopped = new Date().toISOString();
    registry[target] = entry;
    saveRegistry(registry);
  }
  return stopped;
}

export function pickFreePort(): Promise<number> {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function canBindPort(port: number): Promise<boolean> {
  const net = require("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

export function buildSshArgs(opts: SshOptions): string[] {
  const args: string[] = [];
  if (opts.port) {
    args.push("-p", String(opts.port));
  }
  if (opts.identity) {
    args.push("-i", opts.identity);
  }
  if (opts.proxyJump) {
    args.push("-J", opts.proxyJump);
  }
  for (const arg of opts.sshArgs) {
    args.push(arg);
  }
  return args;
}

export function sshRunAsync(
  opts: SshOptions,
  cmd: string,
  execOpts: SshExecOptions = {},
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  const sshArgs = buildSshArgs(opts);
  const finalArgs = sshArgs.concat(execOpts.extraArgs || [], [opts.host, cmd]);
  const stdio = execOpts.inherit ? "inherit" : "pipe";
  return new Promise((resolve) => {
    const child = spawn("ssh", finalArgs, { stdio });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    const finalize = (
      status: number | null,
      error?: Error,
    ) => {
      if (finished) return;
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ status, stdout, stderr, error });
    };
    if (execOpts.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finalize(null, new Error("ssh timeout"));
      }, execOpts.timeoutMs);
    }
    child.once("error", (err) => finalize(null, err as Error));
    child.once("exit", (code) => finalize(code ?? null));
  });
}

export async function sshExecAsync(
  opts: SshOptions,
  cmd: string,
  inherit = false,
): Promise<string> {
  const res = await sshRunAsync(opts, cmd, { inherit });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(`ssh failed: ${stderr || res.status}`);
  }
  return (res.stdout || "").toString().trim();
}

async function waitForLocalUrl(
  url: string,
  timeoutMs = 8000,
  intervalMs = 250,
): Promise<boolean> {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = client.request(
        {
          method: "GET",
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          timeout: 2000,
        },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

export type ProbeResult = {
  status: "found" | "missing" | "unreachable";
  path: string;
};

const REMOTE_STATUS_CACHE_MS = 10_000;
const remoteStatusCache = new Map<string, { status: string; ts: number }>();
const UPGRADE_CACHE_MS = 24 * 60 * 60 * 1000;
const latestManifestCache = new Map<string, { data: any; ts: number }>();
const localUpgradeCache: { info?: UpgradeInfo; ts?: number } = {};
const remoteUpgradeCache = new Map<string, { info: UpgradeInfo; ts: number }>();

function extractVersionFromPath(value?: string) {
  if (!value) return undefined;
  const match = value.match(/[/\\]cocalc[/\\][^/\\]+[/\\]([^/\\]+)[/\\]/);
  return match?.[1];
}

function getLocalVersion(): string {
  if (process.env.COCALC_PLUS_VERSION) return process.env.COCALC_PLUS_VERSION;
  if (process.env.COCALC_PROJECT_HOST_VERSION)
    return process.env.COCALC_PROJECT_HOST_VERSION;
  if (process.env.COCALC_SEA_VERSION) return process.env.COCALC_SEA_VERSION;
  if (process.env.npm_package_version) return process.env.npm_package_version;
  const pathVersion =
    extractVersionFromPath(process.env.COCALC_BIN_PATH) ||
    extractVersionFromPath(__dirname);
  if (pathVersion) return pathVersion;
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg?.version) return pkg.version;
  } catch {
    // ignore
  }
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg?.version) return pkg.version;
  } catch {
    // ignore
  }
  try {
    const baseDir =
      process.env.COCALC_PLUS_HOME ??
      process.env.COCALC_DATA_DIR ??
      path.join(os.homedir(), ".local", "share", "cocalc-plus");
    const candidates = [
      path.join(baseDir, "version.json"),
      path.join(baseDir, "data", "version.json"),
    ];
    for (const versionPath of candidates) {
      if (!fs.existsSync(versionPath)) continue;
      const raw = JSON.parse(fs.readFileSync(versionPath, "utf8"));
      if (raw?.version) return raw.version;
    }
  } catch {
    // ignore
  }
  return "unknown";
}

function getCachedRemoteStatus(target: string, maxAgeMs = REMOTE_STATUS_CACHE_MS) {
  const cached = remoteStatusCache.get(target);
  if (!cached) return null;
  if (Date.now() - cached.ts > maxAgeMs) return null;
  return cached.status;
}

function setCachedRemoteStatus(target: string, status: string) {
  remoteStatusCache.set(target, { status, ts: Date.now() });
}

function getSoftwareBaseUrl() {
  const base =
    process.env.COCALC_PLUS_BASE_URL ||
    process.env.COCALC_SOFTWARE_BASE_URL ||
    "https://software.cocalc.ai/software";
  return base.replace(/\/+$/, "");
}

function normalizeOsArch() {
  const platform = os.platform();
  const osName =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform;
  const archRaw = os.arch();
  const arch =
    archRaw === "x64"
      ? "amd64"
      : archRaw === "arm64"
        ? "arm64"
        : archRaw;
  return { os: osName, arch };
}

function compareVersions(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const norm = (v: string) => v.split(/[+-]/)[0];
  const partsA = norm(a).split(".").map((n) => parseInt(n, 10));
  const partsB = norm(b).split(".").map((n) => parseInt(n, 10));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function extractVersion(raw?: string): string | null {
  if (!raw) return null;
  const match = raw.match(
    /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/,
  );
  return match?.[1] ?? null;
}

function getLatestVersion(latest: any): string | undefined {
  if (!latest) return undefined;
  if (typeof latest.version === "string") return latest.version;
  const fromUrl = extractVersion(
    typeof latest.url === "string" ? latest.url : undefined,
  );
  if (fromUrl) return fromUrl;
  return undefined;
}

async function fetchJson(url: string): Promise<any> {
  return await new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
  });
}

async function getLatestManifest(osName: string, arch: string, force = false) {
  const key = `${osName}-${arch}`;
  const cached = latestManifestCache.get(key);
  if (!force && cached && Date.now() - cached.ts < UPGRADE_CACHE_MS) {
    return cached.data;
  }
  const url = `${getSoftwareBaseUrl()}/cocalc-plus/latest-${osName}-${arch}.json`;
  const data = await fetchJson(url);
  latestManifestCache.set(key, { data, ts: Date.now() });
  return data;
}

async function readRemoteVersionInfo(
  opts: SshOptions,
  target: string,
): Promise<VersionInfo | null> {
  const { remoteDir } = infoPathFor(target);
  const remoteVersionPath = `${remoteDir}/version.json`;
  try {
    const content = await sshExecAsync(opts, `cat ${remoteVersionPath}`);
    const parsed = JSON.parse(content);
    if (parsed?.version && parsed?.os && parsed?.arch) {
      return {
        version: String(parsed.version),
        os: String(parsed.os),
        arch: String(parsed.arch),
        updatedAt: parsed.updatedAt,
        source: "file",
      };
    }
  } catch {
    // ignore and fall back
  }
  try {
    const remoteBin = await resolveRemoteBin(opts);
    const versionRaw = await sshExecAsync(opts, `${remoteBin} version`);
    const version = extractVersion(versionRaw) ?? "unknown";
    const unameOs = await sshExecAsync(opts, "uname -s");
    const unameArch = await sshExecAsync(opts, "uname -m");
    const osName =
      unameOs.toLowerCase().includes("darwin")
        ? "darwin"
        : unameOs.toLowerCase().includes("linux")
          ? "linux"
          : unameOs.toLowerCase();
    let arch = unameArch.trim();
    if (arch === "x86_64" || arch === "amd64") arch = "amd64";
    if (arch === "aarch64" || arch === "arm64") arch = "arm64";
    return {
      version,
      os: osName,
      arch,
      updatedAt: new Date().toISOString(),
      source: "probe",
    };
  } catch {
    return null;
  }
}

export async function getLocalUpgradeInfo(
  opts?: { force?: boolean },
): Promise<UpgradeInfo> {
  if (!opts?.force && localUpgradeCache.info && localUpgradeCache.ts) {
    if (Date.now() - localUpgradeCache.ts < UPGRADE_CACHE_MS) {
      return localUpgradeCache.info;
    }
  }
  const { os: osName, arch } = normalizeOsArch();
  const currentVersion = getLocalVersion();
  let latestVersion = "unknown";
  let upgradeAvailable = false;
  let error: string | undefined;
  try {
    const latest = await getLatestManifest(osName, arch, !!opts?.force);
    latestVersion = getLatestVersion(latest) ?? "unknown";
    upgradeAvailable =
      currentVersion !== "unknown" &&
      latestVersion !== "unknown" &&
      compareVersions(currentVersion, latestVersion) < 0;
  } catch (err: any) {
    error = err?.message || String(err);
  }
  const info: UpgradeInfo = {
    currentVersion,
    latestVersion,
    upgradeAvailable,
    os: osName,
    arch,
    checkedAt: new Date().toISOString(),
    error,
  };
  localUpgradeCache.info = info;
  localUpgradeCache.ts = Date.now();
  return info;
}

export async function getRemoteUpgradeInfo(
  entry: RegistryEntry,
  opts?: { force?: boolean },
): Promise<UpgradeInfo> {
  const cached = remoteUpgradeCache.get(entry.target);
  if (!opts?.force && cached && Date.now() - cached.ts < UPGRADE_CACHE_MS) {
    return cached.info;
  }
  const { host, port } = parseTarget(entry.target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: entry.identity,
    proxyJump: entry.proxyJump,
    sshArgs: entry.sshArgs || [],
  };
  const baseInfo = await readRemoteVersionInfo(sshOpts, entry.target);
  let latestVersion = "unknown";
  let upgradeAvailable = false;
  let error: string | undefined;
  if (baseInfo?.os && baseInfo?.arch && baseInfo?.version) {
    try {
      const latest = await getLatestManifest(
        baseInfo.os,
        baseInfo.arch,
        !!opts?.force,
      );
      latestVersion = getLatestVersion(latest) ?? "unknown";
      upgradeAvailable =
        baseInfo.version !== "unknown" &&
        latestVersion !== "unknown" &&
        compareVersions(baseInfo.version, latestVersion) < 0;
    } catch (err: any) {
      error = err?.message || String(err);
    }
  } else {
    error = "missing version info";
  }
  const info: UpgradeInfo = {
    currentVersion: baseInfo?.version ?? "unknown",
    latestVersion,
    upgradeAvailable,
    os: baseInfo?.os,
    arch: baseInfo?.arch,
    checkedAt: new Date().toISOString(),
    error,
  };
  remoteUpgradeCache.set(entry.target, { info, ts: Date.now() });
  return info;
}

export async function getUpgradeInfo(opts?: {
  force?: boolean;
  scope?: "local" | "remote" | "all";
}): Promise<{ local?: UpgradeInfo; remotes: Record<string, UpgradeInfo> }> {
  const scope = opts?.scope ?? "all";
  const result: { local?: UpgradeInfo; remotes: Record<string, UpgradeInfo> } = {
    remotes: {},
  };
  if (scope === "local" || scope === "all") {
    result.local = await getLocalUpgradeInfo({ force: opts?.force });
  }
  if (scope === "remote" || scope === "all") {
    const entries = listSessions();
    const pending = entries.slice();
    const concurrency = 4;
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (pending.length > 0) {
        const entry = pending.shift();
        if (!entry) continue;
        try {
          const info = await getRemoteUpgradeInfo(entry, {
            force: opts?.force,
          });
          result.remotes[entry.target] = info;
        } catch (err: any) {
          result.remotes[entry.target] = {
            upgradeAvailable: false,
            currentVersion: "unknown",
            latestVersion: "unknown",
            checkedAt: new Date().toISOString(),
            error: err?.message || String(err),
          };
        }
      }
    });
    await Promise.all(workers);
  }
  return result;
}

export function openUrl(url: string) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitRemoteFile(
  opts: SshOptions,
  remotePath: string,
  timeoutMs = 10000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await sshExecAsync(opts, `cat ${remotePath}`);
      if (content) return content;
    } catch {
      // ignore and retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${remotePath}`);
}

export async function resolveRemoteBin(opts: SshOptions): Promise<string> {
  const probe = await probeRemoteBinAsync(opts);
  if (probe.status === "found" && probe.path) return probe.path;
  return "$HOME/.local/bin/cocalc-plus";
}

async function probeRemoteBinAsync(
  opts: SshOptions,
  extraArgs: string[] = [],
): Promise<{ status: "found" | "missing" | "unreachable"; path: string }> {
  const which = await sshRunAsync(opts, "command -v cocalc-plus", {
    timeoutMs: 5000,
    extraArgs,
  });
  if (which.error || which.status === 255) {
    return { status: "unreachable", path: "" };
  }
  if (which.status === 0) {
    const path = (which.stdout || "").toString().trim();
    return { status: "found", path };
  }
  const test = await sshRunAsync(opts, 'test -x "$HOME/.local/bin/cocalc-plus"', {
    timeoutMs: 5000,
    extraArgs,
  });
  if (test.error || test.status === 255) {
    return { status: "unreachable", path: "" };
  }
  if (test.status === 0) {
    return { status: "found", path: "$HOME/.local/bin/cocalc-plus" };
  }
  return { status: "missing", path: "$HOME/.local/bin/cocalc-plus" };
}

export async function getRemoteStatus(
  entry: RegistryEntry,
  opts?: { force?: boolean; maxAgeMs?: number },
): Promise<string> {
  const target = entry.target;
  if (!opts?.force) {
    const cached = getCachedRemoteStatus(target, opts?.maxAgeMs);
    if (cached) return cached;
  }
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: entry.identity,
    proxyJump: entry.proxyJump,
    sshArgs: entry.sshArgs || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const extraArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  const probe = await probeRemoteBinAsync(sshOpts, extraArgs);
  if (probe.status === "unreachable") {
    setCachedRemoteStatus(target, "unreachable");
    return "unreachable";
  }
  if (probe.status === "missing") {
    setCachedRemoteStatus(target, "missing");
    return "missing";
  }
  const remoteBin = probe.path || "$HOME/.local/bin/cocalc-plus";
  const res = await sshRunAsync(
    sshOpts,
    `${remoteBin} --daemon-status --pidfile ${remotePidPath}`,
    { timeoutMs: 5000, extraArgs },
  );
  let status = "error";
  if (res.error) status = "unreachable";
  else if (res.status === 0) status = "running";
  else if (res.status === 1) status = "stopped";
  setCachedRemoteStatus(target, status);
  return status;
}

export async function ensureRemoteReady(
  opts: SshOptions,
  install: boolean,
  upgrade: boolean,
) {
  const probe = await probeRemoteBinAsync(opts);
  if (probe.status === "found" && !upgrade) return;
  if (probe.status === "unreachable") {
    throw new Error("ssh unreachable");
  }
  if (probe.status === "missing" && !install) {
    throw new Error("cocalc-plus not installed on remote");
  }
  if (!install && !upgrade) return;
  await sshExecAsync(
    opts,
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash",
    true,
  );
}

async function stopRemoteDaemonBestEffort(
  opts: SshOptions,
  target: string,
): Promise<void> {
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteBin = await resolveRemoteBin(opts);
  const cmd = `if [ -f ${remotePidPath} ]; then ${remoteBin} --daemon-stop --pidfile ${remotePidPath} >/dev/null 2>&1 || true; fi`;
  try {
    await sshExecAsync(opts, cmd, true);
  } catch {
    // ignore best-effort stop failures
  }
}

export async function upgradeRemote(
  entry: RegistryEntry,
  options?: { localUrl?: string; restart?: boolean },
): Promise<void> {
  const target = entry.target;
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: entry.identity,
    proxyJump: entry.proxyJump,
    sshArgs: entry.sshArgs || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remoteInfoPath = `${remoteDir}/connection.json`;
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteLogPath = `${remoteDir}/daemon.log`;
  const wasRunning = await getRemoteStatus(entry, { force: true });

  await stopRemoteDaemonBestEffort(sshOpts, target);
  await ensureRemoteReady(sshOpts, true, true);

  if (options?.restart !== false && wasRunning === "running") {
    const authToken = crypto.randomBytes(16).toString("hex");
    const localUrl =
      options?.localUrl ??
      (entry.localPort
        ? `http://localhost:${entry.localPort}?auth_token=${encodeURIComponent(
            authToken,
          )}`
        : undefined);
    await startRemote(
      sshOpts,
      target,
      remoteInfoPath,
      remotePidPath,
      remoteLogPath,
      { authToken, localUrl },
    );
  }
}

export async function upgradeLocal(): Promise<void> {
  const cmd =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", cmd], { stdio: "inherit" });
    child.once("error", (err) => reject(err));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`upgrade failed with code ${code}`));
    });
  });
}

export async function startRemote(
  opts: SshOptions,
  target: string,
  remoteInfoPath: string,
  remotePidPath: string,
  remoteLogPath: string,
  options?: {
    authToken?: string;
    localUrl?: string;
  },
): Promise<ConnectionInfo> {
  const remoteBin = await resolveRemoteBin(opts);
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const safeTarget = shellQuote(target);
  const authToken = options?.authToken;
  const localUrl = options?.localUrl;
  const { remoteDir } = infoPathFor(target);
  const remoteVersionPath = `${remoteDir}/version.json`;
  const env = [
    "HOST=127.0.0.1",
    "PORT=0",
    authToken ? `AUTH_TOKEN=${shellQuote(authToken)}` : "AUTH_TOKEN=short",
    "COCALC_ENABLE_SSH_UI=0",
    "COCALC_DATA_DIR=$HOME/.local/share/cocalc-plus/data",
    `COCALC_REMOTE_SSH_TARGET=${safeTarget}`,
    `COCALC_WRITE_CONNECTION_INFO=${remoteInfoPath}`,
    `COCALC_WRITE_VERSION_INFO=${remoteVersionPath}`,
    `COCALC_DAEMON_PIDFILE=${remotePidPath}`,
    `COCALC_DAEMON_LOG=${remoteLogPath}`,
    localUrl ? `COCALC_REMOTE_SSH_LOCAL_URL=${shellQuote(localUrl)}` : "",
  ].join(" ");
  const cmd = `mkdir -p ${path.dirname(remoteInfoPath)} && ${env} ${remoteBin} --daemon --write-connection-info ${remoteInfoPath} --pidfile ${remotePidPath} --log ${remoteLogPath}`;
  await sshExecAsync(opts, cmd, true);
  const info = await waitRemoteFile(opts, remoteInfoPath, 20000);
  return JSON.parse(info) as ConnectionInfo;
}

export async function statusSession(
  mode: "status" | "stop",
  target: string,
  opts: { identity?: string; proxyJump?: string; sshArg?: string[] },
) {
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: opts.identity,
    proxyJump: opts.proxyJump,
    sshArgs: opts.sshArg || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  await ensureRemoteReady(sshOpts, false, false);
  const remoteBin = await resolveRemoteBin(sshOpts);
  const cmd = `${remoteBin} --daemon-${mode} --pidfile ${remotePidPath}`;
  await sshExecAsync(sshOpts, cmd, true);
  if (mode === "stop") {
    updateRegistry(target, { lastStopped: new Date().toISOString() });
  }
}

export async function connectSession(
  target: string,
  options: ConnectOptions,
): Promise<ConnectResult> {
  const { host, port } = parseTarget(target);
  const sshArgs = options.sshArg || [];
  const sshOpts: SshOptions = {
    host,
    port,
    identity: options.identity,
    proxyJump: options.proxyJump,
    sshArgs,
  };
  const label = target;
  const { localDir, remoteDir } = infoPathFor(label);
  fs.mkdirSync(localDir, { recursive: true });
  const localPortPath = path.join(localDir, "local-port");

  const remoteInfoPath = `${remoteDir}/connection.json`;
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteLogPath = `${remoteDir}/daemon.log`;
  let localPort: number | undefined;
  if (options.localPort && options.localPort !== "auto") {
    localPort = parseInt(options.localPort, 10);
  } else if (fs.existsSync(localPortPath)) {
    const saved = parseInt(fs.readFileSync(localPortPath, "utf8").trim(), 10);
    if (saved && (await canBindPort(saved))) {
      localPort = saved;
    }
  }
  if (!localPort) {
    localPort = await pickFreePort();
    fs.writeFileSync(localPortPath, String(localPort));
  }

  if (options.logLevel === "debug") {
    console.log("Target:", sshOpts);
    console.log("Remote state:", remoteDir);
  }

  if (options.upgrade) {
    await stopRemoteDaemonBestEffort(sshOpts, target);
  }
  await ensureRemoteReady(sshOpts, !options.noInstall, !!options.upgrade);

  let info: ConnectionInfo | null = null;
  if (options.forwardOnly) {
    const content = await sshExecAsync(sshOpts, `cat ${remoteInfoPath}`);
    info = JSON.parse(content) as ConnectionInfo;
  } else {
    let reused = false;
    if (!options.upgrade) {
      const status = await getRemoteStatus({
        target,
        identity: options.identity,
        proxyJump: options.proxyJump,
        sshArgs,
      });
      if (status === "running") {
        try {
          const content = await sshExecAsync(sshOpts, `cat ${remoteInfoPath}`);
          info = JSON.parse(content) as ConnectionInfo;
          reused = true;
        } catch {
          reused = false;
          info = null;
        }
      }
    }
    if (!reused) {
      const authToken = crypto.randomBytes(16).toString("hex");
      const localUrlForRemote =
        options.localUrl ??
        `http://localhost:${localPort}?auth_token=${encodeURIComponent(
          authToken,
        )}`;
      info = await startRemote(
        sshOpts,
        target,
        remoteInfoPath,
        remotePidPath,
        remoteLogPath,
        { authToken, localUrl: localUrlForRemote },
      );
    }
  }

  if (!info) {
    throw new Error("Failed to retrieve remote connection info");
  }

  const remotePort = options.remotePort && options.remotePort !== "auto"
    ? parseInt(options.remotePort, 10)
    : info.port;

  const url = `http://localhost:${localPort}?auth_token=${encodeURIComponent(
    info.token || "",
  )}`;

  updateRegistry(label, {
    host,
    port,
    localPort,
    lastUsed: new Date().toISOString(),
    identity: options.identity || undefined,
    proxyJump: options.proxyJump || undefined,
    sshArgs: sshArgs.length > 0 ? sshArgs : undefined,
  });

  const tunnelArgs = buildSshArgs(sshOpts).concat([
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    host,
  ]);

  console.log(`Forwarding localhost:${localPort} -> ${host}:${remotePort}`);
  console.log(url);
  if (!options.noOpen) {
    openUrl(url);
  }

  const tunnel = spawn("ssh", tunnelArgs, { stdio: "inherit" });
  updateRegistry(label, {
    tunnelPid: tunnel.pid ?? undefined,
  });
  tunnel.once("exit", () => {
    const registry = loadRegistry();
    const entry = registry[label];
    if (!entry) return;
    if (entry.tunnelPid != null) {
      delete entry.tunnelPid;
      entry.lastStopped = new Date().toISOString();
      registry[label] = entry;
      saveRegistry(registry);
    }
  });
  if (options.waitForReady) {
    const ready = await waitForLocalUrl(
      url,
      options.readyTimeoutMs ?? 8000,
    );
    if (!ready) {
      tunnel.kill();
      throw new Error("Remote server did not respond in time");
    }
  }
  return {
    url,
    localPort,
    remotePort,
    info,
    tunnel,
  };
}

export function collectRepeatable(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}
