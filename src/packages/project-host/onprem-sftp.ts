// On-prem launchpad only: register an SSH key so rustic can use SFTP for backups.
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { createHostStatusClient } from "@cocalc/conat/project-host/api";
import { randomBytes } from "micro-key-producer/utils.js";
import ssh from "micro-key-producer/ssh.js";
import { getMasterConatClient } from "./master-status";

const logger = getLogger("project-host:onprem-sftp");

type StoredSftpConfig = {
  sshd_host: string;
  sshd_port: number;
  ssh_user: string;
  sftp_root: string;
  public_key: string;
};

let ensurePromise: Promise<void> | null = null;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir(): string {
  return process.env.COCALC_DATA ?? process.env.DATA ?? "/btrfs/data";
}

function isLocalSelfHost(): boolean {
  return (process.env.COCALC_SELF_HOST_MODE ?? "").toLowerCase() === "local";
}

function resolveKeyPath(): string {
  return (
    process.env.COCALC_LAUNCHPAD_SFTP_KEY_PATH ??
    join(resolveDataDir(), "secrets", "launchpad", "sftp-key")
  );
}

function resolveConfigPath(): string {
  return join(resolveDataDir(), "secrets", "launchpad", "sftp-config.json");
}

async function writeKeyPair(keyPath: string, hostId: string): Promise<string> {
  const seed = randomBytes(32);
  const keypair = ssh(seed, `launchpad-sftp-${hostId}`);
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, keypair.privateKey.trim() + "\n", { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await writeFile(`${keyPath}.pub`, keypair.publicKey.trim() + "\n", {
    mode: 0o644,
  });
  return keypair.publicKey.trim();
}

async function ensurePublicKey(keyPath: string, hostId: string): Promise<string> {
  const pubPath = `${keyPath}.pub`;
  if (await fileExists(pubPath)) {
    return (await readFile(pubPath, "utf8")).trim();
  }
  if (await fileExists(keyPath)) {
    logger.warn("onprem sftp key missing public key; regenerating");
  }
  return await writeKeyPair(keyPath, hostId);
}

async function loadStoredConfig(
  configPath: string,
): Promise<StoredSftpConfig | undefined> {
  if (!(await fileExists(configPath))) {
    return undefined;
  }
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as StoredSftpConfig;
  } catch (err) {
    logger.warn("failed to read sftp config", { err });
    return undefined;
  }
}

async function saveStoredConfig(
  configPath: string,
  config: StoredSftpConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  logger.debug("stored onprem sftp config", {
    sshd_host: config.sshd_host,
    sshd_port: config.sshd_port,
    sftp_root: config.sftp_root,
  });
}

async function registerSftpKey(opts: {
  keyPath: string;
  configPath: string;
  fallback?: StoredSftpConfig;
}): Promise<void> {
  const client = getMasterConatClient();
  if (!client) {
    logger.debug("onprem sftp registration skipped (no master client)");
    return;
  }
  const hostId = process.env.PROJECT_HOST_ID ?? "";
  if (!hostId) {
    logger.warn("onprem sftp registration skipped (missing host id)");
    return;
  }
  let publicKey = opts.fallback?.public_key ?? "";
  if (!publicKey) {
    publicKey = await ensurePublicKey(opts.keyPath, hostId);
  }
  if (!publicKey) {
    logger.warn("onprem sftp registration skipped (missing public key)");
    return;
  }
  const statusClient = createHostStatusClient({ client });
  const res = await statusClient.registerOnPremSftpKey({
    host_id: hostId,
    public_key: publicKey,
  });
  const stored: StoredSftpConfig = {
    sshd_host: res.sshd_host,
    sshd_port: res.sshd_port,
    ssh_user: res.ssh_user,
    sftp_root: res.sftp_root,
    public_key: publicKey,
  };
  await saveStoredConfig(opts.configPath, stored);
  logger.info("onprem sftp key registered", {
    sshd_host: stored.sshd_host,
    sshd_port: stored.sshd_port,
    sftp_root: stored.sftp_root,
  });
}

export async function ensureOnPremSftpKey(): Promise<void> {
  if (!isLocalSelfHost()) {
    logger.debug("onprem sftp disabled (self_host_mode != local)");
    return;
  }
  if (ensurePromise) {
    return await ensurePromise;
  }
  ensurePromise = (async () => {
    const keyPath = resolveKeyPath();
    const configPath = resolveConfigPath();
    const storedConfig = await loadStoredConfig(configPath);
    try {
      await registerSftpKey({
        keyPath,
        configPath,
        fallback: storedConfig,
      });
    } catch (err) {
      const message = String(err);
      if (
        message.includes("self-host mode is not local") ||
        message.includes("host is not self-hosted")
      ) {
        logger.debug("onprem sftp registration skipped", { err: message });
        return;
      }
      logger.warn("onprem sftp registration failed", { err: message });
    }
  })();
  try {
    await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}
