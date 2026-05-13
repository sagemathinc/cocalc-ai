/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const SITE_MASTER_KEY_ID = "site-master-key";
export const SITE_MASTER_KEY_FILENAME = "site-master-key";
export const SITE_MASTER_KEY_CREDENTIAL_NAME = "site-master-key";
export const SITE_MASTER_KEY_ENV = "COCALC_SITE_MASTER_KEY_PATH";
export const SITE_MASTER_KEY_REQUIRE_ENV = "COCALC_REQUIRE_SITE_MASTER_KEY";
export const SYSTEMD_CREDENTIALS_DIRECTORY_ENV = "CREDENTIALS_DIRECTORY";
export const LEGACY_SECRET_SETTINGS_KEY_ENV = "COCALC_SECRET_SETTINGS_KEY_PATH";
export const SITE_MASTER_KEY_BACKUP_KIND = "cocalc-site-master-key-backup";

export type SiteMasterKeyPurpose =
  | "secret-settings:v1"
  | "project-backup-repo-secrets:v1";

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

export interface SiteMasterKeyStatus {
  site_master_key: MasterKeyFileStatus;
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

export async function getSiteMasterKeyStatus(
  opts: SiteMasterKeyPathOptions = {},
): Promise<SiteMasterKeyStatus> {
  const siteFile = resolveSiteMasterKeyFile(opts);
  const site = await getMasterKeyFileStatus(siteFile);
  const legacy = await Promise.all(
    resolveLegacyMasterKeyFiles(opts)
      .filter((file) => file.path !== siteFile.path)
      .map(getMasterKeyFileStatus),
  );
  return {
    site_master_key: site,
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
}: {
  passphrase?: string;
  plaintext?: boolean;
  paths?: SiteMasterKeyPathOptions;
} = {}): Promise<SiteMasterKeyBackup> {
  if (!plaintext && !passphrase) {
    throw new Error(
      "passphrase is required unless plaintext export is enabled",
    );
  }
  const file = resolveSiteMasterKeyFile(paths);
  const key = await getOrCreateSiteMasterKey(paths);
  const plain: PlainSiteMasterKeyBackup = {
    kind: SITE_MASTER_KEY_BACKUP_KIND,
    version: 1,
    created_at: new Date().toISOString(),
    encrypted: false,
    key: {
      id: SITE_MASTER_KEY_ID,
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
