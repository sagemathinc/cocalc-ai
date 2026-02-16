// On-prem launchpad only: keep a reverse SSH tunnel from the host back to the
// hub so the hub can proxy project HTTP/WS traffic and users can SSH via a
// host-specific port, without requiring inbound access to the host.
//
// Behavior/assumptions:
// - The host registers a tunnel config with the hub and then establishes
//   reverse port forwards to the hub's sshd for HTTP+SSH proxying.
// - If registration fails (hub down at boot), we retry with backoff until it
//   succeeds; this avoids requiring a host restart.
// - If the SSH connection drops, the ssh client exits (via server alive
//   settings) and we restart the tunnel automatically.
// - If the host and hub are on the same machine, the tunnel is still allowed but
//   can be skipped by higher-level logic.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { sshServer } from "@cocalc/backend/data";
import {
  createHostStatusClient,
  ONPREM_REST_TUNNEL_LOCAL_PORT,
} from "@cocalc/conat/project-host/api";
import { randomBytes } from "micro-key-producer/utils.js";
import ssh from "micro-key-producer/ssh.js";
import { getMasterConatClient } from "./master-status";

const SSH_BINARY = process.env.COCALC_SSH_BINARY ?? "ssh";

const logger = getLogger("project-host:onprem-tunnel");

type TunnelConfig = {
  sshdHost: string;
  sshdPort: number;
  httpTunnelPort: number;
  sshTunnelPort: number;
  sshUser: string;
  keyPath: string;
  restPort: number;
};

type StoredTunnelConfig = {
  sshd_host: string;
  sshd_port: number;
  http_tunnel_port: number;
  ssh_tunnel_port: number;
  ssh_user: string;
  public_key: string;
  rest_port: number;
};

type TunnelState = {
  stopped: boolean;
  child?: ChildProcessWithoutNullStreams;
  retryTimer?: NodeJS.Timeout;
  retryAttempt?: number;
  restartTimer?: NodeJS.Timeout;
  lastForwardFailureMs?: number;
  restartPending?: boolean;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir(): string {
  return process.env.COCALC_DATA ?? process.env.DATA ?? "/mnt/cocalc/data";
}

function isLocalSelfHost(): boolean {
  return (process.env.COCALC_SELF_HOST_MODE ?? "").toLowerCase() === "local";
}

function parsePort(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function resolveKeyPath(): string {
  return (
    process.env.COCALC_LAUNCHPAD_TUNNEL_KEY_PATH ??
    join(resolveDataDir(), "secrets", "launchpad", "tunnel-key")
  );
}

function resolveConfigPath(): string {
  return join(resolveDataDir(), "secrets", "launchpad", "tunnel-config.json");
}

async function writeKeyPair(keyPath: string, hostId: string): Promise<string> {
  const seed = randomBytes(32);
  const keypair = ssh(seed, `launchpad-tunnel-${hostId}`);
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, keypair.privateKey.trim() + "\n", { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return keypair.publicKey.trim();
}

async function ensureKeyPair(keyPath: string, hostId: string): Promise<string> {
  if (await fileExists(keyPath)) {
    return "";
  }
  return await writeKeyPair(keyPath, hostId);
}

function buildTunnelArgs(opts: {
  config: TunnelConfig;
  localHttpPort: number;
  localSshPort: number;
  localRestPort?: number;
  remoteRestPort?: number;
}): string[] {
  const { config, localHttpPort, localSshPort, localRestPort, remoteRestPort } =
    opts;
  const args = [
    "-i",
    config.keyPath,
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-p",
    String(config.sshdPort),
    `${config.sshUser}@${config.sshdHost}`,
    "-R",
    `0.0.0.0:${config.httpTunnelPort}:127.0.0.1:${localHttpPort}`,
    "-R",
    `0.0.0.0:${config.sshTunnelPort}:127.0.0.1:${localSshPort}`,
  ];
  if (localRestPort && remoteRestPort) {
    args.push(
      "-L",
      `127.0.0.1:${localRestPort}:127.0.0.1:${remoteRestPort}`,
    );
  }
  return args;
}

async function loadStoredConfig(
  configPath: string,
): Promise<StoredTunnelConfig | undefined> {
  if (!(await fileExists(configPath))) {
    return undefined;
  }
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as StoredTunnelConfig;
  } catch (err) {
    logger.warn("failed to read tunnel config", { err });
    return undefined;
  }
}

async function saveStoredConfig(
  configPath: string,
  config: StoredTunnelConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  logger.debug("stored onprem tunnel config", {
    sshd_host: config.sshd_host,
    sshd_port: config.sshd_port,
    http_tunnel_port: config.http_tunnel_port,
    ssh_tunnel_port: config.ssh_tunnel_port,
  });
}

function resolveTunnelConfigFromEnv(): TunnelConfig | undefined {
  const sshdHost = process.env.COCALC_LAUNCHPAD_SSHD_HOST;
  const sshdPort = parsePort(process.env.COCALC_LAUNCHPAD_SSHD_PORT);
  const tunnelPort = parsePort(process.env.COCALC_LAUNCHPAD_HTTP_TUNNEL_PORT);
  const sshTunnelPort = parsePort(
    process.env.COCALC_LAUNCHPAD_SSH_TUNNEL_PORT,
  );
  const sshUser =
    process.env.COCALC_LAUNCHPAD_SSHD_USER ??
    process.env.USER ??
    process.env.LOGNAME ??
    "user";
  const keyPath = resolveKeyPath();
  if (!sshdHost || !sshdPort || !tunnelPort || !sshTunnelPort) {
    return undefined;
  }
  return {
    sshdHost,
    sshdPort,
    httpTunnelPort: tunnelPort,
    sshTunnelPort,
    sshUser,
    keyPath,
    restPort: parsePort(process.env.COCALC_LAUNCHPAD_REST_PORT) ?? 9345,
  };
}

function resolveHubHost(): string | undefined {
  const raw =
    process.env.MASTER_CONAT_SERVER ?? process.env.COCALC_MASTER_CONAT_SERVER;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    try {
      return new URL(`https://${raw}`).hostname;
    } catch {
      return undefined;
    }
  }
}

function normalizeStoredConfig(
  stored: StoredTunnelConfig | undefined,
  keyPath: string,
): TunnelConfig | undefined {
  if (!stored) return undefined;
  if (!stored.sshd_host || !stored.sshd_port) return undefined;
  if (!stored.http_tunnel_port || !stored.ssh_tunnel_port) return undefined;
  if (!stored.rest_port) return undefined;
  return {
    sshdHost: stored.sshd_host,
    sshdPort: stored.sshd_port,
    httpTunnelPort: stored.http_tunnel_port,
    sshTunnelPort: stored.ssh_tunnel_port,
    sshUser: stored.ssh_user || "user",
    keyPath,
    restPort: stored.rest_port,
  };
}

async function registerTunnelConfig(opts: {
  keyPath: string;
  configPath: string;
  fallback?: StoredTunnelConfig;
}): Promise<TunnelConfig | undefined> {
  const client = getMasterConatClient();
  if (!client) {
    logger.debug("onprem tunnel registration skipped (no master client)");
    return undefined;
  }
  const hostId = process.env.PROJECT_HOST_ID ?? "";
  if (!hostId) {
    logger.warn("onprem tunnel registration skipped (missing host id)");
    return undefined;
  }
  let publicKey = opts.fallback?.public_key ?? "";
  if (!publicKey) {
    publicKey = await ensureKeyPair(opts.keyPath, hostId);
    if (!publicKey && opts.fallback?.public_key) {
      publicKey = opts.fallback.public_key;
    } else if (!publicKey) {
      logger.warn("onprem tunnel key missing; regenerating");
      publicKey = await writeKeyPair(opts.keyPath, hostId);
    }
  }
  if (!publicKey) {
    logger.warn("onprem tunnel registration skipped (missing public key)");
    return undefined;
  }
  const statusClient = createHostStatusClient({ client });
  try {
    const res = await statusClient.registerOnPremTunnel({
      host_id: hostId,
      public_key: publicKey,
    });
    const sshdHost = res.sshd_host || resolveHubHost();
    if (!sshdHost) {
      logger.warn("onprem tunnel registration missing sshd host");
      return undefined;
    }
    if (!res.rest_port) {
      throw new Error("rest-server port is missing");
    }
    const stored: StoredTunnelConfig = {
      sshd_host: sshdHost,
      sshd_port: res.sshd_port,
      ssh_user: res.ssh_user,
      http_tunnel_port: res.http_tunnel_port,
      ssh_tunnel_port: res.ssh_tunnel_port,
      public_key: publicKey,
      rest_port: res.rest_port,
    };
    await saveStoredConfig(opts.configPath, stored);
    logger.info("onprem tunnel registered", {
      sshd_host: stored.sshd_host,
      sshd_port: stored.sshd_port,
      http_tunnel_port: stored.http_tunnel_port,
      ssh_tunnel_port: stored.ssh_tunnel_port,
      rest_port: stored.rest_port,
    });
    return normalizeStoredConfig(stored, opts.keyPath);
  } catch (err) {
    logger.warn("onprem tunnel registration failed", { err });
    return undefined;
  }
}

export async function startOnPremTunnel(opts: {
  localHttpPort: number;
}): Promise<() => void> {
  if (!isLocalSelfHost()) {
    logger.debug("onprem tunnel disabled (self_host_mode != local)");
    return () => {};
  }
  const keyPath = resolveKeyPath();
  const configPath = resolveConfigPath();
  const envConfig = resolveTunnelConfigFromEnv();
  const storedConfig = await loadStoredConfig(configPath);
  const fallbackConfig =
    normalizeStoredConfig(storedConfig, keyPath) ?? envConfig;
  if (storedConfig) {
    logger.debug("onprem tunnel config loaded from disk");
  } else if (envConfig) {
    logger.debug("onprem tunnel config loaded from env");
  }
  const hostId = process.env.PROJECT_HOST_ID ?? "host";

  await ensureKeyPair(keyPath, hostId);

  const localSshPort = sshServer.port;
  const localRestPort =
    parsePort(process.env.COCALC_ONPREM_REST_TUNNEL_LOCAL_PORT) ??
    ONPREM_REST_TUNNEL_LOCAL_PORT;
  const state: TunnelState = { stopped: false };
  let currentConfig: TunnelConfig | undefined = fallbackConfig;

  const resolveNextConfig = async (
    fallback?: TunnelConfig,
  ): Promise<TunnelConfig | undefined> => {
    const latestStored = await loadStoredConfig(configPath);
    const fresh = await registerTunnelConfig({
      keyPath,
      configPath,
      fallback: latestStored ?? storedConfig,
    });
    return (
      fresh ??
      normalizeStoredConfig(latestStored, keyPath) ??
      fallback ??
      currentConfig
    );
  };

  const start = (config: TunnelConfig) => {
    if (state.stopped) {
      return;
    }
    currentConfig = config;
    const remoteRestPort =
      config.restPort ??
      parsePort(process.env.COCALC_LAUNCHPAD_REST_PORT) ??
      parsePort(process.env.COCALC_REST_PORT);
    if (!remoteRestPort) {
      logger.warn("onprem tunnel missing rest_port; waiting for registration");
      scheduleRetry();
      return;
    }
    const args = buildTunnelArgs({
      config,
      localHttpPort: opts.localHttpPort,
      localSshPort,
      localRestPort,
      remoteRestPort,
    });
    logger.debug("starting onprem tunnel", {
      sshdHost: config.sshdHost,
      sshdPort: config.sshdPort,
      httpTunnelPort: config.httpTunnelPort,
      sshTunnelPort: config.sshTunnelPort,
    });
    const child = spawn(SSH_BINARY, args);
    state.child = child;
    const scheduleRestart = (reason: string) => {
      if (state.stopped || state.restartPending) {
        return;
      }
      state.restartPending = true;
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
      }
      state.restartTimer = setTimeout(async () => {
        state.restartPending = false;
        if (state.stopped) return;
        const next = await resolveNextConfig(config);
        if (!next) {
          logger.warn("onprem tunnel restart could not refresh config", {
            reason,
          });
          scheduleRetry();
          return;
        }
        if (
          next.sshdHost !== config.sshdHost ||
          next.sshdPort !== config.sshdPort ||
          next.restPort !== config.restPort
        ) {
          logger.info("onprem tunnel refreshed config after disconnect", {
            reason,
            sshd_host: next.sshdHost,
            sshd_port: next.sshdPort,
            rest_port: next.restPort,
          });
        }
        start(next);
      }, 5000);
    };
    child.on("error", (err) => {
      if (state.stopped) {
        return;
      }
      logger.warn("onprem tunnel spawn failed", { err: String(err) });
      scheduleRestart("spawn-error");
    });
    child.stdout.on("data", (chunk) => logger.debug(chunk.toString()));
    child.stderr.on("data", (chunk) => {
      const line = chunk.toString();
      logger.debug(line);
      // If the forwarded REST target is stale/unreachable on the hub side,
      // force a reconnect so we re-register and pick up fresh ports.
      if (
        /connect_to 127\.0\.0\.1 port \d+: failed/.test(line) ||
        /open failed: connect failed: Connection refused/.test(line)
      ) {
        const now = Date.now();
        if (
          state.lastForwardFailureMs == null ||
          now - state.lastForwardFailureMs > 15000
        ) {
          state.lastForwardFailureMs = now;
          logger.warn("onprem tunnel forward target failed; reconnecting", {
            line: line.trim(),
          });
          if (child.exitCode == null) {
            child.kill("SIGTERM");
          }
        }
      }
    });
    child.on("exit", (code, signal) => {
      if (state.stopped) {
        return;
      }
      logger.warn("onprem tunnel exited", { code, signal });
      scheduleRestart("ssh-exit");
    });
  };

  const scheduleRetry = () => {
    if (state.stopped) {
      return;
    }
    const attempt = (state.retryAttempt ?? 0) + 1;
    state.retryAttempt = attempt;
    const baseDelay = Math.min(60000, 2000 * Math.pow(2, attempt - 1));
    const jitter = Math.floor(baseDelay * (0.2 * Math.random()));
    const delay = baseDelay + jitter;
    logger.debug("onprem tunnel config missing; retrying registration", {
      attempt,
      delay_ms: delay,
    });
    state.retryTimer = setTimeout(async () => {
      if (state.stopped) return;
      const config = await resolveNextConfig();
      if (config) {
        state.retryTimer = undefined;
        state.retryAttempt = 0;
        logger.info("onprem tunnel config recovered; starting tunnel");
        start(config);
      } else {
        scheduleRetry();
      }
    }, delay);
  };

  const config = await resolveNextConfig(fallbackConfig);
  if (!config) {
    scheduleRetry();
    return () => {
      state.stopped = true;
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
      }
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
      }
    };
  }
  if (fallbackConfig && config === fallbackConfig) {
    logger.info("onprem tunnel using fallback config");
  }

  start(config);

  return () => {
    state.stopped = true;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
    }
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
    }
    if (state.child && state.child.exitCode == null) {
      state.child.kill("SIGTERM");
    }
  };
}
