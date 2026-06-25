/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import getPool from "@cocalc/database/pool";
import { OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON } from "@cocalc/util/legacy-migration";

type ImportTarget =
  | "accounts"
  | "projects"
  | "artifacts"
  | "purchases"
  | "subscriptions"
  | "site_licenses";

type Options = {
  dir?: string;
  only?: Set<string>;
  limit?: number;
  batchSize: number;
  dryRun: boolean;
  enableLegacyProjectsButton: boolean;
};

type ImportStats = {
  file: string;
  repairedRows: number;
  rows: number;
  batches: number;
};

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_ARTIFACT_BUCKET = "cocalc-projects";
const DEFAULT_ARTIFACT_KEY_PREFIX = "prod3/default/";
const DEFAULT_ARTIFACT_KEY_SUFFIX = ".tar.zst";
const LEGACY_SOURCE_PROJECT_LABEL = "legacy.cocalc.com/project_id";
let poolUsed = false;
let rawRecordsSchemaReady: Promise<void> | undefined;
let projectsSchemaReady: Promise<void> | undefined;
let repairedRows = 0;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/import-dump.js --dir <dump-dir> [options]

Options:
  --dir <path>          Directory containing *.ndjson.gz files from kucalc db legacy-migration-dump.
                        Optional when only running --enable-legacy-projects-button.
  --only <list>         Comma-separated import targets: accounts,projects,artifacts,purchases,subscriptions,site_licenses.
  --limit <n>           Stop after importing n rows per file, useful for smoke tests.
  --batch-size <n>      Rows per database batch. Default: ${DEFAULT_BATCH_SIZE}.
  --dry-run             Parse files and report counts without writing to the database.
  --enable-legacy-projects-button
                        After import, enable the Projects-page Legacy Projects button
                        for current accounts with matching primary or verified emails.
                        Existing explicit user choices are preserved.
  --help                Show this help.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
    enableLegacyProjectsButton: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--enable-legacy-projects-button") {
      options.enableLegacyProjectsButton = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--dir") {
      options.dir = value;
    } else if (arg === "--only") {
      options.only = new Set(
        value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      );
    } else if (arg === "--limit") {
      options.limit = positiveInt(value, "--limit");
    } else if (arg === "--batch-size") {
      options.batchSize = positiveInt(value, "--batch-size");
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!options.dir && !options.enableLegacyProjectsButton) {
    throw new Error(
      "--dir is required unless --enable-legacy-projects-button is set",
    );
  }
  if (options.only) {
    const allowed = new Set([
      "accounts",
      "projects",
      "artifacts",
      "purchases",
      "subscriptions",
      "site_licenses",
    ]);
    const unknown = [...options.only].filter((x) => !allowed.has(x));
    if (unknown.length > 0) {
      throw new Error(`unknown --only target(s): ${unknown.join(", ")}`);
    }
  }
  return options as Options;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function clean(value: unknown): string | null {
  const s = `${value ?? ""}`.trim();
  return s || null;
}

function canonicalEmailSql(expression: string): string {
  return `
    CASE
      WHEN split_part(${expression}, '@', 2) IN ('gmail.com', 'googlemail.com')
        THEN regexp_replace(split_part(split_part(${expression}, '@', 1), '+', 1), '\\.', '', 'g') || '@gmail.com'
      ELSE ${expression}
    END
  `;
}

async function enableLegacyProjectsButtonForMatchingAccounts(): Promise<number> {
  const legacyCanonical = canonicalEmailSql("lower(email_address)");
  const currentCanonical = canonicalEmailSql("email");
  const { rowCount } = await pool().query(
    `
    WITH legacy_project_accounts AS (
      SELECT owner_legacy_account_id AS legacy_account_id
        FROM legacy_migration_projects
       WHERE COALESCE(hidden, false) IS FALSE
         AND owner_legacy_account_id IS NOT NULL
      UNION
      SELECT account_id AS legacy_account_id
        FROM legacy_migration_projects p
        CROSS JOIN LATERAL jsonb_object_keys(
          CASE
            WHEN jsonb_typeof(p.legacy_users) = 'object' THEN p.legacy_users
            ELSE '{}'::jsonb
          END
        ) AS users(account_id)
       WHERE COALESCE(p.hidden, false) IS FALSE
    ),
    legacy_email_keys AS (
      SELECT DISTINCT lower(email_address) AS email_key
        FROM legacy_migration_accounts legacy
        JOIN legacy_project_accounts projects
          ON projects.legacy_account_id = legacy.legacy_account_id
       WHERE COALESCE(email_address, '') <> ''
      UNION
      SELECT DISTINCT ${legacyCanonical} AS email_key
        FROM legacy_migration_accounts legacy
        JOIN legacy_project_accounts projects
          ON projects.legacy_account_id = legacy.legacy_account_id
       WHERE COALESCE(email_address, '') <> ''
    ),
    current_email_keys AS (
      SELECT account_id, lower(email_address) AS email
        FROM accounts
       WHERE COALESCE(deleted, false) IS FALSE
         AND COALESCE(email_address, '') <> ''
      UNION
      SELECT account_id, lower(email)
        FROM accounts
        CROSS JOIN LATERAL jsonb_object_keys(
          CASE
            WHEN jsonb_typeof(email_address_verified) = 'object'
              THEN email_address_verified
            ELSE '{}'::jsonb
          END
        ) AS verified(email)
       WHERE COALESCE(deleted, false) IS FALSE
    ),
    current_account_keys AS (
      SELECT account_id, email AS email_key
        FROM current_email_keys
      UNION
      SELECT account_id, ${currentCanonical} AS email_key
        FROM current_email_keys
    ),
    target_accounts AS (
      SELECT DISTINCT current_keys.account_id
        FROM current_account_keys current_keys
        JOIN legacy_email_keys legacy USING (email_key)
    )
    UPDATE accounts account
       SET other_settings = COALESCE(account.other_settings, '{}'::jsonb)
         || jsonb_build_object($1::text, true)
      FROM target_accounts target
     WHERE account.account_id = target.account_id
       AND NOT (COALESCE(account.other_settings, '{}'::jsonb) ? $1::text)
    `,
    [OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON],
  );
  return rowCount ?? 0;
}

async function ensureProjectsSchema(): Promise<void> {
  projectsSchemaReady ??= (async () => {
    await pool().query(`
      ALTER TABLE legacy_migration_projects
        ADD COLUMN IF NOT EXISTS disk_mb DOUBLE PRECISION
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_projects_disk_mb_idx
        ON legacy_migration_projects(disk_mb)
    `);
  })();
  await projectsSchemaReady;
}

function defaultArtifactKey(legacyProjectId: string | null): string | null {
  return legacyProjectId
    ? `${DEFAULT_ARTIFACT_KEY_PREFIX}${legacyProjectId}${DEFAULT_ARTIFACT_KEY_SUFFIX}`
    : null;
}

async function requeueSkippedRestoresWithArtifacts(
  rows: Record<string, any>[],
): Promise<void> {
  const ids = rows
    .map((row) => clean(row.legacy_project_id))
    .filter((id): id is string => id != null);
  if (ids.length === 0) return;
  await pool().query(
    `
    INSERT INTO project_labels
      (project_id, key, value, created_by, updated_by, created_at, updated_at)
    SELECT i.project_id,
           $2,
           i.legacy_project_id,
           i.owner_account_id,
           i.owner_account_id,
           NOW(),
           NOW()
      FROM legacy_migration_project_imports i
     WHERE i.legacy_project_id=ANY($1::TEXT[])
       AND i.project_id IS NOT NULL
    ON CONFLICT (project_id, key)
    DO UPDATE SET value=EXCLUDED.value,
                  updated_by=EXCLUDED.updated_by,
                  updated_at=NOW()
    `,
    [ids, LEGACY_SOURCE_PROJECT_LABEL],
  );
  await pool().query(
    `
    UPDATE legacy_migration_project_imports i
       SET restore_status='pending',
           restore_error=NULL,
           restore_mode='full',
           restore_claimed_until=NULL,
           restore_worker_id=NULL,
           updated=NOW()
      FROM legacy_migration_projects p
     WHERE i.legacy_project_id=p.legacy_project_id
       AND i.legacy_project_id=ANY($1::TEXT[])
       AND i.project_id IS NOT NULL
       AND COALESCE(i.restore_mode, 'full')='full'
       AND i.restore_status='skipped'
       AND COALESCE(p.artifact_status, '')='available'
       AND COALESCE(p.artifact_key, '') <> ''
    `,
    [ids],
  );
}

function targetForFile(file: string): ImportTarget | undefined {
  const name = basename(file);
  if (name === "accounts.ndjson.gz") return "accounts";
  if (name === "projects.ndjson.gz") return "projects";
  if (name === "artifacts.ndjson.gz") return "artifacts";
  if (name === "purchases.ndjson.gz") return "purchases";
  if (name === "subscriptions.ndjson.gz") return "subscriptions";
  if (name === "site_licenses.ndjson.gz") return "site_licenses";
  return undefined;
}

async function loadManifest(dir: string): Promise<Record<string, any> | null> {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function* readRows(
  file: string,
  limit: number | undefined,
): AsyncGenerator<Record<string, any>> {
  const stream = createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield parseDumpRow(trimmed);
    count += 1;
    if (limit != null && count >= limit) break;
  }
  stream.destroy();
}

function parseDumpRow(line: string): Record<string, any> {
  try {
    return JSON.parse(line);
  } catch (err) {
    // Some legacy exports double-escaped embedded quotes inside JSON strings,
    // e.g. "Edie \\"Danger\\"" instead of "Edie \"Danger\"".
    const repaired = line.replace(/\\\\(?=")/g, "\\");
    if (repaired === line) {
      throw err;
    }
    try {
      repairedRows += 1;
      return JSON.parse(repaired);
    } catch (repairErr) {
      throw new Error(
        `invalid legacy dump JSON row: ${err}; quote repair also failed: ${repairErr}`,
      );
    }
  }
}

async function upsertAccounts(rows: Record<string, any>[]): Promise<void> {
  await pool().query(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          legacy_account_id TEXT,
          email_address TEXT,
          email_address_verified BOOLEAN,
          first_name TEXT,
          last_name TEXT,
          display_name TEXT,
          last_active TIMESTAMPTZ,
          metadata JSONB
        )
    )
    INSERT INTO legacy_migration_accounts (
      legacy_account_id,
      email_address,
      email_address_verified,
      first_name,
      last_name,
      display_name,
      last_active,
      metadata,
      created,
      updated
    )
    SELECT legacy_account_id,
           NULLIF(lower(email_address), ''),
           COALESCE(email_address_verified, false),
           first_name,
           last_name,
           display_name,
           last_active,
           COALESCE(metadata, '{}'::jsonb),
           NOW(),
           NOW()
      FROM input
     WHERE COALESCE(legacy_account_id, '') <> ''
    ON CONFLICT (legacy_account_id) DO UPDATE SET
      email_address=EXCLUDED.email_address,
      email_address_verified=EXCLUDED.email_address_verified,
      first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name,
      display_name=EXCLUDED.display_name,
      last_active=EXCLUDED.last_active,
      metadata=EXCLUDED.metadata,
      updated=NOW()
    `,
    [JSON.stringify(rows)],
  );
  await requeueSkippedRestoresWithArtifacts(rows);
}

async function upsertProjects(rows: Record<string, any>[]): Promise<void> {
  await ensureProjectsSchema();
  await pool().query(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          legacy_project_id TEXT,
          title TEXT,
          description TEXT,
          owner_legacy_account_id TEXT,
          legacy_users JSONB,
          hidden BOOLEAN,
          last_edited TIMESTAMPTZ,
          last_active TIMESTAMPTZ,
          disk_mb DOUBLE PRECISION,
          artifact_bucket TEXT,
          artifact_key TEXT,
          manifest_key TEXT,
          artifact_status TEXT,
          artifact_manifest JSONB,
          metadata JSONB
        )
    )
    INSERT INTO legacy_migration_projects (
      legacy_project_id,
      title,
      description,
      owner_legacy_account_id,
      legacy_users,
      hidden,
      last_edited,
      last_active,
      disk_mb,
      artifact_bucket,
      artifact_key,
      manifest_key,
      artifact_status,
      artifact_manifest,
      metadata,
      created,
      updated
    )
    SELECT legacy_project_id,
           title,
           description,
           owner_legacy_account_id,
           COALESCE(legacy_users, '{}'::jsonb),
           COALESCE(hidden, false),
           last_edited,
           last_active,
           CASE WHEN disk_mb >= 0 THEN disk_mb ELSE NULL END,
           artifact_bucket,
           artifact_key,
           manifest_key,
           COALESCE(NULLIF(artifact_status, ''), 'unknown'),
           artifact_manifest,
           COALESCE(metadata, '{}'::jsonb),
           NOW(),
           NOW()
      FROM input
     WHERE COALESCE(legacy_project_id, '') <> ''
    ON CONFLICT (legacy_project_id) DO UPDATE SET
      title=EXCLUDED.title,
      description=EXCLUDED.description,
      owner_legacy_account_id=EXCLUDED.owner_legacy_account_id,
      legacy_users=EXCLUDED.legacy_users,
      hidden=EXCLUDED.hidden,
      last_edited=EXCLUDED.last_edited,
      last_active=EXCLUDED.last_active,
      disk_mb=COALESCE(EXCLUDED.disk_mb, legacy_migration_projects.disk_mb),
      artifact_bucket=COALESCE(EXCLUDED.artifact_bucket, legacy_migration_projects.artifact_bucket),
      artifact_key=COALESCE(EXCLUDED.artifact_key, legacy_migration_projects.artifact_key),
      manifest_key=COALESCE(EXCLUDED.manifest_key, legacy_migration_projects.manifest_key),
      artifact_status=CASE
        WHEN EXCLUDED.artifact_key IS NOT NULL OR EXCLUDED.artifact_status <> 'unknown'
          THEN EXCLUDED.artifact_status
        ELSE legacy_migration_projects.artifact_status
      END,
      artifact_manifest=COALESCE(EXCLUDED.artifact_manifest, legacy_migration_projects.artifact_manifest),
      metadata=EXCLUDED.metadata,
      updated=NOW()
    `,
    [JSON.stringify(rows)],
  );
  await requeueSkippedRestoresWithArtifacts(rows);
}

async function upsertArtifacts(rows: Record<string, any>[]): Promise<void> {
  await pool().query(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          legacy_project_id TEXT,
          artifact_bucket TEXT,
          artifact_key TEXT,
          manifest_key TEXT,
          artifact_status TEXT,
          artifact_manifest JSONB
        )
    )
    INSERT INTO legacy_migration_projects (
      legacy_project_id,
      artifact_bucket,
      artifact_key,
      manifest_key,
      artifact_status,
      artifact_manifest,
      metadata,
      created,
      updated
    )
    SELECT legacy_project_id,
           artifact_bucket,
           artifact_key,
           manifest_key,
           COALESCE(NULLIF(artifact_status, ''), 'available'),
           artifact_manifest,
           '{}'::jsonb,
           NOW(),
           NOW()
      FROM input
     WHERE COALESCE(legacy_project_id, '') <> ''
    ON CONFLICT (legacy_project_id) DO UPDATE SET
      artifact_bucket=EXCLUDED.artifact_bucket,
      artifact_key=EXCLUDED.artifact_key,
      manifest_key=EXCLUDED.manifest_key,
      artifact_status=EXCLUDED.artifact_status,
      artifact_manifest=EXCLUDED.artifact_manifest,
      updated=NOW()
    `,
    [JSON.stringify(rows)],
  );
}

async function ensureRawRecordsSchema(): Promise<void> {
  rawRecordsSchemaReady ??= (async () => {
    await pool().query(`
      CREATE TABLE IF NOT EXISTS legacy_migration_raw_records (
        source VARCHAR(64) NOT NULL,
        legacy_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created TIMESTAMP NOT NULL DEFAULT NOW(),
        updated TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, legacy_id)
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_raw_records_updated_idx
        ON legacy_migration_raw_records(updated)
    `);
  })();
  await rawRecordsSchemaReady;
}

function rawRecordId(row: Record<string, any>): string | null {
  return (
    clean(row.id) ??
    clean(row.legacy_project_id) ??
    clean(row.legacy_account_id) ??
    clean(row.invoice_id)
  );
}

async function upsertRawRecords(
  source: ImportTarget,
  rows: Record<string, any>[],
): Promise<void> {
  await ensureRawRecordsSchema();
  const payload = rows
    .map((row) => ({
      source,
      legacy_id: rawRecordId(row),
      payload: row,
    }))
    .filter((row) => row.legacy_id != null);
  if (payload.length === 0) return;
  await pool().query(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          source TEXT,
          legacy_id TEXT,
          payload JSONB
        )
    )
    INSERT INTO legacy_migration_raw_records (
      source,
      legacy_id,
      payload,
      created,
      updated
    )
    SELECT source,
           legacy_id,
           COALESCE(payload, '{}'::jsonb),
           NOW(),
           NOW()
      FROM input
     WHERE COALESCE(source, '') <> ''
       AND COALESCE(legacy_id, '') <> ''
    ON CONFLICT (source, legacy_id) DO UPDATE SET
      payload=EXCLUDED.payload,
      updated=NOW()
    `,
    [JSON.stringify(payload)],
  );
}

async function writeBatch(
  target: ImportTarget,
  rows: Record<string, any>[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun || rows.length === 0) return;
  if (target === "accounts") {
    await upsertAccounts(rows);
  } else if (target === "projects") {
    await upsertProjects(rows);
  } else if (target === "artifacts") {
    await upsertArtifacts(rows);
  } else {
    await upsertRawRecords(target, rows);
  }
}

async function importFile({
  file,
  target,
  options,
}: {
  file: string;
  target: ImportTarget;
  options: Options;
}): Promise<ImportStats> {
  const batch: Record<string, any>[] = [];
  const repairedRowsStart = repairedRows;
  let rows = 0;
  let batches = 0;
  for await (const row of readRows(file, options.limit)) {
    normalizeRow(target, row);
    batch.push(row);
    rows += 1;
    if (batch.length >= options.batchSize) {
      await writeBatch(target, batch, options.dryRun);
      batches += 1;
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    await writeBatch(target, batch, options.dryRun);
    batches += 1;
  }
  return {
    file,
    rows,
    batches,
    repairedRows: repairedRows - repairedRowsStart,
  };
}

function normalizeRow(target: ImportTarget, row: Record<string, any>): void {
  if (target === "accounts") {
    row.legacy_account_id = clean(row.legacy_account_id);
    row.email_address = clean(row.email_address)?.toLowerCase() ?? null;
    row.first_name = clean(row.first_name);
    row.last_name = clean(row.last_name);
    row.display_name = clean(row.display_name);
  } else if (target === "projects") {
    row.legacy_project_id = clean(row.legacy_project_id);
    row.owner_legacy_account_id = clean(row.owner_legacy_account_id);
    row.title = clean(row.title);
    row.description = clean(row.description);
    row.artifact_bucket = clean(row.artifact_bucket);
    row.artifact_key = clean(row.artifact_key);
    row.manifest_key = clean(row.manifest_key);
    row.artifact_status = clean(row.artifact_status) ?? "unknown";
    if (!row.artifact_key && row.legacy_project_id) {
      row.artifact_bucket = row.artifact_bucket ?? DEFAULT_ARTIFACT_BUCKET;
      row.artifact_key = defaultArtifactKey(row.legacy_project_id);
      row.artifact_status = "available";
    }
  } else if (target === "artifacts") {
    row.legacy_project_id = clean(row.legacy_project_id);
    row.artifact_bucket = clean(row.artifact_bucket);
    row.artifact_key = clean(row.artifact_key);
    row.manifest_key = clean(row.manifest_key);
    row.artifact_status = clean(row.artifact_status) ?? "available";
  } else {
    row.id = clean(row.id);
    row.legacy_account_id = clean(row.legacy_account_id);
    row.legacy_project_id = clean(row.legacy_project_id);
  }
}

async function filesToImport(
  options: Options,
): Promise<{ file: string; target: ImportTarget }[]> {
  if (!options.dir) {
    throw new Error("--dir is required to import dump files");
  }
  const dir = options.dir;
  const entries = await readdir(dir);
  const files = entries
    .filter((file) => file.endsWith(".ndjson.gz"))
    .map((file) => join(dir, file))
    .map((file) => ({ file, target: targetForFile(file) }))
    .filter(
      (x): x is { file: string; target: ImportTarget } => x.target != null,
    )
    .filter((x) => !options.only || options.only.has(x.target));
  const order: Record<ImportTarget, number> = {
    accounts: 0,
    projects: 1,
    artifacts: 2,
    purchases: 3,
    subscriptions: 4,
    site_licenses: 5,
  };
  return files.sort((a, b) => order[a.target] - order[b.target]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dir) {
    if (options.dryRun) {
      console.log(
        "skipping Legacy Projects button backfill because --dry-run is set",
      );
    } else {
      const changed = await enableLegacyProjectsButtonForMatchingAccounts();
      console.log(
        `enabled Legacy Projects button for ${changed} matching account(s)`,
      );
    }
    return;
  }
  const manifest = await loadManifest(options.dir);
  if (manifest) {
    console.log(
      `legacy migration dump: ${manifest.format ?? "unknown"} ${manifest.created ?? ""}`,
    );
  }
  const files = await filesToImport(options);
  if (files.length === 0) {
    throw new Error(`no supported dump files found in ${options.dir}`);
  }
  for (const { file, target } of files) {
    console.log(`importing ${target} from ${file}`);
    const stats = await importFile({ file, target, options });
    console.log(
      `imported ${stats.rows} ${target} row(s) from ${basename(stats.file)} in ${stats.batches} batch(es)`,
    );
    if (stats.repairedRows > 0) {
      console.log(
        `repaired ${stats.repairedRows} legacy over-escaped JSON row(s) in ${basename(stats.file)}`,
      );
    }
  }
  if (options.enableLegacyProjectsButton) {
    if (options.dryRun) {
      console.log(
        "skipping Legacy Projects button backfill because --dry-run is set",
      );
    } else {
      const changed = await enableLegacyProjectsButtonForMatchingAccounts();
      console.log(
        `enabled Legacy Projects button for ${changed} matching account(s)`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (poolUsed) {
      await getPool().end();
    }
  });
