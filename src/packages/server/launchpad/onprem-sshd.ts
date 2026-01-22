import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import getPort from "@cocalc/backend/get-port";
import { secrets } from "@cocalc/backend/data";
import { executeCode } from "@cocalc/backend/execute-code";
import {
  install,
  sftpServer as bundledSftpServer,
  ssh as bundledSsh,
  sshKeygen as bundledSshKeygen,
  sshd as bundledSshd,
} from "@cocalc/backend/sandbox/install";
import {
  getLaunchpadMode,
  getLaunchpadLocalConfig,
  isLaunchpadProduct,
} from "./mode";

const logger = getLogger("launchpad:local:sshd");

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

type SshBins = {
  sshdPath: string;
  sshKeygenPath: string;
  sftpServerPath: string;
  sshBinaryPath: string;
  source: "system" | "bundled";
};

async function resolveSshBins(): Promise<SshBins> {
  const systemSshd = "/usr/sbin/sshd";
  const systemSshKeygen = "/usr/bin/ssh-keygen";
  const systemSftpCandidates = [
    "/usr/lib/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
  ];
  let systemSftpServer: string | undefined;
  for (const candidate of systemSftpCandidates) {
    if (await fileExists(candidate)) {
      systemSftpServer = candidate;
      break;
    }
  }
  const systemSsh = "/usr/bin/ssh";
  const systemReady =
    (await fileExists(systemSshd)) &&
    (await fileExists(systemSshKeygen)) &&
    !!systemSftpServer;
  if (systemReady) {
    return {
      sshdPath: systemSshd,
      sshKeygenPath: systemSshKeygen,
      sftpServerPath: systemSftpServer as string,
      sshBinaryPath: (await fileExists(systemSsh)) ? systemSsh : systemSshd,
      source: "system",
    };
  }
  await install("ssh");
  return {
    sshdPath: bundledSshd,
    sshKeygenPath: bundledSshKeygen,
    sftpServerPath: bundledSftpServer,
    sshBinaryPath: bundledSsh,
    source: "bundled",
  };
}

async function ensureHostKey(
  hostKeyPath: string,
  sshKeygenPath: string,
  sshBinaryPath: string,
): Promise<void> {
  if (await fileExists(hostKeyPath)) {
    return;
  }
  await mkdir(dirname(hostKeyPath), { recursive: true });
  await executeCode({
    command: sshKeygenPath,
    args: ["-t", "ed25519", "-N", "", "-f", hostKeyPath],
    env: {
      ...process.env,
      PATH: `${dirname(sshBinaryPath)}:${process.env.PATH ?? ""}`,
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
  sftpServerPath: string;
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
    `Subsystem sftp ${opts.sftpServerPath}`,
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
  const mode = await getLaunchpadMode();
  const localMode = mode === "local";
  if (!localMode) {
    return null;
  }
  if (!isLaunchpadProduct()) {
    logger.warn("starting local network sshd outside launchpad product", {
      product: process.env.COCALC_PRODUCT,
    });
  }
  if (sshdState) {
    return sshdState;
  }
  const config = getLaunchpadLocalConfig("local");
  if (!config.sshd_port) {
    logger.warn("local sshd disabled (missing COCALC_SSHD_PORT)");
    return null;
  }
  const sshBins = await resolveSshBins();
  logger.info("local sshd binary selection", {
    source: sshBins.source,
    sshd: sshBins.sshdPath,
    sftp: sshBins.sftpServerPath,
  });
  const sshUser = resolveSshUser();
  const sshdDir = join(secrets, "launchpad-sshd");
  const configPath = join(sshdDir, "sshd_config");
  const hostKeyPath = join(sshdDir, "ssh_host_ed25519_key");
  const authorizedKeysPath = join(sshdDir, "authorized_keys");
  const pidPath = join(sshdDir, "sshd.pid");
  await mkdir(sshdDir, { recursive: true });
  await ensureHostKey(hostKeyPath, sshBins.sshKeygenPath, sshBins.sshBinaryPath);
  await ensureAuthorizedKeysPath(authorizedKeysPath);
  await writeSshdConfig({
    configPath,
    hostKeyPath,
    authorizedKeysPath,
    pidPath,
    sshUser,
    sshdPort: config.sshd_port,
    sftpServerPath: sshBins.sftpServerPath,
  });

  const env = {
    ...process.env,
    PATH: `${dirname(sshBins.sshBinaryPath)}:${process.env.PATH ?? ""}`,
  };
  const args = ["-D", "-e", "-f", configPath];
  logger.info("starting local sshd", {
    port: config.sshd_port,
    sshUser,
    configPath,
  });
  const child = spawn(sshBins.sshdPath, args, { env });
  child.stderr.on("data", (chunk) => {
    logger.debug(chunk.toString());
  });
  child.stdout.on("data", (chunk) => {
    logger.debug(chunk.toString());
  });
  child.on("exit", (code, signal) => {
    logger.error("local sshd exited", { code, signal });
  });
  sshdState = { sshdDir, authorizedKeysPath, child };
  return sshdState;
}

type TunnelEntry = {
  host_id: string;
  http_tunnel_port: number | null;
  ssh_tunnel_port: number | null;
  tunnel_public_key: string | null;
};

type SftpEntry = {
  host_id: string;
  sftp_public_key: string | null;
};

function formatAuthorizedKey(entry: TunnelEntry): string | null {
  if (!entry.tunnel_public_key) {
    return null;
  }
  const listens: string[] = [];
  if (entry.http_tunnel_port) {
    listens.push(`permitlisten="0.0.0.0:${entry.http_tunnel_port}"`);
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

function formatSftpAuthorizedKey(
  entry: SftpEntry,
  sftpRoot?: string,
): string | null {
  if (!entry.sftp_public_key || !sftpRoot) {
    return null;
  }
  const options = [
    `command="internal-sftp -d ${sftpRoot}"`,
    "no-agent-forwarding",
    "no-X11-forwarding",
    "no-pty",
    "no-port-forwarding",
  ];
  return `${options.join(",")} ${entry.sftp_public_key} host-${entry.host_id}-sftp`;
}

export async function refreshLaunchpadOnPremAuthorizedKeys(): Promise<void> {
  const state = await startSshd();
  if (!state) {
    return;
  }
  const config = getLaunchpadLocalConfig("local");
  const sftpRoot = config.sftp_root;
  if (!sftpRoot) {
    logger.warn("local sftp disabled (missing COCALC_SFTP_ROOT)");
  }
  if (sftpRoot) {
    await mkdir(sftpRoot, { recursive: true });
  }
  const { rows } = await pool().query<{
    host_id: string;
    http_tunnel_port: string | null;
    ssh_tunnel_port: string | null;
    tunnel_public_key: string | null;
    sftp_public_key: string | null;
  }>(
    `
    SELECT id AS host_id,
           COALESCE(metadata->'self_host'->>'http_tunnel_port',
                    metadata->'self_host'->>'tunnel_port') AS http_tunnel_port,
           metadata->'self_host'->>'ssh_tunnel_port' AS ssh_tunnel_port,
           metadata->'self_host'->>'tunnel_public_key' AS tunnel_public_key,
           metadata->'self_host'->>'sftp_public_key' AS sftp_public_key
      FROM project_hosts
     WHERE deleted IS NULL
       AND metadata ? 'self_host'
    `,
  );
  const lines: string[] = [];
  for (const row of rows) {
    const entry: TunnelEntry = {
      host_id: row.host_id,
      http_tunnel_port: row.http_tunnel_port
        ? Number(row.http_tunnel_port)
        : null,
      ssh_tunnel_port: row.ssh_tunnel_port ? Number(row.ssh_tunnel_port) : null,
      tunnel_public_key: row.tunnel_public_key,
    };
    const line = formatAuthorizedKey(entry);
    if (line) {
      lines.push(line);
    }
    const sftpLine = formatSftpAuthorizedKey(
      { host_id: row.host_id, sftp_public_key: row.sftp_public_key },
      sftpRoot,
    );
    if (sftpLine) {
      lines.push(sftpLine);
    }
  }
  const content = lines.join("\n") + (lines.length ? "\n" : "");
  await writeFile(state.authorizedKeysPath, content, { mode: 0o600 });
}

export async function registerSelfHostSftpKey(opts: {
  host_id: string;
  public_key: string;
}): Promise<{ sftp_public_key: string }> {
  const hostId = opts.host_id;
  if (!opts.public_key) {
    throw new Error("public_key is required");
  }
  const { rows } = await pool().query<{ metadata: any }>(
    `SELECT metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL`,
    [hostId],
  );
  if (!rows.length) {
    throw new Error("host not found");
  }
  const metadata = rows[0]?.metadata ?? {};
  const selfHost = { ...(metadata.self_host ?? {}) };
  let updated = false;
  if (selfHost.sftp_public_key !== opts.public_key) {
    selfHost.sftp_public_key = opts.public_key.trim();
    selfHost.sftp_key_updated_at = new Date().toISOString();
    updated = true;
  }
  if (updated) {
    const nextMetadata = { ...metadata, self_host: selfHost };
    await pool().query(
      `UPDATE project_hosts
         SET metadata=$2, updated=NOW()
       WHERE id=$1 AND deleted IS NULL`,
      [hostId, nextMetadata],
    );
  }
  await refreshLaunchpadOnPremAuthorizedKeys();
  return { sftp_public_key: selfHost.sftp_public_key };
}

export async function registerSelfHostTunnelKey(opts: {
  host_id: string;
  public_key: string;
}): Promise<{
  http_tunnel_port: number;
  ssh_tunnel_port: number;
  tunnel_public_key: string;
}> {
  const hostId = opts.host_id;
  if (!opts.public_key) {
    throw new Error("public_key is required");
  }
  const { rows } = await pool().query<{ metadata: any }>(
    `SELECT metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL`,
    [hostId],
  );
  if (!rows.length) {
    throw new Error("host not found");
  }
  const metadata = rows[0]?.metadata ?? {};
  const selfHost = { ...(metadata.self_host ?? {}) };
  let updated = false;
  if (!selfHost.http_tunnel_port) {
    selfHost.http_tunnel_port = await getPort();
    updated = true;
  }
  if (!selfHost.ssh_tunnel_port) {
    selfHost.ssh_tunnel_port = await getPort();
    updated = true;
  }
  if (selfHost.tunnel_public_key !== opts.public_key) {
    selfHost.tunnel_public_key = opts.public_key.trim();
    selfHost.tunnel_key_updated_at = new Date().toISOString();
    updated = true;
  }
  if (updated) {
    selfHost.http_tunnel_port_updated_at = new Date().toISOString();
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
    http_tunnel_port: Number(selfHost.http_tunnel_port),
    ssh_tunnel_port: Number(selfHost.ssh_tunnel_port),
    tunnel_public_key: selfHost.tunnel_public_key,
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
