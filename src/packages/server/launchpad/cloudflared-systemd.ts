/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { which } from "@cocalc/backend/which";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getDerivedBayPublicHostname } from "@cocalc/server/bay-public-origin";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";
import {
  ensureCloudflareTunnelForHub,
  ensureCloudflareTunnelHostname,
  hasHubCloudflareTunnel,
  type CloudflareTunnel,
} from "@cocalc/server/cloud/cloudflare-tunnel";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { resolvePublicViewerDns } from "@cocalc/util/public-viewer-origin";
import { resolveFundingApprovalConfiguration } from "@cocalc/server/compute/funding/approval-config";
import { ensureLocalCloudflaredBinary } from "./cloudflared-installer";
import { getLaunchpadLocalConfig, isLaunchpadProduct } from "./mode";

const logger = getLogger("launchpad:cloudflared-systemd");
const execFile = promisify(execFileCb);

// How long the hub lets cocalc-bay-cloudflared-ctl restart-all run. With two
// replicas it restarts at most three times (a replica restarted before replica
// 1 is restarted again after it), each waiting up to the units'
// TimeoutStopSec (20 s) to stop and the helper's READY_TIMEOUT_S (60 s) for a
// ready connection; plus slack for starting.
export const CLOUDFLARED_ROLLING_RESTART_TIMEOUT_S = 3 * (20 + 60 + 10) + 30;

type CloudflaredState = {
  tunnel: CloudflareTunnel;
  configPath: string;
  credentialsPath: string;
  origin: string;
  pid: number;
  pidFile: string;
};

type PreparedCloudflaredState = Omit<CloudflaredState, "pid"> & {
  cloudflaredBin: string;
};

let cloudflaredState: CloudflaredState | null = null;
let cloudflaredLastError: string | null = null;

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHostname(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  let host = raw;
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).host;
    } catch {
      host = host.replace(/^https?:\/\//, "");
    }
  }
  host = host.split("/")[0];
  if (host.includes(":")) {
    host = host.split(":")[0];
  }
  return host || undefined;
}

function isEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (value == null) return false;
  const lowered = String(value).trim().toLowerCase();
  if (!lowered) return false;
  return !["0", "false", "no", "off"].includes(lowered);
}

function parsePort(value: unknown): number | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function localOriginHost(value: unknown): string {
  const host = clean(value);
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function normalizeCloudflareMode(
  value: unknown,
): "none" | "self" | "managed" | undefined {
  const raw = clean(value)?.toLowerCase();
  if (raw === "none" || raw === "self" || raw === "managed") {
    return raw;
  }
  return undefined;
}

function cloudflareSelfMode(settings: any): boolean {
  const mode = normalizeCloudflareMode(settings.cloudflare_mode);
  const tunnelEnabled = isEnabled(
    settings.project_hosts_cloudflare_tunnel_enabled,
  );
  if (mode === "self") return true;
  if (mode === "managed") return false;
  if (mode === "none") {
    return tunnelEnabled;
  }
  return tunnelEnabled;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function cloudflaredStateDir(): string {
  const configured = clean(process.env.COCALC_LAUNCHPAD_CLOUDFLARED_STATE_DIR);
  return configured ?? join(secrets, "launchpad-cloudflare");
}

// Replicas of the same tunnel run side by side, one systemd unit each
// (COCALC_BAY_CLOUDFLARED_REPLICA), so that restarting one never takes public
// ingress down. Each has its own config, credentials and pid file, since
// starting a replica stops any cloudflared still running from its config.
// Replica 1, the default, keeps the original file names and is the only one
// that creates or updates the tunnel with Cloudflare; the others use the
// tunnel it recorded.
export function cloudflaredReplica(
  value = process.env.COCALC_BAY_CLOUDFLARED_REPLICA,
): number {
  const raw = clean(value);
  if (raw == null) return 1;
  if (!/^[1-9]$/.test(raw)) {
    throw new Error(`invalid COCALC_BAY_CLOUDFLARED_REPLICA: ${raw}`);
  }
  return Number(raw);
}

export function replicaFileName(name: string, replica = cloudflaredReplica()) {
  if (replica === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}-${replica}${name.slice(dot)}`
    : `${name}-${replica}`;
}

function cloudflaredPidFilePath(replica = cloudflaredReplica()): string {
  const configured = clean(process.env.COCALC_LAUNCHPAD_CLOUDFLARED_PID_FILE);
  if (configured) {
    // (one pid file setting shared by every replica's environment)
    return join(
      dirname(configured),
      replicaFileName(basename(configured), replica),
    );
  }
  return join(
    cloudflaredStateDir(),
    replicaFileName("cloudflared.pid", replica),
  );
}

// Other replicas start only while replica 1's cloudflared runs: replica 1
// starts it only after bringing the tunnel state (tunnel.json) up to date
// with Cloudflare in that same run. Otherwise, e.g. both starting together
// after a tunnel or hostname change, they could pick up the old tunnel.json,
// connect to the old tunnel and look like redundancy they are not. (Replica
// 1's pid file and process are what releases before replicas also wrote, so
// this works during an upgrade too.)
export function primaryTunnelRunning({
  pid,
  cmdline,
  primaryConfigPath,
}: {
  pid: number | undefined;
  cmdline: (pid: number) => string | undefined;
  primaryConfigPath: string;
}): boolean {
  if (!(pid && Number.isInteger(pid) && pid > 0)) return false;
  const args = cmdline(pid);
  if (!args) return false;
  return (
    args.includes("cloudflared") &&
    args.includes(" tunnel ") &&
    args.includes(primaryConfigPath)
  );
}

function processCmdline(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return undefined;
  }
}

/** cloudflared's arguments; the metrics address is pinned per replica. */
export function cloudflaredTunnelArgs({
  configPath,
  metricsAddress = clean(process.env.COCALC_BAY_CLOUDFLARED_METRICS_ADDRESS),
}: {
  configPath: string;
  metricsAddress?: string;
}): string[] {
  return [
    "tunnel",
    "--no-autoupdate",
    ...(metricsAddress ? ["--metrics", metricsAddress] : []),
    "--config",
    configPath,
    "run",
  ];
}

function parsePid(raw: string): number | undefined {
  const text = `${raw ?? ""}`.trim();
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isPidRunning(pid?: number): boolean {
  if (!(pid && Number.isInteger(pid) && pid > 0)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(path: string): Promise<number | undefined> {
  if (!(await fileExists(path))) {
    return undefined;
  }
  try {
    return parsePid(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writePidFile(path: string, pid: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${pid}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function clearPidFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

function clearPidFileSync(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

async function listCloudflaredPidsForConfig(
  configPath: string,
): Promise<number[]> {
  try {
    const { stdout } = await execFile("ps", ["-eo", "pid=,args="], {
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes("cloudflared") &&
          line.includes(configPath) &&
          line.includes(" tunnel "),
      )
      .map((line) => parsePid(line.split(/\s+/, 1)[0]))
      .filter((pid): pid is number => !!pid);
  } catch {
    return [];
  }
}

async function stopCloudflaredPids(pids: Iterable<number>): Promise<void> {
  const unique = [...new Set([...pids].filter((pid) => isPidRunning(pid)))];
  if (unique.length === 0) return;
  for (const pid of unique) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const pid of unique) {
    if (!isPidRunning(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

async function stopManagedLaunchpadCloudflared(): Promise<void> {
  const pidPath = cloudflaredPidFilePath();
  const configPath = join(cloudflaredStateDir(), replicaFileName("config.yml"));
  const persistedPid = await readPidFile(pidPath);
  const pids = [
    ...(await listCloudflaredPidsForConfig(configPath)),
    ...(cloudflaredState?.pid ? [cloudflaredState.pid] : []),
    ...(persistedPid ? [persistedPid] : []),
  ].filter((pid): pid is number => !!pid);
  await stopCloudflaredPids(pids);
  await clearPidFile(pidPath);
  cloudflaredState = null;
}

async function resolveCloudflaredBinary(): Promise<string | null> {
  const configured = clean(process.env.COCALC_LAUNCHPAD_CLOUDFLARED_BINARY);
  if (configured) {
    return configured;
  }
  const systemBinary = await which("cloudflared");
  if (systemBinary) {
    return systemBinary;
  }
  try {
    return await ensureLocalCloudflaredBinary({
      stateDir: cloudflaredStateDir(),
      logger,
    });
  } catch (err) {
    cloudflaredLastError = `failed to install cloudflared automatically: ${String(err)}`;
    logger.warn(cloudflaredLastError);
    return null;
  }
}

function resolveCloudflaredOrigin(): { origin: string; noTLSVerify: boolean } {
  const frontdoorPort = parsePort(process.env.COCALC_BAY_FRONTDOOR_PORT);
  if (frontdoorPort != null) {
    const host = localOriginHost(process.env.COCALC_BAY_FRONTDOOR_HOST);
    return { origin: `http://${host}:${frontdoorPort}`, noTLSVerify: false };
  }
  const port =
    parsePort(process.env.COCALC_BAY_HUB_BASE_PORT) ??
    parsePort(process.env.COCALC_BAY_WORKER_PORT) ??
    parsePort(process.env.HUB_PORT) ??
    parsePort(process.env.PORT);
  if (port != null) {
    const host = localOriginHost(process.env.COCALC_BAY_HUB_BIND_HOST);
    return { origin: `http://${host}:${port}`, noTLSVerify: false };
  }
  const config = getLaunchpadLocalConfig("local");
  const httpPort = config.http_port;
  const fallbackPort = httpPort ?? 9001;
  const host = localOriginHost(process.env.HOST);
  return { origin: `http://${host}:${fallbackPort}`, noTLSVerify: false };
}

async function writeCloudflaredCredentials(
  path: string,
  tunnel: CloudflareTunnel,
): Promise<boolean> {
  const payload = {
    AccountTag: tunnel.account_id,
    TunnelID: tunnel.id,
    TunnelSecret: tunnel.tunnel_secret,
  };
  const next = JSON.stringify(payload, null, 2);
  try {
    const current = await readFile(path, "utf8");
    if (current === next) {
      await chmod(path, 0o600);
      return false;
    }
  } catch {
    // fall through and write a fresh file
  }
  await writeFile(path, next, { mode: 0o600 });
  await chmod(path, 0o600);
  return true;
}

async function writeCloudflaredConfig(opts: {
  path: string;
  credentialsPath: string;
  tunnel: CloudflareTunnel;
  origin: string;
  noTLSVerify: boolean;
  publicViewerHostname?: string;
  additionalHostnames?: string[];
  additionalIngress?: Array<{ hostname: string; origin: string }>;
}): Promise<boolean> {
  const yamlString = (value: string): string => JSON.stringify(value);
  const ingress: string[] = [
    "ingress:",
    `  - hostname: ${yamlString(opts.tunnel.hostname)}`,
    `    service: ${yamlString(opts.origin)}`,
  ];
  const seenHostnames = new Set<string>([opts.tunnel.hostname]);
  if (opts.noTLSVerify) {
    ingress.push("    originRequest:");
    ingress.push("      noTLSVerify: true");
  }
  if (
    opts.publicViewerHostname &&
    !seenHostnames.has(opts.publicViewerHostname)
  ) {
    ingress.push(`  - hostname: ${yamlString(opts.publicViewerHostname)}`);
    ingress.push(`    service: ${yamlString(opts.origin)}`);
    seenHostnames.add(opts.publicViewerHostname);
    if (opts.noTLSVerify) {
      ingress.push("    originRequest:");
      ingress.push("      noTLSVerify: true");
    }
  }
  for (const hostname of opts.additionalHostnames ?? []) {
    if (!hostname || seenHostnames.has(hostname)) continue;
    ingress.push(`  - hostname: ${yamlString(hostname)}`);
    ingress.push(`    service: ${yamlString(opts.origin)}`);
    seenHostnames.add(hostname);
    if (opts.noTLSVerify) {
      ingress.push("    originRequest:");
      ingress.push("      noTLSVerify: true");
    }
  }
  for (const route of opts.additionalIngress ?? []) {
    if (!route.hostname || seenHostnames.has(route.hostname)) continue;
    ingress.push(`  - hostname: ${yamlString(route.hostname)}`);
    ingress.push(`    service: ${yamlString(route.origin)}`);
    seenHostnames.add(route.hostname);
  }
  ingress.push("  - service: http_status:404");
  const lines = [
    `tunnel: ${yamlString(opts.tunnel.id)}`,
    `credentials-file: ${yamlString(opts.credentialsPath)}`,
    ...ingress,
    "",
  ];
  const next = lines.join("\n");
  try {
    const current = await readFile(opts.path, "utf8");
    if (current === next) {
      await chmod(opts.path, 0o600);
      return false;
    }
  } catch {
    // fall through and write a fresh file
  }
  await writeFile(opts.path, next, { mode: 0o600 });
  await chmod(opts.path, 0o600);
  return true;
}

async function loadCloudflaredStateFile(
  path: string,
): Promise<CloudflareTunnel | undefined> {
  if (!(await fileExists(path))) return undefined;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as CloudflareTunnel;
    if (parsed?.id && parsed?.tunnel_secret) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function prepareCloudflared(): Promise<PreparedCloudflaredState | null> {
  cloudflaredLastError = null;
  if (!isLaunchpadProduct()) {
    logger.info("cloudflare tunnel not started (product is not launchpad)");
    return null;
  }
  if (getConfiguredClusterRole() === "attached") {
    await stopManagedLaunchpadCloudflared();
    logger.info(
      "cloudflare tunnel not started on attached bay (managed bay tunnel handles public ingress)",
      { bay_id: getConfiguredBayId() },
    );
    return null;
  }
  const settings = await getServerSettings();
  const rawMode = clean(settings.cloudflare_mode);
  const normalizedMode = normalizeCloudflareMode(settings.cloudflare_mode);
  const tunnelEnabled = isEnabled(
    settings.project_hosts_cloudflare_tunnel_enabled,
  );
  if (!cloudflareSelfMode(settings)) {
    await stopManagedLaunchpadCloudflared();
    logger.info("cloudflare tunnel not started (mode is not self)", {
      cloudflare_mode: rawMode ?? null,
      normalized_mode: normalizedMode ?? null,
      tunnel_enabled: tunnelEnabled,
    });
    return null;
  }
  if (normalizedMode === "none" && tunnelEnabled) {
    logger.warn(
      "cloudflare_mode is none but tunnel is enabled; treating as self for backward compatibility",
      {
        cloudflare_mode: rawMode ?? null,
      },
    );
  }
  const missing: string[] = [];
  if (!clean(settings.project_hosts_cloudflare_tunnel_account_id)) {
    missing.push("Project Hosts: Cloudflare Tunnel - Account ID");
  }
  if (!clean(settings.project_hosts_cloudflare_tunnel_api_token)) {
    missing.push("Project Hosts: Cloudflare Tunnel - API Token");
  }
  if (!clean(settings.dns)) {
    missing.push("External Domain Name");
  }
  if (missing.length) {
    cloudflaredLastError = `Cloudflare tunnel enabled but missing settings: ${missing.join(
      ", ",
    )}`;
    logger.warn(cloudflaredLastError);
    logger.info("cloudflare tunnel not started (missing settings)");
    return null;
  }
  if (!(await hasHubCloudflareTunnel())) {
    cloudflaredLastError =
      "Cloudflare tunnel enabled but configuration is incomplete.";
    logger.warn(cloudflaredLastError);
    logger.info("cloudflare tunnel not started (configuration incomplete)");
    return null;
  }
  if (cloudflaredState && !isPidRunning(cloudflaredState.pid)) {
    cloudflaredState = null;
  }
  const cloudflaredBin = await resolveCloudflaredBinary();
  if (!cloudflaredBin) {
    logger.info("cloudflare tunnel not started (cloudflared missing)");
    return null;
  }

  const cfDir = cloudflaredStateDir();
  await mkdir(cfDir, { recursive: true });
  const replica = cloudflaredReplica();
  const primary = replica === 1;
  const tunnelPath = join(cfDir, "tunnel.json");
  const credentialsPath = join(cfDir, replicaFileName("credentials.json"));
  const configPath = join(cfDir, replicaFileName("config.yml"));
  const pidPath = cloudflaredPidFilePath();

  let tunnel: CloudflareTunnel | undefined;
  if (!primary) {
    if (
      !primaryTunnelRunning({
        pid: await readPidFile(cloudflaredPidFilePath(1)),
        cmdline: processCmdline,
        primaryConfigPath: join(cfDir, "config.yml"),
      })
    ) {
      // Fail (systemd retries) rather than serve a tunnel replica 1 may be
      // about to replace.
      throw new Error(
        `cloudflared replica ${replica} is waiting for replica 1 to bring the tunnel state up to date`,
      );
    }
    tunnel = await loadCloudflaredStateFile(tunnelPath);
    if (!tunnel) {
      // Fail (systemd retries) rather than create a second tunnel next to
      // the one replica 1 is creating.
      throw new Error(
        `cloudflared replica ${replica} is waiting for replica 1 to record the tunnel in ${tunnelPath}`,
      );
    }
  } else {
    try {
      const existing = await loadCloudflaredStateFile(tunnelPath);
      tunnel = await ensureCloudflareTunnelForHub({ existing });
      if (!tunnel) {
        cloudflaredLastError =
          "Cloudflare tunnel configuration missing or incomplete.";
        logger.warn(cloudflaredLastError);
        return null;
      }
      // Other replicas read this file while it is written: replace it whole.
      const temporary = `${tunnelPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(tunnel, null, 2), {
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, tunnelPath);
    } catch (err) {
      cloudflaredLastError = String(err);
      logger.warn("cloudflare tunnel ensure failed", { err });
      return null;
    }
  }

  const { origin, noTLSVerify } = resolveCloudflaredOrigin();
  const publicViewerHostname = normalizeHostname(
    resolvePublicViewerDns({
      publicViewerDns: settings.public_viewer_dns,
      dns: settings.dns,
    }) ?? "",
  );
  const additionalHostnames: string[] = [];
  if (getConfiguredClusterRole() !== "standalone") {
    const bayHostname = await getDerivedBayPublicHostname(getConfiguredBayId());
    if (bayHostname) {
      additionalHostnames.push(bayHostname);
    }
  }
  const additionalIngress: Array<{ hostname: string; origin: string }> = [];
  const fundingApproval = await resolveFundingApprovalConfiguration();
  if (fundingApproval.state === "configured") {
    // (replica 1 registers the hostname with Cloudflare; the rest only route it)
    const approvalUrl = new URL(fundingApproval.config.origin);
    const approvalPort = fundingApproval.config.listen_port;
    {
      if (approvalUrl.protocol !== "https:") {
        throw new Error(
          "Public financial approval ingress requires an HTTPS origin.",
        );
      }
      additionalIngress.push({
        hostname: approvalUrl.hostname,
        origin: `http://127.0.0.2:${approvalPort}`,
      });
      if (primary) {
        await ensureCloudflareTunnelHostname({
          tunnel,
          hostname: approvalUrl.hostname,
          allowOutsideConfiguredDns: true,
          protectExisting: true,
        });
      }
    }
  }
  await writeCloudflaredCredentials(credentialsPath, tunnel);
  await writeCloudflaredConfig({
    path: configPath,
    credentialsPath,
    tunnel,
    origin,
    noTLSVerify,
    publicViewerHostname,
    additionalHostnames,
    additionalIngress,
  });

  return {
    tunnel,
    configPath,
    credentialsPath,
    origin,
    pidFile: pidPath,
    cloudflaredBin,
  };
}

export async function runLaunchpadCloudflaredForeground(): Promise<void> {
  const prepared = await prepareCloudflared();
  if (!prepared) {
    const message =
      cloudflaredLastError ?? "Cloudflare tunnel is not configured.";
    logger.info("cloudflare tunnel foreground runner exiting", { message });
    console.log(message);
    return;
  }

  await stopManagedLaunchpadCloudflared();

  const args = cloudflaredTunnelArgs({ configPath: prepared.configPath });
  logger.info("starting systemd-managed cloudflared", {
    hostname: prepared.tunnel.hostname,
    origin: prepared.origin,
    replica: cloudflaredReplica(),
  });
  const child = spawn(prepared.cloudflaredBin, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (!(child.pid && Number.isInteger(child.pid) && child.pid > 0)) {
    throw new Error("failed to start cloudflared (missing child pid)");
  }

  await writePidFile(prepared.pidFile, child.pid);
  cloudflaredState = {
    tunnel: prepared.tunnel,
    configPath: prepared.configPath,
    credentialsPath: prepared.credentialsPath,
    origin: prepared.origin,
    pid: child.pid,
    pidFile: prepared.pidFile,
  };
  console.log(
    `Cloudflare tunnel is live: https://${prepared.tunnel.hostname} (systemd managed)`,
  );

  let stopping = false;
  const stopChild = (signal: NodeJS.Signals) => {
    stopping = true;
    if (isPidRunning(child.pid)) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  };
  process.once("SIGTERM", () => stopChild("SIGTERM"));
  process.once("SIGINT", () => stopChild("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      cloudflaredState = null;
      void clearPidFile(prepared.pidFile).finally(() => {
        if (stopping) {
          process.exitCode = 0;
        } else if (code != null) {
          process.exitCode = code;
        } else if (signal) {
          process.exitCode = 1;
        }
        resolve();
      });
    });
  });
}

process.once("exit", () => {
  if (cloudflaredState?.pidFile) {
    clearPidFileSync(cloudflaredState.pidFile);
  }
});
