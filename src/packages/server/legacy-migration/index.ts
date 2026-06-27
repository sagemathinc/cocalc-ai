/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getTransactionClient, type PoolClient } from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import createProject, {
  createProjectWithInternalProjectId,
} from "@cocalc/server/projects/create";
import createCredit from "@cocalc/server/purchases/create-credit";
import createSubscription from "@cocalc/server/purchases/create-subscription";
import { getSeedMembershipTierMap } from "@cocalc/server/membership/tiers";
import type { MembershipTierRecord } from "@cocalc/server/membership/tiers";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { resolveHostBayAcrossCluster } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  selectActiveHost,
  syncProjectUsersOnHost,
} from "@cocalc/server/project-host/control";
import { setProjectLabels } from "@cocalc/server/projects/labels";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import {
  assertCanIncreaseAccountStorage,
  getAccountStorageRemainingBytes,
} from "@cocalc/server/membership/project-limits";
import { issueSignedObjectDownload } from "@cocalc/server/project-backup/r2";
import { createLro } from "@cocalc/server/lro/lro-db";
import { triggerLegacyMigrationProjectRestoreWorker } from "@cocalc/server/legacy-migration/restore-worker";
import {
  LEGACY_PROJECT_RESTORE_LRO_KIND,
  LEGACY_RESTORE_ERROR_LABEL,
  LEGACY_RESTORE_LRO_LABEL,
  LEGACY_RESTORE_STATUS_LABEL,
  LEGACY_SOURCE_PROJECT_LABEL,
} from "@cocalc/util/legacy-migration";
import type {
  ProjectArchiveIndexResult,
  ProjectArchiveRestoreResult,
  SignedProjectArchiveDownload,
} from "@cocalc/conat/files/file-server";
import type {
  LegacyMigrationArchiveIndex,
  LegacyMigrationApplyFinancialHomeBayOptions,
  LegacyMigrationApplyFinancialHomeBayResponse,
  LegacyMigrationApplyFinancialOptions,
  LegacyMigrationApplyFinancialResponse,
  LegacyMigrationEntitlementCredit,
  LegacyMigrationFinancialAccount,
  LegacyMigrationFinancialPreviewOptions,
  LegacyMigrationFinancialPreviewResponse,
  LegacyMigrationMembershipPlan,
  LegacyMigrationImportProjectResult,
  LegacyMigrationImportProjectsOptions,
  LegacyMigrationImportProjectsResponse,
  LegacyMigrationListProjectsOptions,
  LegacyMigrationListProjectsResponse,
  LegacyMigrationMatchedAccount,
  LegacyMigrationPrepareArchiveSelectionOptions,
  LegacyMigrationPrepareArchiveSelectionResponse,
  LegacyMigrationProjectRestoreMode,
  LegacyMigrationProjectRestoreStatus,
  LegacyMigrationProjectSummary,
  LegacyMigrationRetryProjectRestoreOptions,
  LegacyMigrationRetryProjectRestoreResponse,
  LegacyMigrationRestoreArchiveSelectionOptions,
  LegacyMigrationRestoreArchiveSelectionResponse,
} from "@cocalc/conat/hub/api/legacy-migration";

import { assertLegacyMigrationEnabled } from "./enabled";
import { moneyRound2Up, moneyToDbString, toDecimal } from "@cocalc/util/money";
import { isValidUUID } from "@cocalc/util/misc";
import { mapCloudRegionToR2Region, parseR2Region } from "@cocalc/util/consts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_LEGACY_PROJECTS_BUCKET = "cocalc-projects";
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;
const PROJECT_ARCHIVE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_INDEX_MAX_ENTRIES = 5_000;
const MAX_ARCHIVE_INDEX_MAX_ENTRIES = 50_000;
const LEGACY_STRIPE_UPGRADE_PLAN_IDS = new Set([
  "standard",
  "premium",
  "professional",
  "standard2",
  "premium2",
  "professional2",
]);
const LEGACY_MIGRATION_STANDARD_ANNUALIZED_CUTOFF = 150;
const LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS = 30;

const logger = getLogger("server:legacy-migration");

type AccountEmailRow = {
  email_address: string | null;
  email_address_verified: Record<string, unknown> | null;
};

type LegacyAccountRow = {
  legacy_account_id: string;
  email_address: string | null;
  display_name: string | null;
  stripe_customer_id: string | null;
};

type AccountPrimaryEmailStatus = {
  email: string | null;
  verified: boolean;
};

type LegacyProjectRow = {
  legacy_project_id: string;
  title: string | null;
  description: string | null;
  owner_legacy_account_id: string | null;
  legacy_users: Record<string, unknown> | null;
  hidden: boolean | null;
  last_edited: Date | string | null;
  last_active: Date | string | null;
  disk_mb: number | string | null;
  artifact_bucket: string | null;
  artifact_key: string | null;
  manifest_key: string | null;
  artifact_status: string | null;
  artifact_manifest: Record<string, any> | null;
  matched_legacy_account_ids?: string[] | null;
  project_id?: string | null;
  owner_account_id?: string | null;
  status?: string | null;
  restore_mode?: LegacyMigrationProjectRestoreMode | null;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  restore_error?: string | null;
  restore_lro_op_id?: string | null;
  restore_progress?: Record<string, any> | null;
  restore_result?: Record<string, any> | null;
  joined?: boolean | null;
  total_count?: number | null;
};

let importSchemaReady: Promise<void> | undefined;
let financialSchemaReady: Promise<void> | undefined;

async function ensureLegacyMigrationProjectImportSchema(): Promise<void> {
  importSchemaReady ??= (async () => {
    await getPool().query(`
      ALTER TABLE legacy_migration_project_imports
        ADD COLUMN IF NOT EXISTS restore_mode VARCHAR(32),
        ADD COLUMN IF NOT EXISTS restore_attempts INTEGER,
        ADD COLUMN IF NOT EXISTS restore_worker_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS restore_host_id UUID,
        ADD COLUMN IF NOT EXISTS restore_claimed_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_started TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_finished TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_lro_op_id UUID,
        ADD COLUMN IF NOT EXISTS restore_progress JSONB,
        ADD COLUMN IF NOT EXISTS restore_result JSONB
    `);
    await getPool().query(`
      ALTER TABLE legacy_migration_projects
        ADD COLUMN IF NOT EXISTS disk_mb DOUBLE PRECISION
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_projects_disk_mb_idx
        ON legacy_migration_projects(disk_mb)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_project_imports_restore_lro_op_id_idx
        ON legacy_migration_project_imports(restore_lro_op_id)
    `);
  })();
  await importSchemaReady;
}

async function ensureLegacyMigrationFinancialSchema(): Promise<void> {
  financialSchemaReady ??= (async () => {
    await getPool().query(`
      ALTER TABLE legacy_migration_accounts
        ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(128)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_accounts_stripe_customer_id_idx
        ON legacy_migration_accounts(stripe_customer_id)
    `);
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS legacy_migration_raw_records (
        source VARCHAR(64) NOT NULL,
        legacy_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created TIMESTAMP NOT NULL DEFAULT NOW(),
        updated TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, legacy_id)
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_raw_records_updated_idx
        ON legacy_migration_raw_records(updated)
    `);
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS legacy_migration_financial_claims (
        legacy_account_id VARCHAR(128) PRIMARY KEY,
        account_id UUID NOT NULL,
        status VARCHAR(32) NOT NULL,
        credit_amount numeric(20,10),
        credit_purchase_id INTEGER,
        selected_membership_class VARCHAR(128),
        selected_membership_interval VARCHAR(16),
        subscription_id INTEGER,
        stripe_customer_id VARCHAR(128),
        applied_at TIMESTAMP,
        metadata JSONB,
        created TIMESTAMP NOT NULL DEFAULT NOW(),
        updated TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_financial_claims_account_id_idx
        ON legacy_migration_financial_claims(account_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_financial_claims_status_idx
        ON legacy_migration_financial_claims(status)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_financial_claims_credit_purchase_id_idx
        ON legacy_migration_financial_claims(credit_purchase_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_financial_claims_subscription_id_idx
        ON legacy_migration_financial_claims(subscription_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_financial_claims_updated_idx
        ON legacy_migration_financial_claims(updated)
    `);
  })();
  await financialSchemaReady;
}

function normalizeEmail(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function gmailCanonicalEmail(email: string): string | null {
  const [local, domain] = email.split("@");
  if (!local || !domain) return null;
  if (domain !== "gmail.com" && domain !== "googlemail.com") return null;
  const base = local.split("+")[0]?.replace(/\./g, "");
  return base ? `${base}@gmail.com` : null;
}

function limitValue(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function projectTitle(
  row: Pick<LegacyProjectRow, "title" | "legacy_project_id">,
) {
  const title = `${row.title ?? ""}`.trim();
  return title || `Imported CoCalc project ${row.legacy_project_id}`;
}

function projectDescription(row: LegacyProjectRow): string {
  const parts = [`Imported from cocalc.com project ${row.legacy_project_id}.`];
  const description = `${row.description ?? ""}`.trim();
  if (description) {
    parts.push("", description);
  }
  return parts.join("\n");
}

function restoreStatusForProject(
  row: Pick<
    LegacyProjectRow,
    "artifact_status" | "artifact_key" | "artifact_manifest"
  >,
  restore_mode: LegacyMigrationProjectRestoreMode = "full",
): LegacyMigrationProjectRestoreStatus {
  if (!legacyArchiveAvailable(row)) {
    return "skipped";
  }
  return restore_mode === "select" ? "selection-pending" : "pending";
}

function normalizeRestoreMode(
  mode: unknown,
): LegacyMigrationProjectRestoreMode {
  if (mode == null || mode === "") return "full";
  if (mode === "full" || mode === "select") return mode;
  throw new Error(`unsupported legacy project restore mode '${mode}'`);
}

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function nonnegativeNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nestedValue(obj: any, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

export function legacyProjectArchiveUncompressedBytes(
  manifest: Record<string, any> | null | undefined,
): number | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const paths = [
    ["uncompressed_bytes"],
    ["uncompressed_size_bytes"],
    ["total_uncompressed_bytes"],
    ["expanded_bytes"],
    ["logical_bytes"],
    ["file_bytes"],
    ["files_bytes"],
    ["total_file_bytes"],
    ["project_size_bytes"],
    ["project_uncompressed_bytes"],
    ["archive_uncompressed_bytes"],
    ["tar_bytes"],
    ["tar", "bytes"],
    ["tar", "uncompressed_bytes"],
    ["archive", "uncompressed_bytes"],
    ["archive", "tar_bytes"],
    ["stats", "uncompressed_bytes"],
    ["stats", "total_file_bytes"],
  ];
  for (const path of paths) {
    const value = positiveInteger(nestedValue(manifest, path));
    if (value != null) return value;
  }
  return undefined;
}

function manifestNumber(
  manifest: Record<string, any> | null | undefined,
  paths: string[][],
): number | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  for (const path of paths) {
    const value = positiveInteger(nestedValue(manifest, path));
    if (value != null) return value;
  }
  return undefined;
}

function manifestCompressedBytes(
  manifest: Record<string, any> | null | undefined,
): number | undefined {
  return manifestNumber(manifest, [
    ["compressed_bytes"],
    ["compressed_size_bytes"],
    ["artifact_bytes"],
    ["object_bytes"],
    ["r2_bytes"],
    ["archive", "compressed_bytes"],
    ["archive", "object_bytes"],
    ["artifact", "bytes"],
  ]);
}

function legacyArchiveAvailable(
  row: Pick<
    LegacyProjectRow,
    "artifact_status" | "artifact_key" | "artifact_manifest"
  >,
): boolean {
  return (
    row.artifact_status === "available" &&
    !!clean(row.artifact_key) &&
    manifestCompressedBytes(row.artifact_manifest) != null
  );
}

function manifestSha256(
  manifest: Record<string, any> | null | undefined,
): string | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const paths = [
    ["sha256"],
    ["content_sha256"],
    ["artifact_sha256"],
    ["compressed_sha256"],
    ["object_sha256"],
    ["archive", "sha256"],
    ["archive", "compressed_sha256"],
    ["artifact", "sha256"],
  ];
  for (const path of paths) {
    const value = `${nestedValue(manifest, path) ?? ""}`.trim();
    if (value) return value.toLowerCase();
  }
  return undefined;
}

function importStatus(row: LegacyProjectRow): LegacyMigrationProjectSummary {
  return {
    legacy_project_id: row.legacy_project_id,
    title: projectTitle(row),
    description: row.description,
    last_edited: row.last_edited,
    last_active: row.last_active,
    hidden: row.hidden,
    disk_mb: nonnegativeNumber(row.disk_mb),
    artifact_bytes: manifestCompressedBytes(row.artifact_manifest) ?? null,
    artifact_status: row.artifact_status,
    artifact_bucket: row.artifact_bucket,
    artifact_key: row.artifact_key,
    manifest_key: row.manifest_key,
    artifact_manifest: row.artifact_manifest,
    matched_legacy_account_ids: row.matched_legacy_account_ids ?? [],
    project_id: row.project_id,
    owner_account_id: row.owner_account_id,
    import_status:
      row.status === "creating" || row.status === "failed"
        ? row.status
        : row.project_id
          ? "imported"
          : "not-imported",
    restore_status: row.restore_status,
    restore_error: row.restore_error,
    restore_lro_op_id: row.restore_lro_op_id,
    restore_progress: row.restore_progress,
    restore_mode: row.restore_mode,
    restore_result: row.restore_result,
    joined: !!row.joined,
  };
}

async function verifiedAccountEmails(account_id: string): Promise<string[]> {
  const { rows } = await getPool().query<AccountEmailRow>(
    `SELECT email_address, email_address_verified
       FROM accounts
      WHERE account_id=$1`,
    [account_id],
  );
  const row = rows[0];
  if (row == null) {
    const account = await getClusterAccountById(account_id);
    const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
    if (homeBayId && homeBayId !== getConfiguredBayId()) {
      const { email_addresses } = await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: homeBayId,
      }).getVerifiedEmailAddresses({ account_id });
      return [
        ...new Set(
          email_addresses
            .map(normalizeEmail)
            .filter((email): email is string => email != null),
        ),
      ].sort();
    }
    const primary = normalizeEmail(account?.email_address);
    return primary && account?.email_address_verified ? [primary] : [];
  }
  const verified = row?.email_address_verified ?? {};
  const emails = new Set<string>();
  for (const [email, value] of Object.entries(verified)) {
    if (value) {
      const normalized = normalizeEmail(email);
      if (normalized) emails.add(normalized);
    }
  }
  const primary = normalizeEmail(row?.email_address);
  if (primary && verified[primary]) emails.add(primary);
  return [...emails].sort();
}

async function accountPrimaryEmailStatus(
  account_id: string,
): Promise<AccountPrimaryEmailStatus> {
  const { rows } = await getPool().query<AccountEmailRow>(
    `SELECT email_address, email_address_verified
       FROM accounts
      WHERE account_id=$1`,
    [account_id],
  );
  const row = rows[0];
  if (row != null) {
    const email = normalizeEmail(row.email_address) || null;
    if (!email) return { email: null, verified: false };
    return {
      email,
      verified: !!(row.email_address_verified ?? {})[email],
    };
  }
  const account = await getClusterAccountById(account_id);
  const email = normalizeEmail(account?.email_address) || null;
  if (!email) return { email: null, verified: false };
  const verifiedEmails = new Set(await verifiedAccountEmails(account_id));
  return {
    email,
    verified: verifiedEmails.has(email),
  };
}

async function unverifiedLegacyEmailMatches(account_id: string): Promise<{
  email: string | null;
  matches: LegacyMigrationMatchedAccount[];
}> {
  const { email, verified } = await accountPrimaryEmailStatus(account_id);
  if (!email || verified) return { email, matches: [] };
  const gmailCanonical = gmailCanonicalEmail(email);
  const { rows } = await getPool().query<LegacyMigrationMatchedAccount>(
    `
    WITH candidates AS (
      SELECT legacy_account_id,
             email_address,
             display_name,
             lower(email_address) AS exact_email,
             CASE
               WHEN split_part(lower(email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
                 THEN replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'
               ELSE NULL
             END AS gmail_canonical_email,
             last_active
        FROM legacy_migration_accounts
       WHERE COALESCE(email_address_verified, false)=true
    )
    SELECT legacy_account_id,
           email_address,
           display_name,
           CASE
             WHEN exact_email=$1 THEN 'exact-email'
             ELSE 'gmail-canonical'
           END AS match_method,
           gmail_canonical_email
      FROM candidates
     WHERE exact_email=$1
        OR (
          $2::TEXT IS NOT NULL
          AND gmail_canonical_email=$2::TEXT
        )
     ORDER BY last_active DESC NULLS LAST,
              legacy_account_id
    `,
    [email, gmailCanonical],
  );
  return {
    email,
    matches: rows.map((row) => ({
      legacy_account_id: row.legacy_account_id,
      email_address: normalizeEmail(row.email_address) || null,
      display_name: row.display_name ?? null,
      match_method: row.match_method ?? null,
      gmail_canonical_email: normalizeEmail(row.gmail_canonical_email) || null,
    })),
  };
}

async function ensureVerifiedEmailLinks(account_id: string): Promise<void> {
  const emails = await verifiedAccountEmails(account_id);
  if (emails.length === 0) return;
  const gmailCanonicalEmails = Array.from(
    new Set(
      emails
        .map(gmailCanonicalEmail)
        .filter((email): email is string => email != null),
    ),
  );
  await getPool().query(
    `
    WITH candidates AS (
      SELECT legacy_account_id,
             email_address,
             lower(email_address) AS exact_email,
             CASE
               WHEN split_part(lower(email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
                 THEN replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'
               ELSE NULL
             END AS gmail_canonical_email
        FROM legacy_migration_accounts
       WHERE COALESCE(email_address_verified, false)=true
    )
    INSERT INTO legacy_migration_account_links
      (legacy_account_id, account_id, claim_method, metadata, created, updated)
    SELECT legacy_account_id,
           $1::UUID,
           'verified-email',
           jsonb_build_object(
             'email_address', email_address,
             'match_method',
             CASE
               WHEN exact_email=ANY($2::TEXT[]) THEN 'exact-email'
               ELSE 'gmail-canonical'
             END,
             'gmail_canonical_email', gmail_canonical_email
           ),
           NOW(),
           NOW()
      FROM candidates
     WHERE exact_email=ANY($2::TEXT[])
        OR (
          gmail_canonical_email IS NOT NULL
          AND gmail_canonical_email=ANY($3::TEXT[])
        )
    ON CONFLICT (legacy_account_id, account_id)
    DO UPDATE SET updated=NOW()
    `,
    [account_id, emails, gmailCanonicalEmails],
  );
}

async function legacyAccounts(
  account_id: string,
): Promise<LegacyMigrationMatchedAccount[]> {
  await ensureVerifiedEmailLinks(account_id);
  const { rows } = await getPool().query<
    LegacyMigrationMatchedAccount & {
      claim_method: string | null;
    }
  >(
    `SELECT linked.legacy_account_id,
            accounts.email_address,
            accounts.display_name,
            linked.metadata->>'match_method' AS match_method,
            linked.metadata->>'gmail_canonical_email' AS gmail_canonical_email
       FROM legacy_migration_account_links linked
       LEFT JOIN legacy_migration_accounts accounts
         ON accounts.legacy_account_id=linked.legacy_account_id
      WHERE linked.account_id=$1
      ORDER BY lower(COALESCE(accounts.email_address, '')),
               linked.legacy_account_id`,
    [account_id],
  );
  return rows.map((row) => ({
    legacy_account_id: row.legacy_account_id,
    email_address: normalizeEmail(row.email_address) || null,
    display_name: row.display_name ?? null,
    match_method: row.match_method ?? null,
    gmail_canonical_email: normalizeEmail(row.gmail_canonical_email) || null,
  }));
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positiveMoneyNumber(value: unknown): number {
  return Math.max(0, numberValue(value));
}

function toMoneyNumber(value: unknown): number {
  const numeric =
    typeof value === "number" || typeof value === "string" ? value : 0;
  const n = Number(toDecimal(numeric).toFixed(2));
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function dateMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ms =
    typeof value === "number" ? value * 1000 : new Date(`${value}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function dateIso(value: unknown): string | null {
  const ms = dateMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function generousRemainingCredit({
  periodCost,
  periodStart,
  periodEnd,
}: {
  periodCost: unknown;
  periodStart: unknown;
  periodEnd: unknown;
}): number {
  const cost = positiveMoneyNumber(periodCost);
  if (cost <= 0) return 0;
  const now = Date.now();
  const end = dateMs(periodEnd);
  if (end == null || end <= now) return 0;
  const start = dateMs(periodStart);
  const fraction =
    start != null && start < end ? Math.min(1, (end - now) / (end - start)) : 1;
  if (fraction <= 0) return 0;
  return toMoneyNumber(moneyRound2Up(toDecimal(cost).mul(fraction)).toString());
}

function subscriptionPeriodCost(row: Record<string, any>): number {
  return positiveMoneyNumber(row.cost);
}

function subscriptionInterval(row: Record<string, any>): "month" | "year" {
  return row.interval === "year" ? "year" : "month";
}

function subscriptionCredit(
  row: Record<string, any>,
): LegacyMigrationEntitlementCredit | null {
  const credit_amount = generousRemainingCredit({
    periodCost: subscriptionPeriodCost(row),
    periodStart: row.current_period_start,
    periodEnd: row.current_period_end,
  });
  if (credit_amount <= 0) return null;
  return {
    source: "subscription",
    id: `${row.id ?? ""}`,
    credit_amount,
    period_cost: subscriptionPeriodCost(row),
    period_start: dateIso(row.current_period_start),
    period_end: dateIso(row.current_period_end),
    interval: subscriptionInterval(row),
    status: clean(row.status) ?? null,
    description: clean(asRecord(row.metadata).type) ?? "legacy subscription",
  };
}

function siteLicenseOwner(row: Record<string, any>): string | null {
  return (
    clean(asRecord(asRecord(row.info).purchased).account_id) ??
    clean(asArray(row.managers)[0]) ??
    null
  );
}

function siteLicensePeriodCost(row: Record<string, any>): number {
  return positiveMoneyNumber(
    asRecord(asRecord(asRecord(row.info).purchased).cost).cost,
  );
}

function siteLicenseCredit(
  row: Record<string, any>,
): LegacyMigrationEntitlementCredit | null {
  const purchased = asRecord(asRecord(row.info).purchased);
  const credit_amount = generousRemainingCredit({
    periodCost: siteLicensePeriodCost(row),
    periodStart: purchased.start ?? row.activates ?? row.created,
    periodEnd: purchased.end ?? row.expires,
  });
  if (credit_amount <= 0) return null;
  return {
    source: "site_license",
    id: `${row.id ?? ""}`,
    credit_amount,
    period_cost: siteLicensePeriodCost(row),
    period_start: dateIso(purchased.start ?? row.activates ?? row.created),
    period_end: dateIso(purchased.end ?? row.expires),
    interval: clean(purchased.subscription) ?? null,
    status: "active",
    description: clean(row.title) ?? clean(row.description) ?? "site license",
  };
}

function csvStripeSubscriptionPlanBase(
  row: Record<string, any>,
): string | null {
  return clean(row.plan)?.split("-")[0] ?? null;
}

function isLegacyStripeSubscriptionRecord(row: Record<string, any>): boolean {
  const planBase = csvStripeSubscriptionPlanBase(row);
  return (
    clean(row.service_metadata) == null &&
    clean(row.service) == null &&
    planBase != null &&
    LEGACY_STRIPE_UPGRADE_PLAN_IDS.has(planBase)
  );
}

function csvStripeSubscriptionInterval(
  row: Record<string, any>,
): "month" | "year" {
  return row.interval === "year" ? "year" : "month";
}

function csvStripeSubscriptionPeriodCost(row: Record<string, any>): number {
  const quantity = positiveMoneyNumber(row.quantity) || 1;
  return toMoneyNumber(positiveMoneyNumber(row.amount) * quantity);
}

function legacyStripeSubscriptionRecordInfo(
  payloads: Record<string, any>[],
): Pick<
  LegacyMigrationFinancialAccount,
  | "active_subscription_annualized"
  | "active_subscription_count"
  | "entitlement_credit_amount"
  | "entitlement_credits"
  | "suggested_membership_interval"
> {
  let active_subscription_annualized = 0;
  let active_subscription_count = 0;
  let yearlyActive = 0;
  let monthlyActive = 0;
  const entitlement_credits: LegacyMigrationEntitlementCredit[] = [];
  for (const value of payloads) {
    const sub = asRecord(value);
    if (!isLegacyStripeSubscriptionRecord(sub)) continue;
    const status = clean(sub.status) ?? "";
    const interval = csvStripeSubscriptionInterval(sub);
    const cost = csvStripeSubscriptionPeriodCost(sub);
    if (status === "active" || status === "trialing") {
      active_subscription_count += 1;
      active_subscription_annualized += cost * (interval === "year" ? 1 : 12);
      if (interval === "year") {
        yearlyActive += 1;
      } else {
        monthlyActive += 1;
      }
    }
    if (status === "active" || status === "trialing" || status === "canceled") {
      const credit_amount = generousRemainingCredit({
        periodCost: cost,
        periodStart: sub.current_period_start,
        periodEnd: sub.current_period_end,
      });
      if (credit_amount > 0) {
        entitlement_credits.push({
          source: "stripe_legacy_subscription",
          id: `${sub.subscription_id ?? sub.id ?? ""}`,
          credit_amount,
          period_cost: cost,
          period_start: dateIso(sub.current_period_start),
          period_end: dateIso(sub.current_period_end),
          interval,
          status,
          description: clean(sub.plan) ?? "legacy Stripe upgrade",
        });
      }
    }
  }
  return {
    active_subscription_annualized: toMoneyNumber(
      active_subscription_annualized,
    ),
    active_subscription_count,
    entitlement_credit_amount: toMoneyNumber(
      entitlement_credits.reduce(
        (total, credit) => total + credit.credit_amount,
        0,
      ),
    ),
    entitlement_credits,
    suggested_membership_interval:
      yearlyActive > 0 && monthlyActive === 0 ? "year" : "month",
  };
}

async function membershipPlans(): Promise<LegacyMigrationMembershipPlan[]> {
  const tiers = await getSeedMembershipTierMap({ includeDisabled: false });
  return ["basic", "standard"]
    .map((id) => tiers[id])
    .filter((tier): tier is MembershipTierRecord => tier != null)
    .map((tier) => ({
      id: tier.id,
      label: tier.label ?? tier.id,
      price_monthly:
        tier.price_monthly == null ? null : toMoneyNumber(tier.price_monthly),
      price_yearly:
        tier.price_yearly == null ? null : toMoneyNumber(tier.price_yearly),
    }));
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

export async function ensureVerifiedEmailLinksForAllAccounts(): Promise<number> {
  await ensureLegacyMigrationFinancialSchema();
  const legacyCanonical = canonicalEmailSql("lower(legacy.email_address)");
  const currentCanonical = canonicalEmailSql("current_emails.email");
  const { rowCount } = await getPool().query(
    `
    WITH current_emails AS (
      SELECT account_id, lower(email_address) AS email
        FROM accounts
       WHERE COALESCE(deleted, false)=false
         AND COALESCE(email_address, '') <> ''
         AND COALESCE(email_address_verified, '{}'::jsonb)
             ? lower(email_address)
      UNION
      SELECT account_id, lower(verified.email) AS email
        FROM accounts
        CROSS JOIN LATERAL jsonb_each(COALESCE(email_address_verified, '{}'::jsonb))
          AS verified(email, verified_value)
       WHERE COALESCE(deleted, false)=false
         AND verified.verified_value = 'true'::jsonb
    ),
    current_keys AS (
      SELECT account_id, email AS email_key, email AS matched_email
        FROM current_emails
      UNION
      SELECT account_id, ${currentCanonical} AS email_key, email AS matched_email
        FROM current_emails
    ),
    legacy_keys AS (
      SELECT legacy_account_id,
             lower(email_address) AS email_key,
             lower(email_address) AS email_address,
             NULL::TEXT AS gmail_canonical_email
        FROM legacy_migration_accounts legacy
       WHERE COALESCE(email_address_verified, false)=true
         AND COALESCE(email_address, '') <> ''
      UNION
      SELECT legacy_account_id,
             ${legacyCanonical} AS email_key,
             lower(email_address) AS email_address,
             ${legacyCanonical} AS gmail_canonical_email
        FROM legacy_migration_accounts legacy
       WHERE COALESCE(email_address_verified, false)=true
         AND COALESCE(email_address, '') <> ''
         AND split_part(lower(email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
    )
    INSERT INTO legacy_migration_account_links
      (legacy_account_id, account_id, claim_method, metadata, created, updated)
    SELECT DISTINCT ON (legacy.legacy_account_id, current_keys.account_id)
           legacy.legacy_account_id,
           current_keys.account_id,
           'verified-email',
           jsonb_build_object(
             'email_address', legacy.email_address,
             'matched_email', current_keys.matched_email,
             'match_method',
             CASE
               WHEN legacy.email_address=current_keys.matched_email THEN 'exact-email'
               ELSE 'gmail-canonical'
             END,
             'gmail_canonical_email', legacy.gmail_canonical_email
           ),
           NOW(),
           NOW()
      FROM legacy_keys legacy
      JOIN current_keys USING (email_key)
     WHERE COALESCE(legacy.email_key, '') <> ''
    ON CONFLICT (legacy_account_id, account_id)
    DO UPDATE SET updated=NOW()
    `,
  );
  return rowCount ?? 0;
}

async function currentMembershipExists(account_id: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `
    SELECT 1
      FROM subscriptions
     WHERE account_id=$1
       AND status IN ('active', 'canceled')
       AND metadata->>'type'='membership'
       AND current_period_end >= NOW()
     LIMIT 1
    `,
    [account_id],
  );
  return rows.length > 0;
}

async function currentPaidMembershipSubscriptionExists(
  account_id: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `
    SELECT 1
      FROM subscriptions
     WHERE account_id=$1
       AND status IN ('active', 'canceled')
       AND metadata->>'type'='membership'
       AND latest_purchase_id IS NOT NULL
       AND current_period_end >= NOW()
     LIMIT 1
    `,
    [account_id],
  );
  return rows.length > 0;
}

async function currentLegacyMigrationMembershipSubscription(
  account_id: string,
  client?: PoolClient,
): Promise<{ id: number; current_period_end: Date | string | null } | null> {
  const { rows } = await (client ?? getPool()).query<{
    id: number;
    current_period_end: Date | string | null;
  }>(
    `
    SELECT id, current_period_end
      FROM subscriptions
     WHERE account_id=$1
       AND metadata->>'type'='membership'
       AND metadata->>'source_id'='legacy-migration'
       AND current_period_end >= NOW()
     ORDER BY current_period_end DESC
     LIMIT 1
    `,
    [account_id],
  );
  return rows[0] ?? null;
}

async function currentStripeCustomerId(
  account_id: string,
  client?: PoolClient,
): Promise<string | null> {
  const { rows } = await (client ?? getPool()).query<{
    stripe_customer_id: string | null;
  }>(`SELECT stripe_customer_id FROM accounts WHERE account_id=$1 LIMIT 1`, [
    account_id,
  ]);
  return clean(rows[0]?.stripe_customer_id) ?? null;
}

async function financialRowsForAccount(
  account_id: string,
  client?: PoolClient,
): Promise<LegacyMigrationFinancialAccount[]> {
  await ensureVerifiedEmailLinks(account_id);
  await ensureLegacyMigrationFinancialSchema();
  const { rows } = await (client ?? getPool()).query<
    LegacyAccountRow & {
      metadata: Record<string, any> | null;
      balance: string | number | null;
      credit_amount: string | number | null;
      active_subscription_annualized: string | number | null;
      active_subscription_count: string | number | null;
      subscription_payloads: Record<string, any>[] | null;
      stripe_subscription_payloads: Record<string, any>[] | null;
      site_license_payloads: Record<string, any>[] | null;
      claimed_by_account_id: string | null;
      claimed_at: Date | string | null;
      selected_membership_class: string | null;
      selected_membership_interval: "month" | "year" | null;
    }
  >(
    `
    WITH linked AS (
      SELECT legacy_account_id
        FROM legacy_migration_account_links
       WHERE account_id=$1
    ),
    purchase_costs AS (
      SELECT payload->>'legacy_account_id' AS legacy_account_id,
             SUM((payload->>'cost')::numeric) AS cost_sum
        FROM legacy_migration_raw_records
       WHERE source='purchases'
         AND payload->>'legacy_account_id' IN (SELECT legacy_account_id FROM linked)
         AND COALESCE(payload->>'cost', '') ~ '^-?[0-9]+([.][0-9]+)?$'
       GROUP BY payload->>'legacy_account_id'
    ),
    active_subscriptions AS (
      SELECT payload->>'legacy_account_id' AS legacy_account_id,
             COUNT(*)::integer AS active_subscription_count,
             SUM(
               (payload->>'cost')::numeric *
               CASE WHEN payload->>'interval'='year' THEN 1 ELSE 12 END
             ) AS active_subscription_annualized
        FROM legacy_migration_raw_records
       WHERE source='subscriptions'
         AND payload->>'legacy_account_id' IN (SELECT legacy_account_id FROM linked)
         AND payload->>'status' IN ('active', 'trialing')
         AND COALESCE(payload->>'cost', '') ~ '^[0-9]+([.][0-9]+)?$'
       GROUP BY payload->>'legacy_account_id'
    ),
    subscription_payloads AS (
      SELECT payload->>'legacy_account_id' AS legacy_account_id,
             jsonb_agg(payload ORDER BY payload->>'id') AS payloads
        FROM legacy_migration_raw_records
       WHERE source='subscriptions'
         AND payload->>'legacy_account_id' IN (SELECT legacy_account_id FROM linked)
         AND payload->>'status' IN ('active', 'trialing', 'canceled')
         AND NULLIF(payload->>'current_period_end', '')::timestamptz > NOW()
         AND COALESCE(payload->>'cost', '') ~ '^[0-9]+([.][0-9]+)?$'
       GROUP BY payload->>'legacy_account_id'
    ),
    stripe_subscription_payloads AS (
      SELECT accounts.legacy_account_id,
             jsonb_agg(raw.payload ORDER BY raw.payload->>'subscription_id')
               AS payloads
        FROM linked
        JOIN legacy_migration_accounts accounts
          ON accounts.legacy_account_id=linked.legacy_account_id
        JOIN legacy_migration_raw_records raw
          ON raw.source='stripe_subscriptions'
         AND raw.payload->>'stripe_customer_id'=accounts.stripe_customer_id
       WHERE COALESCE(accounts.stripe_customer_id, '') <> ''
         AND raw.payload->>'status' IN ('active', 'trialing', 'canceled')
       GROUP BY accounts.legacy_account_id
    ),
    site_license_payloads AS (
      SELECT COALESCE(
               payload#>>'{info,purchased,account_id}',
               payload->'managers'->>0
             ) AS legacy_account_id,
             jsonb_agg(payload ORDER BY payload->>'id') AS payloads
        FROM legacy_migration_raw_records
       WHERE source='site_licenses'
         AND COALESCE(
               payload#>>'{info,purchased,account_id}',
               payload->'managers'->>0
             ) IN (SELECT legacy_account_id FROM linked)
         AND NULLIF(payload->>'expires', '')::timestamptz > NOW()
         AND payload->>'subscription_id' IS NULL
       GROUP BY COALESCE(
               payload#>>'{info,purchased,account_id}',
               payload->'managers'->>0
             )
    )
    SELECT accounts.legacy_account_id,
           accounts.email_address,
           accounts.display_name,
           accounts.stripe_customer_id,
           accounts.metadata,
           COALESCE(-purchase_costs.cost_sum, 0) AS balance,
           GREATEST(COALESCE(-purchase_costs.cost_sum, 0), 0) AS credit_amount,
           COALESCE(active_subscriptions.active_subscription_annualized, 0)
             AS active_subscription_annualized,
           COALESCE(active_subscriptions.active_subscription_count, 0)
             AS active_subscription_count,
           COALESCE(subscription_payloads.payloads, '[]'::jsonb)
             AS subscription_payloads,
           COALESCE(stripe_subscription_payloads.payloads, '[]'::jsonb)
             AS stripe_subscription_payloads,
           COALESCE(site_license_payloads.payloads, '[]'::jsonb)
             AS site_license_payloads,
           claims.account_id AS claimed_by_account_id,
           claims.applied_at AS claimed_at,
           claims.selected_membership_class,
           claims.selected_membership_interval
      FROM linked
      JOIN legacy_migration_accounts accounts
        ON accounts.legacy_account_id=linked.legacy_account_id
      LEFT JOIN purchase_costs
        ON purchase_costs.legacy_account_id=linked.legacy_account_id
      LEFT JOIN active_subscriptions
        ON active_subscriptions.legacy_account_id=linked.legacy_account_id
      LEFT JOIN subscription_payloads
        ON subscription_payloads.legacy_account_id=linked.legacy_account_id
      LEFT JOIN stripe_subscription_payloads
        ON stripe_subscription_payloads.legacy_account_id=linked.legacy_account_id
      LEFT JOIN site_license_payloads
        ON site_license_payloads.legacy_account_id=linked.legacy_account_id
      LEFT JOIN legacy_migration_financial_claims claims
        ON claims.legacy_account_id=linked.legacy_account_id
       AND claims.status='applied'
     ORDER BY COALESCE(active_subscriptions.active_subscription_annualized, 0) DESC,
              GREATEST(COALESCE(-purchase_costs.cost_sum, 0), 0) DESC,
              lower(COALESCE(accounts.email_address, '')),
              accounts.legacy_account_id
    `,
    [account_id],
  );
  return rows.map((row) => {
    const subscriptionCredits = asArray(row.subscription_payloads)
      .map((payload) => subscriptionCredit(asRecord(payload)))
      .filter((credit): credit is LegacyMigrationEntitlementCredit => !!credit);
    const siteLicensePayloads = asArray(row.site_license_payloads).filter(
      (payload) =>
        siteLicenseOwner(asRecord(payload)) === row.legacy_account_id,
    );
    const siteLicenseCredits = siteLicensePayloads
      .map((payload) => siteLicenseCredit(asRecord(payload)))
      .filter((credit): credit is LegacyMigrationEntitlementCredit => !!credit);
    const unvaluedActiveSiteLicenseCount = siteLicensePayloads.filter(
      (payload) => siteLicensePeriodCost(asRecord(payload)) <= 0,
    ).length;
    const stripeInfo = legacyStripeSubscriptionRecordInfo(
      asArray(row.stripe_subscription_payloads).map((payload) =>
        asRecord(payload),
      ),
    );
    const balance_credit_amount = toMoneyNumber(row.credit_amount);
    const entitlement_credits = [
      ...subscriptionCredits,
      ...siteLicenseCredits,
      ...stripeInfo.entitlement_credits,
    ];
    const entitlement_credit_amount = toMoneyNumber(
      entitlement_credits.reduce(
        (total, credit) => total + credit.credit_amount,
        0,
      ),
    );
    const rawActiveCount = numberValue(row.active_subscription_count);
    const rawAnnualized = toMoneyNumber(row.active_subscription_annualized);
    const rawActiveSubscriptionPayloads = asArray(
      row.subscription_payloads,
    ).filter((payload) => {
      const record = asRecord(payload);
      return record.status === "active" || record.status === "trialing";
    });
    const rawActiveYearCount = rawActiveSubscriptionPayloads.filter(
      (payload) => subscriptionInterval(asRecord(payload)) === "year",
    ).length;
    const rawActiveMonthCount =
      rawActiveSubscriptionPayloads.length - rawActiveYearCount;
    return {
      legacy_account_id: row.legacy_account_id,
      email_address: normalizeEmail(row.email_address) || null,
      display_name: row.display_name ?? null,
      stripe_customer_id: clean(row.stripe_customer_id) ?? null,
      balance: toMoneyNumber(row.balance),
      balance_credit_amount,
      entitlement_credit_amount,
      entitlement_credits,
      unvalued_active_site_license_count: unvaluedActiveSiteLicenseCount,
      credit_amount: toMoneyNumber(
        balance_credit_amount + entitlement_credit_amount,
      ),
      active_subscription_annualized: toMoneyNumber(
        rawAnnualized + stripeInfo.active_subscription_annualized,
      ),
      active_subscription_count:
        rawActiveCount + stripeInfo.active_subscription_count,
      suggested_membership_interval:
        rawActiveYearCount > 0 &&
        rawActiveMonthCount === 0 &&
        stripeInfo.suggested_membership_interval === "year"
          ? "year"
          : rawActiveYearCount > 0 &&
              rawActiveMonthCount === 0 &&
              stripeInfo.active_subscription_count === 0
            ? "year"
            : rawActiveCount === 0 && stripeInfo.active_subscription_count > 0
              ? stripeInfo.suggested_membership_interval
              : "month",
      selected_membership_class: clean(row.selected_membership_class) ?? null,
      selected_membership_interval:
        row.selected_membership_interval === "month"
          ? "month"
          : row.selected_membership_interval === "year"
            ? "year"
            : null,
      claimed_by_account_id: row.claimed_by_account_id,
      claimed_at: row.claimed_at,
    };
  });
}

function suggestedMembershipClass({
  active_subscription_count,
  active_subscription_annualized,
  membership_already_applied,
}: {
  active_subscription_annualized: number;
  active_subscription_count: number;
  membership_already_applied: boolean;
}): string | null {
  if (membership_already_applied || active_subscription_count <= 0) {
    return null;
  }
  return active_subscription_annualized >
    LEGACY_MIGRATION_STANDARD_ANNUALIZED_CUTOFF
    ? "standard"
    : "basic";
}

function suggestedFinancialMembershipInterval(
  pending: LegacyMigrationFinancialAccount[],
): "month" | "year" {
  const active = pending.filter(
    (account) => account.active_subscription_count > 0,
  );
  if (active.length === 0) return "month";
  return active.every(
    (account) => account.suggested_membership_interval === "year",
  )
    ? "year"
    : "month";
}

async function financialPreviewForAccount(
  account_id: string,
): Promise<LegacyMigrationFinancialPreviewResponse> {
  const [
    legacy_accounts,
    plans,
    hasActiveMembership,
    membership_renewal_configured,
  ] = await Promise.all([
    financialRowsForAccount(account_id),
    membershipPlans(),
    currentMembershipExists(account_id),
    currentPaidMembershipSubscriptionExists(account_id),
  ]);
  const pending = legacy_accounts.filter(
    (account) => !account.claimed_by_account_id,
  );
  const claimedHere = legacy_accounts.filter(
    (account) => account.claimed_by_account_id === account_id,
  );
  const pending_credit_amount = toMoneyNumber(
    pending.reduce((total, account) => total + account.credit_amount, 0),
  );
  const applied_credit_amount = toMoneyNumber(
    claimedHere.reduce((total, account) => total + account.credit_amount, 0),
  );
  const active_subscription_annualized = toMoneyNumber(
    pending.reduce(
      (total, account) => total + account.active_subscription_annualized,
      0,
    ),
  );
  const active_subscription_count = pending.reduce(
    (total, account) => total + account.active_subscription_count,
    0,
  );
  const appliedMembership = claimedHere.find(
    (account) => account.selected_membership_class,
  );
  const membershipClaimExists = await legacyMembershipClaimExists(account_id);
  const membership_already_applied =
    hasActiveMembership || membershipClaimExists;
  const stripe_customer_id =
    (await currentStripeCustomerId(account_id)) ??
    pending.map((account) => account.stripe_customer_id).find(Boolean) ??
    null;
  const unverifiedEmail =
    legacy_accounts.length === 0
      ? await unverifiedLegacyEmailMatches(account_id)
      : { email: null, matches: [] };
  return {
    legacy_accounts,
    email_verification_required: unverifiedEmail.matches.length > 0,
    email_verification_email: unverifiedEmail.email,
    unverified_email_matches: unverifiedEmail.matches,
    pending_credit_amount,
    applied_credit_amount,
    active_subscription_annualized,
    active_subscription_count,
    suggested_membership_class: suggestedMembershipClass({
      active_subscription_annualized,
      active_subscription_count,
      membership_already_applied,
    }),
    suggested_membership_interval:
      suggestedFinancialMembershipInterval(pending),
    suggested_membership_grant_days: LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS,
    applied_membership_class:
      appliedMembership?.selected_membership_class ?? null,
    applied_membership_interval:
      appliedMembership?.selected_membership_interval ?? null,
    membership_already_applied,
    membership_renewal_configured,
    stripe_customer_id,
    plans,
    can_apply:
      pending.length > 0 &&
      (pending_credit_amount > 0 ||
        active_subscription_count > 0 ||
        pending.some((account) => account.stripe_customer_id)),
  };
}

async function legacyMembershipClaimExists(
  account_id: string,
): Promise<boolean> {
  await ensureLegacyMigrationFinancialSchema();
  const { rows } = await getPool().query(
    `
    SELECT 1
      FROM legacy_migration_financial_claims
     WHERE account_id=$1
       AND status='applied'
       AND subscription_id IS NOT NULL
     LIMIT 1
    `,
    [account_id],
  );
  return rows.length > 0;
}

function legacyMigrationMembershipGrantEnd(): Date {
  const end = new Date();
  end.setDate(end.getDate() + LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS);
  return end;
}

async function membershipCost({
  membership_class,
  interval,
}: {
  membership_class: string;
  interval: "month" | "year";
}): Promise<number> {
  const plans = await membershipPlans();
  const plan = plans.find((plan) => plan.id === membership_class);
  if (!plan) {
    throw new Error(`membership plan '${membership_class}' is not available`);
  }
  const cost = interval === "year" ? plan.price_yearly : plan.price_monthly;
  if (cost == null || cost <= 0) {
    throw new Error(
      `membership plan '${membership_class}' does not have a ${interval} price`,
    );
  }
  return cost;
}

async function claimPendingFinancialAccounts({
  account_id,
  rows,
  client,
}: {
  account_id: string;
  rows: LegacyMigrationFinancialAccount[];
  client: PoolClient;
}): Promise<LegacyMigrationFinancialAccount[]> {
  const pending = rows.filter((row) => !row.claimed_by_account_id);
  if (pending.length === 0) return [];
  const payload = pending.map((row) => ({
    legacy_account_id: row.legacy_account_id,
    account_id,
    credit_amount: moneyToDbString(row.credit_amount),
    stripe_customer_id: row.stripe_customer_id,
    metadata: {
      email_address: row.email_address,
      display_name: row.display_name,
      balance: row.balance,
      balance_credit_amount: row.balance_credit_amount,
      entitlement_credit_amount: row.entitlement_credit_amount,
      entitlement_credits: row.entitlement_credits,
      unvalued_active_site_license_count:
        row.unvalued_active_site_license_count,
      active_subscription_annualized: row.active_subscription_annualized,
      active_subscription_count: row.active_subscription_count,
      suggested_membership_interval: row.suggested_membership_interval,
    },
  }));
  const { rows: claimed } = await client.query<{ legacy_account_id: string }>(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          legacy_account_id TEXT,
          account_id UUID,
          credit_amount numeric,
          stripe_customer_id TEXT,
          metadata JSONB
        )
    )
    INSERT INTO legacy_migration_financial_claims
      (legacy_account_id, account_id, status, credit_amount, stripe_customer_id,
       metadata, created, updated)
    SELECT legacy_account_id,
           account_id,
           'applying',
           credit_amount,
           NULLIF(stripe_customer_id, ''),
           COALESCE(metadata, '{}'::jsonb),
           NOW(),
           NOW()
      FROM input
     WHERE COALESCE(legacy_account_id, '') <> ''
    ON CONFLICT (legacy_account_id) DO NOTHING
    RETURNING legacy_account_id
    `,
    [JSON.stringify(payload)],
  );
  const claimedIds = new Set(claimed.map((row) => row.legacy_account_id));
  return pending.filter((row) => claimedIds.has(row.legacy_account_id));
}

async function finishFinancialClaim({
  legacy_account_id,
  credit_purchase_id,
  subscription_id,
  selected_membership_class,
  selected_membership_interval,
  client,
}: {
  legacy_account_id: string;
  credit_purchase_id?: number | null;
  subscription_id?: number | null;
  selected_membership_class?: string | null;
  selected_membership_interval?: "month" | "year" | null;
  client: PoolClient;
}): Promise<void> {
  await client.query(
    `
    UPDATE legacy_migration_financial_claims
       SET status='applied',
           credit_purchase_id=$2,
           subscription_id=$3,
           selected_membership_class=$4,
           selected_membership_interval=$5,
           applied_at=NOW(),
           updated=NOW()
     WHERE legacy_account_id=$1
    `,
    [
      legacy_account_id,
      credit_purchase_id ?? null,
      subscription_id ?? null,
      selected_membership_class ?? null,
      selected_membership_interval ?? null,
    ],
  );
}

export async function previewFinancialMigration({
  account_id,
}: LegacyMigrationFinancialPreviewOptions = {}): Promise<LegacyMigrationFinancialPreviewResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  return await financialPreviewForAccount(account_id);
}

export async function applyFinancialMigrationHomeBay({
  account_id,
  claimed,
  stripe_customer_id,
  membership_class,
  membership_interval,
}: LegacyMigrationApplyFinancialHomeBayOptions): Promise<LegacyMigrationApplyFinancialHomeBayResponse> {
  // The seed bay owns legacy dump access and validates that migration is enabled
  // before it computes and claims these rows. The account home bay may not have
  // migration enabled locally, but it is authoritative for balance/subscription
  // mutations.
  if (!account_id) {
    throw Error("account_id is required");
  }
  const selectedClass =
    clean(membership_class) === "none" ? undefined : clean(membership_class);
  const selectedInterval = membership_interval === "month" ? "month" : "year";
  const selectedCost =
    selectedClass != null
      ? await membershipCost({
          membership_class: selectedClass,
          interval: selectedInterval,
        })
      : undefined;

  const client = await getTransactionClient();
  try {
    const accountCheck = await client.query(
      `
      SELECT 1
        FROM accounts
       WHERE account_id=$1
         AND (deleted IS NULL OR deleted = FALSE)
       LIMIT 1
      `,
      [account_id],
    );
    if (accountCheck.rows.length === 0) {
      throw Error(`${account_id} is not a valid account on this bay`);
    }
    const existingGrant = await currentLegacyMigrationMembershipSubscription(
      account_id,
      client,
    );
    if (
      selectedClass != null &&
      selectedCost != null &&
      existingGrant == null &&
      (await currentMembershipExists(account_id))
    ) {
      throw new Error("this account already has an active membership");
    }

    if (stripe_customer_id) {
      await client.query(
        `
        UPDATE accounts
           SET stripe_customer_id=$2
         WHERE account_id=$1
           AND COALESCE(stripe_customer_id, '')=''
        `,
        [account_id, stripe_customer_id],
      );
    }

    const creditPurchaseIds: number[] = [];
    const creditPurchaseIdByLegacyAccount: Record<string, number> = {};
    for (const row of claimed) {
      if (positiveMoneyNumber(row.credit_amount) <= 0) continue;
      const purchaseId = await createCredit({
        account_id,
        amount: row.credit_amount,
        invoice_id: `legacy-migration-credit:${row.legacy_account_id}`,
        tag: "legacy-migration-credit",
        notes: `Migrated cocalc.com credit from legacy account ${row.legacy_account_id}, including positive cash balance and remaining paid legacy subscription/license value.`,
        description: {
          purpose: "legacy-migration",
          description:
            "Migrated cocalc.com cash balance and remaining paid legacy value",
          metadata: {
            legacy_account_id: row.legacy_account_id,
            balance_credit_amount: row.balance_credit_amount,
            entitlement_credit_amount: row.entitlement_credit_amount,
            entitlement_credits: row.entitlement_credits,
            unvalued_active_site_license_count:
              row.unvalued_active_site_license_count,
          },
        },
        client,
      });
      creditPurchaseIds.push(purchaseId);
      creditPurchaseIdByLegacyAccount[row.legacy_account_id] = purchaseId;
    }

    let subscription_id = existingGrant?.id;
    let membershipGrantEnd: Date | undefined;
    if (existingGrant?.current_period_end != null) {
      membershipGrantEnd = new Date(existingGrant.current_period_end);
    }
    if (
      selectedClass != null &&
      selectedCost != null &&
      subscription_id == null
    ) {
      membershipGrantEnd = legacyMigrationMembershipGrantEnd();
      subscription_id = await createSubscription(
        {
          account_id,
          cost: selectedCost,
          interval: selectedInterval,
          current_period_start: new Date(),
          current_period_end: membershipGrantEnd,
          status: "canceled",
          metadata: {
            type: "membership",
            class: selectedClass,
            source: "promo",
            source_id: "legacy-migration",
            grant: true,
            grant_days: LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS,
            grant_ends_at: membershipGrantEnd.toISOString(),
          },
        },
        client,
      );
    }

    await client.query("COMMIT");
    return {
      credit_purchase_ids: creditPurchaseIds,
      credit_purchase_id_by_legacy_account: creditPurchaseIdByLegacyAccount,
      subscription_id: subscription_id ?? null,
      membership_grant_ends_at: membershipGrantEnd?.toISOString() ?? null,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function applyFinancialMigrationHomeBayForAccount(
  opts: LegacyMigrationApplyFinancialHomeBayOptions,
): Promise<LegacyMigrationApplyFinancialHomeBayResponse> {
  const account = await getClusterAccountById(opts.account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  if (homeBayId && homeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: homeBayId,
    }).legacyMigrationApplyFinancialHomeBay(opts);
  }
  return await applyFinancialMigrationHomeBay(opts);
}

export async function applyFinancialMigration({
  account_id,
  membership_class,
  membership_interval,
}: LegacyMigrationApplyFinancialOptions = {}): Promise<LegacyMigrationApplyFinancialResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationFinancialSchema();
  const selectedClass =
    clean(membership_class) === "none" ? undefined : clean(membership_class);
  const selectedInterval = membership_interval === "month" ? "month" : "year";

  const client = await getTransactionClient();
  try {
    const rows = await financialRowsForAccount(account_id, client);
    const claimed = await claimPendingFinancialAccounts({
      account_id,
      rows,
      client,
    });
    if (claimed.length === 0) {
      throw new Error("there are no unclaimed legacy financial records");
    }
    const stripe_customer_id =
      (await currentStripeCustomerId(account_id, client)) ??
      claimed.map((row) => row.stripe_customer_id).find(Boolean) ??
      null;
    const applied = await applyFinancialMigrationHomeBayForAccount({
      account_id,
      claimed,
      stripe_customer_id,
      membership_class: selectedClass ?? null,
      membership_interval: selectedClass ? selectedInterval : null,
    });
    const creditPurchaseIds = applied.credit_purchase_ids;

    for (const row of claimed) {
      await finishFinancialClaim({
        legacy_account_id: row.legacy_account_id,
        credit_purchase_id:
          positiveMoneyNumber(row.credit_amount) > 0
            ? (applied.credit_purchase_id_by_legacy_account[
                row.legacy_account_id
              ] ?? null)
            : null,
        subscription_id: applied.subscription_id,
        selected_membership_class: selectedClass,
        selected_membership_interval: selectedClass ? selectedInterval : null,
        client,
      });
    }

    await client.query("COMMIT");
    return {
      claimed_legacy_account_ids: claimed.map((row) => row.legacy_account_id),
      credit_amount: toMoneyNumber(
        claimed.reduce((total, row) => total + row.credit_amount, 0),
      ),
      credit_purchase_ids: creditPurchaseIds,
      subscription_id: applied.subscription_id,
      membership_class: selectedClass ?? null,
      membership_interval: selectedClass ? selectedInterval : null,
      membership_grant_days: selectedClass
        ? LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS
        : null,
      membership_grant_ends_at: applied.membership_grant_ends_at ?? null,
      stripe_customer_id,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function applyAutomaticFinancialMigration({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<LegacyMigrationApplyFinancialResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const preview = await financialPreviewForAccount(account_id);
  if (!preview.can_apply) {
    return {
      claimed_legacy_account_ids: [],
      credit_amount: 0,
      credit_purchase_ids: [],
      subscription_id: null,
      membership_class: null,
      membership_interval: null,
      membership_grant_days: null,
      membership_grant_ends_at: null,
      stripe_customer_id: preview.stripe_customer_id ?? null,
    };
  }
  return await applyFinancialMigration({
    account_id,
    membership_class: preview.suggested_membership_class ?? null,
    membership_interval: preview.suggested_membership_interval,
  });
}

export async function financialMigrationCandidateAccountIds({
  limit,
}: {
  limit?: number;
} = {}): Promise<string[]> {
  await ensureLegacyMigrationFinancialSchema();
  await ensureVerifiedEmailLinksForAllAccounts();
  const n = limitValue(limit);
  const { rows } = await getPool().query<{ account_id: string }>(
    `
    SELECT DISTINCT linked.account_id
      FROM legacy_migration_account_links linked
      JOIN legacy_migration_accounts legacy
        ON legacy.legacy_account_id=linked.legacy_account_id
      LEFT JOIN legacy_migration_financial_claims claims
        ON claims.legacy_account_id=linked.legacy_account_id
       AND claims.status='applied'
     WHERE claims.legacy_account_id IS NULL
       AND (
         COALESCE(legacy.stripe_customer_id, '') <> ''
         OR EXISTS (
           SELECT 1
             FROM legacy_migration_raw_records raw
            WHERE (
                    raw.source IN ('purchases', 'subscriptions')
                    AND raw.payload->>'legacy_account_id'=linked.legacy_account_id
                  )
               OR (
                    raw.source='site_licenses'
                    AND COALESCE(
                          raw.payload#>>'{info,purchased,account_id}',
                          raw.payload->'managers'->>0
                        )=linked.legacy_account_id
                  )
               OR (
                    raw.source='stripe_subscriptions'
                    AND raw.payload->>'stripe_customer_id'=legacy.stripe_customer_id
                  )
         )
       )
     ORDER BY linked.account_id
     LIMIT $1
    `,
    [n],
  );
  return rows.map((row) => row.account_id);
}

export async function listProjects({
  account_id,
  include_hidden,
  limit,
  max_disk_mb,
  query,
}: LegacyMigrationListProjectsOptions): Promise<LegacyMigrationListProjectsResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const legacy_accounts = await legacyAccounts(account_id);
  const legacy_account_ids = legacy_accounts.map(
    (account) => account.legacy_account_id,
  );
  if (legacy_account_ids.length === 0) {
    const unverifiedEmail = await unverifiedLegacyEmailMatches(account_id);
    return {
      legacy_account_ids,
      legacy_accounts,
      email_verification_required: unverifiedEmail.matches.length > 0,
      email_verification_email: unverifiedEmail.email,
      unverified_email_matches: unverifiedEmail.matches,
      projects: [],
      total_count: 0,
    };
  }
  const search = `%${`${query ?? ""}`.trim().toLowerCase()}%`;
  const useSearch = search !== "%%";
  const maxDiskMb = nonnegativeNumber(max_disk_mb);
  const { rows } = await getPool().query<LegacyProjectRow>(
    `
    WITH matched AS (
      SELECT p.legacy_project_id,
             ARRAY_AGG(DISTINCT linked.legacy_account_id ORDER BY linked.legacy_account_id)
               AS matched_legacy_account_ids
        FROM legacy_migration_projects p
        JOIN legacy_migration_account_links linked
          ON linked.account_id=$1
         AND (
           p.owner_legacy_account_id=linked.legacy_account_id
           OR COALESCE(p.legacy_users, '{}'::jsonb) ? linked.legacy_account_id
         )
       WHERE ($2::BOOLEAN OR COALESCE(p.hidden, false)=false)
         AND (
           NOT $3::BOOLEAN
           OR lower(COALESCE(p.title, '')) LIKE $4
           OR lower(p.legacy_project_id) LIKE $4
         )
         AND (
           $5::DOUBLE PRECISION IS NULL
           OR p.disk_mb <= $5::DOUBLE PRECISION
         )
       GROUP BY p.legacy_project_id
    )
    SELECT p.legacy_project_id,
           p.title,
           p.description,
           p.owner_legacy_account_id,
           p.legacy_users,
           p.hidden,
           p.last_edited,
           p.last_active,
           p.disk_mb,
           p.artifact_bucket,
           p.artifact_key,
           p.manifest_key,
           p.artifact_status,
           p.artifact_manifest,
           matched.matched_legacy_account_ids,
           i.project_id,
           i.owner_account_id,
           i.status,
           i.restore_mode,
           i.restore_status,
           i.restore_error,
           i.restore_lro_op_id,
           i.restore_progress,
           i.restore_result,
           COUNT(*) OVER()::INTEGER AS total_count,
           EXISTS (
             SELECT 1
               FROM legacy_migration_project_import_accounts a
              WHERE a.legacy_project_id=p.legacy_project_id
                AND a.account_id=$1
           ) AS joined
      FROM legacy_migration_projects p
      JOIN matched
        ON matched.legacy_project_id=p.legacy_project_id
      LEFT JOIN legacy_migration_project_imports i
        ON i.legacy_project_id=p.legacy_project_id
     ORDER BY p.last_edited DESC NULLS LAST, p.legacy_project_id
     LIMIT $6
    `,
    [
      account_id,
      !!include_hidden,
      useSearch,
      search,
      maxDiskMb,
      limitValue(limit),
    ],
  );
  return {
    legacy_account_ids,
    legacy_accounts,
    projects: rows.map(importStatus),
    total_count: rows[0]?.total_count ?? 0,
  };
}

async function authorizedLegacyProject({
  account_id,
  legacy_project_id,
}: {
  account_id: string;
  legacy_project_id: string;
}): Promise<(LegacyProjectRow & { matched_legacy_account_id: string }) | null> {
  await ensureVerifiedEmailLinks(account_id);
  const { rows } = await getPool().query<
    LegacyProjectRow & { matched_legacy_account_id: string }
  >(
    `
    SELECT p.*,
           linked.legacy_account_id AS matched_legacy_account_id
      FROM legacy_migration_projects p
      JOIN legacy_migration_account_links linked
        ON linked.account_id=$1
       AND (
         p.owner_legacy_account_id=linked.legacy_account_id
         OR COALESCE(p.legacy_users, '{}'::jsonb) ? linked.legacy_account_id
       )
     WHERE p.legacy_project_id=$2
     ORDER BY linked.legacy_account_id
     LIMIT 1
    `,
    [account_id, legacy_project_id],
  );
  return rows[0] ?? null;
}

async function addMigrationCollaborator({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `
    UPDATE projects
       SET users=jsonb_set(
             COALESCE(users, '{}'::jsonb),
             ARRAY[$2::TEXT],
             COALESCE(users -> $2::TEXT, '{}'::jsonb) ||
               jsonb_build_object('group', 'collaborator'),
             true
           ),
           last_edited=NOW()
     WHERE project_id=$1
       AND COALESCE(users -> $2::TEXT ->> 'group', '') <> 'owner'
    `,
    [project_id, account_id],
  );
  if (rowCount && rowCount > 0) {
    await syncProjectUsersOnHost({ project_id });
    await publishProjectAccountFeedEventsBestEffort({ project_id });
  }
}

async function recordImportAccount({
  account_id,
  legacy_account_id,
  legacy_project_id,
  project_id,
  role,
}: {
  account_id: string;
  legacy_account_id: string;
  legacy_project_id: string;
  project_id: string;
  role: "owner" | "collaborator";
}): Promise<void> {
  await getPool().query(
    `
    INSERT INTO legacy_migration_project_import_accounts
      (legacy_project_id, account_id, project_id, legacy_account_id, role, created, updated)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (legacy_project_id, account_id)
    DO UPDATE SET project_id=EXCLUDED.project_id,
                  legacy_account_id=EXCLUDED.legacy_account_id,
                  role=EXCLUDED.role,
                  updated=NOW()
    `,
    [legacy_project_id, account_id, project_id, legacy_account_id, role],
  );
}

async function setLegacySourceProjectLabelBestEffort({
  account_id,
  legacy_project_id,
  project_id,
}: {
  account_id: string;
  legacy_project_id: string;
  project_id: string;
}): Promise<void> {
  try {
    await setProjectLabels({
      project_id,
      account_id,
      labels: {
        [LEGACY_SOURCE_PROJECT_LABEL]: legacy_project_id,
      },
    });
  } catch (err) {
    logger.warn("failed to set legacy source project label", {
      account_id,
      legacy_project_id,
      project_id,
      err: `${err}`,
    });
  }
}

function labelValue(value: unknown): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  return text.length > 512 ? text.slice(0, 512) : text;
}

async function setLegacyRestoreLabelsBestEffort({
  account_id,
  project_id,
  restore_status,
  restore_lro_op_id,
  restore_error,
}: {
  account_id?: string | null;
  project_id: string;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  restore_lro_op_id?: string | null;
  restore_error?: string | null;
}): Promise<void> {
  try {
    await setProjectLabels({
      project_id,
      account_id,
      labels: {
        [LEGACY_RESTORE_STATUS_LABEL]: labelValue(restore_status),
        [LEGACY_RESTORE_LRO_LABEL]: labelValue(restore_lro_op_id),
        [LEGACY_RESTORE_ERROR_LABEL]: labelValue(restore_error),
      },
    });
  } catch (err) {
    logger.warn("failed to set legacy restore project labels", {
      account_id,
      project_id,
      restore_status,
      restore_lro_op_id,
      err: `${err}`,
    });
  }
}

async function createLegacyProjectRestoreLro({
  account_id,
  legacy_project_id,
  project_id,
}: {
  account_id: string;
  legacy_project_id: string;
  project_id: string;
}) {
  return await createLro({
    kind: LEGACY_PROJECT_RESTORE_LRO_KIND,
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    owner_type: "hub",
    input: {
      legacy_project_id,
      project_id,
    },
    dedupe_key: `legacy-project-restore:${legacy_project_id}`,
    expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
  });
}

function isExplicitProjectIdUnavailableError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err}`;
  return (
    message.includes("project_id already exists") ||
    message.includes("project_id belongs to a permanently deleted workspace") ||
    message.includes("if project_id is given, it must be a valid uuid")
  );
}

async function createImportedLegacyProject({
  account_id,
  legacy,
  legacy_project_id,
  rootfs_image,
  rootfs_image_id,
  host_id,
  region,
}: {
  account_id: string;
  legacy: LegacyProjectRow;
  legacy_project_id: string;
  rootfs_image?: string;
  rootfs_image_id?: string;
  host_id?: string;
  region?: string;
}): Promise<string> {
  const placement = await selectLegacyMigrationHostPlacement({
    account_id,
    host_id,
    region,
  });
  const account = await getClusterAccountById(account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  const projectBayId = placement.bay_id ?? homeBayId;
  if (projectBayId && projectBayId !== getConfiguredBayId()) {
    const { project_id } = await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: projectBayId,
      timeout: PROJECT_ARCHIVE_TIMEOUT_MS,
    }).createLegacyMigrationProject({
      account_id,
      legacy_project_id,
      title: projectTitle(legacy),
      description: projectDescription(legacy),
      rootfs_image,
      rootfs_image_id,
      host_id: placement.host_id,
      region: placement.region,
    });
    return project_id;
  }
  const opts = {
    account_id,
    title: projectTitle(legacy),
    description: projectDescription(legacy),
    rootfs_image,
    rootfs_image_id,
    host_id: placement.host_id,
    region: placement.region,
    skip_project_count_limit: true,
    start: false,
  };
  if (!isValidUUID(legacy_project_id)) {
    return await createProject(opts);
  }
  try {
    return await createProjectWithInternalProjectId({
      ...opts,
      project_id: legacy_project_id,
    });
  } catch (err) {
    if (!isExplicitProjectIdUnavailableError(err)) {
      throw err;
    }
    logger.warn(
      "legacy migration project_id unavailable; falling back to fresh project_id",
      {
        legacy_project_id,
        err: `${err}`,
      },
    );
    return await createProject(opts);
  }
}

async function selectLegacyMigrationHostPlacement({
  account_id,
  host_id,
  region,
}: {
  account_id: string;
  host_id?: string;
  region?: string;
}): Promise<{ host_id?: string; region?: string; bay_id?: string }> {
  if (host_id) {
    const hostBay = await resolveHostBayAcrossCluster(host_id);
    return { host_id, region, bay_id: hostBay?.bay_id };
  }
  const requestedRegion = parseR2Region(region);
  if (region && !requestedRegion) {
    return { region };
  }
  let selected = await selectActiveHost({
    account_id,
    project_region: requestedRegion,
    allow_region_fallback: true,
  });
  if (!selected) {
    return { region };
  }
  return {
    host_id: selected.id,
    region: mapCloudRegionToR2Region(selected.region),
    bay_id: selected.bay_id,
  };
}

async function importOneProject({
  account_id,
  legacy_project_id,
  restore_mode,
  rootfs_image,
  rootfs_image_id,
  host_id,
  region,
}: {
  account_id: string;
  legacy_project_id: string;
  restore_mode: LegacyMigrationProjectRestoreMode;
  rootfs_image?: string;
  rootfs_image_id?: string;
  host_id?: string;
  region?: string;
}): Promise<LegacyMigrationImportProjectResult> {
  await ensureLegacyMigrationProjectImportSchema();
  const legacy = await authorizedLegacyProject({
    account_id,
    legacy_project_id,
  });
  if (legacy == null) {
    return {
      legacy_project_id,
      status: "failed",
      error: "legacy project is not available for this account",
    };
  }
  const pool = getPool();
  if (restoreStatusForProject(legacy, restore_mode) === "skipped") {
    const { rows } = await pool.query<{
      project_id: string | null;
      restore_status: LegacyMigrationProjectRestoreStatus | null;
      restore_lro_op_id: string | null;
    }>(
      `SELECT project_id, restore_status, restore_lro_op_id
         FROM legacy_migration_project_imports
        WHERE legacy_project_id=$1`,
      [legacy_project_id],
    );
    const existingProjectId = rows[0]?.project_id;
    if (existingProjectId) {
      await addMigrationCollaborator({
        account_id,
        project_id: existingProjectId,
      });
      await recordImportAccount({
        account_id,
        legacy_account_id: legacy.matched_legacy_account_id,
        legacy_project_id,
        project_id: existingProjectId,
        role: "collaborator",
      });
      await setLegacySourceProjectLabelBestEffort({
        account_id,
        legacy_project_id,
        project_id: existingProjectId,
      });
      return {
        legacy_project_id,
        project_id: existingProjectId,
        status: "joined",
        restore_status: rows[0]?.restore_status,
        restore_lro_op_id: rows[0]?.restore_lro_op_id,
      };
    }
    return {
      legacy_project_id,
      status: "failed",
      error:
        "The archived files for this legacy project are not available yet. Try again after the cocalc.com archive has been uploaded.",
    };
  }
  if (restore_mode !== "full") {
    try {
      await assertCanIncreaseAccountStorage({ account_id });
    } catch (err) {
      return {
        legacy_project_id,
        status: "failed",
        error: `${err}`,
      };
    }
  }

  const created = await pool.query<{ legacy_project_id: string }>(
    `
    INSERT INTO legacy_migration_project_imports
      (legacy_project_id, owner_account_id, status, restore_mode, restore_status,
       rootfs_image, rootfs_image_id, created, updated)
    VALUES ($1, $2, 'creating', $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (legacy_project_id) DO UPDATE
      SET owner_account_id=EXCLUDED.owner_account_id,
          status='creating',
          restore_mode=EXCLUDED.restore_mode,
          restore_status=EXCLUDED.restore_status,
          restore_error=NULL,
          restore_attempts=NULL,
          restore_worker_id=NULL,
          restore_host_id=NULL,
          restore_claimed_until=NULL,
          restore_started=NULL,
          restore_finished=NULL,
          restore_lro_op_id=NULL,
          restore_progress=NULL,
          restore_result=NULL,
          rootfs_image=EXCLUDED.rootfs_image,
          rootfs_image_id=EXCLUDED.rootfs_image_id,
          updated=NOW()
    WHERE legacy_migration_project_imports.project_id IS NULL
      AND legacy_migration_project_imports.status = 'failed'
    RETURNING legacy_project_id
    `,
    [
      legacy_project_id,
      account_id,
      restore_mode,
      restoreStatusForProject(legacy, restore_mode),
      rootfs_image ?? null,
      rootfs_image_id ?? null,
    ],
  );

  if (created.rowCount === 0) {
    const { rows } = await pool.query<{
      project_id: string | null;
      restore_status: LegacyMigrationProjectRestoreStatus | null;
      restore_lro_op_id: string | null;
      restore_mode: LegacyMigrationProjectRestoreMode | null;
      status: string | null;
    }>(
      `SELECT project_id, restore_mode, restore_status, restore_lro_op_id, status
         FROM legacy_migration_project_imports
        WHERE legacy_project_id=$1`,
      [legacy_project_id],
    );
    const migration = rows[0];
    if (!migration?.project_id) {
      return {
        legacy_project_id,
        status: migration?.status === "creating" ? "creating" : "failed",
        error:
          migration?.status === "creating"
            ? undefined
            : "legacy project import has no target project",
      };
    }
    await addMigrationCollaborator({
      account_id,
      project_id: migration.project_id,
    });
    await recordImportAccount({
      account_id,
      legacy_account_id: legacy.matched_legacy_account_id,
      legacy_project_id,
      project_id: migration.project_id,
      role: "collaborator",
    });
    await setLegacySourceProjectLabelBestEffort({
      account_id,
      legacy_project_id,
      project_id: migration.project_id,
    });
    return {
      legacy_project_id,
      project_id: migration.project_id,
      status: "joined",
      restore_status: migration.restore_status,
      restore_lro_op_id: migration.restore_lro_op_id,
    };
  }

  try {
    const project_id = await createImportedLegacyProject({
      account_id,
      legacy,
      legacy_project_id,
      rootfs_image,
      rootfs_image_id,
      host_id,
      region,
    });
    const restore_status = restoreStatusForProject(legacy, restore_mode);
    const restore_lro_op_id =
      restore_status === "pending"
        ? (
            await createLegacyProjectRestoreLro({
              account_id,
              legacy_project_id,
              project_id,
            })
          ).op_id
        : null;
    await pool.query(
      `
      UPDATE legacy_migration_project_imports
         SET project_id=$2,
             status='imported',
             restore_mode=$4,
             restore_status=$3,
             restore_lro_op_id=$5,
             restore_progress=$6::JSONB,
             restore_error=NULL,
             updated=NOW()
       WHERE legacy_project_id=$1
      `,
      [
        legacy_project_id,
        project_id,
        restore_status,
        restore_mode,
        restore_lro_op_id,
        restore_lro_op_id
          ? JSON.stringify({
              phase: "queued",
              message: "restore queued",
              progress: 0,
            })
          : null,
      ],
    );
    await recordImportAccount({
      account_id,
      legacy_account_id: legacy.matched_legacy_account_id,
      legacy_project_id,
      project_id,
      role: "owner",
    });
    await setLegacySourceProjectLabelBestEffort({
      account_id,
      legacy_project_id,
      project_id,
    });
    await setLegacyRestoreLabelsBestEffort({
      account_id,
      project_id,
      restore_status,
      restore_lro_op_id,
      restore_error: null,
    });
    return {
      legacy_project_id,
      project_id,
      status: "imported",
      restore_status,
      restore_lro_op_id,
    };
  } catch (err) {
    await pool.query(
      `
      UPDATE legacy_migration_project_imports
         SET status='failed',
             restore_status='failed',
             restore_error=$2,
             updated=NOW()
       WHERE legacy_project_id=$1
      `,
      [legacy_project_id, `${err}`],
    );
    return {
      legacy_project_id,
      status: "failed",
      error: `${err}`,
    };
  }
}

export async function importProjects({
  account_id,
  legacy_project_ids,
  restore_mode,
  rootfs_image,
  rootfs_image_id,
  host_id,
  region,
}: LegacyMigrationImportProjectsOptions): Promise<LegacyMigrationImportProjectsResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const mode = normalizeRestoreMode(restore_mode);
  const ids = Array.from(
    new Set(
      (legacy_project_ids ?? [])
        .map((id) => `${id ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  if (ids.length === 0) {
    throw Error("select at least one legacy project");
  }
  const results: LegacyMigrationImportProjectResult[] = [];
  for (const legacy_project_id of ids) {
    results.push(
      await importOneProject({
        account_id,
        legacy_project_id,
        restore_mode: mode,
        rootfs_image,
        rootfs_image_id,
        host_id: clean(host_id),
        region: clean(region),
      }),
    );
  }
  if (results.some((result) => result.restore_status === "pending")) {
    wakeLegacyRestoreWorker();
  }
  return { results };
}

export async function retryProjectRestore({
  account_id,
  legacy_project_id,
}: LegacyMigrationRetryProjectRestoreOptions): Promise<LegacyMigrationRetryProjectRestoreResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const row = await importedProjectForAccount({
    account_id,
    legacy_project_id,
  });
  if (row == null || !row.project_id) {
    throw new Error("legacy project import is not available for this account");
  }
  if (row.restore_mode === "select") {
    throw new Error("selective restores must be retried from file selection");
  }
  if (!legacyArchiveAvailable(row)) {
    throw new Error("legacy project archive is not available");
  }
  if (row.restore_status === "restored") {
    return {
      legacy_project_id,
      project_id: row.project_id,
      restore_status: "restored",
      restore_lro_op_id: row.restore_lro_op_id,
    };
  }
  const op = await createLegacyProjectRestoreLro({
    account_id,
    legacy_project_id,
    project_id: row.project_id,
  });
  const restore_progress = {
    phase: "queued",
    message: "restore queued",
    progress: 0,
  };
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status='pending',
           restore_error=NULL,
           restore_lro_op_id=$2,
           restore_progress=$3::JSONB,
           restore_worker_id=NULL,
           restore_host_id=NULL,
           restore_claimed_until=NULL,
           restore_started=NULL,
           restore_finished=NULL,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [legacy_project_id, op.op_id, JSON.stringify(restore_progress)],
  );
  await setLegacyRestoreLabelsBestEffort({
    account_id,
    project_id: row.project_id,
    restore_status: "pending",
    restore_lro_op_id: op.op_id,
    restore_error: null,
  });
  wakeLegacyRestoreWorker();
  return {
    legacy_project_id,
    project_id: row.project_id,
    restore_status: "pending",
    restore_lro_op_id: op.op_id,
  };
}

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

function wakeLegacyRestoreWorker(): void {
  void triggerLegacyMigrationProjectRestoreWorker().catch((err) => {
    logger.warn("failed to wake legacy migration restore worker", {
      err: `${err}`,
    });
  });
}

function archiveIndexSummary(
  index: ProjectArchiveIndexResult,
): Record<string, any> {
  return {
    cache_id: index.cache_id,
    bytes: index.bytes,
    sha256: index.sha256,
    file_count: index.file_count,
    uncompressed_bytes: index.uncompressed_bytes,
    entries_returned: index.entries.length,
    truncated: index.truncated,
    duration_ms: index.duration_ms,
  };
}

function archiveIndexFromRestoreResult(
  restore_result: Record<string, any> | null | undefined,
): Record<string, any> | undefined {
  const index = restore_result?.archive_index;
  return index && typeof index === "object" ? index : undefined;
}

function normalizePathList(paths?: string[]): string[] | undefined {
  const normalized = Array.from(
    new Set(
      (paths ?? []).map((path) => `${path ?? ""}`.trim()).filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function maxArchiveIndexEntries(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_ARCHIVE_INDEX_MAX_ENTRIES;
  }
  return Math.min(MAX_ARCHIVE_INDEX_MAX_ENTRIES, Math.floor(n));
}

async function getR2Credentials(): Promise<{
  endpoint: string;
  accessKey: string;
  secretKey: string;
}> {
  const settings = await getServerSettings();
  const accountId = clean((settings as any).r2_account_id);
  const accessKey = clean((settings as any).r2_access_key_id);
  const secretKey = clean((settings as any).r2_secret_access_key);
  const endpoint =
    clean(process.env.COCALC_LEGACY_PROJECTS_R2_ENDPOINT) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("missing R2 credentials for legacy project restore");
  }
  return { endpoint, accessKey, secretKey };
}

async function signedLegacyArchiveDownload(
  row: Pick<
    LegacyProjectRow,
    "artifact_bucket" | "artifact_key" | "artifact_manifest"
  >,
): Promise<SignedProjectArchiveDownload> {
  const bucket =
    clean(row.artifact_bucket) ??
    clean(process.env.COCALC_LEGACY_PROJECTS_BUCKET) ??
    DEFAULT_LEGACY_PROJECTS_BUCKET;
  const key = clean(row.artifact_key);
  if (!key) {
    throw new Error("legacy project archive key is missing");
  }
  const { endpoint, accessKey, secretKey } = await getR2Credentials();
  return {
    ...issueSignedObjectDownload({
      endpoint,
      accessKey,
      secretKey,
      bucket,
      key,
    }),
    bucket,
    key,
    bytes: manifestCompressedBytes(row.artifact_manifest),
    sha256: manifestSha256(row.artifact_manifest),
  };
}

async function importedProjectForAccount({
  account_id,
  legacy_project_id,
}: {
  account_id: string;
  legacy_project_id: string;
}): Promise<LegacyProjectRow | null> {
  await ensureLegacyMigrationProjectImportSchema();
  const { rows } = await getPool().query<LegacyProjectRow>(
    `
    SELECT p.legacy_project_id,
           p.title,
           p.description,
           p.owner_legacy_account_id,
           p.legacy_users,
           p.hidden,
           p.last_edited,
           p.last_active,
           p.artifact_bucket,
           p.artifact_key,
           p.manifest_key,
           p.artifact_status,
           p.artifact_manifest,
           i.project_id,
           i.owner_account_id,
           i.status,
           i.restore_mode,
           i.restore_status,
           i.restore_error,
           i.restore_lro_op_id,
           i.restore_progress,
           i.restore_result
      FROM legacy_migration_project_imports i
      JOIN legacy_migration_projects p
        ON p.legacy_project_id=i.legacy_project_id
     WHERE i.legacy_project_id=$1
       AND (
         i.owner_account_id=$2
         OR EXISTS (
           SELECT 1
             FROM legacy_migration_project_import_accounts a
            WHERE a.legacy_project_id=i.legacy_project_id
              AND a.account_id=$2
         )
       )
     LIMIT 1
    `,
    [legacy_project_id, account_id],
  );
  return rows[0] ?? null;
}

function requireSelectableImport(
  row: LegacyProjectRow | null,
): LegacyProjectRow {
  if (row == null) {
    throw new Error("legacy project import is not available for this account");
  }
  if (!row.project_id) {
    throw new Error("legacy project has no target project yet");
  }
  if (row.restore_mode !== "select") {
    throw new Error("legacy project was not imported for selective restore");
  }
  if (!legacyArchiveAvailable(row)) {
    throw new Error("legacy project archive is not available");
  }
  return row;
}

async function setArchiveSelectionState({
  legacy_project_id,
  restore_status,
  restore_error = null,
  restore_result,
}: {
  legacy_project_id: string;
  restore_status: LegacyMigrationProjectRestoreStatus;
  restore_error?: string | null;
  restore_result?: Record<string, any>;
}): Promise<void> {
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status=$2,
           restore_error=$3,
           restore_result=COALESCE($4::JSONB, restore_result),
           restore_claimed_until=NULL,
           restore_worker_id=NULL,
           restore_host_id=NULL,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [
      legacy_project_id,
      restore_status,
      restore_error,
      restore_result == null ? null : JSON.stringify(restore_result),
    ],
  );
}

async function projectFileServerForArchive({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}) {
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    timeout: PROJECT_ARCHIVE_TIMEOUT_MS,
  });
  await ensureProjectFileServerClientReady({
    project_id,
    client,
    maxWait: FILE_SERVER_READY_TIMEOUT_MS,
  });
  return client;
}

function toLegacyMigrationArchiveIndex(
  index: ProjectArchiveIndexResult,
): LegacyMigrationArchiveIndex {
  return index;
}

export async function prepareArchiveSelection({
  account_id,
  legacy_project_id,
  max_entries,
}: LegacyMigrationPrepareArchiveSelectionOptions): Promise<LegacyMigrationPrepareArchiveSelectionResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = requireSelectableImport(
    await importedProjectForAccount({ account_id, legacy_project_id }),
  );
  const project_id = row.project_id!;
  await setArchiveSelectionState({
    legacy_project_id,
    restore_status: "indexing",
    restore_error: null,
  });
  try {
    const client = await projectFileServerForArchive({
      account_id,
      project_id,
    });
    const index = await client.cacheProjectArchive({
      project_id,
      download: await signedLegacyArchiveDownload(row),
      max_entries: maxArchiveIndexEntries(max_entries),
    });
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "indexed",
      restore_error: null,
      restore_result: {
        ...(row.restore_result ?? {}),
        archive_index: archiveIndexSummary(index),
        indexed_at: new Date().toISOString(),
      },
    });
    return {
      legacy_project_id,
      project_id,
      index: toLegacyMigrationArchiveIndex(index),
    };
  } catch (err) {
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "selection-pending",
      restore_error: `${err}`.slice(0, 4000),
    });
    throw err;
  }
}

export async function restoreArchiveSelection({
  account_id,
  legacy_project_id,
  include_paths,
  exclude_paths,
}: LegacyMigrationRestoreArchiveSelectionOptions): Promise<LegacyMigrationRestoreArchiveSelectionResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = requireSelectableImport(
    await importedProjectForAccount({ account_id, legacy_project_id }),
  );
  const project_id = row.project_id!;
  const include = normalizePathList(include_paths);
  const exclude = normalizePathList(exclude_paths);
  if (include == null && exclude == null) {
    throw new Error("select at least one include or exclude path");
  }
  const archiveIndex = archiveIndexFromRestoreResult(row.restore_result);
  const cache_id = clean(archiveIndex?.cache_id);
  if (!cache_id) {
    throw new Error("index the archive before restoring selected files");
  }
  await setArchiveSelectionState({
    legacy_project_id,
    restore_status: "restoring",
    restore_error: null,
  });
  try {
    const max_uncompressed_bytes = await getAccountStorageRemainingBytes({
      account_id: row.owner_account_id ?? account_id,
      fresh: true,
    });
    const client = await projectFileServerForArchive({
      account_id,
      project_id,
    });
    const result = await client.restoreProjectArchive({
      project_id,
      cache_id,
      include_paths: include,
      exclude_paths: exclude,
      max_uncompressed_bytes,
    });
    const restoreResult: Record<string, any> = {
      ...(row.restore_result ?? {}),
      archive_index: archiveIndex,
      restore: selectedRestoreSummary({
        result,
        include_paths: include,
        exclude_paths: exclude,
      }),
      restored_at: new Date().toISOString(),
    };
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "restored",
      restore_error: null,
      restore_result: restoreResult,
    });
    return {
      legacy_project_id,
      project_id,
      restore_status: "restored",
      result: restoreResult,
    };
  } catch (err) {
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "indexed",
      restore_error: `${err}`.slice(0, 4000),
    });
    throw err;
  }
}

function selectedRestoreSummary({
  result,
  include_paths,
  exclude_paths,
}: {
  result: ProjectArchiveRestoreResult;
  include_paths?: string[];
  exclude_paths?: string[];
}): Record<string, any> {
  return {
    bytes: result.bytes,
    sha256: result.sha256,
    file_count: result.file_count,
    uncompressed_bytes: result.uncompressed_bytes,
    duration_ms: result.duration_ms,
    include_paths: include_paths ?? [],
    exclude_paths: exclude_paths ?? [],
  };
}
