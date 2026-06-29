/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import getPool from "@cocalc/database/pool";
import {
  ensurePublicDirectorySharesSchema,
  normalizePublicDirectorySharePath,
  normalizePublicDirectoryShareSlug,
} from "@cocalc/server/public-directory-shares";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { is_valid_uuid_string as isValidUUID } from "@cocalc/util/misc";
import { OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON } from "@cocalc/util/legacy-migration";

type ImportTarget =
  | "accounts"
  | "projects"
  | "artifacts"
  | "purchases"
  | "subscriptions"
  | "site_licenses"
  | "public_paths";

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
  publicPathDetails?: PublicPathImportCounters;
};

type PublicPathImportCounters = {
  duplicateSlugs: number;
  filePathsAsDirectories: number;
  invalidSiteLicenseIds: number;
  skippedInvalid: number;
  skippedMissingProject: number;
  skippedMissingRequired: number;
};

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_ARTIFACT_BUCKET = "cocalc-projects";
const DEFAULT_ARTIFACT_KEY_PREFIX = "prod3/default/";
const DEFAULT_ARTIFACT_KEY_SUFFIX = ".tar.zst";
const LEGACY_SOURCE_PROJECT_LABEL = "legacy.cocalc.com/project_id";
let poolUsed = false;
let rawRecordsSchemaReady: Promise<void> | undefined;
let projectsSchemaReady: Promise<void> | undefined;
let accountsSchemaReady: Promise<void> | undefined;
let repairedRows = 0;
const publicPathCounters: PublicPathImportCounters = {
  duplicateSlugs: 0,
  filePathsAsDirectories: 0,
  invalidSiteLicenseIds: 0,
  skippedInvalid: 0,
  skippedMissingProject: 0,
  skippedMissingRequired: 0,
};
const seenPublicPathSlugs = new Map<string, string>();

function publicPathCounterSnapshot(): PublicPathImportCounters {
  return { ...publicPathCounters };
}

function publicPathCounterDelta(
  before: PublicPathImportCounters,
): PublicPathImportCounters {
  return {
    duplicateSlugs: publicPathCounters.duplicateSlugs - before.duplicateSlugs,
    filePathsAsDirectories:
      publicPathCounters.filePathsAsDirectories - before.filePathsAsDirectories,
    invalidSiteLicenseIds:
      publicPathCounters.invalidSiteLicenseIds - before.invalidSiteLicenseIds,
    skippedInvalid: publicPathCounters.skippedInvalid - before.skippedInvalid,
    skippedMissingProject:
      publicPathCounters.skippedMissingProject - before.skippedMissingProject,
    skippedMissingRequired:
      publicPathCounters.skippedMissingRequired - before.skippedMissingRequired,
  };
}

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
  --only <list>         Comma-separated import targets: accounts,projects,artifacts,purchases,subscriptions,site_licenses,public_paths.
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
      "public_paths",
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

async function ensureAccountsSchema(): Promise<void> {
  accountsSchemaReady ??= (async () => {
    await pool().query(`
      ALTER TABLE legacy_migration_accounts
        ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(128)
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_accounts_stripe_customer_id_idx
        ON legacy_migration_accounts(stripe_customer_id)
    `);
  })();
  await accountsSchemaReady;
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
  if (name === "public_paths.ndjson.gz") return "public_paths";
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
  await ensureAccountsSchema();
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
          stripe_customer_id TEXT,
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
      stripe_customer_id,
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
           NULLIF(stripe_customer_id, ''),
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
      stripe_customer_id=EXCLUDED.stripe_customer_id,
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

function legacyPublicPathSlug(row: Record<string, any>): string {
  const raw =
    clean(row.url) ??
    clean(row.name) ??
    (clean(row.project_id) && clean(row.path)
      ? `${clean(row.project_id)}/${clean(row.path)}`
      : null);
  if (!raw) {
    throw Error("public_paths row has no usable url, name, or project/path");
  }
  let slug = raw.trim();
  try {
    if (/^https?:\/\//i.test(slug)) {
      slug = new URL(slug).pathname;
    }
  } catch {
    // Fall through to path-style normalization below.
  }
  slug = slug.replace(/^\/+|\/+$/g, "");
  if (slug.toLowerCase().startsWith("share/")) {
    slug = slug.slice("share/".length);
  }
  return normalizePublicDirectoryShareSlug(slug);
}

function uniqueLegacyPublicPathSlug({
  slug,
  legacyId,
}: {
  slug: string;
  legacyId: string;
}): string {
  const key = slug.toLowerCase();
  const existing = seenPublicPathSlugs.get(key);
  if (existing == null || existing === legacyId) {
    seenPublicPathSlugs.set(key, legacyId);
    return slug;
  }
  publicPathCounters.duplicateSlugs += 1;
  const prefix = legacyId.slice(0, 10);
  return normalizePublicDirectoryShareSlug(`${slug}~${prefix}`);
}

function looksLikeLegacyFilePath(path: string): boolean {
  if (path === ".") return false;
  const tail = posix.basename(path);
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(tail);
}

function normalizeLegacyPublicPathSharePath(rawPath: unknown): {
  path: string;
  original_path: string;
  original_path_type: "directory" | "file";
} {
  const originalPath = normalizePublicDirectorySharePath(clean(rawPath) ?? ".");
  if (!looksLikeLegacyFilePath(originalPath)) {
    return {
      path: originalPath,
      original_path: originalPath,
      original_path_type: "directory",
    };
  }
  publicPathCounters.filePathsAsDirectories += 1;
  return {
    path: normalizePublicDirectorySharePath(posix.dirname(originalPath)),
    original_path: originalPath,
    original_path_type: "file",
  };
}

function validUuidOrNull(value: unknown): string | null {
  const normalized = clean(value);
  if (normalized == null) {
    return null;
  }
  if (isValidUUID(normalized)) {
    return normalized;
  }
  publicPathCounters.invalidSiteLicenseIds += 1;
  return null;
}

async function upsertPublicPaths(rows: Record<string, any>[]): Promise<void> {
  await ensurePublicDirectorySharesSchema();
  const payload = rows
    .map((row) => ({
      skip_public_path: row.__skip_public_path === true,
      legacy_public_path_id: clean(row.id),
      project_id: clean(row.project_id),
      path: clean(row.path) ?? ".",
      original_path: clean(row.original_path) ?? clean(row.path) ?? ".",
      original_path_type: clean(row.original_path_type) ?? "directory",
      slug: clean(row.slug),
      visibility: row.disabled
        ? "disabled"
        : row.unlisted
          ? "unlisted"
          : "listed",
      requires_auth: true,
      title: clean(row.title) ?? clean(row.name),
      description: clean(row.description),
      license: clean(row.license),
      image: clean(row.image),
      redirect: clean(row.redirect),
      site_license_id: clean(row.site_license_id),
      legacy_url: clean(row.url),
      created_at: row.created ?? null,
      metadata: {
        authenticated: row.authenticated ?? null,
        auth: row.auth ?? null,
        compute_image: row.compute_image ?? null,
        counter: row.counter ?? null,
        legacy_path: clean(row.original_path) ?? clean(row.path) ?? null,
        legacy_path_type: clean(row.original_path_type) ?? "directory",
        legacy_site_license_id: clean(row.legacy_site_license_id),
        jupyter_api: row.jupyter_api ?? null,
        token: row.token ?? null,
        vhost: row.vhost ?? null,
      },
      last_edited: row.last_edited ?? row.last_saved ?? null,
      disabled: row.disabled === true,
    }))
    .filter((row) => {
      if (row.skip_public_path === true) {
        return false;
      }
      if (row.legacy_public_path_id && row.project_id && row.slug) {
        return true;
      }
      publicPathCounters.skippedMissingRequired += 1;
      return false;
    });
  if (payload.length === 0) return;
  const { rows: resultRows } = await pool().query<{
    skipped_missing_project: number;
  }>(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          legacy_public_path_id TEXT,
          project_id UUID,
          path TEXT,
          slug TEXT,
          visibility TEXT,
          requires_auth BOOLEAN,
          title TEXT,
          description TEXT,
          license TEXT,
          image TEXT,
          redirect TEXT,
          site_license_id UUID,
          legacy_url TEXT,
          created_at TIMESTAMPTZ,
          metadata JSONB,
          last_edited TIMESTAMPTZ,
          disabled BOOLEAN
        )
    ),
    missing_project AS (
      SELECT input.legacy_public_path_id
        FROM input
        LEFT JOIN projects ON projects.project_id=input.project_id
       WHERE input.legacy_public_path_id IS NOT NULL
         AND projects.project_id IS NULL
    ),
    deleted_paths AS (
      DELETE FROM public_project_paths p
       USING missing_project
       WHERE p.legacy_public_path_id=missing_project.legacy_public_path_id
      RETURNING p.id
    ),
    deleted_slug_rows AS (
      DELETE FROM public_project_path_slugs s
       USING deleted_paths
       WHERE s.public_project_path_id=deleted_paths.id
      RETURNING 1
    ),
    prepared AS (
      SELECT input.*,
             'available'::text AS availability_status,
             NULL::text AS availability_message
        FROM input
        JOIN projects ON projects.project_id=input.project_id
    ),
    upserted AS (
      INSERT INTO public_project_paths (
        id, project_id, path, slug, visibility, requires_auth,
        availability_status, availability_message, title, description, license,
        image, redirect, site_license_id, metadata, legacy_public_path_id,
        legacy_url, last_edited, disabled, created_at, updated_at
      )
      SELECT gen_random_uuid(),
             project_id,
             path,
             slug,
             visibility,
             COALESCE(requires_auth, true),
             availability_status,
             availability_message,
             title,
             description,
             license,
             image,
             redirect,
             site_license_id,
             COALESCE(metadata, '{}'::jsonb),
             legacy_public_path_id,
             legacy_url,
             last_edited,
             COALESCE(disabled, false) OR visibility='disabled',
             COALESCE(created_at, NOW()),
             NOW()
        FROM prepared
       WHERE legacy_public_path_id IS NOT NULL
         AND project_id IS NOT NULL
         AND COALESCE(slug, '') <> ''
      ON CONFLICT (legacy_public_path_id)
        WHERE legacy_public_path_id IS NOT NULL
      DO UPDATE SET
        project_id=EXCLUDED.project_id,
        path=EXCLUDED.path,
        slug=EXCLUDED.slug,
        visibility=EXCLUDED.visibility,
        requires_auth=EXCLUDED.requires_auth,
        availability_status=EXCLUDED.availability_status,
        availability_message=EXCLUDED.availability_message,
        title=EXCLUDED.title,
        description=EXCLUDED.description,
        license=EXCLUDED.license,
        image=EXCLUDED.image,
        redirect=EXCLUDED.redirect,
        site_license_id=EXCLUDED.site_license_id,
        metadata=EXCLUDED.metadata,
        legacy_url=EXCLUDED.legacy_url,
        created_at=EXCLUDED.created_at,
        last_edited=EXCLUDED.last_edited,
        disabled=EXCLUDED.disabled,
        updated_at=NOW()
      RETURNING id, project_id, slug, disabled
    ),
    upserted_slug_rows AS (
    INSERT INTO public_project_path_slugs (
      slug_lower, slug, owning_bay_id, public_project_path_id, project_id,
      disabled, updated_at
    )
    SELECT lower(slug), slug, $2, id, project_id, disabled, NOW()
      FROM upserted
    ON CONFLICT (slug_lower) DO UPDATE SET
      slug=EXCLUDED.slug,
      owning_bay_id=EXCLUDED.owning_bay_id,
      public_project_path_id=EXCLUDED.public_project_path_id,
      project_id=EXCLUDED.project_id,
      disabled=EXCLUDED.disabled,
      updated_at=NOW()
      RETURNING 1
    )
    SELECT COUNT(*)::int AS skipped_missing_project
      FROM missing_project
    `,
    [JSON.stringify(payload), getConfiguredBayId()],
  );
  publicPathCounters.skippedMissingProject +=
    resultRows[0]?.skipped_missing_project ?? 0;
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
  } else if (target === "public_paths") {
    await upsertPublicPaths(rows);
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
  const publicPathCountersStart =
    target === "public_paths" ? publicPathCounterSnapshot() : undefined;
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
    publicPathDetails: publicPathCountersStart
      ? publicPathCounterDelta(publicPathCountersStart)
      : undefined,
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
  } else if (target === "public_paths") {
    row.id = clean(row.id);
    row.project_id = clean(row.project_id);
    if (!row.id || !row.project_id || !isValidUUID(row.project_id)) {
      row.__skip_public_path = true;
      publicPathCounters.skippedMissingRequired += 1;
      return;
    }
    try {
      const slug = legacyPublicPathSlug(row);
      const sharePath = normalizeLegacyPublicPathSharePath(row.path);
      row.path = sharePath.path;
      row.original_path = sharePath.original_path;
      row.original_path_type = sharePath.original_path_type;
      row.slug = uniqueLegacyPublicPathSlug({
        slug,
        legacyId: row.id,
      });
    } catch {
      row.__skip_public_path = true;
      publicPathCounters.skippedInvalid += 1;
      return;
    }
    row.name = clean(row.name);
    row.description = clean(row.description);
    row.url = clean(row.url);
    row.legacy_site_license_id = clean(row.site_license_id);
    row.site_license_id = validUuidOrNull(row.site_license_id);
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
    public_paths: 6,
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
    if (stats.publicPathDetails) {
      const details = stats.publicPathDetails;
      console.log(
        `public_paths details: ${details.filePathsAsDirectories} file path(s) imported as containing directories; ${details.duplicateSlugs} duplicate slug(s) suffixed; ${details.invalidSiteLicenseIds} invalid site_license_id value(s) preserved in metadata; ${details.skippedInvalid} invalid row(s) skipped; ${details.skippedMissingProject} row(s) skipped because the project has not been migrated; ${details.skippedMissingRequired} row(s) skipped due to missing required fields`,
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
