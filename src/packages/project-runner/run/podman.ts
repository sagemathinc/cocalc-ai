/*
Runner based on podman.

DEPENDENCIES:

   sudo apt-get install rsync podman

- podman -- to run projects
- rsync - to setup the rootfs

TODO: obviously, we will very likely change things below
so that pods are subprocesses so this server can be
restarted without restarting all projects it manages.
Maybe.  Perhaps we'll have two modes.

*/

import { mountArg } from "@cocalc/backend/podman";
import { nodePath } from "./mounts";
import { isValidUUID } from "@cocalc/util/misc";
import { ensureConfFilesExists, setupDataPath, writeSecretToken } from "./util";
import { getEnvironment } from "./env";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  realpath,
  writeFile,
} from "node:fs/promises";
import { getCoCalcMounts, COCALC_SRC } from "./mounts";
import { fileServerClient, setQuota } from "./filesystem";
import { type RestoreMode } from "@cocalc/conat/files/file-server";
import { dirname, join, relative, isAbsolute } from "node:path";
import { mount as mountRootFs, unmount as unmountRootFs } from "./rootfs";
import { type ProjectState } from "@cocalc/conat/project/runner/state";
import { type Configuration } from "@cocalc/conat/project/runner/types";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { podmanLimits } from "./limits";
import { executeCode } from "@cocalc/backend/execute-code";
import {
  type LocalPathFunction,
  type SshServersFunction,
} from "@cocalc/conat/project/runner/types";
import {
  INTERNAL_SSH_CONFIG,
  SSHD_CONFIG,
  SSH_IDENTITY_FILE,
  START_PROJECT_SSH,
} from "@cocalc/conat/project/runner/constants";
import { lroProgress } from "@cocalc/conat/lro/progress";
import getLogger from "@cocalc/backend/logger";
import { writeStartupScripts } from "./startup-scripts";
import { podman } from "@cocalc/backend/podman";
import getPort from "@cocalc/backend/get-port";

const logger = getLogger("project-runner:podman");
// Restores can be large; allow the RPC to stay open while rustic runs.
const RESTORE_RPC_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STOP_RM_TIMEOUT_S = 10;
const STOP_RM_PODMAN_TERM_S = 5;
const STOP_INSPECT_TIMEOUT_S = 10;
const STOP_FORCE_KILL_SETTLE_MS = 250;

const DEFAULT_PROJECT_SCRIPT = join(
  COCALC_SRC,
  "packages/project/bin/cocalc-project.js",
);
const PROJECT_BUNDLE_ENTRY_CANDIDATES = [
  ["bundle", "index.js"],
  // Legacy layout: bundle/bundle/index.js from older tarball structure.
  ["bundle", "bundle", "index.js"],
] as const;
const PROJECT_BUNDLE_MOUNT_POINT = "/opt/cocalc/project-bundle";
const PROJECT_BUNDLE_BIN_PATH = join(PROJECT_BUNDLE_MOUNT_POINT, "bin");

// if computing status of a project shows pod is
// somehow messed up, this will cleanly kill it.  It's
// very good right now to have this on, since otherwise
// restart, etc., would be impossible. But it is annoying
// when debugging.
const STOP_ON_STATUS_ERROR = false;

// projects we are definitely starting right now
export const starting = new Set<string>();

type ProgressEvent = {
  type: string;
  progress?: number;
  min?: number;
  max?: number;
  error?: unknown;
  desc?: string;
  elapsed?: number;
  speed?: string;
  eta?: number;
};

function reportProgress({
  project_id,
  op_id,
  event,
}: {
  project_id: string;
  op_id?: string;
  event: ProgressEvent;
}) {
  void lroProgress({
    project_id,
    op_id,
    phase: event.type,
    message: event.desc,
    progress: event.progress,
    min: event.min,
    max: event.max,
    error: event.error,
    elapsed: event.elapsed,
    speed: event.speed,
    eta: event.eta,
  });
}

function formatKeys(keys?: string): string | undefined {
  if (!keys) return;
  const trimmed = keys.trim();
  if (!trimmed) return;
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

async function maybeRestoreFromBackup({
  project_id,
  home,
  restore,
  lro_op_id,
}: {
  project_id: string;
  home: string;
  restore?: RestoreMode;
  lro_op_id?: string;
}): Promise<void> {
  if (!restore || restore === "none") return;
  const fs = fileServerClient({ timeout: RESTORE_RPC_TIMEOUT_MS });
  const handle = await fs.beginRestoreStaging({ project_id, home, restore });
  if (!handle) return;

  let cleanupStaging = false;
  const report = (event: ProgressEvent) =>
    reportProgress({ project_id, op_id: lro_op_id, event });
  try {
    report({
      type: "start-project",
      progress: 8,
      desc: "checking backups...",
    });

    const backups = await fs.getBackups({ project_id });
    if (!backups.length) {
      cleanupStaging = true;
      if (restore === "required") {
        throw Error("no backups available for restore");
      }
      report({
        type: "start-project",
        progress: 10,
        desc: "no backups found; continuing",
      });
      return;
    }

    const latest = backups.reduce((best, current) =>
      new Date(current.time).getTime() > new Date(best.time).getTime()
        ? current
        : best,
    );
    report({
      type: "start-project",
      progress: 12,
      desc: "restoring from backup...",
    });

    await fs.ensureRestoreStaging({ handle });
    await fs.restoreBackup({
      project_id,
      id: latest.id,
      dest: handle.stagingPath,
      lro: lro_op_id
        ? { op_id: lro_op_id, scope_type: "project", scope_id: project_id }
        : undefined,
    });
    await fs.finalizeRestoreStaging({ handle });

    report({
      type: "start-project",
      progress: 18,
      desc: "restore complete",
    });
  } catch (err) {
    report({
      type: "start-project",
      progress: 18,
      desc: "restore failed",
    });
    throw err;
  } finally {
    await fs
      .releaseRestoreStaging({ handle, cleanupStaging })
      .catch(() => {});
  }
}

async function writeSshAuthorizedKeys({
  home,
  sshProxyPublicKey,
  authorizedKeys,
}: {
  home: string;
  sshProxyPublicKey?: string;
  authorizedKeys?: string;
}) {
  const write = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  };

  const proxyKeys = formatKeys(sshProxyPublicKey);
  if (proxyKeys) {
    const proxyAuthPath = join(home, SSHD_CONFIG, "authorized_keys");
    await write(proxyAuthPath, proxyKeys);
  }

  const masterKeys = formatKeys(authorizedKeys);
  if (masterKeys) {
    const managedAuthPath = join(home, INTERNAL_SSH_CONFIG, "authorized_keys");
    // Managed keys are written so sshpiperd can quickly assemble the full
    // allowed list (account/project keys plus ~/.ssh/authorized_keys) when
    // routing ssh to the project.
    await write(managedAuthPath, masterKeys);
  }
}

function projectContainerName(project_id) {
  return `project-${project_id}`;
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await podman(["container", "exists", name]);
    return true;
  } catch {
    return false;
  }
}

function isLikelyTimeoutError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("killed command")
  );
}

async function inspectContainerPids(name: string): Promise<number[]> {
  const { stdout } = await executeCode({
    command: "podman",
    args: ["inspect", "--format", "{{.State.Pid}} {{.State.ConmonPid}}", name],
    timeout: STOP_INSPECT_TIMEOUT_S,
    err_on_exit: false,
  });
  const out = `${stdout ?? ""}`.trim();
  if (!out) return [];
  const pids = out
    .split(/\s+/g)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 1 && n !== process.pid);
  return [...new Set(pids)];
}

function tryKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
  try {
    process.kill(-pid, signal);
  } catch {}
}

async function forceKillContainerProcesses(
  project_id: string,
  name: string,
): Promise<void> {
  const pids = await inspectContainerPids(name);
  if (!pids.length) return;
  logger.warn("stop: force-killing container processes after podman hang", {
    project_id,
    name,
    pids,
  });
  for (const pid of pids) {
    tryKillPid(pid, "SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, STOP_FORCE_KILL_SETTLE_MS));
}

interface ScriptResolution {
  script: string;
  bundleMount?: { source: string; target: string };
}

function isSubPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (code != null) {
      return String(code);
    }
  }
  return undefined;
}

async function resolveProjectScript(): Promise<ScriptResolution> {
  const bundlesRootEnv = process.env.COCALC_PROJECT_BUNDLES;
  if (!bundlesRootEnv) {
    return { script: DEFAULT_PROJECT_SCRIPT };
  }

  let bundlesRoot: string;
  try {
    bundlesRoot = await realpath(bundlesRootEnv);
  } catch (err) {
    logger.warn("COCALC_PROJECT_BUNDLES path not accessible; falling back", {
      path: bundlesRootEnv,
      error: `${err}`,
    });
    return { script: DEFAULT_PROJECT_SCRIPT };
  }

  const resolveCandidate = async (
    candidate: string,
  ): Promise<{ path: string; mtimeMs: number } | undefined> => {
    try {
      const resolved = await realpath(candidate);
      if (!isSubPath(bundlesRoot, resolved)) {
        logger.warn("bundle candidate outside of root; ignoring", {
          candidate,
          resolved,
        });
        return undefined;
      }
      const info = await stat(resolved);
      if (!info.isDirectory()) {
        logger.warn("bundle candidate is not a directory; ignoring", {
          resolved,
        });
        return undefined;
      }
      return { path: resolved, mtimeMs: info.mtimeMs };
    } catch (err) {
      const code = getErrorCode(err);
      if (code !== "ENOENT") {
        logger.warn("failed to inspect bundle candidate; ignoring", {
          candidate,
          error: `${err}`,
        });
      }
      return undefined;
    }
  };

  let bundleDir: string | undefined;

  const currentCandidate = await resolveCandidate(join(bundlesRoot, "current"));
  if (currentCandidate != null) {
    bundleDir = currentCandidate.path;
  }

  if (bundleDir == null) {
    let newest: { path: string; mtimeMs: number } | undefined;
    let entries;
    try {
      entries = await readdir(bundlesRoot, { withFileTypes: true });
    } catch (err) {
      logger.warn("failed to read bundles directory; falling back", {
        path: bundlesRoot,
        error: `${err}`,
      });
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const candidate = await resolveCandidate(join(bundlesRoot, entry.name));
      if (candidate == null) {
        continue;
      }
      if (newest == null || candidate.mtimeMs > newest.mtimeMs) {
        newest = candidate;
      }
    }

    if (newest != null) {
      bundleDir = newest.path;
    }
  }

  if (bundleDir == null) {
    logger.warn(
      "no suitable bundles found under COCALC_PROJECT_BUNDLES; falling back",
      { path: bundlesRoot },
    );
    return { script: DEFAULT_PROJECT_SCRIPT };
  }

  let entry: readonly string[] | undefined;
  for (const candidate of PROJECT_BUNDLE_ENTRY_CANDIDATES) {
    const hostScriptPath = join(bundleDir, ...candidate);
    try {
      const info = await stat(hostScriptPath);
      if (info.isFile()) {
        entry = [...candidate];
        break;
      }
      logger.warn("bundle entry is not a file; skipping", {
        entry: hostScriptPath,
      });
    } catch (err) {
      const code = getErrorCode(err);
      if (code !== "ENOENT") {
        logger.warn("failed to stat bundle entry; skipping", {
          entry: hostScriptPath,
          error: `${err}`,
        });
      }
    }
  }

  if (!entry) {
    logger.warn("no usable bundle entry found; falling back", {
      bundleDir,
    });
    return { script: DEFAULT_PROJECT_SCRIPT };
  }

  const containerScript = join(PROJECT_BUNDLE_MOUNT_POINT, ...entry);

  logger.info("using project bundle", {
    source: bundleDir,
    script: containerScript,
  });

  return {
    script: containerScript,
    bundleMount: { source: bundleDir, target: PROJECT_BUNDLE_MOUNT_POINT },
  };
}

export function networkArgument() {
  // Allow explicit override when debugging networking behavior.
  const explicit = `${process.env.COCALC_PROJECT_RUNNER_NETWORK ?? ""}`.trim();
  if (explicit) {
    const lowered = explicit.toLowerCase();
    const allowed =
      lowered === "none" ||
      lowered.startsWith("slirp4netns") ||
      lowered.startsWith("pasta");
    if (allowed) {
      return `--network=${explicit}`;
    }
    logger.warn("ignoring unsupported COCALC_PROJECT_RUNNER_NETWORK override", {
      explicit,
    });
  }
  const defaultNetworkRaw = `${
    process.env.COCALC_PROJECT_RUNNER_NETWORK_DEFAULT ?? "pasta"
  }`
    .trim()
    .toLowerCase();
  const defaultNetwork =
    defaultNetworkRaw === "pasta" || defaultNetworkRaw === "none"
      ? defaultNetworkRaw
      : "slirp4netns";
  if (defaultNetwork === "none") {
    return "--network=none";
  }
  if (defaultNetwork === "pasta") {
    const pastaOptionsRaw = `${
      process.env.COCALC_PROJECT_RUNNER_PASTA_OPTIONS ??
      "--map-gw"
    }`.trim();
    if (!pastaOptionsRaw) {
      return "--network=pasta";
    }
    return `--network=pasta:${pastaOptionsRaw}`;
  }
  // Rootless pods need host loopback access so project containers can reach
  // host-local conat (mapped as host.containers.internal in env.ts).
  const allowHostLoopbackRaw = `${process.env.COCALC_PROJECT_RUNNER_ALLOW_HOST_LOOPBACK ?? "true"}`
    .trim()
    .toLowerCase();
  const allowHostLoopback = !(
    allowHostLoopbackRaw === "0" ||
    allowHostLoopbackRaw === "false" ||
    allowHostLoopbackRaw === "no"
  );
  return allowHostLoopback
    ? "--network=slirp4netns:allow_host_loopback=true"
    : "--network=slirp4netns";
}

function pastaConatHost(): string | undefined {
  const host = `${process.env.COCALC_PROJECT_RUNNER_PASTA_CONAT_HOST ?? ""}`
    .trim();
  return host || undefined;
}

function slirpConatHost(): string {
  const host = `${process.env.COCALC_PROJECT_RUNNER_SLIRP_CONAT_HOST ?? "10.0.2.2"}`
    .trim();
  return host || "10.0.2.2";
}

// Parse Linux /proc/net/route content and return the default gateway IPv4.
//
// Why we do this:
// - With pasta --map-gw, host services bound on host loopback are reachable
//   from the container via the container's default gateway.
// - This avoids hardcoding host aliases such as 169.254.1.2, which are not
//   universally valid across pasta versions/configurations.
//
// /proc/net/route stores Destination and Gateway as little-endian hex. For the
// default route Destination is 00000000, and Gateway must be byte-reversed when
// converting to dotted-decimal IPv4.
function defaultGatewayFromProcNetRouteContent(
  content: string,
): string | undefined {
  const lines = content.trim().split("\n");
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    // Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
    if (cols.length < 4) continue;
    const destination = cols[1];
    const gatewayHex = cols[2];
    const flagsHex = cols[3];
    if (destination !== "00000000") continue;
    const flags = Number.parseInt(flagsHex, 16);
    // RTF_GATEWAY bit must be set.
    if (Number.isNaN(flags) || (flags & 0x2) === 0) continue;
    if (!/^[0-9a-fA-F]{8}$/.test(gatewayHex)) continue;
    const bytes = gatewayHex.match(/../g);
    if (!bytes || bytes.length !== 4) continue;
    // Example: C0A80401 -> 192.168.4.1 (reverse byte order first).
    const octets = bytes.reverse().map((x) => Number.parseInt(x, 16));
    if (octets.some((x) => Number.isNaN(x))) continue;
    return octets.join(".");
  }
  return undefined;
}

async function defaultGatewayFromProcNetRoute(): Promise<string | undefined> {
  try {
    const content = await readFile("/proc/net/route", "utf8");
    return defaultGatewayFromProcNetRouteContent(content);
  } catch {
    return undefined;
  }
}

async function pastaHostAliasDefaultAddr(
  selectedNetwork: string,
): Promise<string | undefined> {
  // Explicit override always wins.
  const explicit = `${
    process.env.COCALC_PROJECT_RUNNER_PASTA_HOST_ALIAS_ADDR ?? ""
  }`.trim();
  if (explicit) {
    return explicit;
  }
  // Only synthesize a default host alias when pasta is configured with
  // --map-guest-addr. Otherwise we may force host.containers.internal to an
  // unroutable address on older pasta versions.
  if (!selectedNetwork.includes("--map-guest-addr")) {
    if (!selectedNetwork.includes("--map-gw")) {
      return undefined;
    }
    // With --map-gw (and without --map-guest-addr support), host loopback is
    // reachable via the guest default gateway address.
    const gateway = await defaultGatewayFromProcNetRoute();
    if (!gateway) return undefined;
    return gateway;
  }
  const addr = "169.254.1.2";
  return addr || undefined;
}

function replaceUrlHostname(value: string, hostname: string): string {
  try {
    const url = new URL(value);
    url.hostname = hostname;
    return url.toString();
  } catch {
    return value;
  }
}

function getUrlHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export function publishHost(): string {
  const value = `${process.env.COCALC_PROJECT_RUNNER_PUBLISH_HOST ?? "127.0.0.1"}`
    .trim()
    .toLowerCase();
  if (!value) return "127.0.0.1";
  if (value === "127.0.0.1" || value === "localhost" || value === "::1") {
    return value === "localhost" ? "127.0.0.1" : value;
  }
  if (value === "0.0.0.0" || value === "::") {
    const allowInsecurePublishHostRaw = `${process.env.COCALC_PROJECT_RUNNER_ALLOW_INSECURE_PUBLISH_HOST ?? "false"}`
      .trim()
      .toLowerCase();
    const allowInsecurePublishHost =
      allowInsecurePublishHostRaw === "1" ||
      allowInsecurePublishHostRaw === "true" ||
      allowInsecurePublishHostRaw === "yes" ||
      allowInsecurePublishHostRaw === "on";
    if (allowInsecurePublishHost) {
      return value;
    }
    logger.warn(
      "refusing insecure non-loopback publish host without explicit override",
      {
        value,
        overrideVar: "COCALC_PROJECT_RUNNER_ALLOW_INSECURE_PUBLISH_HOST",
      },
    );
    return "127.0.0.1";
  }
  logger.warn("ignoring invalid COCALC_PROJECT_RUNNER_PUBLISH_HOST override", {
    value,
  });
  return "127.0.0.1";
}

export async function start({
  project_id,
  config = {},
  localPath,
  sshServers: _sshServers,
}: {
  project_id: string;
  config?: Configuration;
  localPath: LocalPathFunction;
  sshServers?: SshServersFunction;
}): Promise<{ state: ProjectState; ssh_port: number; http_port: number }> {
  if (!isValidUUID(project_id)) {
    throw Error("start: project_id must be valid");
  }
  logger.debug("start", { project_id, config: { ...config, secret: "xxx" } });

  if (starting.has(project_id) || stopping.has(project_id)) {
    logger.debug("starting/stopping -- already running");
    return { state: "starting", ssh_port: 0, http_port: 0 };
  }

  const lro_op_id = config?.lro_op_id;
  const report = (event: ProgressEvent) =>
    reportProgress({ project_id, op_id: lro_op_id, event });
  try {
    starting.add(project_id);
    report({ type: "start-project", progress: 0 });

    let { home, scratch } = await localPath({
      project_id,
      disk: config?.disk,
      scratch: config?.scratch,
      ensure: false,
    });
    logger.debug("start: resolved home and scratch", {
      project_id,
      home,
      scratch,
    });
    report({
      type: "start-project",
      progress: 5,
      desc: "resolved home and scratch paths",
    });

    await maybeRestoreFromBackup({
      project_id,
      home,
      restore: config?.restore,
      lro_op_id,
    });

    ({ home, scratch } = await localPath({
      project_id,
      disk: config?.disk,
      scratch: config?.scratch,
      ensure: true,
    }));

    const image = getImage(config);
    report({
      type: "start-project",
      progress: 20,
      desc: "mounting rootfs...",
    });

    const rootfs = await mountRootFs({ project_id, home, config });
    report({
      type: "start-project",
      progress: 40,
      desc: "mounted rootfs",
    });
    logger.debug("start: got rootfs", { project_id, rootfs });

    const { script: projectScript, bundleMount } = await resolveProjectScript();

    const mounts = getCoCalcMounts();
    if (bundleMount != null) {
      let replaced = false;
      for (const source of Object.keys(mounts)) {
        if (mounts[source] === COCALC_SRC) {
          delete mounts[source];
          replaced = true;
          break;
        }
      }
      mounts[bundleMount.source] = bundleMount.target;
      if (!replaced) {
        logger.warn(
          "expected to replace default project mount but did not find it",
          { bundleSource: bundleMount.source },
        );
      }
    }

    logger.debug("start: resolved project script", {
      project_id,
      script: projectScript,
    });
    const env = await getEnvironment({
      project_id,
      env: config?.env,
      HOME: "/root",
      image,
    });

    if (bundleMount != null) {
      env.PATH = env.PATH
        ? `${PROJECT_BUNDLE_BIN_PATH}:${env.PATH}`
        : PROJECT_BUNDLE_BIN_PATH;
    }

    report({
      type: "start-project",
      progress: 42,
      desc: "got env variables",
    });

    await mkdir(home, { recursive: true });
    logger.debug("start: created home", { project_id });
    report({
      type: "start-project",
      progress: 48,
      desc: "created HOME",
    });

    await ensureConfFilesExists(home);
    report({
      type: "start-project",
      progress: 50,
      desc: "created conf files",
    });
    logger.debug("start: created conf files", { project_id });

    await writeStartupScripts(home);
    logger.debug("start: wrote startup scripts", { project_id });

    report({
      type: "start-project",
      progress: 52,
      desc: "wrote startup scripts",
    });

    await writeSshAuthorizedKeys({
      home,
      sshProxyPublicKey: config?.ssh_proxy_public_key,
      authorizedKeys: config?.authorized_keys,
    });
    logger.debug("start: wrote ssh authorized_keys", { project_id });

    await setupDataPath(home);

    report({
      type: "start-project",
      progress: 55,
      desc: "setup project directories",
    });

    logger.debug("start: setup data path", { project_id });
    if (config.secret) {
      await writeSecretToken(home, config.secret!);
      logger.debug("start: wrote secret", { project_id });
    }

    if (config.disk) {
      // TODO: maybe this should be done in parallel with other things
      // to make startup time slightly faster (?) -- could also be incorporated
      // into mount.
      await setQuota(project_id, config.disk!);
      logger.debug("start: set disk quota", { project_id });
    }
    report({
      type: "start-project",
      progress: 80,
      desc: "configured quotas",
    });
    const ssh_port = await getPort();
    let http_port = await getPort();
    // avoid rare collision with ssh_port
    if (http_port === ssh_port) {
      http_port = await getPort();
    }

    const args: string[] = [];
    args.push("run");
    args.push("--runtime", "/usr/bin/crun");
    args.push("--security-opt", "no-new-privileges");
    //args.push("--user", "1000:1000");
    args.push("--user", "0:0");
    args.push("--detach");
    args.push("--label", `project_id=${project_id}`, "--label", `role=project`);
    args.push("--rm");
    args.push("--replace");
    const originalConatServer = env.CONAT_SERVER;
    const selectedNetwork = networkArgument();
    args.push(selectedNetwork);
    const originalConatHost = getUrlHostname(originalConatServer);
    const conatUsesDefaultHostAlias =
      originalConatHost === "host.containers.internal";
    const explicitPastaConatHost = pastaConatHost();
    const slirpConatServer = conatUsesDefaultHostAlias
      ? replaceUrlHostname(originalConatServer, slirpConatHost())
      : originalConatServer;
    if (selectedNetwork.startsWith("--network=pasta")) {
      const resolvedPastaConatHost =
        explicitPastaConatHost ??
        (conatUsesDefaultHostAlias
          ? await pastaHostAliasDefaultAddr(selectedNetwork)
          : undefined);
      if (resolvedPastaConatHost && conatUsesDefaultHostAlias) {
        env.CONAT_SERVER = replaceUrlHostname(
          originalConatServer,
          resolvedPastaConatHost,
        );
        logger.debug("using pasta conat host", {
          project_id,
          conat_server: env.CONAT_SERVER,
          host: resolvedPastaConatHost,
          explicit: !!explicitPastaConatHost,
        });
      }

      const pastaHostAliasAddr = conatUsesDefaultHostAlias
        ? resolvedPastaConatHost
        : undefined;
      if (pastaHostAliasAddr) {
        // Preserve host.containers.internal for software inside the project that
        // expects this alias, but point it at an actually routable address.
        args.push(
          "--add-host",
          `host.containers.internal:${pastaHostAliasAddr}`,
        );
      }

      // Startup assumption check: with pasta, we expect a host path that can
      // reliably reach conat.
      const hasNoMapGw = selectedNetwork.includes("--no-map-gw");
      let conatHost = "";
      let conatPort: number | undefined;
      try {
        const url = new URL(env.CONAT_SERVER);
        conatHost = url.hostname;
        conatPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      } catch {
        // keep defaults on parse failure
      }
      const expectedPastaHost =
        explicitPastaConatHost ??
        (conatUsesDefaultHostAlias ? pastaHostAliasAddr : conatHost);
      const assumptionsOk =
        !!conatHost &&
        conatHost === expectedPastaHost &&
        (!explicitPastaConatHost || !hasNoMapGw);
      logger.info("pasta startup assumptions", {
        project_id,
        ok: assumptionsOk,
        selectedNetwork,
        conatHost,
        conatPort,
        expectedPastaHost,
        hasNoMapGw,
        pastaHostAliasAddr,
        explicitPastaConatHost,
      });
      if (!assumptionsOk) {
        logger.warn(
          "pasta startup assumptions not met; connectivity to conat may fail",
          {
            project_id,
            selectedNetwork,
            conat_server: env.CONAT_SERVER,
            expectedPastaHost,
            hasNoMapGw,
            pastaHostAliasAddr,
            explicitPastaConatHost,
          },
        );
      }
    } else if (
      selectedNetwork.startsWith("--network=slirp4netns") &&
      conatUsesDefaultHostAlias
    ) {
      env.CONAT_SERVER = slirpConatServer;
      logger.debug("using slirp conat host", {
        project_id,
        conat_server: env.CONAT_SERVER,
      });
    }
    const publishHostValue = publishHost();
    args.push("-p", `${publishHostValue}:${ssh_port}:22`);
    args.push("-p", `${publishHostValue}:${http_port}:80`);
    if (config.gpu) {
      args.push("--device", "nvidia.com/gpu=all");
      args.push("--security-opt", "label=disable");
    }

    const name = projectContainerName(project_id);
    args.push("--name", name);
    args.push("--hostname", name);

    for (const path in mounts) {
      args.push(
        mountArg({ source: path, target: mounts[path], readOnly: true }),
      );
    }
    args.push(mountArg({ source: home, target: env.HOME }));
    if (scratch) {
      args.push(mountArg({ source: scratch, target: "/scratch" }));
    }
    if (config.tmp) {
      args.push(
        "--mount",
        `type=tmpfs,tmpfs-size=${config.tmp},tmpfs-mode=1777,destination=/tmp`,
      );
    } else if (scratch) {
      await mkdir(join(scratch, "tmp"), { recursive: true });
      args.push(mountArg({ source: join(scratch, "tmp"), target: "/tmp" }));
    }

    for (const key in env) {
      args.push("-e", `${key}=${env[key]}`);
    }

    args.push(...(await podmanLimits(config)));

    // --init = have podman inject a tiny built in init script so we don't get zombies.
    args.push("--init");

    args.push("--rootfs", rootfs);
    args.push(nodePath);
    args.push(projectScript, "--init", "project_init.sh");

    logger.debug("start: launching container - ", name);
    await podman(args);

    report({
      type: "start-project",
      progress: 85,
      desc: "launched project container",
    });

    await initSshServer(name);
    report({
      type: "start-project",
      progress: 100,
      desc: "started",
    });

    return { state: "running", ssh_port, http_port };
  } catch (err) {
    report({ type: "start-project", error: err });
    throw err;
  } finally {
    starting.delete(project_id);
  }
}

// projects we are definitely stopping right now
export const stopping = new Set<string>();
export async function stop({
  project_id,
  force,
}: {
  project_id?: string;
  force?: boolean;
}) {
  if (!project_id) {
    await stopAll(force);
    return;
  }
  if (!isValidUUID(project_id)) {
    throw Error(`stop: project_id '${project_id}' must be a uuid`);
  }
  logger.debug("stop", { project_id });
  if (stopping.has(project_id) || starting.has(project_id)) {
    return;
  }
  try {
    stopping.add(project_id);
    try {
      const name = projectContainerName(project_id);
      if (await containerExists(name)) {
        try {
          await podman(["rm", "-f", "-t", `${STOP_RM_PODMAN_TERM_S}`, name], {
            timeout: STOP_RM_TIMEOUT_S,
          });
        } catch (err) {
          if (!isLikelyTimeoutError(err)) {
            throw err;
          }
          // Workaround: we sometimes see podman rm -f hang unexpectedly in production.
          // Docker did not show this behavior for us; root cause is still unclear.
          // If rm hangs, force-kill container processes by pid and retry rm once.
          logger.warn("stop: podman rm timed out; forcing process kill", {
            project_id,
            name,
            err: `${err}`,
          });
          await forceKillContainerProcesses(project_id, name);
          await podman(["rm", "-f", "-t", `${STOP_RM_PODMAN_TERM_S}`, name], {
            timeout: STOP_RM_TIMEOUT_S,
          });
        }
        await unmountRootFs(project_id);
      } else {
        logger.debug("stop: container not found; skipping rm/unmount", {
          project_id,
          name,
        });
      }
    } catch (err) {
      logger.debug("stop", { err });
      throw err;
    }
  } finally {
    stopping.delete(project_id);
  }
}

export async function state(
  project_id: string,
  ignoreCache = false,
): Promise<ProjectState> {
  if (!ignoreCache) {
    if (starting.has(project_id)) {
      return "starting";
    }
    if (stopping.has(project_id)) {
      return "stopping";
    }
  }
  const { stdout } = await podman([
    "ps",
    "--filter",
    `name=${projectContainerName(project_id)}`,
    "--filter",
    "label=role=project",
    "--format",
    "{{.Names}} {{.State}}",
  ]);
  const output: { [name: string]: string } = {};
  for (const x of stdout.trim().split("\n")) {
    const v = x.split(" ");
    if (v.length < 2) continue;
    output[v[0]] = v[1].trim();
  }
  if (output[projectContainerName(project_id)] == "running") {
    return "running";
  }
  if (Object.keys(output).length > 0 && STOP_ON_STATUS_ERROR) {
    // broken half-way state -- stop it asap
    await stop({ project_id, force: true });
  }
  return "opened";
}

export async function status({ project_id, localPath }) {
  if (!isValidUUID(project_id)) {
    throw Error("status: project_id must be valid");
  }
  logger.debug("status", { project_id });
  const s = await state(project_id);
  let publicKey: string | undefined = undefined;
  let error: string | undefined = undefined;
  try {
    const { home } = await localPath({ project_id, ensure: false });
    publicKey = await readFile(join(home, SSH_IDENTITY_FILE + ".pub"), "utf8");
  } catch (err) {
    if (s != "opened") {
      error = `unable to read ssh public key of project -- ${err}`;
    }
  }
  if (error) {
    logger.debug("WARNING ", { project_id, error });
  }
  return {
    state: s,
    publicKey,
    error,
  };
}

export async function getAll(): Promise<string[]> {
  const { stdout } = await podman([
    "ps",
    "--filter",
    "label=role=project",
    "--format",
    '{{ index .Labels "project_id" }}',
  ]);
  return stdout
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length == 36);
}

async function stopAll(force) {
  const v: any[] = [];
  for (const project_id of await getAll()) {
    logger.debug(`killing project_id=${project_id}`);
    v.push(stop({ project_id, force }));
  }
  await Promise.all(v);
}

/**
 * If the image name is unqualified, prepend "docker.io/".
 * Otherwise, return it unchanged.  We do this so that we
 * don't have to modify the configuration of podman at all,
 * and ALSO to keep things as canonical as possible.
 */
function isQualified(name) {
  const firstSlash = name.indexOf("/");
  if (firstSlash === -1) return false; // no slash => unqualified
  const first = name.slice(0, firstSlash);
  return first === "localhost" || first.includes(".") || first.includes(":");
}

function normalizeImageName(name) {
  return isQualified(name) ? name : `docker.io/${name}`;
}

export function getImage(config?: Configuration): string {
  const image = config?.image?.trim();
  return normalizeImageName(image ? image : DEFAULT_PROJECT_IMAGE);
}

export async function initSshServer(name: string) {
  await podman(["exec", name, "bash", "-c", join("/root", START_PROJECT_SSH)]);
}

// Placeholder: saving is a no-op now that sync sidecars are gone.
export async function save(_opts: {
  project_id: string;
  rootfs?: boolean;
  home?: boolean;
}): Promise<void> {
  return;
}
