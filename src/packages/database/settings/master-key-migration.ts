/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Re-encryption of everything the site master key protects in the database.
//
// It moves every encrypted value to the active site master key: values under
// the legacy per-purpose key files, values stored in plaintext by older
// versions, and, after a key rotation (see master-key-lifecycle), values
// under a staged or retired key of the keyring. Keyed hashes that can be
// recomputed (invite email hashes) are recomputed. Each row is rewritten with
// a compare-and-swap update, so it can run while the site is up and can be
// run again; a dry run is the doctor's database check.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

import { secrets } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import {
  decryptWithAnyKey,
  deriveSiteMasterKeyring,
  getOrCreateSiteMasterKey,
  getSiteMasterKeyStatus,
  readOptionalMasterKeyFile,
  readSiteMasterKeyring,
  resolveLegacyMasterKeyFiles,
  resolveSiteMasterKeyFile,
  siteMasterKeyId,
  type DerivedSiteKey,
  type SiteMasterKeyEntry,
} from "@cocalc/util/master-key-lifecycle";
import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
  type EncryptedProjectSecretValue,
} from "@cocalc/util/project-secrets";
import { PROJECT_SECRETS_PURPOSE } from "@cocalc/util/project-secrets-constants";
import {
  isSecretSetting,
  SECRET_SETTING_PREFIX,
} from "@cocalc/util/secret-settings";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

// current: under the active key. rotated: under a staged or retired key of
// the keyring. legacy: under a legacy per-purpose key file.
type MigrationSource =
  | "current"
  | "rotated"
  | "legacy"
  | "plaintext"
  | "empty"
  | "error";

type KeyMaterial = {
  secretSettings: DerivedSiteKey[];
  projectBackup: DerivedSiteKey[];
  projectSecrets: DerivedSiteKey[];
  legacySecretSettingsKey?: Buffer;
  legacyProjectBackupKey?: Buffer;
};

type PlannedUpdate = {
  table: string;
  row: string;
  source: MigrationSource;
  sql: string;
  params: any[];
  // Run once per transaction after the updates, e.g. to make project hosts
  // re-sync rewrapped project secrets.
  after?: { key: string; sql: string; params: any[] };
};

export type MasterKeyMigrationTableReport = {
  table: string;
  encrypted_column: string;
  total: number;
  current: number;
  rotated: number;
  legacy: number;
  plaintext: number;
  empty: number;
  errors: number;
  // Rows whose keyed hash must be recomputed (it was made with another key).
  stale_hashes: number;
  to_migrate: number;
  migrated: number;
  // Rows by the key that decrypts them: a key id, "legacy" or "plaintext".
  by_key: Record<string, number>;
  skipped_missing_table: boolean;
  error_details: string[];
};

export type MasterKeyMigrationReport = {
  // Compare-and-swap updates: safe while the site is running.
  offline_required: false;
  executed: boolean;
  site_master_key_path: string;
  active_key_id?: string;
  keyring: { id: string; role: string }[];
  legacy_key_files_present: string[];
  tables: MasterKeyMigrationTableReport[];
  totals: {
    rows: number;
    current: number;
    rotated: number;
    legacy: number;
    plaintext: number;
    empty: number;
    errors: number;
    stale_hashes: number;
    to_migrate: number;
    migrated: number;
  };
};

export type MasterKeyDoctorCheck = {
  id: string;
  level: "ok" | "warning" | "error";
  message: string;
};

export type MasterKeyDoctorReport = {
  ok: boolean;
  checked_at: string;
  status: Awaited<ReturnType<typeof getSiteMasterKeyStatus>>;
  checks: MasterKeyDoctorCheck[];
  migration?: MasterKeyMigrationReport;
  database_error?: string;
};

function makeTableReport({
  table,
  encrypted_column,
  skipped_missing_table = false,
}: {
  table: string;
  encrypted_column: string;
  skipped_missing_table?: boolean;
}): MasterKeyMigrationTableReport {
  return {
    table,
    encrypted_column,
    total: 0,
    current: 0,
    rotated: 0,
    legacy: 0,
    plaintext: 0,
    empty: 0,
    errors: 0,
    stale_hashes: 0,
    to_migrate: 0,
    migrated: 0,
    by_key: {},
    skipped_missing_table,
    error_details: [],
  };
}

function addSource(
  report: MasterKeyMigrationTableReport,
  source: MigrationSource,
  keyId?: string,
): void {
  report.total += 1;
  if (source === "empty" || source === "error") {
    report[source === "empty" ? "empty" : "errors"] += 1;
    return;
  }
  report[source] += 1;
  const byKey = source === "current" || source === "rotated" ? keyId! : source;
  report.by_key[byKey] = (report.by_key[byKey] ?? 0) + 1;
}

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const { rows } = await db.query<{ name: string | null }>(
    "SELECT to_regclass($1)::TEXT AS name",
    [`public.${table}`],
  );
  return rows[0]?.name != null;
}

type Decrypted = {
  source: MigrationSource;
  plaintext?: string;
  keyId?: string;
  error?: string;
};

function classify(key: DerivedSiteKey): MigrationSource {
  return key.role === "active" ? "current" : "rotated";
}

function secretSettingKeyId(value: string): string | undefined {
  return value.slice(SECRET_SETTING_PREFIX.length).split(":")[0] || undefined;
}

function decryptSecretSettingCandidate({
  name,
  value,
  keys,
}: {
  name: string;
  value: string;
  keys: KeyMaterial;
}): Decrypted {
  if (!value) return { source: "empty", plaintext: "" };
  if (!isEncryptedSecretSettingValue(value)) {
    return { source: "plaintext", plaintext: value };
  }
  try {
    const { value: plaintext, key } = decryptWithAnyKey(
      keys.secretSettings,
      (candidate) => decryptSecretSettingValue(name, value, candidate),
      secretSettingKeyId(value),
    );
    return { source: classify(key), plaintext, keyId: key.id };
  } catch {}
  if (keys.legacySecretSettingsKey) {
    try {
      return {
        source: "legacy",
        plaintext: decryptSecretSettingValue(
          name,
          value,
          keys.legacySecretSettingsKey,
        ),
      };
    } catch {}
  }
  return {
    source: "error",
    error:
      "unable to decrypt with any site master key or the legacy secret-settings key",
  };
}

function encryptProjectBackupSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptProjectBackupSecret(encoded: string, key: Buffer): string {
  if (!encoded.startsWith("v1:")) return encoded;
  const [, ivB64, tagB64, dataB64] = encoded.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("invalid backup secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptProjectBackupCandidate({
  value,
  keys,
}: {
  value: string;
  keys: KeyMaterial;
}): Decrypted {
  if (!value) return { source: "empty", plaintext: "" };
  if (!value.startsWith("v1:")) {
    return { source: "plaintext", plaintext: value };
  }
  try {
    const { value: plaintext, key } = decryptWithAnyKey(
      keys.projectBackup,
      (candidate) => decryptProjectBackupSecret(value, candidate),
    );
    return { source: classify(key), plaintext, keyId: key.id };
  } catch {}
  if (keys.legacyProjectBackupKey) {
    try {
      return {
        source: "legacy",
        plaintext: decryptProjectBackupSecret(
          value,
          keys.legacyProjectBackupKey,
        ),
      };
    } catch {}
  }
  return {
    source: "error",
    error:
      "unable to decrypt with any site master key or the legacy project-backup key",
  };
}

async function getKeyMaterial({
  createSiteKey,
}: {
  createSiteKey: boolean;
}): Promise<{
  keys: KeyMaterial;
  siteMasterKeyPath: string;
  activeKeyId?: string;
  keyring: SiteMasterKeyEntry[];
  legacyKeyFilesPresent: string[];
}> {
  const readIfReadable = async (path: string): Promise<Buffer | undefined> => {
    try {
      return await readOptionalMasterKeyFile(path);
    } catch {
      return undefined;
    }
  };
  const siteFile = resolveSiteMasterKeyFile({ secretsDir: secrets });
  const siteKey = createSiteKey
    ? await getOrCreateSiteMasterKey({ secretsDir: secrets })
    : await readIfReadable(siteFile.path);
  const activeKeyId = siteKey ? siteMasterKeyId(siteKey) : undefined;
  const keyring: SiteMasterKeyEntry[] = [
    ...(siteKey
      ? [{ id: activeKeyId!, key: siteKey, role: "active" as const }]
      : []),
    ...(await readSiteMasterKeyring({ secretsDir: secrets })).filter(
      (entry) => entry.id !== activeKeyId,
    ),
  ];
  const legacyFiles = resolveLegacyMasterKeyFiles({ secretsDir: secrets });
  const legacySecretSettingsFile = legacyFiles.find(
    (file) =>
      file.id === "legacy-secret-settings" && file.path !== siteFile.path,
  );
  const legacyProjectBackupsFile = legacyFiles.find(
    (file) =>
      file.id === "legacy-project-backups" && file.path !== siteFile.path,
  );
  const legacySecretSettingsKey = legacySecretSettingsFile
    ? await readIfReadable(legacySecretSettingsFile.path)
    : undefined;
  const legacyProjectBackupKey = legacyProjectBackupsFile
    ? await readIfReadable(legacyProjectBackupsFile.path)
    : undefined;

  return {
    keys: {
      secretSettings: deriveSiteMasterKeyring(keyring, "secret-settings:v1"),
      projectBackup: deriveSiteMasterKeyring(
        keyring,
        "project-backup-repo-secrets:v1",
      ),
      projectSecrets: deriveSiteMasterKeyring(keyring, PROJECT_SECRETS_PURPOSE),
      legacySecretSettingsKey,
      legacyProjectBackupKey,
    },
    siteMasterKeyPath: siteFile.path,
    activeKeyId,
    keyring,
    legacyKeyFilesPresent: [
      legacySecretSettingsKey ? legacySecretSettingsFile?.path : undefined,
      legacyProjectBackupKey ? legacyProjectBackupsFile?.path : undefined,
    ].filter((path): path is string => path != null),
  };
}

// Rows needing migration whose plaintext must be re-encrypted. A store with
// no active key (dry run without a site key) only reports.
function needsRewrap(result: Decrypted): boolean {
  return (
    (result.source === "rotated" ||
      result.source === "legacy" ||
      result.source === "plaintext") &&
    !!result.plaintext
  );
}

type Scan = {
  report: MasterKeyMigrationTableReport;
  updates: PlannedUpdate[];
};

/**
 * A table column holding values encrypted like secret settings (AES-GCM with
 * the secret-settings key, `enc:v1:<key id>:…`, AAD from the row).
 */
async function scanSecretSettingsColumn({
  db,
  keys,
  table,
  column,
  select,
  aad,
  update,
  include = () => true,
}: {
  db: Queryable;
  keys: KeyMaterial;
  table: string;
  column: string;
  select: string;
  aad: (row: any) => string;
  update: (
    row: any,
    encrypted: string,
    old: string,
  ) => { sql: string; params: any[] };
  include?: (row: any) => boolean;
}): Promise<Scan> {
  const report = makeTableReport({ table, encrypted_column: column });
  if (!(await tableExists(db, table))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<any>(select);
  const active = keys.secretSettings[0];
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    if (!include(row)) continue;
    const value = row.value ?? "";
    const name = aad(row);
    const result = decryptSecretSettingCandidate({ name, value, keys });
    addSource(report, result.source, result.keyId);
    if (result.source === "error") {
      report.error_details.push(`${row.id}: ${result.error}`);
      continue;
    }
    if (!needsRewrap(result)) continue;
    report.to_migrate += 1;
    if (!active || active.role !== "active") continue;
    updates.push({
      table,
      row: `${row.id}`,
      source: result.source,
      ...update(
        row,
        encryptSecretSettingValue(
          name,
          result.plaintext!,
          active.key,
          active.id,
        ),
        value,
      ),
    });
  }
  return { report, updates };
}

function scanServerSettings(db: Queryable, keys: KeyMaterial) {
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "server_settings",
    column: "value",
    select: "SELECT name AS id, value FROM server_settings",
    include: (row) => isSecretSetting(row.id),
    aad: (row) => row.id,
    update: (row, encrypted, old) => ({
      sql: "UPDATE server_settings SET value=$2 WHERE name=$1 AND value=$3",
      params: [row.id, encrypted, old],
    }),
  });
}

function scanAccountSecondFactors(db: Queryable, keys: KeyMaterial) {
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "account_second_factors",
    column: "secret_encrypted",
    select: "SELECT id, secret_encrypted AS value FROM account_second_factors",
    aad: (row) => `account_second_factor_secret:${row.id}`,
    update: (row, encrypted, old) => ({
      sql: `UPDATE account_second_factors SET secret_encrypted=$2
             WHERE id=$1::UUID AND secret_encrypted=$3`,
      params: [row.id, encrypted, old],
    }),
  });
}

function scanExternalCredentials(db: Queryable, keys: KeyMaterial) {
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "external_credentials",
    column: "encrypted_payload",
    select: `SELECT id, provider, kind, scope, encrypted_payload AS value
               FROM external_credentials WHERE revoked IS NULL`,
    aad: (row) =>
      `external_credentials:${row.provider}:${row.kind}:${row.scope}`,
    update: (row, encrypted, old) => ({
      sql: `UPDATE external_credentials SET encrypted_payload=$2, updated=NOW()
             WHERE id=$1::UUID AND encrypted_payload=$3`,
      params: [row.id, encrypted, old],
    }),
  });
}

function scanRegistrationTokens(db: Queryable, keys: KeyMaterial) {
  // Only the encrypted form: hash-only tokens cannot be migrated (their
  // plaintext is not stored); they match under any key in the keyring.
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "registration_tokens",
    column: "token",
    select: `SELECT token AS id, token AS value FROM registration_tokens
              WHERE token LIKE '${SECRET_SETTING_PREFIX}%'`,
    aad: () => "registration_tokens.token",
    update: (_row, encrypted, old) => ({
      sql: "UPDATE registration_tokens SET token=$1 WHERE token=$2",
      params: [encrypted, old],
    }),
  });
}

function scanConnectorTurns(db: Queryable, keys: KeyMaterial) {
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "agent_cocalc_connector_turns",
    column: "secret_ciphertext",
    select: `SELECT turn_id AS id, secret_ciphertext AS value
               FROM agent_cocalc_connector_turns
              WHERE COALESCE(secret_ciphertext, '') <> ''`,
    aad: (row) => `agent-cocalc-connector-turn:${row.id}`,
    update: (row, encrypted, old) => ({
      sql: `UPDATE agent_cocalc_connector_turns SET secret_ciphertext=$2
             WHERE turn_id=$1::UUID AND secret_ciphertext=$3`,
      params: [row.id, encrypted, old],
    }),
  });
}

function scanExamTokens(db: Queryable, keys: KeyMaterial) {
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "project_host_exam_configs",
    column: "token_ciphertext",
    select: `SELECT host_id AS id, token_ciphertext AS value
               FROM project_host_exam_configs WHERE token_ciphertext IS NOT NULL`,
    aad: (row) => `project-host-exam-token:${row.id}`,
    update: (row, encrypted, old) => ({
      sql: `UPDATE project_host_exam_configs SET token_ciphertext=$2
             WHERE host_id=$1::UUID AND token_ciphertext=$3`,
      params: [row.id, encrypted, old],
    }),
  });
}

function scanInviteTokens(db: Queryable, keys: KeyMaterial) {
  return scanSecretSettingsColumn({
    db,
    keys,
    table: "project_collab_invites",
    column: "token_ciphertext",
    select: `SELECT invite_id AS id, token_ciphertext AS value
               FROM project_collab_invites WHERE token_ciphertext IS NOT NULL`,
    aad: () => "project_collab_invites.token",
    update: (row, encrypted, old) => ({
      sql: `UPDATE project_collab_invites SET token_ciphertext=$2
             WHERE invite_id=$1::UUID AND token_ciphertext=$3`,
      params: [row.id, encrypted, old],
    }),
  });
}

const INVITE_EMAIL_AAD = "project_collab_invites.email";

// Must match hmacInviteValue in server/projects/collaborators.ts.
export function inviteEmailHash(key: Buffer, email: string): string {
  const digest = createHmac("sha256", key)
    .update(INVITE_EMAIL_AAD)
    .update("\0")
    .update(email)
    .digest("base64url");
  return `${INVITE_EMAIL_AAD}:${digest}`;
}

/**
 * Invite emails: the ciphertext is rewrapped like the other columns, and the
 * keyed email hash (used to find an existing invite) is recomputed under the
 * active key from the decrypted email.
 */
async function scanInviteEmails(
  db: Queryable,
  keys: KeyMaterial,
): Promise<Scan> {
  const table = "project_collab_invites";
  const report = makeTableReport({
    table,
    encrypted_column: "email_ciphertext",
  });
  if (!(await tableExists(db, table))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<{
    invite_id: string;
    email_ciphertext: string;
    email_hash: string | null;
  }>(
    `SELECT invite_id, email_ciphertext, email_hash FROM ${table}
      WHERE email_ciphertext IS NOT NULL`,
  );
  const active = keys.secretSettings[0];
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    const value = row.email_ciphertext ?? "";
    const result = decryptSecretSettingCandidate({
      name: INVITE_EMAIL_AAD,
      value,
      keys,
    });
    addSource(report, result.source, result.keyId);
    if (result.source === "error") {
      report.error_details.push(`${row.invite_id}: ${result.error}`);
      continue;
    }
    if (!result.plaintext || !active || active.role !== "active") {
      if (needsRewrap(result)) report.to_migrate += 1;
      continue;
    }
    const hash = inviteEmailHash(active.key, result.plaintext);
    const staleHash = row.email_hash != null && row.email_hash !== hash;
    if (staleHash) report.stale_hashes += 1;
    if (!needsRewrap(result) && !staleHash) continue;
    report.to_migrate += 1;
    updates.push({
      table,
      row: row.invite_id,
      source: result.source,
      sql: `UPDATE ${table}
               SET email_ciphertext=$2,
                   email_hash=CASE WHEN email_hash IS NULL THEN NULL ELSE $3 END
             WHERE invite_id=$1::UUID
               AND email_ciphertext=$4
               AND email_hash IS NOT DISTINCT FROM $5`,
      params: [
        row.invite_id,
        needsRewrap(result)
          ? encryptSecretSettingValue(
              INVITE_EMAIL_AAD,
              result.plaintext,
              active.key,
              active.id,
            )
          : value,
        hash,
        value,
        row.email_hash,
      ],
    });
  }
  return { report, updates };
}

async function scanProjectBackupRepos(
  db: Queryable,
  keys: KeyMaterial,
): Promise<Scan> {
  const table = "project_backup_repos";
  const report = makeTableReport({ table, encrypted_column: "secret" });
  if (!(await tableExists(db, table))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<{ id: string; secret: string | null }>(
    "SELECT id, secret FROM project_backup_repos",
  );
  const active = keys.projectBackup[0];
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    const value = row.secret ?? "";
    const result = decryptProjectBackupCandidate({ value, keys });
    addSource(report, result.source, result.keyId);
    if (result.source === "error") {
      report.error_details.push(`${row.id}: ${result.error}`);
      continue;
    }
    if (!needsRewrap(result)) continue;
    report.to_migrate += 1;
    if (!active || active.role !== "active") continue;
    updates.push({
      table,
      row: row.id,
      source: result.source,
      sql: `UPDATE project_backup_repos SET secret=$2, updated=NOW()
             WHERE id=$1::UUID AND secret=$3`,
      params: [
        row.id,
        encryptProjectBackupSecret(result.plaintext!, active.key),
        value,
      ],
    });
  }
  return { report, updates };
}

/**
 * Project secrets: rewrapped under the active key; the project's runtime
 * generation is bumped so project hosts replace their cached copies (a host
 * ignores a re-sync at the same generation).
 */
async function scanProjectSecrets(
  db: Queryable,
  keys: KeyMaterial,
): Promise<Scan> {
  const table = "project_secrets";
  const report = makeTableReport({
    table,
    encrypted_column: "encrypted_value",
  });
  if (!(await tableExists(db, table))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const hasRuntimeState = await tableExists(
    db,
    "project_secrets_runtime_state",
  );
  const { rows } = await db.query<{
    project_id: string;
    name: string;
    encrypted_value: EncryptedProjectSecretValue | string;
  }>("SELECT project_id, name, encrypted_value FROM project_secrets");
  const active = keys.projectSecrets[0];
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    const id = `${row.project_id}/${row.name}`;
    const encrypted: EncryptedProjectSecretValue =
      typeof row.encrypted_value === "string"
        ? JSON.parse(row.encrypted_value)
        : row.encrypted_value;
    let result: Decrypted;
    try {
      const { value, key } = decryptWithAnyKey(
        keys.projectSecrets,
        (candidate) =>
          decryptProjectSecretValue({
            project_id: row.project_id,
            name: row.name,
            encrypted,
            key: candidate,
          }),
      );
      result = { source: classify(key), plaintext: value, keyId: key.id };
    } catch {
      result = {
        source: "error",
        error: "unable to decrypt with any site master key",
      };
    }
    addSource(report, result.source, result.keyId);
    if (result.source === "error") {
      report.error_details.push(`${id}: ${result.error}`);
      continue;
    }
    if (result.source !== "rotated") continue;
    report.to_migrate += 1;
    if (!active || active.role !== "active") continue;
    updates.push({
      table,
      row: id,
      source: result.source,
      sql: `UPDATE project_secrets SET encrypted_value=$3::JSONB
             WHERE project_id=$1::UUID AND name=$2 AND encrypted_value=$4::JSONB`,
      params: [
        row.project_id,
        row.name,
        JSON.stringify(
          encryptProjectSecretValue({
            project_id: row.project_id,
            name: row.name,
            value: result.plaintext!,
            key: active.key,
          }),
        ),
        JSON.stringify(encrypted),
      ],
      ...(hasRuntimeState
        ? {
            after: {
              key: `project_secrets_runtime_state:${row.project_id}`,
              sql: `INSERT INTO project_secrets_runtime_state(project_id, generation, updated_at)
                    VALUES ($1, 1, NOW())
                    ON CONFLICT (project_id) DO UPDATE SET
                      generation=project_secrets_runtime_state.generation + 1,
                      updated_at=NOW()`,
              params: [row.project_id],
            },
          }
        : {}),
    });
  }
  return { report, updates };
}

function emptyTotals(): MasterKeyMigrationReport["totals"] {
  return {
    rows: 0,
    current: 0,
    rotated: 0,
    legacy: 0,
    plaintext: 0,
    empty: 0,
    errors: 0,
    stale_hashes: 0,
    to_migrate: 0,
    migrated: 0,
  };
}

function addTotals(
  totals: MasterKeyMigrationReport["totals"],
  report: MasterKeyMigrationTableReport,
): void {
  totals.rows += report.total;
  totals.current += report.current;
  totals.rotated += report.rotated;
  totals.legacy += report.legacy;
  totals.plaintext += report.plaintext;
  totals.empty += report.empty;
  totals.errors += report.errors;
  totals.stale_hashes += report.stale_hashes;
  totals.to_migrate += report.to_migrate;
  totals.migrated += report.migrated;
}

export async function runMasterKeyMigration({
  execute = false,
}: {
  execute?: boolean;
} = {}): Promise<MasterKeyMigrationReport> {
  const {
    keys,
    siteMasterKeyPath,
    activeKeyId,
    keyring,
    legacyKeyFilesPresent,
  } = await getKeyMaterial({ createSiteKey: execute });
  const client = await getPool().connect();
  try {
    const scans: Scan[] = [];
    for (const scan of [
      scanServerSettings,
      scanAccountSecondFactors,
      scanExternalCredentials,
      scanProjectBackupRepos,
      scanRegistrationTokens,
      scanConnectorTurns,
      scanExamTokens,
      scanInviteEmails,
      scanInviteTokens,
      scanProjectSecrets,
    ]) {
      scans.push(await scan(client, keys));
    }
    const tables = scans.map(({ report }) => report);
    const totals = emptyTotals();
    for (const report of tables) addTotals(totals, report);
    if (execute && totals.errors > 0) {
      throw new Error(
        `master-key migration has ${totals.errors} decrypt errors; refusing to execute`,
      );
    }
    if (execute) {
      // One transaction per table keeps locks short; every update is a
      // compare-and-swap, so a row changed meanwhile is simply skipped and
      // picked up by the next run.
      for (const { report, updates } of scans) {
        if (updates.length === 0) continue;
        await client.query("BEGIN");
        try {
          const after = new Map<string, { sql: string; params: any[] }>();
          for (const update of updates) {
            const result = await client.query(update.sql, update.params);
            report.migrated += result.rowCount ?? 0;
            if (update.after && (result.rowCount ?? 0) > 0) {
              after.set(update.after.key, update.after);
            }
          }
          for (const { sql, params } of after.values()) {
            await client.query(sql, params);
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    }
    const finalTotals = emptyTotals();
    for (const report of tables) addTotals(finalTotals, report);
    return {
      offline_required: false,
      executed: execute,
      site_master_key_path: siteMasterKeyPath,
      active_key_id: activeKeyId,
      keyring: keyring.map(({ id, role }) => ({ id, role })),
      legacy_key_files_present: legacyKeyFilesPresent,
      tables,
      totals: finalTotals,
    };
  } finally {
    client.release();
  }
}

/** Rows (by table) that still decrypt only with the given key id. */
export function rowsUnderKey(
  report: MasterKeyMigrationReport,
  keyId: string,
): Record<string, number> {
  return Object.fromEntries(
    report.tables
      .map((table) => [
        table.table + "." + table.encrypted_column,
        table.by_key[keyId] ?? 0,
      ])
      .filter(([, count]) => (count as number) > 0),
  );
}

function check(
  checks: MasterKeyDoctorCheck[],
  id: string,
  level: MasterKeyDoctorCheck["level"],
  message: string,
): void {
  checks.push({ id, level, message });
}

export async function getMasterKeyDoctorReport({
  scanDatabase = true,
}: {
  scanDatabase?: boolean;
} = {}): Promise<MasterKeyDoctorReport> {
  const status = await getSiteMasterKeyStatus({ secretsDir: secrets });
  const checks: MasterKeyDoctorCheck[] = [];
  const site = status.site_master_key;
  check(
    checks,
    "site-master-key-present",
    site.exists ? "ok" : "error",
    site.exists
      ? `site master key exists at ${site.path}`
      : site.warning && site.warning !== "missing"
        ? `site master key path is not accessible at ${site.path}: ${site.warning}`
        : `site master key is missing at ${site.path}`,
  );
  check(
    checks,
    "site-master-key-production-mode",
    site.required ? "ok" : "warning",
    site.required
      ? `site master key is required from ${site.source ?? "configured path"}`
      : "site master key is not required; missing keys may be auto-created for development",
  );
  if (site.exists) {
    check(
      checks,
      "site-master-key-readable",
      site.readable && site.key_valid ? "ok" : "error",
      site.readable && site.key_valid
        ? `site master key ${site.key_id ?? ""} is readable and has a valid 32-byte value`
        : `site master key is not readable or valid: ${site.warning ?? "unknown error"}`,
    );
    check(
      checks,
      "site-master-key-permissions",
      site.strict_permissions ? "ok" : "error",
      site.strict_permissions
        ? "site master key file permissions are private"
        : "site master key file must not be readable or writable by group/other users",
    );
    check(
      checks,
      "site-master-key-backup",
      "warning",
      "software cannot verify that this key is backed up; export it and store the backup separately",
    );
  }
  const keyring = status.keyring;
  if (keyring.warning) {
    check(
      checks,
      "site-master-keyring",
      "error",
      `keyring ${keyring.path}: ${keyring.warning}`,
    );
  } else {
    const next = keyring.keys.filter((key) => key.role === "next");
    const retired = keyring.keys.filter((key) => key.role === "retired");
    check(
      checks,
      "site-master-keyring",
      next.length || retired.length ? "warning" : "ok",
      next.length
        ? `key rotation in progress: ${next.map((key) => key.id).join(", ")} is staged; activate it once every service has restarted`
        : retired.length
          ? `retired keys are still online: ${retired.map((key) => key.id).join(", ")}; retire them once no rows remain under them`
          : "no staged or retired site master keys",
    );
  }
  const existingLegacy = status.legacy_keys.filter((file) => file.exists);
  const inaccessibleLegacy = status.legacy_keys.filter(
    (file) => !file.exists && file.warning && file.warning !== "missing",
  );
  check(
    checks,
    "legacy-master-key-files",
    existingLegacy.length === 0 && inaccessibleLegacy.length === 0
      ? "ok"
      : "warning",
    existingLegacy.length === 0 && inaccessibleLegacy.length === 0
      ? "no separate legacy master-key files detected"
      : inaccessibleLegacy.length > 0
        ? `legacy key paths could not be inspected: ${inaccessibleLegacy.map((file) => `${file.path} (${file.warning})`).join(", ")}`
        : `legacy key files still exist: ${existingLegacy.map((file) => file.path).join(", ")}`,
  );

  let migration: MasterKeyMigrationReport | undefined;
  let databaseError: string | undefined;
  if (scanDatabase) {
    try {
      migration = await runMasterKeyMigration({ execute: false });
      check(
        checks,
        "encrypted-data-migration",
        migration.totals.errors > 0
          ? "error"
          : migration.totals.to_migrate > 0
            ? "warning"
            : "ok",
        migration.totals.errors > 0
          ? `${migration.totals.errors} encrypted rows could not be decrypted`
          : migration.totals.to_migrate > 0
            ? `${migration.totals.to_migrate} rows still need re-encryption under the active key (${migration.totals.rotated} under other keyring keys, ${migration.totals.legacy} legacy, ${migration.totals.plaintext} plaintext, ${migration.totals.stale_hashes} stale hashes); run the migration with --execute`
            : `all scanned encrypted rows are under the active site master key ${migration.active_key_id ?? ""}`,
      );
    } catch (err) {
      databaseError = `${err}`;
      check(
        checks,
        "encrypted-data-scan",
        "error",
        `database scan failed: ${databaseError}`,
      );
    }
  }

  return {
    ok: !checks.some((entry) => entry.level === "error"),
    checked_at: new Date().toISOString(),
    status,
    checks,
    migration,
    database_error: databaseError,
  };
}
