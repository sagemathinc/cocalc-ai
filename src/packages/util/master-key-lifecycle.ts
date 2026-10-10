/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const SITE_MASTER_KEY_ID = "site-master-key";
export const SITE_MASTER_KEY_FILENAME = "site-master-key";
export const SITE_MASTER_KEY_CREDENTIAL_NAME = "site-master-key";
export const SITE_MASTER_KEY_ENV = "COCALC_SITE_MASTER_KEY_PATH";
export const SITE_MASTER_KEY_REQUIRE_ENV = "COCALC_REQUIRE_SITE_MASTER_KEY";
export const SYSTEMD_CREDENTIALS_DIRECTORY_ENV = "CREDENTIALS_DIRECTORY";
export const LEGACY_SECRET_SETTINGS_KEY_ENV = "COCALC_SECRET_SETTINGS_KEY_PATH";
export const SITE_MASTER_KEY_BACKUP_KIND = "cocalc-site-master-key-backup";
// Keys other than the active one: a staged next key during a rotation and
// retired keys that existing ciphertexts may still need. Stored next to the
// active key (or as a systemd credential of this name).
export const SITE_MASTER_KEYRING_CREDENTIAL_NAME = "site-master-key.keyring";
export const SITE_MASTER_KEYRING_ENV = "COCALC_SITE_MASTER_KEYRING_PATH";

export type SiteMasterKeyPurpose =
  | "secret-settings:v1"
  | "project-backup-repo-secrets:v1"
  | "project-secrets:v1";

export type LegacyMasterKeyId =
  | "legacy-secret-settings"
  | "legacy-project-backups";

export type MasterKeyFileSource =
  | "option"
  | "systemd-credential"
  | "environment"
  | "legacy-environment"
  | "default";

export interface SiteMasterKeyPathOptions {
  dataDir?: string;
  secretsDir?: string;
  siteMasterKeyPath?: string;
  legacySecretSettingsKeyPath?: string;
  legacyProjectBackupsKeyPath?: string;
}

export interface MasterKeyFile {
  id: typeof SITE_MASTER_KEY_ID | LegacyMasterKeyId;
  label: string;
  path: string;
  env?: string;
  source?: MasterKeyFileSource;
  read_only?: boolean;
  required?: boolean;
}

export interface MasterKeyFileStatus extends MasterKeyFile {
  exists: boolean;
  readable: boolean;
  key_valid: boolean;
  mode?: string;
  size?: number;
  sha256?: string;
  strict_permissions: boolean;
  warning?: string;
}

export type SiteMasterKeyRole = "active" | "next" | "retired";

/** One key of the site keyring. The key id is derived from the key and is not secret. */
export interface SiteMasterKeyEntry {
  id: string;
  key: Buffer;
  role: SiteMasterKeyRole;
  added_at?: string;
}

export interface SiteMasterKeyringStatus {
  path: string;
  read_only: boolean;
  exists: boolean;
  strict_permissions: boolean;
  keys: {
    id: string;
    role: Exclude<SiteMasterKeyRole, "active">;
    added_at?: string;
  }[];
  warning?: string;
}

export interface SiteMasterKeyStatus {
  site_master_key: MasterKeyFileStatus & { key_id?: string };
  keyring: SiteMasterKeyringStatus;
  legacy_keys: MasterKeyFileStatus[];
  needs_initialization: boolean;
  backup_required: boolean;
}

interface PlainSiteMasterKeyBackup {
  kind: typeof SITE_MASTER_KEY_BACKUP_KIND;
  version: 1;
  created_at: string;
  encrypted: false;
  key: {
    id: typeof SITE_MASTER_KEY_ID;
    // Which key this is (siteMasterKeyId); absent in older backups.
    key_id?: string;
    original_path: string;
    sha256: string;
    value_base64: string;
  };
}

interface EncryptedSiteMasterKeyBackup {
  kind: typeof SITE_MASTER_KEY_BACKUP_KIND;
  version: 1;
  created_at: string;
  encrypted: true;
  kdf: {
    name: "scrypt";
    salt_base64: string;
    N: number;
    r: number;
    p: number;
    key_length: number;
  };
  cipher: {
    name: "aes-256-gcm";
    iv_base64: string;
    tag_base64: string;
    data_base64: string;
  };
}

export type SiteMasterKeyBackup =
  | PlainSiteMasterKeyBackup
  | EncryptedSiteMasterKeyBackup;

function normalizePath(path?: string): string | undefined {
  const trimmed = `${path ?? ""}`.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

function truthyEnv(name: string): boolean {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveSystemdCredentialPath(): string | undefined {
  const credentialsDir = normalizePath(
    process.env[SYSTEMD_CREDENTIALS_DIRECTORY_ENV],
  );
  return credentialsDir
    ? join(credentialsDir, SITE_MASTER_KEY_CREDENTIAL_NAME)
    : undefined;
}

function resolveDataDir(opts: SiteMasterKeyPathOptions = {}): string {
  return (
    normalizePath(opts.dataDir) ??
    normalizePath(process.env.COCALC_DATA_DIR) ??
    normalizePath(process.env.DATA) ??
    resolve(process.cwd(), "data")
  );
}

function resolveSecretsDir(opts: SiteMasterKeyPathOptions = {}): string {
  return (
    normalizePath(opts.secretsDir) ??
    normalizePath(process.env.SECRETS) ??
    join(resolveDataDir(opts), "secrets")
  );
}

export function resolveSiteMasterKeyFile(
  opts: SiteMasterKeyPathOptions = {},
): MasterKeyFile {
  const secretsDir = resolveSecretsDir(opts);
  const required = truthyEnv(SITE_MASTER_KEY_REQUIRE_ENV);
  const optionPath = normalizePath(opts.siteMasterKeyPath);
  if (optionPath) {
    return {
      id: SITE_MASTER_KEY_ID,
      label: "Site master key",
      path: optionPath,
      env: SITE_MASTER_KEY_ENV,
      source: "option",
      required,
    };
  }
  const credentialPath = resolveSystemdCredentialPath();
  if (credentialPath) {
    return {
      id: SITE_MASTER_KEY_ID,
      label: "Site master key",
      path: credentialPath,
      env: SYSTEMD_CREDENTIALS_DIRECTORY_ENV,
      source: "systemd-credential",
      read_only: true,
      required: true,
    };
  }
  const envPath = normalizePath(process.env[SITE_MASTER_KEY_ENV]);
  if (envPath) {
    return {
      id: SITE_MASTER_KEY_ID,
      label: "Site master key",
      path: envPath,
      env: SITE_MASTER_KEY_ENV,
      source: "environment",
      required,
    };
  }
  const legacyEnvPath = normalizePath(
    process.env[LEGACY_SECRET_SETTINGS_KEY_ENV],
  );
  if (legacyEnvPath) {
    return {
      id: SITE_MASTER_KEY_ID,
      label: "Site master key",
      path: legacyEnvPath,
      env: LEGACY_SECRET_SETTINGS_KEY_ENV,
      source: "legacy-environment",
      required,
    };
  }
  return {
    id: SITE_MASTER_KEY_ID,
    label: "Site master key",
    path: join(secretsDir, SITE_MASTER_KEY_FILENAME),
    env: SITE_MASTER_KEY_ENV,
    source: "default",
    required,
  };
}

export function resolveLegacyMasterKeyFiles(
  opts: SiteMasterKeyPathOptions = {},
): MasterKeyFile[] {
  const secretsDir = resolveSecretsDir(opts);
  return [
    {
      id: "legacy-secret-settings",
      label: "Legacy secret settings key",
      path:
        normalizePath(opts.legacySecretSettingsKeyPath) ??
        normalizePath(process.env[LEGACY_SECRET_SETTINGS_KEY_ENV]) ??
        join(secretsDir, "server-settings-key"),
      env: LEGACY_SECRET_SETTINGS_KEY_ENV,
    },
    {
      id: "legacy-project-backups",
      label: "Legacy project backup repository secret key",
      path:
        normalizePath(opts.legacyProjectBackupsKeyPath) ??
        join(secretsDir, "backup-master-key"),
    },
  ];
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function hasStrictPermissions(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function parseKeyContents({
  contents,
  path,
}: {
  contents: string;
  path: string;
}): Buffer {
  const key = Buffer.from(contents.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`invalid master key length at ${path}`);
  }
  return key;
}

async function readMasterKeyFile(path: string): Promise<Buffer> {
  return parseKeyContents({ contents: await readFile(path, "utf8"), path });
}

export async function readOptionalMasterKeyFile(
  path: string,
): Promise<Buffer | undefined> {
  try {
    return await readMasterKeyFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeSiteMasterKeyFile({
  path,
  key,
  overwrite,
}: {
  path: string;
  key: Buffer;
  overwrite: boolean;
}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await access(path, constants.F_OK);
    if (!overwrite) {
      throw new Error(`refusing to overwrite existing site master key ${path}`);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  await writeFile(path, key.toString("base64"), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function getOrCreateSiteMasterKey(
  opts: SiteMasterKeyPathOptions = {},
): Promise<Buffer> {
  const file = resolveSiteMasterKeyFile(opts);
  const existing = await readOptionalMasterKeyFile(file.path);
  if (existing) return existing;
  if (file.required || file.read_only) {
    throw new Error(
      `site master key is required but missing at ${file.path}; provision it before startup`,
    );
  }
  const key = randomBytes(32);
  await writeSiteMasterKeyFile({ path: file.path, key, overwrite: false });
  return key;
}

export function deriveSiteMasterKey(
  siteMasterKey: Buffer,
  purpose: SiteMasterKeyPurpose,
): Buffer {
  if (siteMasterKey.length !== 32) {
    throw new Error("site master key must be 32 bytes");
  }
  const derived = hkdfSync(
    "sha256",
    siteMasterKey,
    Buffer.from("cocalc-site-master-key:v1"),
    Buffer.from(`cocalc:${purpose}`),
    32,
  );
  return Buffer.from(derived);
}

/**
 * A stable, non-secret identifier for a site master key, so people and
 * ciphertexts can say which key they mean without revealing it.
 */
export function siteMasterKeyId(siteMasterKey: Buffer): string {
  if (siteMasterKey.length !== 32) {
    throw new Error("site master key must be 32 bytes");
  }
  return `smk_${createHmac("sha256", siteMasterKey)
    .update("cocalc-site-master-key-id:v1")
    .digest("base64url")
    .slice(0, 16)}`;
}

export function resolveSiteMasterKeyringFile(
  opts: SiteMasterKeyPathOptions & { keyringPath?: string } = {},
): { path: string; read_only: boolean } {
  const optionPath = normalizePath(opts.keyringPath);
  if (optionPath) return { path: optionPath, read_only: false };
  const site = resolveSiteMasterKeyFile(opts);
  if (site.source === "systemd-credential") {
    return {
      path: join(dirname(site.path), SITE_MASTER_KEYRING_CREDENTIAL_NAME),
      read_only: true,
    };
  }
  const envPath = normalizePath(process.env[SITE_MASTER_KEYRING_ENV]);
  if (envPath) return { path: envPath, read_only: false };
  return { path: `${site.path}.keyring`, read_only: false };
}

const KEYRING_ROLES = new Set(["next", "retired"]);
const KEY_ID_RE = /^smk_[A-Za-z0-9_-]{16}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** How long a key stays retired before it may leave the keyring. */
export const SITE_MASTER_KEY_RETIRE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** A key in canonical base64, exactly 32 bytes. */
export function parseCanonicalSiteMasterKey(
  value: string,
  where: string,
): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`${where}: not a canonical base64 32-byte key`);
  }
  return key;
}

/**
 * Parse a keyring file: one key per line, exactly
 * "<base64 key> <next|retired> <key id> <added at>", as written by
 * formatSiteMasterKeyring. Blank lines and lines starting with "#" are
 * ignored. Anything else, a key id that does not match its key, a duplicate
 * key or more than one next key is an error rather than a guess.
 */
export function parseSiteMasterKeyring(
  contents: string,
  path = "keyring",
): SiteMasterKeyEntry[] {
  const entries: SiteMasterKeyEntry[] = [];
  contents.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const where = `${path}:${index + 1}`;
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(
        `${where}: expected "<base64 key> <next|retired> <key id> <added at>"`,
      );
    }
    const [value, role, recordedId, added_at] = fields;
    if (!KEYRING_ROLES.has(role)) {
      throw new Error(`${where}: role must be "next" or "retired"`);
    }
    const key = parseCanonicalSiteMasterKey(value, where);
    const id = siteMasterKeyId(key);
    if (!KEY_ID_RE.test(recordedId) || recordedId !== id) {
      throw new Error(
        `${where}: key id ${recordedId} does not match its key (${id})`,
      );
    }
    if (
      !TIMESTAMP_RE.test(added_at) ||
      !Number.isFinite(Date.parse(added_at))
    ) {
      throw new Error(`${where}: invalid timestamp ${added_at}`);
    }
    if (entries.some((entry) => entry.id === id)) {
      throw new Error(`${where}: duplicate key ${id}`);
    }
    if (role === "next" && entries.some((entry) => entry.role === "next")) {
      throw new Error(`${where}: more than one next key`);
    }
    entries.push({ id, key, role: role as SiteMasterKeyRole, added_at });
  });
  return entries;
}

export function formatSiteMasterKeyring(entries: SiteMasterKeyEntry[]): string {
  const lines = [
    "# CoCalc site master keyring: keys other than the active one.",
    "# <base64 key> <next|retired> <key id> <added at>. Keep this file 0600.",
  ];
  for (const entry of entries) {
    if (entry.role === "active") {
      throw new Error("the active key does not belong in the keyring file");
    }
    lines.push(
      [
        entry.key.toString("base64"),
        entry.role,
        siteMasterKeyId(entry.key),
        entry.added_at ?? new Date().toISOString(),
      ].join(" "),
    );
  }
  return lines.join("\n") + "\n";
}

export async function readSiteMasterKeyring(
  opts: SiteMasterKeyPathOptions & { keyringPath?: string } = {},
): Promise<SiteMasterKeyEntry[]> {
  const { path } = resolveSiteMasterKeyringFile(opts);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return parseSiteMasterKeyring(contents, path);
}

/**
 * Every site master key this process may use: the active key first (the only
 * one used to encrypt), then the keyring's next and retired keys (used only to
 * decrypt and to match keyed hashes).
 */
export async function getSiteMasterKeyring(
  opts: SiteMasterKeyPathOptions & { keyringPath?: string } = {},
): Promise<SiteMasterKeyEntry[]> {
  const active = await getOrCreateSiteMasterKey(opts);
  const activeId = siteMasterKeyId(active);
  return [
    { id: activeId, key: active, role: "active" },
    ...(await readSiteMasterKeyring(opts)).filter(
      (entry) => entry.id !== activeId,
    ),
  ];
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Write a 0600 file by creating a new file next to it and renaming it over
// the old one, then syncing the directory: a reader never sees a partial key
// file, and the rename is on disk before the next step of a rotation starts
// (several renames are otherwise not guaranteed to survive a crash in order).
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (err) {
    await unlink(temporary).catch(() => {});
    throw err;
  }
  await syncDirectory(dirname(path));
}

/** Create a new 0600 file (never replacing one) and make it durable. */
export async function writeNewFileDurably(
  path: string,
  contents: string,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(resolve(path)));
}

type RotationPaths = SiteMasterKeyPathOptions & { keyringPath?: string };

function writableRotationFiles(opts: RotationPaths) {
  const site = resolveSiteMasterKeyFile(opts);
  const keyring = resolveSiteMasterKeyringFile(opts);
  if (site.read_only || keyring.read_only) {
    throw new Error(
      `the site master key is loaded from a read-only systemd credential (${site.path}); run key rotation with ${SITE_MASTER_KEY_ENV} set to the real key file, e.g. /etc/cocalc/site-master-key`,
    );
  }
  return { site, keyring };
}

// Who holds a lock: a process id alone can be reused after a crash or reboot,
// so the lock also records the boot and the process start time (Linux /proc;
// without them only the process id is checked).
type LockHolder = { pid: number; boot_id?: string; start?: string };

async function processIdentity(pid: number): Promise<Omit<LockHolder, "pid">> {
  const boot_id =
    `${await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")}`.trim() ||
    undefined;
  let start: string | undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime); the command name in field 2 may contain spaces.
    start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {}
  return { boot_id, start };
}

// The lock's holder: a JSON record, or (written by an older version, e.g.
// during a mixed-version rollout) a bare process id. JSON.parse would accept
// the bare id as a number, so it is recognised first.
function parseLockHolder(text: string): LockHolder | undefined {
  const trimmed = text.trim();
  if (trimmed !== "" && Number.isSafeInteger(Number(trimmed))) {
    return { pid: Number(trimmed) };
  }
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === "object") return value;
  } catch {}
  return undefined;
}

async function lockHolderAlive(text: string): Promise<boolean> {
  const holder = parseLockHolder(text);
  if (!holder) return false;
  const pid = Number(holder.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const current = await processIdentity(pid);
  if (holder.boot_id && current.boot_id && holder.boot_id !== current.boot_id) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err?.code !== "EPERM") return false;
  }
  return !(holder.start && current.start && holder.start !== current.start);
}

/**
 * Run one key-file change under `<keyring>.lock`, so two rotation commands
 * cannot interleave their reads and writes. A lock whose holder is gone
 * (exited, or from before a reboot, even if its process id was reused) is
 * removed. The bay's root helper uses the same lock file and format.
 */
async function withKeyringLock<T>(
  keyringPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${keyringPath}.lock`;
  const nonce = randomBytes(8).toString("hex");
  const me = JSON.stringify({
    pid: process.pid,
    ...(await processIdentity(process.pid)),
    nonce,
  });
  // Publish the complete record with link(2), which fails if the lock exists:
  // a lock created empty and then written could be read as stale, and
  // removed, in between.
  const record = `${lockPath}.${nonce}`;
  await writeFile(record, `${me}\n`, { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(record, lockPath);
        break;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        const holder =
          `${await readFile(lockPath, "utf8").catch(() => "")}`.trim();
        if (!(await lockHolderAlive(holder))) {
          // Remove only the stale lock we looked at, not a newer one.
          const now =
            `${await readFile(lockPath, "utf8").catch(() => "")}`.trim();
          if (now === holder) await unlink(lockPath).catch(() => {});
          continue;
        }
        if (attempt >= 30) {
          throw new Error(
            `another key rotation step holds ${lockPath} (${holder}); try again when it finishes, or remove the file if that process is not a rotation step`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    await unlink(record).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock, in case it was wrongly judged stale.
    const now = `${await readFile(lockPath, "utf8").catch(() => "")}`.trim();
    if (now === me) await unlink(lockPath).catch(() => {});
  }
}

async function readActiveKey(path: string): Promise<Buffer> {
  const key = await readOptionalMasterKeyFile(path);
  if (!key) throw new Error(`no site master key at ${path}`);
  return key;
}

export interface SiteMasterKeyRotationStep {
  active_id: string;
  keyring: {
    id: string;
    role: Exclude<SiteMasterKeyRole, "active">;
    added_at?: string;
  }[];
}

async function rotationState(
  opts: RotationPaths,
): Promise<SiteMasterKeyRotationStep> {
  const { site } = writableRotationFiles(opts);
  const activeId = siteMasterKeyId(await readActiveKey(site.path));
  return {
    active_id: activeId,
    keyring: (await readSiteMasterKeyring(opts))
      .filter((entry) => entry.id !== activeId)
      .map(({ id, role, added_at }) => ({
        id,
        role: role as Exclude<SiteMasterKeyRole, "active">,
        added_at,
      })),
  };
}

/**
 * Rotation step 1: add a key to the keyring as "next": a new random key, or
 * (`key`) one generated elsewhere, e.g. on the first of several bays sharing
 * the site key. It is not used to encrypt anything until it is activated;
 * once services restart with it in the keyring they can decrypt what it will
 * encrypt. The caller must back it up before activating.
 */
export async function stageNextSiteMasterKey(
  opts: RotationPaths & { key?: Buffer } = {},
): Promise<{ id: string; key: Buffer }> {
  const { site, keyring } = writableRotationFiles(opts);
  return await withKeyringLock(keyring.path, async () => {
    const active = await readActiveKey(site.path);
    const entries = await readSiteMasterKeyring(opts);
    const key = opts.key ?? randomBytes(32);
    if (key.length !== 32) throw new Error("site master key must be 32 bytes");
    if (key.equals(active))
      throw new Error("the new key equals the active key");
    const id = siteMasterKeyId(key);
    const staged = entries.find((entry) => entry.role === "next");
    if (staged?.id === id) return { id, key };
    if (staged) {
      throw new Error(
        `a next key (${staged.id}) is already staged; activate it or remove it from ${keyring.path} first`,
      );
    }
    if (entries.some((entry) => entry.id === id)) {
      throw new Error(`${id} is already in the keyring as a retired key`);
    }
    await writeFileAtomic(
      keyring.path,
      formatSiteMasterKeyring([
        ...entries,
        { id, key, role: "next", added_at: new Date().toISOString() },
      ]),
    );
    return { id, key };
  });
}

/**
 * Put an old key back in the keyring as "retired", e.g. before restoring a
 * backup made before a rotation. Decrypt-only; reencrypt then moves its data
 * to the active key.
 */
export async function addRetiredSiteMasterKey(
  key: Buffer,
  opts: RotationPaths = {},
): Promise<SiteMasterKeyRotationStep> {
  const { site, keyring } = writableRotationFiles(opts);
  return await withKeyringLock(keyring.path, async () => {
    if (key.length !== 32) throw new Error("site master key must be 32 bytes");
    const id = siteMasterKeyId(key);
    if (siteMasterKeyId(await readActiveKey(site.path)) === id) {
      throw new Error(`${id} is the active key`);
    }
    const entries = await readSiteMasterKeyring(opts);
    if (!entries.some((entry) => entry.id === id)) {
      await writeFileAtomic(
        keyring.path,
        formatSiteMasterKeyring([
          ...entries,
          { id, key, role: "retired", added_at: new Date().toISOString() },
        ]),
      );
    }
    return await rotationState(opts);
  });
}

/**
 * Rotation step 2 (and rollback): make the keyring key `id` (the staged next
 * key, or a retired key to roll back) the active key; the previously active
 * key becomes "retired". Each write is atomic and durable before the next,
 * and the order keeps every key on disk at all times: first the keyring
 * gains the old key as retired, then the active file changes, then the new
 * active key leaves the keyring. If interrupted, running it again completes
 * it.
 */
export async function activateSiteMasterKey(
  id: string,
  opts: RotationPaths = {},
): Promise<SiteMasterKeyRotationStep & { previous_id?: string }> {
  const { site, keyring } = writableRotationFiles(opts);
  return await withKeyringLock(keyring.path, async () => {
    const active = await readActiveKey(site.path);
    const activeId = siteMasterKeyId(active);
    let entries = await readSiteMasterKeyring(opts);
    const target = entries.find((entry) => entry.id === id);
    if (!target) {
      if (activeId === id) return await rotationState(opts);
      throw new Error(`key ${id} is not in the keyring at ${keyring.path}`);
    }
    if (activeId !== id) {
      if (!entries.some((entry) => entry.id === activeId)) {
        entries = [
          ...entries,
          {
            id: activeId,
            key: active,
            role: "retired",
            added_at: new Date().toISOString(),
          },
        ];
        await writeFileAtomic(keyring.path, formatSiteMasterKeyring(entries));
      }
      await writeFileAtomic(site.path, target.key.toString("base64"));
    }
    await writeFileAtomic(
      keyring.path,
      formatSiteMasterKeyring(entries.filter((entry) => entry.id !== id)),
    );
    return {
      ...(await rotationState(opts)),
      ...(activeId !== id ? { previous_id: activeId } : {}),
    };
  });
}

/**
 * Rotation step 3: remove a retired key from the online keyring, once nothing
 * encrypted under it is still needed. Short-lived keyed hashes (email sign-in
 * challenges, connector turns) cannot be re-encrypted, so a key must have
 * been retired for at least `minAgeMs` (24 hours) unless `force`. Keep an
 * offline copy for as long as backups made before the rotation are retained.
 */
export async function retireSiteMasterKey(
  id: string,
  opts: RotationPaths & { force?: boolean; minAgeMs?: number; now?: Date } = {},
): Promise<SiteMasterKeyRotationStep> {
  const { site, keyring } = writableRotationFiles(opts);
  return await withKeyringLock(keyring.path, async () => {
    if (siteMasterKeyId(await readActiveKey(site.path)) === id) {
      throw new Error(`${id} is the active key`);
    }
    const entries = await readSiteMasterKeyring(opts);
    const target = entries.find((entry) => entry.id === id);
    if (!target) {
      throw new Error(`key ${id} is not in the keyring at ${keyring.path}`);
    }
    if (target.role !== "retired") {
      throw new Error(`key ${id} is ${target.role}, not retired`);
    }
    const minAgeMs = opts.minAgeMs ?? SITE_MASTER_KEY_RETIRE_MIN_AGE_MS;
    const age =
      (opts.now ?? new Date()).getTime() - Date.parse(target.added_at!);
    if (!opts.force && !(age >= minAgeMs)) {
      throw new Error(
        `${id} was retired at ${target.added_at}; wait until ${new Date(Date.parse(target.added_at!) + minAgeMs).toISOString()} (in-flight sign-in challenges may still need it) or force it`,
      );
    }
    await writeFileAtomic(
      keyring.path,
      formatSiteMasterKeyring(entries.filter((entry) => entry.id !== id)),
    );
    return await rotationState(opts);
  });
}

/** A purpose key derived from one keyring entry. */
export interface DerivedSiteKey {
  id: string;
  key: Buffer;
  role: SiteMasterKeyRole;
}

export function deriveSiteMasterKeyring(
  keyring: SiteMasterKeyEntry[],
  purpose: SiteMasterKeyPurpose,
): DerivedSiteKey[] {
  return keyring.map(({ id, key, role }) => ({
    id,
    role,
    key: deriveSiteMasterKey(key, purpose),
  }));
}

/**
 * Try `decrypt` with each key, the one named by `preferredId` first. Returns
 * the result and the key that worked; throws the first error if none did.
 * AES-GCM authentication makes a wrong key fail rather than return garbage.
 */
export function decryptWithAnyKey<T>(
  keys: DerivedSiteKey[],
  decrypt: (key: Buffer) => T,
  preferredId?: string,
): { value: T; key: DerivedSiteKey } {
  const ordered = preferredId
    ? [
        ...keys.filter((key) => key.id === preferredId),
        ...keys.filter((key) => key.id !== preferredId),
      ]
    : keys;
  let firstError: unknown;
  for (const key of ordered) {
    try {
      return { value: decrypt(key.key), key };
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error("no site master key available");
}

async function getMasterKeyFileStatus(
  file: MasterKeyFile,
): Promise<MasterKeyFileStatus> {
  try {
    const info = await stat(file.path);
    let readable = true;
    let key: Buffer | undefined;
    let warning: string | undefined;
    try {
      await access(file.path, constants.R_OK);
      key = await readMasterKeyFile(file.path);
    } catch (err) {
      readable = false;
      warning = `file exists but is not readable or valid: ${err}`;
    }
    const strict = hasStrictPermissions(info.mode);
    if (!strict) {
      warning = "file is readable or writable by group/other users";
    }
    return {
      ...file,
      exists: true,
      readable,
      key_valid: key != null,
      mode: modeString(info.mode),
      size: info.size,
      sha256: key ? sha256(key) : undefined,
      strict_permissions: strict,
      warning,
    };
  } catch (err: any) {
    if (err?.code && err.code !== "ENOENT") {
      return {
        ...file,
        exists: false,
        readable: false,
        key_valid: false,
        strict_permissions: false,
        warning: `not accessible: ${err}`,
      };
    }
    return {
      ...file,
      exists: false,
      readable: false,
      key_valid: false,
      strict_permissions: false,
      warning: "missing",
    };
  }
}

async function getKeyringStatus(
  opts: SiteMasterKeyPathOptions,
): Promise<SiteMasterKeyringStatus> {
  const { path, read_only } = resolveSiteMasterKeyringFile(opts);
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      return {
        path,
        read_only,
        exists: false,
        strict_permissions: false,
        keys: [],
        warning: `not accessible: ${err}`,
      };
    }
  }
  if (mode == null) {
    return {
      path,
      read_only,
      exists: false,
      strict_permissions: true,
      keys: [],
    };
  }
  const strict = hasStrictPermissions(mode);
  try {
    const keys = (await readSiteMasterKeyring(opts)).map(
      ({ id, role, added_at }) => ({
        id,
        role: role as Exclude<SiteMasterKeyRole, "active">,
        ...(added_at ? { added_at } : {}),
      }),
    );
    return {
      path,
      read_only,
      exists: true,
      strict_permissions: strict,
      keys,
      ...(strict
        ? {}
        : { warning: "file is readable or writable by group/other users" }),
    };
  } catch (err) {
    return {
      path,
      read_only,
      exists: true,
      strict_permissions: strict,
      keys: [],
      warning: `invalid keyring: ${err}`,
    };
  }
}

export async function getSiteMasterKeyStatus(
  opts: SiteMasterKeyPathOptions = {},
): Promise<SiteMasterKeyStatus> {
  const siteFile = resolveSiteMasterKeyFile(opts);
  const site: SiteMasterKeyStatus["site_master_key"] =
    await getMasterKeyFileStatus(siteFile);
  if (site.key_valid) {
    try {
      site.key_id = siteMasterKeyId(await readMasterKeyFile(siteFile.path));
    } catch {}
  }
  const keyring = await getKeyringStatus(opts);
  const legacy = await Promise.all(
    resolveLegacyMasterKeyFiles(opts)
      .filter((file) => file.path !== siteFile.path)
      .map(getMasterKeyFileStatus),
  );
  return {
    site_master_key: site,
    keyring,
    legacy_keys: legacy,
    needs_initialization: !site.exists,
    backup_required: site.exists,
  };
}

function deriveBackupEncryptionKey({
  passphrase,
  salt,
}: {
  passphrase: string;
  salt: Buffer;
}): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptBackupPayload({
  payload,
  passphrase,
}: {
  payload: PlainSiteMasterKeyBackup;
  passphrase: string;
}): EncryptedSiteMasterKeyBackup {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveBackupEncryptionKey({ passphrase, salt });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${SITE_MASTER_KEY_BACKUP_KIND}:v1`));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    kind: SITE_MASTER_KEY_BACKUP_KIND,
    version: 1,
    created_at: payload.created_at,
    encrypted: true,
    kdf: {
      name: "scrypt",
      salt_base64: salt.toString("base64"),
      N: 16384,
      r: 8,
      p: 1,
      key_length: 32,
    },
    cipher: {
      name: "aes-256-gcm",
      iv_base64: iv.toString("base64"),
      tag_base64: cipher.getAuthTag().toString("base64"),
      data_base64: data.toString("base64"),
    },
  };
}

function decryptBackupPayload({
  backup,
  passphrase,
}: {
  backup: EncryptedSiteMasterKeyBackup;
  passphrase: string;
}): PlainSiteMasterKeyBackup {
  if (backup.kdf.name !== "scrypt" || backup.cipher.name !== "aes-256-gcm") {
    throw new Error("unsupported site master key backup encryption format");
  }
  const salt = Buffer.from(backup.kdf.salt_base64, "base64");
  const key = deriveBackupEncryptionKey({ passphrase, salt });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(backup.cipher.iv_base64, "base64"),
  );
  decipher.setAAD(Buffer.from(`${SITE_MASTER_KEY_BACKUP_KIND}:v1`));
  decipher.setAuthTag(Buffer.from(backup.cipher.tag_base64, "base64"));
  const data = Buffer.concat([
    decipher.update(Buffer.from(backup.cipher.data_base64, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(data.toString("utf8")) as PlainSiteMasterKeyBackup;
}

export async function createSiteMasterKeyBackup({
  passphrase,
  plaintext = false,
  paths,
  key: givenKey,
}: {
  passphrase?: string;
  plaintext?: boolean;
  paths?: SiteMasterKeyPathOptions;
  // A specific key, e.g. a newly staged next key; default: the active key.
  key?: Buffer;
} = {}): Promise<SiteMasterKeyBackup> {
  if (!plaintext && !passphrase) {
    throw new Error(
      "passphrase is required unless plaintext export is enabled",
    );
  }
  const file = resolveSiteMasterKeyFile(paths);
  const key = givenKey ?? (await getOrCreateSiteMasterKey(paths));
  const plain: PlainSiteMasterKeyBackup = {
    kind: SITE_MASTER_KEY_BACKUP_KIND,
    version: 1,
    created_at: new Date().toISOString(),
    encrypted: false,
    key: {
      id: SITE_MASTER_KEY_ID,
      key_id: siteMasterKeyId(key),
      original_path: file.path,
      sha256: sha256(key),
      value_base64: key.toString("base64"),
    },
  };
  return plaintext
    ? plain
    : encryptBackupPayload({ payload: plain, passphrase: passphrase! });
}

function parseSiteMasterKeyBackup(raw: string): SiteMasterKeyBackup {
  const backup = JSON.parse(raw) as SiteMasterKeyBackup;
  if (
    backup.kind !== SITE_MASTER_KEY_BACKUP_KIND ||
    backup.version !== 1 ||
    typeof backup.encrypted !== "boolean"
  ) {
    throw new Error("invalid site master key backup file");
  }
  return backup;
}

export async function readSiteMasterKeyBackupFile({
  path,
  passphrase,
}: {
  path: string;
  passphrase?: string;
}): Promise<PlainSiteMasterKeyBackup> {
  const backup = parseSiteMasterKeyBackup(await readFile(path, "utf8"));
  if (!backup.encrypted) return backup;
  if (!passphrase) {
    throw new Error(
      "passphrase is required for encrypted site master key backup",
    );
  }
  return decryptBackupPayload({ backup, passphrase });
}

export async function restoreSiteMasterKeyBackup({
  backup,
  paths,
  force = false,
}: {
  backup: PlainSiteMasterKeyBackup;
  paths?: SiteMasterKeyPathOptions;
  force?: boolean;
}): Promise<SiteMasterKeyStatus> {
  const target = resolveSiteMasterKeyFile(paths);
  if (target.read_only) {
    throw new Error(
      `cannot restore site master key to read-only credential path ${target.path}; set ${SITE_MASTER_KEY_ENV} to a writable permanent path`,
    );
  }
  const key = Buffer.from(backup.key.value_base64, "base64");
  if (sha256(key) !== backup.key.sha256) {
    throw new Error("backup checksum mismatch for site master key");
  }
  const existing = await readOptionalMasterKeyFile(target.path);
  if (existing) {
    if (sha256(existing) === backup.key.sha256) {
      return await getSiteMasterKeyStatus(paths);
    }
    if (!force) {
      throw new Error(
        `refusing to overwrite existing site master key ${target.path}; use --force to replace it`,
      );
    }
  }
  await writeSiteMasterKeyFile({ path: target.path, key, overwrite: true });
  return await getSiteMasterKeyStatus(paths);
}
