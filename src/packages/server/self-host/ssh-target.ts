import { spawn, type ChildProcess } from "node:child_process";
import { getLogger } from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import getPort from "@cocalc/backend/get-port";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import { argsJoin } from "@cocalc/util/args";

const logger = getLogger("server:self-host:ssh-target");

type SshTarget = {
  raw: string;
  host: string;
  user?: string;
  port?: number;
  explicit: boolean;
};

type TunnelState = {
  host_id: string;
  target: SshTarget;
  port: number;
  child: ChildProcess;
  restarting?: boolean;
};

const tunnels = new Map<string, TunnelState>();

function parseSshTarget(raw: string): SshTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Accept user@host[:port] or host[:port]. ssh config names pass through unchanged.
  const atIndex = trimmed.indexOf("@");
  const hasUser = atIndex > 0;
  const user = hasUser ? trimmed.slice(0, atIndex) : undefined;
  const hostPart = hasUser ? trimmed.slice(atIndex + 1) : trimmed;
  const matchPort = hostPart.match(/^(.*):(\d+)$/);
  if (matchPort) {
    const host = matchPort[1];
    const port = Number(matchPort[2]);
    if (host && Number.isFinite(port)) {
      return {
        raw: trimmed,
        host,
        user,
        port,
        explicit: true,
      };
    }
  }
  return { raw: trimmed, host: hostPart, user, explicit: false };
}

function buildSshArgs(target: SshTarget, extraArgs: string[] = []): string[] {
  const args: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  if (target.user) {
    args.push("-l", target.user);
  }
  if (target.port) {
    args.push("-p", String(target.port));
  }
  args.push(...extraArgs, target.host);
  return args;
}

async function updateHostSelfHostMetadata(host_id: string, update: any) {
  const { rows } = await getPool().query<{ metadata: any }>(
    `SELECT metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL`,
    [host_id],
  );
  const metadata = rows[0]?.metadata ?? {};
  const nextMetadata = {
    ...metadata,
    self_host: {
      ...(metadata.self_host ?? {}),
      ...update,
    },
  };
  await getPool().query(
    `UPDATE project_hosts
     SET metadata=$2, updated=NOW()
     WHERE id=$1 AND deleted IS NULL`,
    [host_id, nextMetadata],
  );
}

async function loadSelfHostMetadata(host_id: string): Promise<any> {
  const { rows } = await getPool().query<{ metadata: any }>(
    `SELECT metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL`,
    [host_id],
  );
  if (!rows[0]) {
    throw new Error("host not found");
  }
  return rows[0].metadata ?? {};
}

async function ensureReversePort(host_id: string): Promise<number> {
  const metadata = await loadSelfHostMetadata(host_id);
  const stored = Number(metadata?.self_host?.ssh_reverse_port ?? 0);
  if (stored) return stored;
  const port = await getPort();
  await updateHostSelfHostMetadata(host_id, {
    ssh_reverse_port: port,
    ssh_reverse_port_updated_at: new Date().toISOString(),
  });
  return port;
}

async function spawnReverseTunnel(host_id: string, target: SshTarget, port: number) {
  const config = getLaunchpadLocalConfig("local");
  if (!config.sshd_port) {
    throw new Error("local network sshd is not configured");
  }
  const reverseSpec = `${port}:127.0.0.1:${config.sshd_port}`;
  const extraArgs = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-R",
    reverseSpec,
  ];
  const args = buildSshArgs(target, extraArgs);
  logger.info("starting self-host reverse tunnel", {
    host_id,
    target: target.raw,
    remote_port: port,
    sshd_port: config.sshd_port,
  });
  const child = spawn("ssh", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    logger.debug("self-host tunnel stdout", {
      host_id,
      output: chunk.toString(),
    });
  });
  child.stderr?.on("data", (chunk) => {
    logger.debug("self-host tunnel stderr", {
      host_id,
      output: chunk.toString(),
    });
  });
  return child;
}

async function restartTunnel(state: TunnelState) {
  if (state.restarting) return;
  state.restarting = true;
  const delays = [1000, 2000, 5000, 10000];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const child = await spawnReverseTunnel(state.host_id, state.target, state.port);
      const nextState: TunnelState = { ...state, child, restarting: false };
      tunnels.set(state.host_id, nextState);
      attachTunnelHandlers(nextState);
      return;
    } catch (err) {
      logger.warn("self-host tunnel restart failed", {
        host_id: state.host_id,
        err,
      });
    }
  }
  state.restarting = false;
}

function attachTunnelHandlers(state: TunnelState) {
  state.child.on("exit", (code, signal) => {
    logger.warn("self-host tunnel exited", {
      host_id: state.host_id,
      code,
      signal,
    });
    const current = tunnels.get(state.host_id);
    if (current && current.child === state.child) {
      restartTunnel(state).catch((err) => {
        logger.warn("self-host tunnel restart failed", { host_id: state.host_id, err });
      });
    }
  });
}

export async function ensureSelfHostReverseTunnel(opts: {
  host_id: string;
  ssh_target: string;
}): Promise<number> {
  const target = parseSshTarget(opts.ssh_target);
  if (!target) {
    throw new Error("self-host ssh target is empty");
  }
  const existing = tunnels.get(opts.host_id);
  if (existing && existing.target.raw === target.raw && existing.child.exitCode == null) {
    return existing.port;
  }
  const port = await ensureReversePort(opts.host_id);
  const child = await spawnReverseTunnel(opts.host_id, target, port);
  const state: TunnelState = { host_id: opts.host_id, target, port, child };
  tunnels.set(opts.host_id, state);
  attachTunnelHandlers(state);
  return port;
}

export function stopSelfHostReverseTunnel(host_id: string): void {
  const state = tunnels.get(host_id);
  if (!state) return;
  tunnels.delete(host_id);
  if (state.child?.exitCode == null) {
    state.child.kill("SIGTERM");
  }
}

export async function runConnectorInstallOverSsh(opts: {
  host_id: string;
  ssh_target: string;
  pairing_token: string;
  name?: string;
  ssh_port: number;
}): Promise<void> {
  const target = parseSshTarget(opts.ssh_target);
  if (!target) {
    throw new Error("self-host ssh target is empty");
  }
  const config = getLaunchpadLocalConfig("local");
  const sshUser = config.ssh_user ?? "user";
  const installCmdParts = [
    "curl",
    "-fsSL",
    "https://software.cocalc.ai/software/self-host/install.sh",
    "|",
    "bash",
    "-s",
    "--",
    "--ssh-host",
    "localhost",
    "--ssh-port",
    String(opts.ssh_port),
    "--ssh-user",
    sshUser,
    "--token",
    opts.pairing_token,
    "--replace",
  ];
  if (opts.name) {
    installCmdParts.push("--name", `'${opts.name.replace(/'/g, "'\\''")}'`);
  }
  const installCmd = installCmdParts.join(" ");
  const args: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  if (target.user) {
    args.push("-l", target.user);
  }
  if (target.port) {
    args.push("-p", String(target.port));
  }
  args.push(target.host, "bash", "-lc", installCmd);
  logger.info("installing connector over ssh", {
    host_id: opts.host_id,
    target: target.raw,
    command: argsJoin(["ssh", ...args]),
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeoutMs = 5 * 60 * 1000;
    const timeout = setTimeout(() => {
      logger.warn("connector install timed out", {
        host_id: opts.host_id,
        timeout_ms: timeoutMs,
      });
      child.kill("SIGTERM");
      reject(new Error(`connector install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      logger.debug("connector install stdout", {
        host_id: opts.host_id,
        output: chunk.toString(),
      });
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      logger.warn("connector install failed", {
        host_id: opts.host_id,
        code,
        stderr,
      });
      reject(new Error(`connector install failed (exit ${code ?? "unknown"})`));
    });
  });
}
