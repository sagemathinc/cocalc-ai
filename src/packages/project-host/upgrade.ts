import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import getLogger from "@cocalc/backend/logger";
import type {
  HostRuntimeRetentionPolicy,
  SoftwareUpgradeTarget,
  UpgradeSoftwareRequest,
  UpgradeSoftwareResponse,
  UpgradeSoftwareResult,
  SoftwareArtifact,
  SoftwareChannel,
} from "@cocalc/conat/project-host/api";
import { readProjectHostAcpWorkerTarget } from "./hub/acp/worker-target";
import { readHostAgentState } from "./host-agent-state";
import {
  retentionPolicyForArtifact,
  writeConfiguredRuntimeRetentionPolicy,
} from "./runtime-retention-policy";
import { listRuntimeArtifactReferences } from "./sqlite/projects";
import { podmanEnv } from "@cocalc/backend/podman/env";
import {
  beginProjectRuntimeMaintenance,
  endProjectRuntimeMaintenance,
} from "./runtime-maintenance";
import { trimTrailingSlashes } from "@cocalc/util/linear-text";

const logger = getLogger("project-host:upgrade");

const DEFAULT_BASE_URL = "https://software.cocalc.ai/software";
const DEFAULT_BUNDLE_ROOT = "/opt/cocalc/project-bundles";
const DEFAULT_TOOLS_ROOT = "/opt/cocalc/tools";
const DEFAULT_CONTAINER_RUNTIME_ROOT = "/opt/cocalc/container-runtime";
const PROJECT_HOST_ROOT = "/opt/cocalc/project-host";
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const DEFAULT_UPGRADE_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_UPGRADE_DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;
const CONTAINER_QUIESCE_TIMEOUT_MS = 2 * 60_000;

const installTails = new Map<string, Promise<void>>();

type CanonicalArtifact =
  | "project-host"
  | "container-runtime"
  | "project"
  | "tools";

type ResolvedArtifact = {
  artifact: SoftwareArtifact;
  canonicalArtifact: CanonicalArtifact;
  version: string;
  url: string;
  sha256?: string;
  stripComponents: number;
  root: string;
  versionDir: string;
  currentLink: string;
  activate?: boolean;
  retentionPolicy?: HostRuntimeRetentionPolicy;
  containerRuntimeContract?: ContainerRuntimeContract;
};

type VersionDirEntry = {
  dir: string;
  real: string;
  mtimeMs: number;
  name: string;
  bytes: number | undefined;
};

function normalizeBaseUrl(baseUrl?: string): string {
  const raw =
    baseUrl ??
    process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL ??
    DEFAULT_BASE_URL;
  return trimTrailingSlashes(raw);
}

function canonicalizeArtifact(artifact: SoftwareArtifact): CanonicalArtifact {
  if (artifact === "project-bundle") return "project";
  return artifact;
}

function normalizeArch(): "amd64" | "arm64" {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`unsupported architecture: ${process.arch}`);
}

function normalizeOs(): "linux" | "darwin" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  throw new Error(`unsupported platform: ${process.platform}`);
}

function normalizeArchValue(value?: string): "amd64" | "arm64" | undefined {
  if (!value) return undefined;
  const raw = value.toLowerCase();
  if (raw === "amd64" || raw === "x86_64" || raw === "x64") return "amd64";
  if (raw === "arm64" || raw === "aarch64") return "arm64";
  return undefined;
}

function normalizeOsValue(value?: string): "linux" | "darwin" | undefined {
  if (!value) return undefined;
  const raw = value.toLowerCase();
  if (raw === "linux") return "linux";
  if (raw === "darwin" || raw === "macos" || raw === "osx") return "darwin";
  return undefined;
}

function extractVersionFromUrl(url: string, artifact: CanonicalArtifact) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(new RegExp(`/${artifact}/([^/]+)/`));
    return match?.[1];
  } catch {
    return undefined;
  }
}

function describeError(err: any): string {
  if (!err) return "unknown error";
  const parts: string[] = [];
  if (err?.name) parts.push(String(err.name));
  if (err?.message) parts.push(String(err.message));
  const cause = err?.cause;
  if (cause) {
    const detail =
      cause?.code ?? cause?.errno ?? cause?.message ?? JSON.stringify(cause);
    parts.push(`cause=${detail}`);
  }
  return parts.join(": ");
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function fetchTimeoutMs(): number {
  return parsePositiveIntEnv(
    "COCALC_PROJECT_HOST_UPGRADE_FETCH_TIMEOUT_MS",
    DEFAULT_UPGRADE_FETCH_TIMEOUT_MS,
  );
}

function downloadTimeoutMs(): number {
  return parsePositiveIntEnv(
    "COCALC_PROJECT_HOST_UPGRADE_DOWNLOAD_TIMEOUT_MS",
    DEFAULT_UPGRADE_DOWNLOAD_TIMEOUT_MS,
  );
}

function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function curlTimeoutArgs(timeoutMs: number): string[] {
  const maxTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const connectTimeoutSeconds = Math.max(1, Math.min(20, maxTimeSeconds));
  return [
    "--connect-timeout",
    `${connectTimeoutSeconds}`,
    "--max-time",
    `${maxTimeSeconds}`,
  ];
}

async function runCommandCapture(
  cmd: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: "pipe", env: opts?.env });
      let stdout = "";
      let stderr = "";
      const timeoutMs = opts?.timeoutMs;
      let settled = false;
      const timer =
        timeoutMs == null
          ? undefined
          : setTimeout(() => {
              if (settled) return;
              proc.kill("SIGKILL");
              settled = true;
              reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
      timer?.unref?.();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        fn();
      };
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => finish(() => reject(err)));
      proc.on("close", (code) => {
        finish(() => {
          if (code === 0) {
            resolve({ stdout, stderr });
          } else {
            reject(
              new Error(
                stderr || stdout || `${cmd} failed with code ${code ?? "?"}`,
              ),
            );
          }
        });
      });
    },
  );
}

async function fetchText(
  url: string,
  headers?: Record<string, string>,
): Promise<string> {
  const timeoutMs = fetchTimeoutMs();
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, headers ? { headers, signal } : { signal });
    if (!res.ok) {
      throw new Error(`fetch ${url} failed (${res.status})`);
    }
    return await res.text();
  } catch (err) {
    logger.warn("upgrade: fetch failed, trying curl fallback", {
      url,
      err: describeError(err),
    });
    const args = ["-fsSL", ...curlTimeoutArgs(timeoutMs)];
    for (const [key, value] of Object.entries(headers ?? {})) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url);
    const { stdout } = await runCommandCapture("curl", args, {
      timeoutMs: timeoutMs + 5_000,
    });
    return stdout;
  } finally {
    cleanup();
  }
}

async function fetchJson(url: string): Promise<any> {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invalid JSON from ${url}: ${describeError(err)}: ${text.slice(0, 200)}`,
    );
  }
}

async function fetchSha256(url: string): Promise<string | undefined> {
  try {
    const text = await fetchText(url);
    const token = text.trim().split(/\s+/)[0];
    return token || undefined;
  } catch {
    return undefined;
  }
}

function resolveDownloadsRoot(): string {
  const dataDir = process.env.COCALC_DATA ?? process.env.DATA;
  if (dataDir) {
    return path.join(dataDir, "cache", "software-downloads");
  }
  return path.join(os.tmpdir(), "cocalc-software-downloads");
}

function resolveProjectHostPaths() {
  const bundleRoot = process.env.COCALC_PROJECT_HOST_BUNDLE_ROOT;
  const currentLink = process.env.COCALC_PROJECT_HOST_CURRENT;
  if (bundleRoot || currentLink) {
    const root =
      bundleRoot ??
      (currentLink
        ? path.join(path.dirname(currentLink), "bundles")
        : PROJECT_HOST_ROOT);
    return {
      root,
      currentLink: currentLink ?? path.join(root, "current"),
      stripComponents: 1,
      usesBundleLayout: true,
    };
  }
  return {
    root: PROJECT_HOST_ROOT,
    currentLink: path.join(PROJECT_HOST_ROOT, "current"),
    stripComponents: 1,
    usesBundleLayout: false,
  };
}

async function downloadToFile(url: string, dest: string) {
  const timeoutMs = downloadTimeoutMs();
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
      throw new Error(`download failed (${res.status})`);
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const body = Readable.fromWeb(res.body as any);
    await pipeline(body, fs.createWriteStream(dest));
  } catch (err) {
    logger.warn("upgrade: stream download failed, trying curl fallback", {
      url,
      dest,
      err: describeError(err),
    });
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await runCommandCapture(
      "curl",
      ["-fsSL", ...curlTimeoutArgs(timeoutMs), "-o", dest, url],
      { timeoutMs: timeoutMs + 5_000 },
    );
  } finally {
    cleanup();
  }
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runTar(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("tar", args, { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `tar failed with code ${code}`));
      }
    });
  });
}

async function runCommand(cmd: string, args: string[]): Promise<void> {
  await runCommandCapture(cmd, args);
}

async function ensureDirWriteAccess(dir: string): Promise<void> {
  await fs.promises.access(dir, fs.constants.W_OK | fs.constants.X_OK);
}

async function ensureWritableDir(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err: any) {
    if (err?.code !== "EACCES") throw err;
  }
  try {
    await ensureDirWriteAccess(dir);
    return;
  } catch (err: any) {
    if (err?.code !== "EACCES") throw err;
  }
  const user = os.userInfo().username;
  logger.warn("upgrade: fixing permissions with sudo", { dir, user });
  await runCommand("sudo", ["-n", STORAGE_WRAPPER, "mkdir", "-p", dir]);
  await runCommand("sudo", [
    "-n",
    STORAGE_WRAPPER,
    "chown",
    `${user}:${user}`,
    dir,
  ]);
  await fs.promises.mkdir(dir, { recursive: true });
  await ensureDirWriteAccess(dir);
}

async function safeRemove(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (err: any) {
    if (err?.code !== "EACCES") throw err;
    logger.warn("upgrade: removing with sudo", { dir });
    await runCommand("sudo", ["-n", STORAGE_WRAPPER, "rm", "-rf", dir]);
  }
}

async function replaceSymlink(linkPath: string, target: string) {
  const tmp = `${linkPath}.tmp-${Date.now()}`;
  try {
    const stat = await fs.promises.lstat(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      await fs.promises.unlink(linkPath);
    } else if (stat.isDirectory()) {
      await fs.promises.rm(linkPath, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
  await fs.promises.symlink(target, tmp);
  await fs.promises.rename(tmp, linkPath);
}

async function assertInstalledVersionDir(versionDir: string): Promise<void> {
  let stat;
  try {
    stat = await fs.promises.stat(versionDir);
  } catch {
    throw new Error(`installed version not found at ${versionDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`installed version is not a directory at ${versionDir}`);
  }
}

async function installedVersionDirExists(versionDir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(versionDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `refusing to replace immutable artifact version because it is not a directory at ${versionDir}`,
      );
    }
    if ((await fs.promises.readdir(versionDir)).length === 0) {
      throw new Error(
        `refusing to replace empty immutable artifact version at ${versionDir}`,
      );
    }
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

type ContainerRuntimeContract = {
  database_backend: string;
  network_backend: string;
  cgroup_manager: string;
};

async function podmanInfoField(
  field: "DatabaseBackend" | "NetworkBackend" | "CgroupManager",
  env = podmanEnv(),
): Promise<string> {
  const { stdout } = await runCommandCapture(
    "podman",
    ["info", "--format", `{{.Host.${field}}}`],
    { timeoutMs: 30_000, env },
  );
  return stdout.trim().toLowerCase();
}

async function assertContainerRuntimeMigrationIsSafe(
  contract: ContainerRuntimeContract,
): Promise<void> {
  const env = podmanEnv();
  const backend = await podmanInfoField("DatabaseBackend", env);
  if (backend !== contract.database_backend) {
    throw new Error(
      `container runtime activation requires existing Podman state to use ${contract.database_backend}; found ${backend || "unknown"}`,
    );
  }
  const networkBackend = await podmanInfoField("NetworkBackend", env);
  if (networkBackend !== contract.network_backend) {
    const { stdout } = await runCommandCapture("podman", ["ps", "-q"], {
      timeoutMs: 30_000,
      env,
    });
    const running = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (running.length > 0) {
      throw new Error(
        `container runtime network migration ${networkBackend || "unknown"}->${contract.network_backend} requires zero running containers; found ${running.length}`,
      );
    }
  }
}

async function quiesceProjectContainersForRuntimeMigration(
  contract: ContainerRuntimeContract,
): Promise<(() => void) | undefined> {
  const env = podmanEnv();
  const databaseBackend = await podmanInfoField("DatabaseBackend", env);
  if (databaseBackend !== contract.database_backend) {
    throw new Error(
      `container runtime activation requires existing Podman state to use ${contract.database_backend}; found ${databaseBackend || "unknown"}`,
    );
  }
  const networkBackend = await podmanInfoField("NetworkBackend", env);
  if (networkBackend === contract.network_backend) return undefined;

  beginProjectRuntimeMaintenance({
    reason: `container-runtime migration ${networkBackend || "unknown"}->${contract.network_backend}`,
  });
  let release = true;
  try {
    const runningBefore = await listRunningPodmanContainerIdsStrict(env);
    logger.warn("upgrade: quiescing project containers for runtime migration", {
      from: networkBackend || "unknown",
      to: contract.network_backend,
      running_containers: runningBefore.length,
    });
    if (runningBefore.length > 0) {
      try {
        await runCommandCapture("podman", ["stop", "--all", "--time", "5"], {
          timeoutMs: CONTAINER_QUIESCE_TIMEOUT_MS,
          env,
        });
      } catch (err) {
        logger.warn("upgrade: podman stop --all reported an error", {
          err: describeError(err),
        });
      }
    }
    const deadline = Date.now() + CONTAINER_QUIESCE_TIMEOUT_MS;
    let running = await listRunningPodmanContainerIdsStrict(env);
    while (running.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      running = await listRunningPodmanContainerIdsStrict(env);
    }
    if (running.length > 0) {
      throw new Error(
        `container runtime migration could not quiesce ${running.length} running container${running.length === 1 ? "" : "s"}`,
      );
    }
    release = false;
    return () => endProjectRuntimeMaintenance();
  } finally {
    if (release) endProjectRuntimeMaintenance();
  }
}

async function validateContainerRuntimeVersion(
  versionDir: string,
): Promise<ContainerRuntimeContract> {
  const manifestPath = path.join(
    versionDir,
    "share",
    "cocalc",
    "runtime-manifest.json",
  );
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  if (manifest?.schema !== "cocalc-container-runtime-v1") {
    throw new Error(`invalid container runtime manifest at ${manifestPath}`);
  }
  const contract: ContainerRuntimeContract = {
    database_backend: `${manifest?.host_contract?.database_backend ?? ""}`
      .trim()
      .toLowerCase(),
    network_backend: `${manifest?.host_contract?.network_backend ?? ""}`
      .trim()
      .toLowerCase(),
    cgroup_manager: `${manifest?.host_contract?.cgroup_manager ?? ""}`
      .trim()
      .toLowerCase(),
  };
  if (
    contract.database_backend !== "sqlite" ||
    contract.network_backend !== "netavark" ||
    contract.cgroup_manager !== "cgroupfs"
  ) {
    throw new Error(
      `unsupported container runtime host contract: ${JSON.stringify(contract)}`,
    );
  }
  const requiredCommands = manifest?.host_contract?.required_commands;
  if (!Array.isArray(requiredCommands)) {
    throw new Error(
      "container runtime host contract commands must be an array",
    );
  }
  for (const command of requiredCommands) {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("container runtime host contract has an invalid command");
    }
    await runCommandCapture(
      "sh",
      ["-c", 'command -v "$1" >/dev/null', "sh", command],
      { timeoutMs: 15_000 },
    );
  }
  for (const binary of [
    "podman",
    "conmon",
    "crun",
    "netavark",
    "aardvark-dns",
  ]) {
    const binaryPath = path.join(versionDir, "bin", binary);
    await fs.promises.access(binaryPath, fs.constants.X_OK);
    let dependencies = "";
    try {
      const { stdout, stderr } = await runCommandCapture("ldd", [binaryPath], {
        timeoutMs: 15_000,
      });
      dependencies = `${stdout}\n${stderr}`;
    } catch (err) {
      dependencies = describeError(err);
      if (!/not a dynamic executable|statically linked/i.test(dependencies)) {
        throw new Error(
          `unable to inspect container runtime ${binary} dependencies: ${dependencies}`,
        );
      }
    }
    if (/\bnot found\b/i.test(dependencies)) {
      throw new Error(
        `container runtime ${binary} has unavailable shared libraries: ${dependencies.trim()}`,
      );
    }
  }
  const podmanBinary = path.join(versionDir, "bin", "podman");
  const { stdout } = await runCommandCapture(podmanBinary, ["--version"], {
    timeoutMs: 15_000,
  });
  const expectedVersion = `${manifest?.components?.podman?.version ?? ""}`;
  if (!expectedVersion || !stdout.includes(expectedVersion)) {
    throw new Error(
      `container runtime Podman version mismatch: expected ${expectedVersion || "manifest version"}, got ${stdout.trim()}`,
    );
  }
  return contract;
}

async function verifyActivatedContainerRuntime(
  contract: ContainerRuntimeContract,
): Promise<void> {
  const env = podmanEnv();
  for (const [field, expected] of [
    ["DatabaseBackend", contract.database_backend],
    ["NetworkBackend", contract.network_backend],
    ["CgroupManager", contract.cgroup_manager],
  ] as const) {
    const observed = await podmanInfoField(field, env);
    if (observed !== expected) {
      throw new Error(
        `activated container runtime ${field} mismatch: expected ${expected}, got ${observed || "unknown"}`,
      );
    }
  }
  await runCommandCapture("podman", ["ps", "-a"], {
    timeoutMs: 30_000,
    env,
  });
}

function pathSizeBytes(target: string, seen = new Set<string>()): number {
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    // keep original path
  }
  if (seen.has(real)) return 0;
  seen.add(real);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = 0;
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += pathSizeBytes(path.join(target, entry.name), seen);
    }
  } catch {
    // ignore unreadable directories
  }
  return total;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRootPath(root: string): string {
  return trimTrailingSlashes(`${root ?? ""}`);
}

function isArtifactVersionName(name: string): boolean {
  return (
    !!name &&
    name !== "current" &&
    name !== "downloads" &&
    !name.startsWith(".")
  );
}

function decodeProcPath(value: string): string {
  return `${value ?? ""}`.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function normalizeMountedArtifactVersion(value: string): string {
  return decodeProcPath(value)
    .replace(/\s+\(deleted\)$/i, "")
    .replace(/\/+\(?deleted\)?$/i, "")
    .trim();
}

function extractMountedArtifactVersionsFromMountinfo(
  mountinfo: string,
  root: string,
): string[] {
  const normalizedRoot = normalizeRootPath(root);
  if (!normalizedRoot) return [];
  const versions = new Set<string>();
  const pattern = new RegExp(
    `${escapeRegExp(normalizedRoot)}/([^/\\s]+)(?:/|\\s|$)`,
    "g",
  );
  for (const line of `${mountinfo ?? ""}`.split("\n")) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) != null) {
      const version = normalizeMountedArtifactVersion(match[1]);
      if (isArtifactVersionName(version)) {
        versions.add(version);
      }
    }
  }
  return [...versions].sort();
}

async function listInstalledArtifactVersions(root: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        isArtifactVersionName(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

async function listRunningPodmanContainerIdsStrict(
  env = podmanEnv(),
): Promise<string[]> {
  const { stdout } = await runCommandCapture("podman", ["ps", "-q"], {
    timeoutMs: 15_000,
    env,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listRunningPodmanContainerIds(): Promise<string[]> {
  try {
    return await listRunningPodmanContainerIdsStrict();
  } catch (err) {
    logger.warn("upgrade: unable to list running podman containers", {
      err: describeError(err),
    });
    return [];
  }
}

async function listLivePodmanMountedArtifactVersions(
  root: string,
): Promise<string[]> {
  const containerIds = await listRunningPodmanContainerIds();
  if (containerIds.length === 0) return [];
  try {
    const { stdout } = await runCommandCapture(
      "podman",
      ["inspect", ...containerIds],
      { timeoutMs: 30_000 },
    );
    return extractMountedArtifactVersionsFromMountinfo(stdout, root);
  } catch (err) {
    logger.warn("upgrade: unable to inspect running podman mounts", {
      root,
      err: describeError(err),
    });
    return [];
  }
}

async function listLiveMountedArtifactVersions(
  root: string,
  procRoot = "/proc",
  includePodman = true,
): Promise<string[]> {
  const roots = new Set([normalizeRootPath(root)]);
  try {
    roots.add(normalizeRootPath(await fs.promises.realpath(root)));
  } catch {
    // keep the configured root; it may not exist in tests or during bootstrap
  }
  roots.delete("");
  if (roots.size === 0) return [];

  let procEntries: fs.Dirent[];
  try {
    procEntries = await fs.promises.readdir(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const versions = new Set<string>();
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let mountinfo: string;
    try {
      mountinfo = await fs.promises.readFile(
        path.join(procRoot, entry.name, "mountinfo"),
        "utf8",
      );
    } catch {
      continue;
    }
    for (const candidateRoot of roots) {
      for (const version of extractMountedArtifactVersionsFromMountinfo(
        mountinfo,
        candidateRoot,
      )) {
        versions.add(version);
      }
    }
  }
  if (includePodman) {
    for (const version of await listLivePodmanMountedArtifactVersions(root)) {
      versions.add(version);
    }
  }
  return [...versions].sort();
}

async function referencedToolsVersions(
  root: string,
  procRoot = "/proc",
  run = runCommandCapture,
): Promise<string[]> {
  const env = podmanEnv();
  const listContainers = async () => {
    const { stdout } = await run("podman", ["ps", "-aq", "--no-trunc"], {
      env,
      timeoutMs: 15_000,
    });
    return stdout.trim().split(/\s+/).filter(Boolean).sort();
  };
  const ids = await listContainers();
  const versions = new Set(
    await listLiveMountedArtifactVersions(root, procRoot, false),
  );
  const roots = new Set([path.resolve(root), await fs.promises.realpath(root)]);
  // Inspect stopped containers too: they may still refer to an older bundle.
  // Structured Mounts avoids treating JSON punctuation as part of a version.
  for (let offset = 0; offset < ids.length; offset += 32) {
    const batch = ids.slice(offset, offset + 32);
    const { stdout } = await run(
      "podman",
      [
        "inspect",
        "--type",
        "container",
        "--format",
        '{"id":{{json .ID}},"pid":{{json .State.Pid}},"mounts":{{json .Mounts}}}',
        ...batch,
      ],
      { env, timeoutMs: 30_000 },
    );
    const seen = new Set<string>();
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (
        !batch.includes(row.id) ||
        seen.has(row.id) ||
        !Number.isInteger(row.pid) ||
        row.pid < 0 ||
        !Array.isArray(row.mounts)
      ) {
        throw Error("incomplete container mount inspection");
      }
      seen.add(row.id);
      const liveMountVersions = new Map<string, Set<string>>();
      // The global proc scan is best effort (rootless hosts cannot read other
      // users' processes). Reading each managed live container is mandatory.
      if (row.pid > 0) {
        const mountinfo = await fs.promises.readFile(
          path.join(procRoot, `${row.pid}`, "mountinfo"),
          "utf8",
        );
        if (!mountinfo.trim()) throw Error("empty live container mount table");
        for (const line of mountinfo.split("\n")) {
          const destination = decodeProcPath(line.split(" ")[4] ?? "");
          const mounted = new Set<string>();
          for (const candidateRoot of roots) {
            for (const version of extractMountedArtifactVersionsFromMountinfo(
              line,
              candidateRoot,
            )) {
              versions.add(version);
              mounted.add(version);
            }
          }
          if (mounted.size) liveMountVersions.set(destination, mounted);
        }
      }
      for (const mount of row.mounts) {
        if (typeof mount.Source !== "string")
          throw Error("invalid container mount source");
        for (const candidateRoot of roots) {
          const relative = path.relative(
            candidateRoot,
            path.resolve(mount.Source),
          );
          const ancestor = path.relative(
            path.resolve(mount.Source),
            candidateRoot,
          );
          if (
            relative === "" ||
            (ancestor !== ".." &&
              !ancestor.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(ancestor))
          )
            throw Error("container mounts the entire tools directory");
          if (relative.startsWith("../") || path.isAbsolute(relative)) continue;
          const version = relative.split(path.sep)[0];
          if (version === "current" || version === "previous") {
            // A retargeted alias says nothing about what a live container
            // mounted earlier. If its concrete mount cannot be mapped, wait.
            if (
              row.pid > 0 &&
              !liveMountVersions.get(mount.Destination)?.size
            ) {
              throw Error("unable to resolve live tools alias mount");
            }
            versions.add(
              path.basename(
                await fs.promises.realpath(path.join(candidateRoot, version)),
              ),
            );
          } else if (isArtifactVersionName(version)) versions.add(version);
        }
      }
    }
    if (seen.size !== batch.length)
      throw Error("incomplete container mount inspection");
  }
  if (JSON.stringify(ids) !== JSON.stringify(await listContainers())) {
    throw Error("container inventory changed during retention scan");
  }
  // Read these last so project starts during the scan contribute references.
  for (const reference of listRuntimeArtifactReferences().tools) {
    versions.add(reference.version);
  }
  return [...versions];
}

async function pruneVersionDirs(opts: {
  root: string;
  currentLink: string;
  desiredDir: string;
  protectedVersions?: string[] | null;
  keep?: number;
  maxBytes?: number;
  keepRecent?: boolean;
}) {
  if (opts.protectedVersions === null) return;
  const keep = opts.keep ?? 3;
  const maxBytes = opts.maxBytes;
  const entries = await fs.promises.readdir(opts.root, { withFileTypes: true });
  const keepRealPaths = new Set<string>();
  try {
    keepRealPaths.add(await fs.promises.realpath(opts.desiredDir));
  } catch {
    // ignore
  }
  try {
    keepRealPaths.add(await fs.promises.realpath(opts.currentLink));
  } catch {
    // ignore
  }
  for (const protectedVersion of opts.protectedVersions ?? []) {
    const version = `${protectedVersion ?? ""}`.trim();
    if (!version) continue;
    try {
      keepRealPaths.add(
        await fs.promises.realpath(path.join(opts.root, version)),
      );
    } catch {
      // ignore missing protected versions
    }
  }
  const dirs: Array<VersionDirEntry | undefined> = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name !== "current" &&
          !entry.name.startsWith(".") &&
          entry.isDirectory() &&
          !entry.isSymbolicLink(),
      )
      .map(async (entry) => {
        const dir = path.join(opts.root, entry.name);
        try {
          const stat = await fs.promises.stat(dir);
          let real = dir;
          try {
            real = await fs.promises.realpath(dir);
          } catch {
            // keep raw path
          }
          return {
            dir,
            real,
            mtimeMs: stat.mtimeMs,
            name: entry.name,
            bytes: maxBytes != null ? pathSizeBytes(dir) : undefined,
          };
        } catch {
          return undefined;
        }
      }),
  );
  const sorted = dirs
    .filter((entry): entry is VersionDirEntry => entry != null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  if (opts.keepRecent) {
    for (const entry of sorted.slice(0, keep)) keepRealPaths.add(entry.real);
    try {
      keepRealPaths.add(
        await fs.promises.realpath(path.join(opts.root, "previous")),
      );
    } catch {
      // Hosts upgraded from older software have no previous link yet.
    }
  }
  let retainedCount = 0;
  let retainedBytes = 0;
  for (const entry of sorted) {
    if (!keepRealPaths.has(entry.real)) continue;
    retainedCount += 1;
    retainedBytes += entry.bytes ?? 0;
  }
  for (const entry of sorted) {
    if (keepRealPaths.has(entry.real)) continue;
    if (retainedCount < keep) {
      keepRealPaths.add(entry.real);
      retainedCount += 1;
      retainedBytes += entry.bytes ?? 0;
      continue;
    }
    if (maxBytes != null && retainedBytes + (entry.bytes ?? 0) <= maxBytes) {
      keepRealPaths.add(entry.real);
      retainedCount += 1;
      retainedBytes += entry.bytes ?? 0;
      continue;
    }
    logger.info("upgrade: pruning old bundle dir", {
      root: opts.root,
      dir: entry.dir,
      keep,
      max_bytes: maxBytes,
    });
    await safeRemove(entry.dir);
  }
}

async function protectedArtifactVersions(
  {
    artifact,
    desiredVersion,
    root,
  }: {
    artifact: CanonicalArtifact;
    desiredVersion: string;
    root: string;
  },
  readToolsReferences = referencedToolsVersions,
): Promise<string[] | null> {
  const versions = new Set<string>();
  const desired = `${desiredVersion ?? ""}`.trim();
  if (desired) {
    versions.add(desired);
  }
  if (artifact === "project-host") {
    const acpWorkerTarget = readProjectHostAcpWorkerTarget();
    if (acpWorkerTarget?.artifact_version) {
      versions.add(acpWorkerTarget.artifact_version);
    }
    const hostAgentState = readHostAgentState();
    const lastKnownGood =
      `${hostAgentState.project_host?.last_known_good_version ?? ""}`.trim();
    const pendingPrevious =
      `${hostAgentState.project_host?.pending_rollout?.previous_version ?? ""}`.trim();
    if (lastKnownGood) {
      versions.add(lastKnownGood);
    }
    if (pendingPrevious) {
      versions.add(pendingPrevious);
    }
  } else if (artifact === "container-runtime") {
    const installedVersions = await listInstalledArtifactVersions(root);
    for (const version of installedVersions.slice(-2)) {
      versions.add(version);
    }
  } else {
    if (artifact === "tools") {
      try {
        for (const version of await configuredToolsVersions(root))
          versions.add(version);
        for (const version of await readToolsReferences(root))
          versions.add(version);
      } catch (err) {
        // Cleanup is optional. An uncertain scan must neither remove live tools
        // nor turn a successful software upgrade into an outage.
        logger.warn(
          "upgrade: skipping tools pruning after incomplete reference scan",
          {
            root,
            err: describeError(err),
          },
        );
        return null;
      }
      return [...versions];
    }
    const references = listRuntimeArtifactReferences();
    const artifactReferences =
      artifact === "project" ? references.project_bundle : references.tools;
    for (const reference of artifactReferences) {
      const version = `${reference.version ?? ""}`.trim();
      if (version) {
        versions.add(version);
      }
    }
    const liveMountedVersions = await listLiveMountedArtifactVersions(root);
    if (liveMountedVersions.length > 0) {
      logger.info(
        "upgrade: protecting live-mounted runtime artifact versions",
        {
          artifact,
          root,
          versions: liveMountedVersions,
        },
      );
      for (const version of liveMountedVersions) {
        versions.add(version);
      }
    }
  }
  return [...versions];
}

async function configuredToolsVersions(root: string): Promise<string[]> {
  const bootstrapDir =
    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR?.trim() ||
    "/var/lib/cocalc/bootstrap-lifecycle";
  const desired = JSON.parse(
    await fs.promises.readFile(
      path.join(bootstrapDir, "bootstrap-desired-state.json"),
      "utf8",
    ),
  ).tools_bundle;
  // Old bootstraps do not coordinate activation with our collector. Wait for
  // bootstrap reconciliation to publish support before enabling deletion.
  if (
    desired?.retention_lock_protocol !== 1 ||
    typeof desired.root !== "string"
  )
    throw Error("bootstrap does not support coordinated tools retention");
  const realRoot = await fs.promises.realpath(root);
  if ((await fs.promises.realpath(desired.root)) !== realRoot)
    throw Error("bootstrap tools root does not match retention root");
  const versions: string[] = [];
  if (
    typeof desired.version !== "string" ||
    !isArtifactVersionName(desired.version)
  )
    throw Error("invalid bootstrap desired tools version");
  versions.push(desired.version);
  const configured = process.env.COCALC_PROJECT_TOOLS;
  if (configured) {
    const real = await fs.promises.realpath(configured);
    const relative = path.relative(realRoot, real);
    if (relative === "")
      throw Error("configured tools path is entire tools root");
    if (
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    )
      versions.push(relative.split(path.sep)[0]);
  }
  return versions;
}

async function resolveArtifact(
  target: SoftwareUpgradeTarget,
  baseUrl: string,
): Promise<ResolvedArtifact> {
  const artifact = target.artifact;
  const canonicalArtifact = canonicalizeArtifact(artifact);
  let url = "";
  let sha256: string | undefined;
  let version = target.version;
  if (!version) {
    const channel: SoftwareChannel = target.channel ?? "latest";
    const os = normalizeOs();
    const arch = normalizeArch();
    const archSpecific =
      canonicalArtifact === "tools" ||
      canonicalArtifact === "container-runtime";
    const manifestUrl = archSpecific
      ? `${baseUrl}/${canonicalArtifact}/${channel}-${os}-${arch}.json`
      : `${baseUrl}/${canonicalArtifact}/${channel}-${os}.json`;
    const manifest = await fetchJson(manifestUrl);
    const manifestOs = normalizeOsValue(manifest?.os);
    const manifestArch = normalizeArchValue(manifest?.arch);
    if (manifestOs && manifestOs !== os) {
      throw new Error(
        `manifest OS mismatch (${canonicalArtifact}): expected ${os}, got ${manifestOs}`,
      );
    }
    if (archSpecific && manifestArch && manifestArch !== arch) {
      throw new Error(
        `manifest arch mismatch (${canonicalArtifact}): expected ${arch}, got ${manifestArch}`,
      );
    }
    url = manifest?.url ?? "";
    sha256 = manifest?.sha256;
    version = extractVersionFromUrl(url, canonicalArtifact);
  } else {
    const os = normalizeOs();
    if (canonicalArtifact === "project-host") {
      url = `${baseUrl}/project-host/${version}/bundle-${os}.tar.xz`;
    } else if (canonicalArtifact === "container-runtime") {
      const arch = normalizeArch();
      url = `${baseUrl}/container-runtime/${version}/container-runtime-${os}-${arch}.tar.xz`;
    } else if (canonicalArtifact === "project") {
      url = `${baseUrl}/project/${version}/bundle-${os}.tar.xz`;
    } else {
      const arch = normalizeArch();
      url = `${baseUrl}/tools/${version}/tools-${os}-${arch}.tar.xz`;
    }
  }
  if (!url) {
    throw new Error(`unable to resolve ${artifact} url`);
  }
  if (!sha256) {
    sha256 = await fetchSha256(`${url}.sha256`);
  }
  if (!version) {
    version = extractVersionFromUrl(url, canonicalArtifact) ?? "unknown";
  }
  const projectHostPaths =
    canonicalArtifact === "project-host"
      ? resolveProjectHostPaths()
      : undefined;
  const root =
    canonicalArtifact === "project-host"
      ? (projectHostPaths?.root ?? PROJECT_HOST_ROOT)
      : canonicalArtifact === "project"
        ? (process.env.COCALC_PROJECT_BUNDLES ?? DEFAULT_BUNDLE_ROOT)
        : canonicalArtifact === "container-runtime"
          ? (process.env.COCALC_CONTAINER_RUNTIME_ROOT ??
            DEFAULT_CONTAINER_RUNTIME_ROOT)
          : process.env.COCALC_PROJECT_TOOLS
            ? path.dirname(process.env.COCALC_PROJECT_TOOLS)
            : DEFAULT_TOOLS_ROOT;
  const stripComponents =
    canonicalArtifact === "project-host"
      ? (projectHostPaths?.stripComponents ?? 2)
      : 1;
  const versionDir =
    canonicalArtifact === "project-host"
      ? projectHostPaths?.usesBundleLayout
        ? path.join(root, version)
        : path.join(root, "versions", version)
      : path.join(root, version);
  const currentLink =
    canonicalArtifact === "project-host"
      ? (projectHostPaths?.currentLink ?? path.join(root, "current"))
      : path.join(root, "current");
  return {
    artifact,
    canonicalArtifact,
    version,
    url,
    sha256,
    stripComponents,
    root,
    versionDir,
    currentLink,
  };
}

function currentVersion(linkPath: string): string | undefined {
  try {
    const resolved = fs.realpathSync(linkPath);
    const base = path.basename(resolved);
    if (base && base !== "current") return base;
  } catch {
    // ignore
  }
  return undefined;
}

async function downloadAndInstallUnlocked(
  resolved: ResolvedArtifact,
): Promise<UpgradeSoftwareResult> {
  const existing = currentVersion(resolved.currentLink);
  const versionDirExists = await installedVersionDirExists(resolved.versionDir);
  if (existing && existing === resolved.version) {
    if (!versionDirExists) {
      throw new Error(
        `current artifact version is missing at ${resolved.versionDir}`,
      );
    }
    return {
      artifact: resolved.artifact,
      version: resolved.version,
      status: "noop",
    };
  }
  await ensureWritableDir(resolved.root);
  await ensureWritableDir(path.dirname(resolved.currentLink));
  if (versionDirExists) {
    logger.info("upgrade: reusing immutable artifact version", {
      artifact: resolved.artifact,
      version: resolved.version,
      dir: resolved.versionDir,
    });
  } else {
    const downloadsRoot = resolveDownloadsRoot();
    const archivePath = path.join(
      downloadsRoot,
      `${resolved.canonicalArtifact}-${resolved.version}.tar.xz`,
    );
    logger.info("upgrade: downloading artifact", {
      artifact: resolved.artifact,
      version: resolved.version,
      url: resolved.url,
    });
    await downloadToFile(resolved.url, archivePath);
    logger.info("upgrade: downloaded artifact", {
      artifact: resolved.artifact,
      version: resolved.version,
      archive: archivePath,
    });
    if (resolved.sha256) {
      const actual = await sha256File(archivePath);
      if (actual !== resolved.sha256) {
        throw new Error(
          `sha256 mismatch for ${resolved.artifact} (${resolved.version})`,
        );
      }
      logger.info("upgrade: checksum ok", {
        artifact: resolved.artifact,
        version: resolved.version,
      });
    }
    const versionParent = path.dirname(resolved.versionDir);
    await ensureWritableDir(versionParent);
    const stagingDir = path.join(
      versionParent,
      `.${path.basename(resolved.versionDir)}.extract-${process.pid}-${crypto.randomUUID()}`,
    );
    let promoted = false;
    await ensureWritableDir(stagingDir);
    try {
      logger.info("upgrade: extracting artifact", {
        artifact: resolved.artifact,
        version: resolved.version,
        stripComponents: resolved.stripComponents,
        dir: stagingDir,
      });
      await runTar([
        "-xJf",
        archivePath,
        `--strip-components=${resolved.stripComponents}`,
        "-C",
        stagingDir,
      ]);
      if (await installedVersionDirExists(resolved.versionDir)) {
        logger.info("upgrade: another installer promoted artifact version", {
          artifact: resolved.artifact,
          version: resolved.version,
          dir: resolved.versionDir,
        });
      } else {
        await fs.promises.rename(stagingDir, resolved.versionDir);
        promoted = true;
      }
    } finally {
      if (!promoted) {
        await safeRemove(stagingDir).catch(() => undefined);
      }
    }
  }
  logger.info("upgrade: artifact version ready", {
    artifact: resolved.artifact,
    version: resolved.version,
    dir: resolved.versionDir,
  });
  if (resolved.activate === false) {
    const retentionPolicy = retentionPolicyForArtifact(
      resolved.artifact === "project" ? "project-bundle" : resolved.artifact,
      resolved.retentionPolicy,
    );
    await pruneVersionDirs({
      root: resolved.root,
      currentLink: resolved.currentLink,
      desiredDir: resolved.versionDir,
      protectedVersions: await protectedArtifactVersions({
        artifact: resolved.canonicalArtifact,
        desiredVersion: resolved.version,
        root: resolved.root,
      }),
      keep: retentionPolicy.keep_count,
      maxBytes: retentionPolicy.max_bytes,
      keepRecent: resolved.canonicalArtifact === "tools",
    });
    logger.info("upgrade: staged artifact without changing current symlink", {
      artifact: resolved.artifact,
      version: resolved.version,
      dir: resolved.versionDir,
      current: resolved.currentLink,
    });
    return {
      artifact: resolved.artifact,
      version: resolved.version,
      status: "staged",
    };
  }
  const previousTarget = await fs.promises
    .realpath(resolved.currentLink)
    .catch(() => undefined);
  let releaseRuntimeMaintenance: (() => void) | undefined;
  if (resolved.canonicalArtifact === "container-runtime") {
    const contract = await validateContainerRuntimeVersion(resolved.versionDir);
    releaseRuntimeMaintenance =
      await quiesceProjectContainersForRuntimeMigration(contract);
    await assertContainerRuntimeMigrationIsSafe(contract);
    resolved.containerRuntimeContract = contract;
  }
  try {
    if (resolved.canonicalArtifact === "tools" && previousTarget) {
      await replaceSymlink(
        path.join(resolved.root, "previous"),
        previousTarget,
      );
    }
    await replaceSymlink(resolved.currentLink, resolved.versionDir);
    if (resolved.canonicalArtifact === "container-runtime") {
      try {
        await verifyActivatedContainerRuntime(
          resolved.containerRuntimeContract!,
        );
      } catch (err) {
        if (previousTarget) {
          await replaceSymlink(resolved.currentLink, previousTarget);
        } else {
          await fs.promises.rm(resolved.currentLink, { force: true });
        }
        throw new Error(
          `activated container runtime failed Podman state verification and was rolled back: ${describeError(err)}`,
        );
      }
    }
    const retentionPolicy = retentionPolicyForArtifact(
      resolved.artifact === "project" ? "project-bundle" : resolved.artifact,
      resolved.retentionPolicy,
    );
    await pruneVersionDirs({
      root: resolved.root,
      currentLink: resolved.currentLink,
      desiredDir: resolved.versionDir,
      protectedVersions: await protectedArtifactVersions({
        artifact: resolved.canonicalArtifact,
        desiredVersion: resolved.version,
        root: resolved.root,
      }),
      keep: retentionPolicy.keep_count,
      maxBytes: retentionPolicy.max_bytes,
      keepRecent: resolved.canonicalArtifact === "tools",
    });
    logger.info("upgrade: updated current symlink", {
      artifact: resolved.artifact,
      version: resolved.version,
      current: resolved.currentLink,
    });
    return {
      artifact: resolved.artifact,
      version: resolved.version,
      status: "updated",
    };
  } finally {
    releaseRuntimeMaintenance?.();
  }
}

async function withArtifactInstallLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = installTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  installTails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (installTails.get(key) === tail) {
      installTails.delete(key);
    }
  }
}

async function downloadAndInstall(
  resolved: ResolvedArtifact,
): Promise<UpgradeSoftwareResult> {
  return await withArtifactInstallLock(resolved.currentLink, () =>
    resolved.canonicalArtifact === "tools"
      ? withToolsFilesystemLock(resolved.root, () =>
          downloadAndInstallUnlocked(resolved),
        )
      : downloadAndInstallUnlocked(resolved),
  );
}

async function withToolsFilesystemLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  await fs.promises.mkdir(root, { recursive: true });
  const lockPath = path.join(root, ".artifact.lock");
  // Linux flock works on a read-only descriptor too. Bootstrap may have
  // created this persistent inode as root; never unlink or replace it.
  const handle = await fs.promises
    .open(lockPath, "a", 0o644)
    .catch(async (err) => {
      if (err.code !== "EACCES") throw err;
      return await fs.promises.open(lockPath, "r");
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["-x", "-w", "30", "3"], {
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error("tools artifact lock unavailable")),
      );
    });
    // The inherited fd shares an open-file description with this process;
    // the kernel lock survives flock's exit until our descriptor is closed.
    return await work();
  } finally {
    await handle.close();
  }
}

export async function pruneInstalledTools(
  root = process.env.COCALC_PROJECT_TOOLS
    ? path.dirname(process.env.COCALC_PROJECT_TOOLS)
    : DEFAULT_TOOLS_ROOT,
): Promise<void> {
  const currentLink = path.join(root, "current");
  await withArtifactInstallLock(currentLink, () =>
    withToolsFilesystemLock(root, async () => {
      let desiredDir: string;
      try {
        desiredDir = await fs.promises.realpath(currentLink);
      } catch (err: any) {
        if (err?.code === "ENOENT") return;
        throw err;
      }
      const policy = retentionPolicyForArtifact("tools");
      const protectedVersions = await protectedArtifactVersions({
        artifact: "tools",
        desiredVersion: path.basename(desiredDir),
        root,
      });
      await pruneVersionDirs({
        root,
        currentLink,
        desiredDir,
        protectedVersions,
        keep: policy.keep_count,
        maxBytes: policy.max_bytes,
        keepRecent: true,
      });
    }),
  );
}

export function startRuntimeArtifactMaintenance({
  sweep = pruneInstalledTools,
  initialDelayMs = 5 * 60_000 + Math.random() * 60_000,
  intervalMs = 60 * 60_000,
}: {
  sweep?: () => Promise<void>;
  initialDelayMs?: number;
  intervalMs?: number;
} = {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try {
      await sweep();
    } catch (err) {
      logger.warn("runtime artifact maintenance failed", {
        err: describeError(err),
      });
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => void tick(), initialDelayMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function scheduleProjectHostRestart() {
  const override = process.env.COCALC_PROJECT_HOST_BIN;
  const candidate = path.join(
    PROJECT_HOST_ROOT,
    "current",
    "cocalc-project-host",
  );
  const bin = override
    ? override
    : fs.existsSync(candidate)
      ? candidate
      : path.join(PROJECT_HOST_ROOT, "cocalc-project-host");
  const cmd = scheduledProjectHostReconcileCommand(bin);
  const child = spawn("bash", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logger.info("upgrade: scheduled project-host restart");
}

function scheduledProjectHostReconcileCommand(bin: string): string {
  return `sleep 3; COCALC_PROJECT_HOST_RELOAD_ENV_FILES=1 ${bin} daemon restart-project-host || true`;
}

export async function activateInstalledProjectHostVersion(
  version: string,
): Promise<void> {
  const normalizedVersion = `${version ?? ""}`.trim();
  if (!normalizedVersion) {
    throw new Error("project-host version is required");
  }
  const resolved = await resolveArtifact(
    {
      artifact: "project-host",
      version: normalizedVersion,
    },
    normalizeBaseUrl(),
  );
  await assertInstalledVersionDir(resolved.versionDir);
  await ensureWritableDir(path.dirname(resolved.currentLink));
  await replaceSymlink(resolved.currentLink, resolved.versionDir);
  logger.info("upgrade: activated installed project-host version", {
    version: normalizedVersion,
    current: resolved.currentLink,
    version_dir: resolved.versionDir,
  });
}

function orderTargets(
  targets: SoftwareUpgradeTarget[],
): SoftwareUpgradeTarget[] {
  const order: SoftwareArtifact[] = [
    "container-runtime",
    "tools",
    "project",
    "project-bundle",
    "project-host",
  ];
  return [...targets].sort(
    (a, b) => order.indexOf(a.artifact) - order.indexOf(b.artifact),
  );
}

export async function upgradeSoftware(
  opts: UpgradeSoftwareRequest,
): Promise<UpgradeSoftwareResponse> {
  try {
    const targets = orderTargets(opts.targets ?? []);
    const restartProjectHost = opts.restart_project_host !== false;
    if (!targets.length) {
      throw new Error("upgrade requires at least one target");
    }
    if (opts.retention_policy) {
      writeConfiguredRuntimeRetentionPolicy(opts.retention_policy);
    }
    const baseUrl = normalizeBaseUrl(opts.base_url);
    const results: UpgradeSoftwareResult[] = [];
    let restartHost = false;
    let restartForContainerRuntime = false;
    for (const target of targets) {
      const resolved = await resolveArtifact(target, baseUrl);
      resolved.activate =
        resolved.canonicalArtifact !== "project-host" ||
        opts.activate_project_host !== false;
      resolved.retentionPolicy = opts.retention_policy;
      logger.info("upgrade: resolved artifact", {
        artifact: resolved.artifact,
        version: resolved.version,
        url: resolved.url,
        root: resolved.root,
        versionDir: resolved.versionDir,
        currentLink: resolved.currentLink,
        stripComponents: resolved.stripComponents,
      });
      const result = await downloadAndInstall(resolved);
      results.push(result);
      if (resolved.artifact === "project-host" && result.status === "updated") {
        restartHost = true;
      }
      if (
        resolved.artifact === "container-runtime" &&
        result.status === "updated"
      ) {
        restartForContainerRuntime = true;
      }
    }
    if ((restartHost && restartProjectHost) || restartForContainerRuntime) {
      await scheduleProjectHostRestart();
    }
    return { results };
  } catch (err) {
    logger.error("upgrade: failed", {
      err: describeError(err),
      stack: (err as any)?.stack,
    });
    throw err;
  }
}

export const __test__ = {
  curlTimeoutArgs,
  downloadAndInstall,
  extractMountedArtifactVersionsFromMountinfo,
  listInstalledArtifactVersions,
  listLiveMountedArtifactVersions,
  listLivePodmanMountedArtifactVersions,
  pruneVersionDirs,
  protectedArtifactVersions,
  referencedToolsVersions,
  withArtifactInstallLock,
  withToolsFilesystemLock,
  configuredToolsVersions,
  runCommandCapture,
  scheduledProjectHostReconcileCommand,
};
