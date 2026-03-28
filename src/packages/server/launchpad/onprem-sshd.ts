import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, unlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import getPort from "@cocalc/backend/get-port";
import { secrets } from "@cocalc/backend/data";
import { executeCode } from "@cocalc/backend/execute-code";
import { restServer } from "@cocalc/backend/sandbox/install";
import { which } from "@cocalc/backend/which";
import ssh from "micro-key-producer/ssh.js";
import { getLaunchpadLocalConfig, isLaunchpadProduct } from "./mode";
import {
  ensureCloudflareTunnelForHub,
  hasHubCloudflareTunnel,
  type CloudflareTunnel,
} from "@cocalc/server/cloud/cloudflare-tunnel";
import { ensurePublicViewerDns } from "@cocalc/server/cloud/dns";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { resolvePublicViewerDns } from "@cocalc/util/public-viewer-origin";

const logger = getLogger("launchpad:local:sshd");
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type SshdState = {
  sshdDir: string;
  authorizedKeysPath: string;
  child: ChildProcessWithoutNullStreams;
  refreshTimer?: NodeJS.Timeout;
};

type RestServerState = {
  restPort: number;
  repoRoot: string;
  htpasswdPath: string;
  pid: number;
  child?: ChildProcessWithoutNullStreams;
};

let sshdState: SshdState | null = null;
let restServerState: RestServerState | null = null;
type CloudflaredState = {
  tunnel: CloudflareTunnel;
  configPath: string;
  credentialsPath: string;
  origin: string;
  pid: number;
  pidFile: string;
  error?: string;
};
let cloudflaredState: CloudflaredState | null = null;
let cloudflaredLastError: string | null = null;
const REST_USER = "cocalc";

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

async function hasLocalSelfHostHosts(): Promise<boolean> {
  const { rows } = await pool().query(
    `
      SELECT 1
      FROM project_hosts
      WHERE deleted IS NULL
        AND (metadata->'machine'->>'cloud') = 'self-host'
        AND COALESCE(metadata->'machine'->'metadata'->>'self_host_mode','local') = 'local'
      LIMIT 1
    `,
  );
  return rows.length > 0;
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
  if (!systemReady) {
    throw new Error(
      "system OpenSSH binaries not found; install openssh-server",
    );
  }
  return {
    sshdPath: systemSshd,
    sshKeygenPath: systemSshKeygen,
    sftpServerPath: systemSftpServer as string,
    sshBinaryPath: (await fileExists(systemSsh)) ? systemSsh : systemSshd,
    source: "system",
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
    "GSSAPIAuthentication no",
    "GSSAPIKeyExchange no",
    "KerberosAuthentication no",
    `PermitRootLogin ${permitRootLogin}`,
    "PermitTTY no",
    "PermitUserEnvironment no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "AllowTcpForwarding yes",
    "GatewayPorts clientspecified",
    `Subsystem sftp ${opts.sftpServerPath}`,
    "StrictModes no",
    "UseDNS no",
    "UsePAM no",
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
  if (!(await hasLocalSelfHostHosts())) {
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
  await ensureHostKey(
    hostKeyPath,
    sshBins.sshKeygenPath,
    sshBins.sshBinaryPath,
  );
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
    if (sshdState?.child === child) {
      if (sshdState.refreshTimer) {
        clearInterval(sshdState.refreshTimer);
      }
      sshdState = null;
    }
  });
  const refreshTimer = setInterval(() => {
    refreshLaunchpadOnPremAuthorizedKeys().catch((err) => {
      logger.warn("failed to refresh authorized keys", { err });
    });
  }, REFRESH_INTERVAL_MS);
  sshdState = { sshdDir, authorizedKeysPath, child, refreshTimer };
  return sshdState;
}

type TunnelEntry = {
  host_id: string;
  http_tunnel_port: number | null;
  ssh_tunnel_port: number | null;
  tunnel_public_key: string | null;
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

function normalizeSshKey(key?: string | null): string {
  if (!key) return "";
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return "";
  return `${parts[0]} ${parts[1]}`;
}

function derivePublicKeyFromSeed(seedBase64: string): string | null {
  try {
    const seed = Buffer.from(seedBase64, "base64url");
    if (seed.length !== 32) return null;
    const keypair = ssh(seed, "cocalc-pair");
    return normalizeSshKey(keypair.publicKey);
  } catch {
    return null;
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPairCommand(): string {
  const envKeys = [
    "COCALC_DB",
    "COCALC_PGLITE_DATA_DIR",
    "COCALC_DATA_DIR",
    "DATA",
    "COCALC_BASE_PORT",
    "COCALC_HTTP_PORT",
    "PORT",
    "COCALC_SELF_HOST_PAIR_URL",
    "PGHOST",
    "PGUSER",
    "PGDATABASE",
    "PGPORT",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
  ];
  const envParts = envKeys
    .map((key) => {
      const value = process.env[key];
      if (!value) return "";
      return `${key}=${shellEscape(value)}`;
    })
    .filter(Boolean);
  const base = `${process.execPath} ${join(__dirname, "ssh-pair.js")}`;
  if (!envParts.length) return base;
  return `env ${envParts.join(" ")} ${base}`;
}

function formatPairingKey(command: string, key: string): string {
  const options = [
    `command="${command.replace(/"/g, '\\"')}"`,
    "no-agent-forwarding",
    "no-X11-forwarding",
    "no-pty",
    "no-port-forwarding",
  ];
  return `${options.join(",")} ${key}`;
}

function formatForwardKey(key: string, httpPort: number): string {
  const options = [
    `permitopen="127.0.0.1:${httpPort}"`,
    "no-agent-forwarding",
    "no-X11-forwarding",
    "no-pty",
  ];
  return `${options.join(",")} ${key}`;
}

export async function refreshLaunchpadOnPremAuthorizedKeys(): Promise<void> {
  const state = await startSshd();
  if (!state) {
    return;
  }
  const config = getLaunchpadLocalConfig("local");
  const { rows } = await pool().query<{
    host_id: string;
    http_tunnel_port: string | null;
    ssh_tunnel_port: string | null;
    tunnel_public_key: string | null;
  }>(
    `
    SELECT id AS host_id,
           COALESCE(metadata->'self_host'->>'http_tunnel_port',
                    metadata->'self_host'->>'tunnel_port') AS http_tunnel_port,
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
  }
  const commandPath = buildPairCommand();
  const { rows: pairingRows } = await pool().query<{
    pairing_key_seed: string | null;
  }>(
    `
    SELECT pairing_key_seed
      FROM self_host_connector_tokens
     WHERE purpose='pairing'
       AND revoked IS NOT TRUE
       AND expires > NOW()
       AND pairing_key_seed IS NOT NULL
    `,
  );
  for (const row of pairingRows) {
    if (!row.pairing_key_seed) continue;
    const key = derivePublicKeyFromSeed(row.pairing_key_seed);
    if (!key) continue;
    lines.push(formatPairingKey(commandPath, key));
  }

  const httpPort = config.http_port ?? 9001;
  const { rows: connectorRows } = await pool().query<{
    ssh_key_seed: string | null;
  }>(
    `
    SELECT ssh_key_seed
      FROM self_host_connectors
     WHERE revoked IS NOT TRUE
       AND ssh_key_seed IS NOT NULL
       AND token_hash IS NOT NULL
    `,
  );
  for (const row of connectorRows) {
    if (!row.ssh_key_seed) continue;
    const key = derivePublicKeyFromSeed(row.ssh_key_seed);
    if (!key) continue;
    lines.push(formatForwardKey(key, httpPort));
  }

  const { rows: bootstrapRows } = await pool().query<{
    ssh_key_seed: string | null;
  }>(
    `
    SELECT ssh_key_seed
      FROM project_host_bootstrap_tokens
     WHERE purpose='bootstrap'
       AND revoked IS NOT TRUE
       AND expires > NOW()
       AND ssh_key_seed IS NOT NULL
    `,
  );
  for (const row of bootstrapRows) {
    if (!row.ssh_key_seed) continue;
    const key = derivePublicKeyFromSeed(row.ssh_key_seed);
    if (!key) continue;
    lines.push(formatForwardKey(key, httpPort));
  }
  const content = lines.join("\n") + (lines.length ? "\n" : "");
  await writeFile(state.authorizedKeysPath, content, { mode: 0o600 });
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

async function startRestServer(): Promise<RestServerState | null> {
  if (!(await hasLocalSelfHostHosts())) {
    return null;
  }
  if (restServerState) {
    return restServerState;
  }
  const config = getLaunchpadLocalConfig("local");
  if (!config.rest_port) {
    logger.warn("rest-server disabled (missing COCALC_LAUNCHPAD_REST_PORT)");
    return null;
  }
  if (!config.backup_root) {
    logger.warn("rest-server disabled (missing backup root)");
    return null;
  }
  const repoRoot = join(config.backup_root, "rustic");
  await mkdir(repoRoot, { recursive: true });
  if (!(await fileExists(restServer))) {
    logger.warn("rest-server binary not found", { path: restServer });
    return null;
  }
  const auth = await ensureRestAuth();
  if (!auth?.htpasswdPath) {
    logger.warn("rest-server auth initialization failed; not starting server");
    return null;
  }
  const stateFile = restServerStateFilePath();
  const stored = await loadRestServerStateFile(stateFile);
  if (
    stored?.pid &&
    (await isManagedRestServerProcess({
      pid: stored.pid,
      repoRoot,
      htpasswdPath: auth.htpasswdPath,
      restPort: stored.rest_port,
    }))
  ) {
    restServerState = {
      restPort: stored.rest_port,
      repoRoot,
      htpasswdPath: auth.htpasswdPath,
      pid: stored.pid,
    };
    await killDuplicateRestServers({
      repoRoot,
      htpasswdPath: auth.htpasswdPath,
      keepPid: stored.pid,
    });
    logger.info("reusing existing rest-server from state file", {
      rest_port: stored.rest_port,
      pid: stored.pid,
      repoRoot,
    });
    return restServerState;
  }
  const preferredPort = config.rest_port;
  const existingPreferredPid = await listeningPidOnPort(preferredPort);
  if (
    existingPreferredPid &&
    (await isManagedRestServerProcess({
      pid: existingPreferredPid,
      repoRoot,
      htpasswdPath: auth.htpasswdPath,
      restPort: preferredPort,
    }))
  ) {
    await writeRestServerStateFile(stateFile, {
      pid: existingPreferredPid,
      rest_port: preferredPort,
      repo_root: repoRoot,
      htpasswd_path: auth.htpasswdPath,
    });
    restServerState = {
      restPort: preferredPort,
      repoRoot,
      htpasswdPath: auth.htpasswdPath,
      pid: existingPreferredPid,
    };
    await killDuplicateRestServers({
      repoRoot,
      htpasswdPath: auth.htpasswdPath,
      keepPid: existingPreferredPid,
    });
    logger.info("reusing existing rest-server on preferred port", {
      rest_port: preferredPort,
      pid: existingPreferredPid,
      repoRoot,
    });
    return restServerState;
  }
  const restPort = (await isPortAvailable(preferredPort))
    ? preferredPort
    : await getPort();
  const listen = `127.0.0.1:${restPort}`;
  const args = [
    "--path",
    repoRoot,
    "--listen",
    listen,
    "--htpasswd-file",
    auth.htpasswdPath,
  ];
  logger.info("starting rest-server", { listen, repoRoot });
  const child = spawn(restServer, args, { env: process.env });
  child.stderr.on("data", (chunk) => {
    logger.debug(chunk.toString());
  });
  child.stdout.on("data", (chunk) => {
    logger.debug(chunk.toString());
  });
  child.on("exit", (code, signal) => {
    logger.error("rest-server exited", { code, signal });
    restServerState = null;
    void clearRestServerStateFile(stateFile);
  });
  if (child.pid) {
    child.unref();
    await writeRestServerStateFile(stateFile, {
      pid: child.pid,
      rest_port: restPort,
      repo_root: repoRoot,
      htpasswd_path: auth.htpasswdPath,
    });
  }
  restServerState = {
    restPort,
    repoRoot,
    htpasswdPath: auth.htpasswdPath,
    pid: child.pid ?? 0,
    child,
  };
  await killDuplicateRestServers({
    repoRoot,
    htpasswdPath: auth.htpasswdPath,
    keepPid: child.pid ?? undefined,
  });
  return restServerState;
}

export function getLaunchpadRestPort(): number | undefined {
  if (restServerState?.restPort) return restServerState.restPort;
  const config = getLaunchpadLocalConfig("local");
  return config.rest_port;
}

export async function getLaunchpadRestAuth(): Promise<{
  user: string;
  password: string;
} | null> {
  const auth = await ensureRestAuth();
  if (!auth) return null;
  return { user: auth.user, password: auth.password };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function ensureRestAuth(): Promise<{
  user: string;
  password: string;
  htpasswdPath: string;
} | null> {
  try {
    const authDir = join(secrets, "launchpad-rest");
    await mkdir(authDir, { recursive: true });
    const authPath = join(authDir, "auth.json");
    const htpasswdPath = join(authDir, "htpasswd");
    let auth: { user: string; password: string } | null = null;
    if (await fileExists(authPath)) {
      try {
        const raw = await readFile(authPath, "utf8");
        const parsed = JSON.parse(raw) as {
          user?: string;
          password?: string;
        };
        if (parsed.user && parsed.password) {
          auth = { user: parsed.user, password: parsed.password };
        }
      } catch {
        auth = null;
      }
    }
    if (!auth) {
      auth = {
        user: REST_USER,
        password: randomBytes(24).toString("base64url"),
      };
      await writeFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
      await chmod(authPath, 0o600);
    }
    const htpasswd = `${auth.user}:{SHA}${createHash("sha1")
      .update(auth.password)
      .digest("base64")}\n`;
    await writeFile(htpasswdPath, htpasswd, { mode: 0o600 });
    await chmod(htpasswdPath, 0o600);
    return { ...auth, htpasswdPath };
  } catch (err) {
    logger.warn("failed to initialize rest-server auth", { err: String(err) });
    return null;
  }
}

async function resolveCloudflaredBinary(): Promise<string | null> {
  return await which("cloudflared");
}

function cloudflaredStateDir(): string {
  const configured = clean(process.env.COCALC_LAUNCHPAD_CLOUDFLARED_STATE_DIR);
  return configured ?? join(secrets, "launchpad-cloudflare");
}

function cloudflaredPidFilePath(): string {
  const configured = clean(process.env.COCALC_LAUNCHPAD_CLOUDFLARED_PID_FILE);
  return configured ?? join(cloudflaredStateDir(), "cloudflared.pid");
}

function restServerStateFilePath(): string {
  const configured = clean(process.env.COCALC_LAUNCHPAD_REST_STATE_FILE);
  return configured ?? join(secrets, "launchpad-rest", "rest-server.json");
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

function readPidFileSync(path: string): number | undefined {
  try {
    return parsePid(readFileSync(path, "utf8"));
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

type StoredRestServerState = {
  pid: number;
  rest_port: number;
  repo_root: string;
  htpasswd_path: string;
};

async function loadRestServerStateFile(
  path: string,
): Promise<StoredRestServerState | undefined> {
  if (!(await fileExists(path))) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as StoredRestServerState;
  } catch {
    return undefined;
  }
}

function loadRestServerStateFileSync(
  path: string,
): StoredRestServerState | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredRestServerState;
  } catch {
    return undefined;
  }
}

async function writeRestServerStateFile(
  path: string,
  state: StoredRestServerState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function clearRestServerStateFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

function clearRestServerStateFileSync(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

async function readProcessArgs(pid: number): Promise<string[]> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function restServerArgsMatch(opts: {
  args: string[];
  repoRoot: string;
  htpasswdPath: string;
  restPort?: number;
}): boolean {
  const { args, repoRoot, htpasswdPath, restPort } = opts;
  if (!args.length) return false;
  const joined = args.join(" ");
  if (!joined.includes("rest-server")) return false;
  const pathIndex = args.indexOf("--path");
  if (pathIndex < 0 || args[pathIndex + 1] !== repoRoot) return false;
  const authIndex = args.indexOf("--htpasswd-file");
  if (authIndex < 0 || args[authIndex + 1] !== htpasswdPath) return false;
  if (restPort != null) {
    const listenIndex = args.indexOf("--listen");
    if (listenIndex < 0 || args[listenIndex + 1] !== `127.0.0.1:${restPort}`) {
      return false;
    }
  }
  return true;
}

async function isManagedRestServerProcess(opts: {
  pid: number;
  repoRoot: string;
  htpasswdPath: string;
  restPort?: number;
}): Promise<boolean> {
  if (!isPidRunning(opts.pid)) return false;
  return restServerArgsMatch({
    args: await readProcessArgs(opts.pid),
    repoRoot: opts.repoRoot,
    htpasswdPath: opts.htpasswdPath,
    restPort: opts.restPort,
  });
}

async function listeningPidOnPort(port: number): Promise<number | undefined> {
  try {
    const { stdout, exit_code } = await executeCode({
      command: "lsof",
      args: ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      timeout: 10,
    });
    if (exit_code !== 0) return undefined;
    return parsePid(`${stdout}`.trim().split(/\s+/)[0]);
  } catch {
    return undefined;
  }
}

async function killDuplicateRestServers(opts: {
  repoRoot: string;
  htpasswdPath: string;
  keepPid?: number;
}): Promise<void> {
  try {
    const { stdout, exit_code } = await executeCode({
      command: "pgrep",
      args: ["-af", "rest-server"],
      timeout: 10,
    });
    if (exit_code !== 0 && `${stdout ?? ""}`.trim() === "") {
      return;
    }
    const pids = `${stdout ?? ""}`
      .split(/\r?\n/)
      .map((line) => parsePid(line.trim().split(/\s+/, 1)[0]))
      .filter((pid): pid is number => !!pid);
    for (const pid of pids) {
      if (opts.keepPid && pid === opts.keepPid) continue;
      if (
        !(await isManagedRestServerProcess({
          pid,
          repoRoot: opts.repoRoot,
          htpasswdPath: opts.htpasswdPath,
        }))
      ) {
        continue;
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore cleanup failure
  }
}

function resolveCloudflaredOrigin(): { origin: string; noTLSVerify: boolean } {
  const config = getLaunchpadLocalConfig("local");
  const httpPort = config.http_port;
  const port = httpPort ?? 9001;
  return { origin: `http://127.0.0.1:${port}`, noTLSVerify: false };
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
}): Promise<boolean> {
  const yamlString = (value: string): string => JSON.stringify(value);
  const ingress: string[] = [
    "ingress:",
    `  - hostname: ${yamlString(opts.tunnel.hostname)}`,
    `    service: ${yamlString(opts.origin)}`,
  ];
  if (opts.noTLSVerify) {
    ingress.push("    originRequest:");
    ingress.push("      noTLSVerify: true");
  }
  if (
    opts.publicViewerHostname &&
    opts.publicViewerHostname !== opts.tunnel.hostname
  ) {
    ingress.push(`  - hostname: ${yamlString(opts.publicViewerHostname)}`);
    ingress.push(`    service: ${yamlString(opts.origin)}`);
    if (opts.noTLSVerify) {
      ingress.push("    originRequest:");
      ingress.push("      noTLSVerify: true");
    }
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

async function startCloudflared(): Promise<CloudflaredState | null> {
  cloudflaredLastError = null;
  if (!isLaunchpadProduct()) {
    logger.info("cloudflare tunnel not started (product is not launchpad)");
    return null;
  }
  const settings = await getServerSettings();
  const rawMode = clean(settings.cloudflare_mode);
  const normalizedMode = normalizeCloudflareMode(settings.cloudflare_mode);
  const tunnelEnabled = isEnabled(
    settings.project_hosts_cloudflare_tunnel_enabled,
  );
  if (!cloudflareSelfMode(settings)) {
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
  if (!clean(settings.project_hosts_dns)) {
    missing.push("Project Hosts: Domain name");
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
    cloudflaredLastError =
      "cloudflared binary not found; install from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
    logger.warn(cloudflaredLastError);
    logger.info("cloudflare tunnel not started (cloudflared missing)");
    return null;
  }

  const cfDir = cloudflaredStateDir();
  await mkdir(cfDir, { recursive: true });
  const tunnelPath = join(cfDir, "tunnel.json");
  const credentialsPath = join(cfDir, "credentials.json");
  const configPath = join(cfDir, "config.yml");
  const pidPath = cloudflaredPidFilePath();

  let tunnel: CloudflareTunnel | undefined;
  let tunnelStateChanged = false;
  try {
    const existing = await loadCloudflaredStateFile(tunnelPath);
    tunnel = await ensureCloudflareTunnelForHub({ existing });
    if (!tunnel) {
      cloudflaredLastError =
        "Cloudflare tunnel configuration missing or incomplete.";
      logger.warn(cloudflaredLastError);
      return null;
    }
    const next = JSON.stringify(tunnel, null, 2);
    try {
      const current = await readFile(tunnelPath, "utf8");
      if (current !== next) {
        await writeFile(tunnelPath, next, { mode: 0o600 });
        await chmod(tunnelPath, 0o600);
        tunnelStateChanged = true;
      }
    } catch {
      await writeFile(tunnelPath, next, { mode: 0o600 });
      await chmod(tunnelPath, 0o600);
      tunnelStateChanged = true;
    }
  } catch (err) {
    cloudflaredLastError = String(err);
    logger.warn("cloudflare tunnel ensure failed", { err });
    return null;
  }

  const { origin, noTLSVerify } = resolveCloudflaredOrigin();
  const publicViewerHostname = normalizeHostname(
    resolvePublicViewerDns({
      publicViewerDns: settings.public_viewer_dns,
      dns: settings.dns,
    }) ?? "",
  );
  const credentialsChanged = await writeCloudflaredCredentials(
    credentialsPath,
    tunnel,
  );
  const configChanged = await writeCloudflaredConfig({
    path: configPath,
    credentialsPath,
    tunnel,
    origin,
    noTLSVerify,
    publicViewerHostname,
  });
  const shouldRestartRunning =
    tunnelStateChanged || credentialsChanged || configChanged;

  const persistedPid = await readPidFile(pidPath);
  if (isPidRunning(persistedPid)) {
    if (shouldRestartRunning) {
      logger.info("restarting cloudflared to apply updated config", {
        hostname: tunnel.hostname,
        pid: persistedPid,
      });
      try {
        process.kill(persistedPid as number, "SIGTERM");
      } catch {
        // ignore and fall through to a fresh start
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (isPidRunning(persistedPid)) {
        try {
          process.kill(persistedPid as number, "SIGKILL");
        } catch {
          // ignore
        }
      }
      await clearPidFile(pidPath);
      if (cloudflaredState?.pid === persistedPid) {
        cloudflaredState = null;
      }
    } else {
      logger.info("cloudflare tunnel already running", {
        hostname: tunnel.hostname,
        pid: persistedPid,
      });
      cloudflaredState = {
        tunnel,
        configPath,
        credentialsPath,
        origin,
        pid: persistedPid as number,
        pidFile: pidPath,
      };
      return cloudflaredState;
    }
  }
  if (persistedPid) {
    await clearPidFile(pidPath);
  }
  const args = ["tunnel", "--no-autoupdate", "--config", configPath, "run"];
  logger.info("starting cloudflared", { hostname: tunnel.hostname, origin });
  const child = spawn(cloudflaredBin, args, {
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  if (!(child.pid && Number.isInteger(child.pid) && child.pid > 0)) {
    cloudflaredLastError = "failed to start cloudflared (missing child pid)";
    logger.error(cloudflaredLastError);
    return null;
  }
  child.unref();
  await writePidFile(pidPath, child.pid);
  cloudflaredState = {
    tunnel,
    configPath,
    credentialsPath,
    origin,
    pid: child.pid,
    pidFile: pidPath,
  };
  logger.info("cloudflare tunnel started", {
    hostname: tunnel.hostname,
    pid: child.pid,
  });
  console.log(
    `Cloudflare tunnel is live: https://${tunnel.hostname} (public access enabled)`,
  );
  return cloudflaredState;
}

export async function getLaunchpadCloudflaredStatus(): Promise<{
  enabled: boolean;
  running: boolean;
  hostname?: string;
  error?: string | null;
}> {
  const settings = await getServerSettings();
  const enabled = cloudflareSelfMode(settings);
  const pidPath = cloudflaredPidFilePath();
  const pid = cloudflaredState?.pid ?? (await readPidFile(pidPath));
  const running = isPidRunning(pid);
  if (cloudflaredState && !running) {
    cloudflaredState = null;
    await clearPidFile(pidPath);
  }
  let hostname = cloudflaredState?.tunnel?.hostname;
  if (!hostname) {
    const tunnel = await loadCloudflaredStateFile(
      join(cloudflaredStateDir(), "tunnel.json"),
    );
    hostname = tunnel?.hostname;
  }
  const error =
    cloudflaredLastError ??
    (enabled && !running ? "Cloudflare tunnel is not running." : null);
  return { enabled, running, hostname, error };
}

export async function maybeStartLaunchpadOnPremServices(): Promise<void> {
  const state = await startSshd();
  await startRestServer();
  const tunnel = await startCloudflared();
  try {
    const publicViewerDns = await ensurePublicViewerDns();
    if (publicViewerDns) {
      logger.info("public viewer dns ensured", publicViewerDns);
    }
  } catch (err) {
    logger.warn("public viewer dns ensure failed", { err: `${err}` });
  }
  if (!tunnel) {
    const status = await getLaunchpadCloudflaredStatus();
    if (status.enabled) {
      logger.warn("cloudflare tunnel not running", {
        error: status.error ?? undefined,
      });
    } else {
      logger.info("cloudflare tunnel disabled");
    }
  }
  if (state) {
    await refreshLaunchpadOnPremAuthorizedKeys();
  }
}

export function stopLaunchpadOnPremServices(): void {
  if (sshdState) {
    const { child, refreshTimer } = sshdState;
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    if (child.exitCode == null) {
      child.kill("SIGTERM");
    }
    sshdState = null;
  }
  if (restServerState) {
    const child = restServerState.child;
    if (child && child.exitCode == null) {
      child.kill("SIGTERM");
    } else if (isPidRunning(restServerState.pid)) {
      try {
        process.kill(restServerState.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    clearRestServerStateFileSync(restServerStateFilePath());
    restServerState = null;
  } else {
    const statePath = restServerStateFilePath();
    const stored = loadRestServerStateFileSync(statePath);
    if (isPidRunning(stored?.pid)) {
      try {
        process.kill(stored!.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    clearRestServerStateFileSync(statePath);
  }
  if (cloudflaredState) {
    if (isPidRunning(cloudflaredState.pid)) {
      try {
        process.kill(cloudflaredState.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    clearPidFileSync(cloudflaredState.pidFile);
    cloudflaredState = null;
    return;
  }

  const pidPath = cloudflaredPidFilePath();
  const pid = readPidFileSync(pidPath);
  if (isPidRunning(pid)) {
    try {
      process.kill(pid as number, "SIGTERM");
    } catch {
      // ignore
    }
  }
  clearPidFileSync(pidPath);
}
