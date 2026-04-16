/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { conatServer, secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { which } from "@cocalc/backend/which";
import {
  type BayRegistryManagedTunnel,
  createInterBayBayRegistryClient,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getCurrentBayPublicTarget } from "@cocalc/server/bay-public-origin";
import { buildLocalBayRegistration } from "@cocalc/server/bay-registry";
import { getConfiguredClusterRole, isMultiBayCluster } from "./cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { ensureLocalCloudflaredBinary } from "@cocalc/server/launchpad/cloudflared-installer";

const logger = getLogger("server:bay-cloudflared");
const RECONCILE_INTERVAL_MS = 60_000;

type CloudflaredState = {
  tunnel: BayRegistryManagedTunnel;
  configPath: string;
  credentialsPath: string;
  pid: number;
  pidFile: string;
};

let cloudflaredState: CloudflaredState | null = null;
let started = false;
let lastError: string | null = null;
let registryClient:
  | ReturnType<typeof createInterBayBayRegistryClient>
  | undefined;

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function stateDir(): string {
  const configured = trim(process.env.COCALC_BAY_CLOUDFLARED_STATE_DIR);
  return configured || join(secrets, `bay-cloudflare-${getConfiguredBayId()}`);
}

function pidFilePath(): string {
  const configured = trim(process.env.COCALC_BAY_CLOUDFLARED_PID_FILE);
  return configured || join(stateDir(), "cloudflared.pid");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parsePid(raw: string): number | undefined {
  const text = trim(raw);
  if (!/^\d+$/.test(text)) return;
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
  if (!(await fileExists(path))) return undefined;
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

async function resolveCloudflaredBinary(): Promise<string | null> {
  const systemBinary = await which("cloudflared");
  if (systemBinary) {
    return systemBinary;
  }
  try {
    return await ensureLocalCloudflaredBinary({
      stateDir: stateDir(),
      logger,
    });
  } catch (err) {
    lastError = `failed to install cloudflared automatically: ${String(err)}`;
    logger.warn(lastError);
    return null;
  }
}

async function loadTunnelState(
  path: string,
): Promise<BayRegistryManagedTunnel | undefined> {
  if (!(await fileExists(path))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.id && parsed?.hostname && parsed?.tunnel_secret) {
      return parsed as BayRegistryManagedTunnel;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function writeCredentials(
  path: string,
  tunnel: BayRegistryManagedTunnel,
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
    // write fresh
  }
  await writeFile(path, next, { mode: 0o600 });
  await chmod(path, 0o600);
  return true;
}

async function writeConfig(opts: {
  path: string;
  credentialsPath: string;
  tunnel: BayRegistryManagedTunnel;
  origin: string;
}): Promise<boolean> {
  const yamlString = (value: string): string => JSON.stringify(value);
  const lines = [
    `tunnel: ${yamlString(opts.tunnel.id)}`,
    `credentials-file: ${yamlString(opts.credentialsPath)}`,
    "ingress:",
    `  - hostname: ${yamlString(opts.tunnel.hostname)}`,
    `    service: ${yamlString(opts.origin)}`,
    "  - service: http_status:404",
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
    // write fresh
  }
  await writeFile(opts.path, next, { mode: 0o600 });
  await chmod(opts.path, 0o600);
  return true;
}

async function fetchManagedTunnel(): Promise<BayRegistryManagedTunnel | null> {
  if (getCurrentBayPublicTarget()) {
    return null;
  }
  registryClient ??= createInterBayBayRegistryClient({
    // This reconcile loop runs every minute on attached bays. Reusing the
    // shared fabric client avoids leaking one inter-bay socket per tick.
    client: getInterBayFabricClient(),
  });
  const client = registryClient;
  const result = await client.register(await buildLocalBayRegistration());
  return result.managed_tunnel ?? null;
}

async function reconcileOnce(): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() !== "attached") {
    return;
  }
  const tunnel = await fetchManagedTunnel();
  if (!tunnel) {
    return;
  }
  const cloudflaredBin = await resolveCloudflaredBinary();
  if (!cloudflaredBin) {
    logger.info("bay cloudflare tunnel not started (cloudflared missing)");
    return;
  }
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const tunnelPath = join(dir, "tunnel.json");
  const credentialsPath = join(dir, "credentials.json");
  const configPath = join(dir, "config.yml");
  const pidPath = pidFilePath();

  const nextTunnel = JSON.stringify(tunnel, null, 2);
  let tunnelChanged = false;
  try {
    const current = await readFile(tunnelPath, "utf8");
    if (current !== nextTunnel) {
      await writeFile(tunnelPath, nextTunnel, { mode: 0o600 });
      await chmod(tunnelPath, 0o600);
      tunnelChanged = true;
    }
  } catch {
    await writeFile(tunnelPath, nextTunnel, { mode: 0o600 });
    await chmod(tunnelPath, 0o600);
    tunnelChanged = true;
  }

  const origin = conatServer;
  const credentialsChanged = await writeCredentials(credentialsPath, tunnel);
  const configChanged = await writeConfig({
    path: configPath,
    credentialsPath,
    tunnel,
    origin,
  });

  const persistedPid = await readPidFile(pidPath);
  const shouldRestart = tunnelChanged || credentialsChanged || configChanged;
  if (isPidRunning(persistedPid)) {
    if (!shouldRestart) {
      cloudflaredState = {
        tunnel,
        configPath,
        credentialsPath,
        pid: persistedPid!,
        pidFile: pidPath,
      };
      return;
    }
    try {
      process.kill(persistedPid!, "SIGTERM");
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (isPidRunning(persistedPid)) {
      try {
        process.kill(persistedPid!, "SIGKILL");
      } catch {
        // ignore
      }
    }
    await clearPidFile(pidPath);
  }

  const args = ["tunnel", "--no-autoupdate", "--config", configPath, "run"];
  logger.info("starting bay cloudflared", {
    bay_id: getConfiguredBayId(),
    hostname: tunnel.hostname,
    origin,
  });
  const child = spawn(cloudflaredBin, args, {
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  if (!(child.pid && Number.isInteger(child.pid) && child.pid > 0)) {
    lastError = "failed to start bay cloudflared (missing child pid)";
    logger.error(lastError);
    return;
  }
  child.unref();
  await writePidFile(pidPath, child.pid);
  cloudflaredState = {
    tunnel,
    configPath,
    credentialsPath,
    pid: child.pid,
    pidFile: pidPath,
  };
  lastError = null;
}

export function startManagedBayCloudflared(): void {
  if (started) return;
  started = true;
  void reconcileOnce().catch((err) => {
    logger.warn("initial bay cloudflared reconcile failed", { err: `${err}` });
  });
  const timer = setInterval(() => {
    void reconcileOnce().catch((err) => {
      logger.warn("bay cloudflared reconcile failed", { err: `${err}` });
    });
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
}

export function stopManagedBayCloudflared(): void {
  if (cloudflaredState?.pid && isPidRunning(cloudflaredState.pid)) {
    try {
      process.kill(cloudflaredState.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  if (cloudflaredState?.pidFile) {
    clearPidFileSync(cloudflaredState.pidFile);
  } else {
    clearPidFileSync(pidFilePath());
  }
  cloudflaredState = null;
}

export async function getManagedBayCloudflaredStatus(): Promise<{
  enabled: boolean;
  running: boolean;
  hostname?: string;
  error?: string | null;
}> {
  const pid = cloudflaredState?.pid ?? (await readPidFile(pidFilePath()));
  const running = isPidRunning(pid);
  if (cloudflaredState && !running) {
    cloudflaredState = null;
  }
  let hostname = cloudflaredState?.tunnel.hostname;
  if (!hostname) {
    hostname = (await loadTunnelState(join(stateDir(), "tunnel.json")))
      ?.hostname;
  }
  return {
    enabled: isMultiBayCluster() && getConfiguredClusterRole() === "attached",
    running,
    hostname,
    error: lastError,
  };
}
