import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { randomBytes } from "micro-key-producer/utils.js";
import ssh from "micro-key-producer/ssh.js";
import getPool from "@cocalc/database/pool";
import getPort from "@cocalc/backend/get-port";
import { secrets } from "@cocalc/backend/data";
import { executeCode } from "@cocalc/backend/execute-code";
import {
  install,
  sftpServer,
  ssh as sshBinary,
  sshKeygen,
  sshd,
} from "@cocalc/backend/sandbox/install";
import { getLaunchpadMode, getLaunchpadOnPremConfig } from "./mode";

const logger = getLogger("launchpad:onprem:sshd");

type SshdState = {
  sshdDir: string;
  authorizedKeysPath: string;
  child: ChildProcessWithoutNullStreams;
};

let sshdState: SshdState | null = null;

function pool() {
  return getPool();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveSshUser(): string {
  return (
    process.env.COCALC_SSHD_USER ??
    process.env.USER ??
    process.env.LOGNAME ??
    "user"
  );
}

async function ensureHostKey(hostKeyPath: string): Promise<void> {
  if (await fileExists(hostKeyPath)) {
    return;
  }
  await mkdir(dirname(hostKeyPath), { recursive: true });
  await executeCode({
    command: sshKeygen,
    args: ["-t", "ed25519", "-N", "", "-f", hostKeyPath],
    env: {
      ...process.env,
      PATH: `${dirname(sshBinary)}:${process.env.PATH ?? ""}`,
    },
  });
  await chmod(hostKeyPath, 0o600);
}

async function writeSshdConfig(opts: {
  configPath: string;
  hostKeyPath: string;
  authorizedKeysPath: string;
  pidPath: string;
  sshUser: string;
  sshdPort: number;
}): Promise<void> {
  const permitRootLogin = opts.sshUser === "root" ? "prohibit-password" : "no";
  const lines = [
    `Port ${opts.sshdPort}`,
    "ListenAddress 0.0.0.0",
    `HostKey ${opts.hostKeyPath}`,
    `AuthorizedKeysFile ${opts.authorizedKeysPath}`,
    `PidFile ${opts.pidPath}`,
    `LogLevel VERBOSE`,
    `AllowUsers ${opts.sshUser}`,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    `PermitRootLogin ${permitRootLogin}`,
    "PermitTTY no",
    "PermitUserEnvironment no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "AllowTcpForwarding yes",
    "GatewayPorts clientspecified",
    `Subsystem sftp ${sftpServer}`,
    "StrictModes no",
  ];
  const configText = lines.join("\n") + "\n";
  await writeFile(opts.configPath, configText, { mode: 0o600 });
}

async function ensureAuthorizedKeysPath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (!(await fileExists(path))) {
    await writeFile(path, "", { mode: 0o600 });
  }
}

async function startSshd(): Promise<SshdState | null> {
  if (process.env.COCALC_MODE !== "launchpad") {
    return null;
  }
  const mode = await getLaunchpadMode();
  if (mode !== "onprem") {
    return null;
  }
  if (sshdState) {
    return sshdState;
  }
  const config = getLaunchpadOnPremConfig(mode);
  if (!config.sshd_port) {
    logger.warn("onprem sshd disabled (missing COCALC_SSHD_PORT)");
    return null;
  }
  await install("ssh");
  const sshUser = resolveSshUser();
  const sshdDir = join(secrets, "launchpad-sshd");
  const configPath = join(sshdDir, "sshd_config");
  const hostKeyPath = join(sshdDir, "ssh_host_ed25519_key");
  const authorizedKeysPath = join(sshdDir, "authorized_keys");
  const pidPath = join(sshdDir, "sshd.pid");
  await mkdir(sshdDir, { recursive: true });
  await ensureHostKey(hostKeyPath);
  await ensureAuthorizedKeysPath(authorizedKeysPath);
  await writeSshdConfig({
    configPath,
    hostKeyPath,
    authorizedKeysPath,
    pidPath,
    sshUser,
    sshdPort: config.sshd_port,
  });

  const env = {
    ...process.env,
    PATH: `${dirname(sshBinary)}:${process.env.PATH ?? ""}`,
  };
  const args = ["-D", "-e", "-f", configPath];
  logger.info("starting onprem sshd", {
    port: config.sshd_port,
    sshUser,
    configPath,
  });
  const child = spawn(sshd, args, { env });
  child.stderr.on("data", (chunk) => {
    logger.debug(chunk.toString());
  });
  child.stdout.on("data", (chunk) => {
    logger.debug(chunk.toString());
  });
  child.on("exit", (code, signal) => {
    logger.error("onprem sshd exited", { code, signal });
  });
  sshdState = { sshdDir, authorizedKeysPath, child };
  return sshdState;
}

type TunnelEntry = {
  host_id: string;
  tunnel_port: number | null;
  ssh_tunnel_port: number | null;
  tunnel_public_key: string | null;
};

function formatAuthorizedKey(entry: TunnelEntry): string | null {
  if (!entry.tunnel_public_key) {
    return null;
  }
  const listens: string[] = [];
  if (entry.tunnel_port) {
    listens.push(`permitlisten="0.0.0.0:${entry.tunnel_port}"`);
  }
  if (entry.ssh_tunnel_port) {
    listens.push(`permitlisten="0.0.0.0:${entry.ssh_tunnel_port}"`);
  }
  if (!listens.length) {
    return null;
  }
  const options = [
    ...listens,
    "no-agent-forwarding",
    "no-X11-forwarding",
    "no-pty",
  ];
  return `${options.join(",")} ${entry.tunnel_public_key} host-${entry.host_id}`;
}

export async function refreshLaunchpadOnPremAuthorizedKeys(): Promise<void> {
  const state = await startSshd();
  if (!state) {
    return;
  }
  const { rows } = await pool().query<{
    host_id: string;
    tunnel_port: string | null;
    ssh_tunnel_port: string | null;
    tunnel_public_key: string | null;
  }>(
    `
    SELECT id AS host_id,
           metadata->'self_host'->>'tunnel_port' AS tunnel_port,
           metadata->'self_host'->>'ssh_tunnel_port' AS ssh_tunnel_port,
           metadata->'self_host'->>'tunnel_public_key' AS tunnel_public_key
      FROM project_hosts
     WHERE deleted IS NULL
       AND metadata ? 'self_host'
    `,
  );
  const lines: string[] = [];
  for (const row of rows) {
    const entry: TunnelEntry = {
      host_id: row.host_id,
      tunnel_port: row.tunnel_port ? Number(row.tunnel_port) : null,
      ssh_tunnel_port: row.ssh_tunnel_port ? Number(row.ssh_tunnel_port) : null,
      tunnel_public_key: row.tunnel_public_key,
    };
    const line = formatAuthorizedKey(entry);
    if (line) {
      lines.push(line);
    }
  }
  const content = lines.join("\n") + (lines.length ? "\n" : "");
  await writeFile(state.authorizedKeysPath, content, { mode: 0o600 });
}

export async function ensureSelfHostTunnelInfo(opts: {
  host_id: string;
}): Promise<{
  tunnel_port: number;
  ssh_tunnel_port: number;
  tunnel_public_key: string;
  tunnel_private_key: string;
}> {
  const hostId = opts.host_id;
  const { rows } = await pool().query<{ metadata: any }>(
    `SELECT metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL`,
    [hostId],
  );
  const metadata = rows[0]?.metadata ?? {};
  const selfHost = { ...(metadata.self_host ?? {}) };
  let updated = false;
  if (!selfHost.tunnel_port) {
    selfHost.tunnel_port = await getPort();
    updated = true;
  }
  if (!selfHost.ssh_tunnel_port) {
    selfHost.ssh_tunnel_port = await getPort();
    updated = true;
  }
  if (!selfHost.tunnel_public_key || !selfHost.tunnel_private_key) {
    const seed = randomBytes(32);
    const keypair = ssh(seed, `launchpad-tunnel-${hostId}`);
    selfHost.tunnel_public_key = keypair.publicKey.trim();
    selfHost.tunnel_private_key = keypair.privateKey;
    selfHost.tunnel_key_created_at = new Date().toISOString();
    updated = true;
  }
  if (updated) {
    selfHost.tunnel_port_updated_at = new Date().toISOString();
    const nextMetadata = { ...metadata, self_host: selfHost };
    await pool().query(
      `UPDATE project_hosts
         SET metadata=$2, updated=NOW()
       WHERE id=$1 AND deleted IS NULL`,
      [hostId, nextMetadata],
    );
  }
  await refreshLaunchpadOnPremAuthorizedKeys();
  return {
    tunnel_port: Number(selfHost.tunnel_port),
    ssh_tunnel_port: Number(selfHost.ssh_tunnel_port),
    tunnel_public_key: selfHost.tunnel_public_key,
    tunnel_private_key: selfHost.tunnel_private_key,
  };
}

export async function maybeStartLaunchpadOnPremServices(): Promise<void> {
  const state = await startSshd();
  if (state) {
    await refreshLaunchpadOnPremAuthorizedKeys();
  }
}

export function stopLaunchpadOnPremServices(): void {
  if (!sshdState) {
    return;
  }
  const { child } = sshdState;
  if (child.exitCode == null) {
    child.kill("SIGTERM");
  }
  sshdState = null;
}
