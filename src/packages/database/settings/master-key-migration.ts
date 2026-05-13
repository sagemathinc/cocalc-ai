/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { secrets } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import {
  deriveSiteMasterKey,
  getOrCreateSiteMasterKey,
  getSiteMasterKeyStatus,
  readOptionalMasterKeyFile,
  resolveLegacyMasterKeyFiles,
  resolveSiteMasterKeyFile,
} from "@cocalc/util/master-key-lifecycle";
import { isSecretSetting } from "@cocalc/util/secret-settings";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

const SECRET_SETTINGS_KEY_ID = "site-master-key-v1";

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type MigrationSource = "current" | "legacy" | "plaintext" | "empty" | "error";

type KeyMaterial = {
  currentSecretSettingsKey?: Buffer;
  legacySecretSettingsKey?: Buffer;
  currentProjectBackupKey?: Buffer;
  legacyProjectBackupKey?: Buffer;
};

type PlannedUpdate = {
  table: string;
  row: string;
  source: Exclude<MigrationSource, "current" | "empty" | "error">;
  sql: string;
  params: any[];
};

export type MasterKeyMigrationTableReport = {
  table: string;
  encrypted_column: string;
  total: number;
  current: number;
  legacy: number;
  plaintext: number;
  empty: number;
  errors: number;
  to_migrate: number;
  migrated: number;
  skipped_missing_table: boolean;
  error_details: string[];
};

export type MasterKeyMigrationReport = {
  offline_required: true;
  executed: boolean;
  site_master_key_path: string;
  legacy_key_files_present: string[];
  tables: MasterKeyMigrationTableReport[];
  totals: {
    rows: number;
    current: number;
    legacy: number;
    plaintext: number;
    empty: number;
    errors: number;
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
    legacy: 0,
    plaintext: 0,
    empty: 0,
    errors: 0,
    to_migrate: 0,
    migrated: 0,
    skipped_missing_table,
    error_details: [],
  };
}

function addSource(
  report: MasterKeyMigrationTableReport,
  source: MigrationSource,
): void {
  if (source === "current") report.current += 1;
  if (source === "legacy") report.legacy += 1;
  if (source === "plaintext") report.plaintext += 1;
  if (source === "empty") report.empty += 1;
  if (source === "error") report.errors += 1;
  if (source === "legacy" || source === "plaintext") report.to_migrate += 1;
}

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const { rows } = await db.query<{ name: string | null }>(
    "SELECT to_regclass($1)::TEXT AS name",
    [`public.${table}`],
  );
  return rows[0]?.name != null;
}

function decryptSecretSettingCandidate({
  name,
  value,
  keys,
}: {
  name: string;
  value: string;
  keys: KeyMaterial;
}): { source: MigrationSource; plaintext?: string; error?: string } {
  if (!value) return { source: "empty", plaintext: "" };
  if (!isEncryptedSecretSettingValue(value)) {
    return { source: "plaintext", plaintext: value };
  }
  if (keys.currentSecretSettingsKey) {
    try {
      return {
        source: "current",
        plaintext: decryptSecretSettingValue(
          name,
          value,
          keys.currentSecretSettingsKey,
        ),
      };
    } catch {}
  }
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
    error: "unable to decrypt with current or legacy secret-settings key",
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
}): { source: MigrationSource; plaintext?: string; error?: string } {
  if (!value) return { source: "empty", plaintext: "" };
  if (!value.startsWith("v1:")) {
    return { source: "plaintext", plaintext: value };
  }
  if (keys.currentProjectBackupKey) {
    try {
      return {
        source: "current",
        plaintext: decryptProjectBackupSecret(
          value,
          keys.currentProjectBackupKey,
        ),
      };
    } catch {}
  }
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
    error: "unable to decrypt with current or legacy project-backup key",
  };
}

async function getKeyMaterial({
  createSiteKey,
}: {
  createSiteKey: boolean;
}): Promise<{
  keys: KeyMaterial;
  siteMasterKeyPath: string;
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
      currentSecretSettingsKey: siteKey
        ? deriveSiteMasterKey(siteKey, "secret-settings:v1")
        : undefined,
      currentProjectBackupKey: siteKey
        ? deriveSiteMasterKey(siteKey, "project-backup-repo-secrets:v1")
        : undefined,
      legacySecretSettingsKey,
      legacyProjectBackupKey,
    },
    siteMasterKeyPath: siteFile.path,
    legacyKeyFilesPresent: [
      legacySecretSettingsKey ? legacySecretSettingsFile?.path : undefined,
      legacyProjectBackupKey ? legacyProjectBackupsFile?.path : undefined,
    ].filter((path): path is string => path != null),
  };
}

async function scanServerSettings({
  db,
  keys,
}: {
  db: Queryable;
  keys: KeyMaterial;
}): Promise<{
  report: MasterKeyMigrationTableReport;
  updates: PlannedUpdate[];
}> {
  const report = makeTableReport({
    table: "server_settings",
    encrypted_column: "value",
  });
  if (!(await tableExists(db, "server_settings"))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<{ name: string; value: string | null }>(
    "SELECT name, value FROM server_settings",
  );
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    if (!isSecretSetting(row.name)) continue;
    report.total += 1;
    const value = row.value ?? "";
    const result = decryptSecretSettingCandidate({
      name: row.name,
      value,
      keys,
    });
    addSource(report, result.source);
    if (result.source === "error") {
      report.error_details.push(`${row.name}: ${result.error}`);
      continue;
    }
    if (
      (result.source === "legacy" || result.source === "plaintext") &&
      result.plaintext &&
      keys.currentSecretSettingsKey
    ) {
      updates.push({
        table: "server_settings",
        row: row.name,
        source: result.source,
        sql: "UPDATE server_settings SET value=$2 WHERE name=$1 AND value=$3",
        params: [
          row.name,
          encryptSecretSettingValue(
            row.name,
            result.plaintext,
            keys.currentSecretSettingsKey,
            SECRET_SETTINGS_KEY_ID,
          ),
          value,
        ],
      });
    }
  }
  return { report, updates };
}

async function scanAccountSecondFactors({
  db,
  keys,
}: {
  db: Queryable;
  keys: KeyMaterial;
}): Promise<{
  report: MasterKeyMigrationTableReport;
  updates: PlannedUpdate[];
}> {
  const report = makeTableReport({
    table: "account_second_factors",
    encrypted_column: "secret_encrypted",
  });
  if (!(await tableExists(db, "account_second_factors"))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<{
    id: string;
    secret_encrypted: string | null;
  }>("SELECT id, secret_encrypted FROM account_second_factors");
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    report.total += 1;
    const value = row.secret_encrypted ?? "";
    const aad = `account_second_factor_secret:${row.id}`;
    const result = decryptSecretSettingCandidate({ name: aad, value, keys });
    addSource(report, result.source);
    if (result.source === "error") {
      report.error_details.push(`${row.id}: ${result.error}`);
      continue;
    }
    if (
      (result.source === "legacy" || result.source === "plaintext") &&
      result.plaintext &&
      keys.currentSecretSettingsKey
    ) {
      updates.push({
        table: "account_second_factors",
        row: row.id,
        source: result.source,
        sql: `
          UPDATE account_second_factors
             SET secret_encrypted = $2
           WHERE id = $1::UUID
             AND secret_encrypted = $3
        `,
        params: [
          row.id,
          encryptSecretSettingValue(
            aad,
            result.plaintext,
            keys.currentSecretSettingsKey,
            SECRET_SETTINGS_KEY_ID,
          ),
          value,
        ],
      });
    }
  }
  return { report, updates };
}

async function scanExternalCredentials({
  db,
  keys,
}: {
  db: Queryable;
  keys: KeyMaterial;
}): Promise<{
  report: MasterKeyMigrationTableReport;
  updates: PlannedUpdate[];
}> {
  const report = makeTableReport({
    table: "external_credentials",
    encrypted_column: "encrypted_payload",
  });
  if (!(await tableExists(db, "external_credentials"))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<{
    id: string;
    provider: string;
    kind: string;
    scope: string;
    encrypted_payload: string | null;
  }>(
    "SELECT id, provider, kind, scope, encrypted_payload FROM external_credentials WHERE revoked IS NULL",
  );
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    report.total += 1;
    const value = row.encrypted_payload ?? "";
    const aad = `external_credentials:${row.provider}:${row.kind}:${row.scope}`;
    const result = decryptSecretSettingCandidate({ name: aad, value, keys });
    addSource(report, result.source);
    if (result.source === "error") {
      report.error_details.push(`${row.id}: ${result.error}`);
      continue;
    }
    if (
      (result.source === "legacy" || result.source === "plaintext") &&
      result.plaintext &&
      keys.currentSecretSettingsKey
    ) {
      updates.push({
        table: "external_credentials",
        row: row.id,
        source: result.source,
        sql: `
          UPDATE external_credentials
             SET encrypted_payload = $2,
                 updated = NOW()
           WHERE id = $1::UUID
             AND encrypted_payload = $3
        `,
        params: [
          row.id,
          encryptSecretSettingValue(
            aad,
            result.plaintext,
            keys.currentSecretSettingsKey,
            SECRET_SETTINGS_KEY_ID,
          ),
          value,
        ],
      });
    }
  }
  return { report, updates };
}

async function scanProjectBackupRepos({
  db,
  keys,
}: {
  db: Queryable;
  keys: KeyMaterial;
}): Promise<{
  report: MasterKeyMigrationTableReport;
  updates: PlannedUpdate[];
}> {
  const report = makeTableReport({
    table: "project_backup_repos",
    encrypted_column: "secret",
  });
  if (!(await tableExists(db, "project_backup_repos"))) {
    report.skipped_missing_table = true;
    return { report, updates: [] };
  }
  const { rows } = await db.query<{ id: string; secret: string | null }>(
    "SELECT id, secret FROM project_backup_repos",
  );
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    report.total += 1;
    const value = row.secret ?? "";
    const result = decryptProjectBackupCandidate({ value, keys });
    addSource(report, result.source);
    if (result.source === "error") {
      report.error_details.push(`${row.id}: ${result.error}`);
      continue;
    }
    if (
      (result.source === "legacy" || result.source === "plaintext") &&
      result.plaintext &&
      keys.currentProjectBackupKey
    ) {
      updates.push({
        table: "project_backup_repos",
        row: row.id,
        source: result.source,
        sql: `
          UPDATE project_backup_repos
             SET secret = $2,
                 updated = NOW()
           WHERE id = $1::UUID
             AND secret = $3
        `,
        params: [
          row.id,
          encryptProjectBackupSecret(
            result.plaintext,
            keys.currentProjectBackupKey,
          ),
          value,
        ],
      });
    }
  }
  return { report, updates };
}

function addTotals(
  totals: MasterKeyMigrationReport["totals"],
  report: MasterKeyMigrationTableReport,
): void {
  totals.rows += report.total;
  totals.current += report.current;
  totals.legacy += report.legacy;
  totals.plaintext += report.plaintext;
  totals.empty += report.empty;
  totals.errors += report.errors;
  totals.to_migrate += report.to_migrate;
  totals.migrated += report.migrated;
}

export async function runMasterKeyMigration({
  execute = false,
}: {
  execute?: boolean;
} = {}): Promise<MasterKeyMigrationReport> {
  const { keys, siteMasterKeyPath, legacyKeyFilesPresent } =
    await getKeyMaterial({ createSiteKey: execute });
  const client = await getPool().connect();
  try {
    const scans = [
      await scanServerSettings({ db: client, keys }),
      await scanAccountSecondFactors({ db: client, keys }),
      await scanExternalCredentials({ db: client, keys }),
      await scanProjectBackupRepos({ db: client, keys }),
    ];
    const tables = scans.map(({ report }) => report);
    const updates = scans.flatMap(({ updates }) => updates);
    const totals: MasterKeyMigrationReport["totals"] = {
      rows: 0,
      current: 0,
      legacy: 0,
      plaintext: 0,
      empty: 0,
      errors: 0,
      to_migrate: 0,
      migrated: 0,
    };
    for (const report of tables) addTotals(totals, report);
    if (execute && totals.errors > 0) {
      throw new Error(
        `master-key migration has ${totals.errors} decrypt errors; refusing to execute`,
      );
    }
    if (execute && updates.length > 0) {
      await client.query("BEGIN");
      try {
        for (const update of updates) {
          const result = await client.query(update.sql, update.params);
          const report = tables.find((table) => table.table === update.table);
          if (report) {
            report.migrated += result.rowCount ?? 0;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    const finalTotals: MasterKeyMigrationReport["totals"] = {
      rows: 0,
      current: 0,
      legacy: 0,
      plaintext: 0,
      empty: 0,
      errors: 0,
      to_migrate: 0,
      migrated: 0,
    };
    for (const report of tables) addTotals(finalTotals, report);
    return {
      offline_required: true,
      executed: execute,
      site_master_key_path: siteMasterKeyPath,
      legacy_key_files_present: legacyKeyFilesPresent,
      tables,
      totals: finalTotals,
    };
  } finally {
    client.release();
  }
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
        ? "site master key is readable and has a valid 32-byte value"
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
            ? `${migration.totals.to_migrate} encrypted/plaintext rows still need migration`
            : "all scanned encrypted rows are already under the site master key",
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
