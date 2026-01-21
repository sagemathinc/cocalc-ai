import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { sshServer } from "@cocalc/backend/data";
import { install, ssh as sshBinary } from "@cocalc/backend/sandbox/install";

const logger = getLogger("project-host:onprem-tunnel");

type TunnelConfig = {
  sshdHost: string;
  sshdPort: number;
  tunnelPort: number;
  sshTunnelPort: number;
  sshUser: string;
  keyPath: string;
};

type TunnelState = {
  stopped: boolean;
  child?: ChildProcessWithoutNullStreams;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parsePort(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

async function ensureKeyPath(keyPath: string, keyContent?: string): Promise<void> {
  if (await fileExists(keyPath)) {
    return;
  }
  if (!keyContent) {
    throw new Error("launchpad tunnel key missing");
  }
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, keyContent.trim() + "\n", { mode: 0o600 });
  await chmod(keyPath, 0o600);
}

function buildTunnelArgs(opts: {
  config: TunnelConfig;
  localHttpPort: number;
  localSshPort: number;
}): string[] {
  const { config, localHttpPort, localSshPort } = opts;
  return [
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
    `0.0.0.0:${config.tunnelPort}:127.0.0.1:${localHttpPort}`,
    "-R",
    `0.0.0.0:${config.sshTunnelPort}:127.0.0.1:${localSshPort}`,
  ];
}

function resolveTunnelConfig(): TunnelConfig | undefined {
  const sshdHost = process.env.COCALC_LAUNCHPAD_SSHD_HOST;
  const sshdPort = parsePort(process.env.COCALC_LAUNCHPAD_SSHD_PORT);
  const tunnelPort = parsePort(process.env.COCALC_LAUNCHPAD_TUNNEL_PORT);
  const sshTunnelPort = parsePort(
    process.env.COCALC_LAUNCHPAD_SSH_TUNNEL_PORT,
  );
  const sshUser =
    process.env.COCALC_LAUNCHPAD_SSHD_USER ??
    process.env.USER ??
    process.env.LOGNAME ??
    "user";
  const keyPath =
    process.env.COCALC_LAUNCHPAD_TUNNEL_KEY_PATH ??
    join(process.env.COCALC_DATA ?? "/btrfs/data", "secrets", "launchpad", "tunnel-key");
  if (!sshdHost || !sshdPort || !tunnelPort || !sshTunnelPort) {
    return undefined;
  }
  return {
    sshdHost,
    sshdPort,
    tunnelPort,
    sshTunnelPort,
    sshUser,
    keyPath,
  };
}

export async function startOnPremTunnel(opts: {
  localHttpPort: number;
}): Promise<() => void> {
  const config = resolveTunnelConfig();
  if (!config) {
    logger.debug("onprem tunnel disabled (missing config)");
    return () => {};
  }
  await install("ssh");
  const keyContent = process.env.COCALC_LAUNCHPAD_TUNNEL_PRIVATE_KEY;
  await ensureKeyPath(config.keyPath, keyContent);
  const localSshPort = sshServer.port;
  const state: TunnelState = { stopped: false };

  const start = () => {
    if (state.stopped) {
      return;
    }
    const args = buildTunnelArgs({
      config,
      localHttpPort: opts.localHttpPort,
      localSshPort,
    });
    logger.debug("starting onprem tunnel", {
      sshdHost: config.sshdHost,
      sshdPort: config.sshdPort,
      tunnelPort: config.tunnelPort,
      sshTunnelPort: config.sshTunnelPort,
    });
    const child = spawn(sshBinary, args);
    state.child = child;
    child.stdout.on("data", (chunk) => logger.debug(chunk.toString()));
    child.stderr.on("data", (chunk) => logger.debug(chunk.toString()));
    child.on("exit", (code, signal) => {
      if (state.stopped) {
        return;
      }
      logger.warn("onprem tunnel exited", { code, signal });
      setTimeout(start, 5000);
    });
  };

  start();

  return () => {
    state.stopped = true;
    if (state.child && state.child.exitCode == null) {
      state.child.kill("SIGTERM");
    }
  };
}
