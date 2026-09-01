/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getTransactionClient, type PoolClient } from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getLogger from "@cocalc/backend/logger";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { MAX_INTEREST_TIMEOUT } from "@cocalc/conat/core/client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  ensureProjectFileServerClientReady,
  getProjectFsClient,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import createProject, {
  createProjectWithInternalProjectId,
} from "@cocalc/server/projects/create";
import createCredit from "@cocalc/server/purchases/create-credit";
import createSubscription from "@cocalc/server/purchases/create-subscription";
import {
  assertNoDueMembershipRenewal,
  lockMembershipSubscriptionAccount,
} from "@cocalc/server/purchases/membership-subscription-guard";
import {
  cancelOpenSubscriptionRenewalAttempts,
  scheduleSubscriptionRenewalAttempt,
} from "@cocalc/server/purchases/subscription-renewal-attempts";
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
import {
  ensurePublicDirectorySharesSchema,
  normalizePublicDirectorySharePath,
  upsertMigratedLegacyPublicDirectoryShare,
} from "@cocalc/server/public-directory-shares";
import {
  isUnsupportedLegacyProxyPublicPath,
  legacyPublicPathSlugForRecord,
  normalizeLegacyPublicPathDescription,
} from "@cocalc/server/legacy-migration/public-path-slugs";
import { setProjectLabels } from "@cocalc/server/projects/labels";
import { createLro } from "@cocalc/server/lro/lro-db";
import { triggerLegacyMigrationProjectRestoreWorker } from "@cocalc/server/legacy-migration/restore-worker";
import { issueSignedObjectDownload } from "@cocalc/server/project-backup/r2";
import {
  LEGACY_PROJECT_RESTORE_LRO_KIND,
  LEGACY_RESTORE_ERROR_LABEL,
  LEGACY_RESTORE_LRO_LABEL,
  LEGACY_RESTORE_STATUS_LABEL,
  LEGACY_SOURCE_PROJECT_LABEL,
} from "@cocalc/util/legacy-migration";
import { assertValidSnapshotName } from "@cocalc/util/snapshot-name";
import type {
  LegacyMigrationApplyFinancialHomeBayOptions,
  LegacyMigrationApplyFinancialHomeBayResponse,
  LegacyMigrationApplyFinancialOptions,
  LegacyMigrationApplyFinancialResponse,
  LegacyMigrationAdminAccountSearchOptions,
  LegacyMigrationAdminAccountSearchResponse,
  LegacyMigrationAdminAccountSummary,
  LegacyMigrationAdminApplyProjectRemediationOptions,
  LegacyMigrationAdminLinkedProjectsOptions,
  LegacyMigrationAdminLinkedProjectsResponse,
  LegacyMigrationAdminLinkLegacyAccountOptions,
  LegacyMigrationAdminLinkLegacyAccountResponse,
  LegacyMigrationAdminLinksOptions,
  LegacyMigrationAdminLinksResponse,
  LegacyMigrationAdminLinkSummary,
  LegacyMigrationAdminProjectSearchOptions,
  LegacyMigrationAdminReplayPublicPathsOptions,
  LegacyMigrationAdminReplayPublicPathsResponse,
  LegacyMigrationAdminReplayRestoredPublicPathsOptions,
  LegacyMigrationAdminReplayRestoredPublicPathsResponse,
  LegacyMigrationAdminProjectSearchResponse,
  LegacyMigrationAdminProjectAccountCandidate,
  LegacyMigrationAdminProjectSummary,
  LegacyMigrationAdminUnlinkLegacyAccountOptions,
  LegacyMigrationAdminUnlinkLegacyAccountResponse,
  LegacyMigrationApplyProjectRemediationOptions,
  LegacyMigrationConfigureFinancialRenewalHomeBayOptions,
  LegacyMigrationConfigureFinancialRenewalOptions,
  LegacyMigrationConfigureFinancialRenewalResponse,
  LegacyMigrationDismissProjectRemediationOptions,
  LegacyMigrationEntitlementCredit,
  LegacyMigrationFinancialAccount,
  LegacyMigrationFinancialMembershipGrantHomeBayOptions,
  LegacyMigrationFinancialMembershipGrantHomeBayResponse,
  LegacyMigrationFinancialPreviewOptions,
  LegacyMigrationFinancialPreviewResponse,
  LegacyMigrationMembershipPlan,
  LegacyMigrationImportProjectResult,
  LegacyMigrationImportProjectsOptions,
  LegacyMigrationImportProjectsResponse,
  LegacyMigrationListProjectsOptions,
  LegacyMigrationListProjectsResponse,
  LegacyMigrationListPublicSharesOptions,
  LegacyMigrationListPublicSharesResponse,
  LegacyMigrationPublicSharePathType,
  LegacyMigrationPublicShareSummary,
  LegacyMigrationMatchedAccount,
  LegacyMigrationPrepareProjectRemediationOptions,
  LegacyMigrationPrepareProjectRemediationResponse,
  LegacyMigrationProjectImportStatus,
  LegacyMigrationProjectRemediationDiffEntry,
  LegacyMigrationProjectRemediationDiffKind,
  LegacyMigrationProjectRemediationStatusOptions,
  LegacyMigrationProjectRemediationStatusResponse,
  LegacyMigrationProjectRestoreMode,
  LegacyMigrationProjectRestoreStatus,
  LegacyMigrationProjectSummary,
  LegacyMigrationRetryProjectRestoreOptions,
  LegacyMigrationRetryProjectRestoreResponse,
} from "@cocalc/conat/hub/api/legacy-migration";

import { randomUUID } from "node:crypto";
import { assertLegacyMigrationEnabled } from "./enabled";
import { moneyRound2Up, moneyToDbString, toDecimal } from "@cocalc/util/money";
import { isValidUUID } from "@cocalc/util/misc";
import { mapCloudRegionToR2Region, parseR2Region } from "@cocalc/util/consts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_PUBLIC_SHARE_LIST_LIMIT = 1000;
const PROJECT_ARCHIVE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const LEGACY_FINANCIAL_HOME_BAY_TIMEOUT_MS = MAX_INTEREST_TIMEOUT + 30_000;
const DEFAULT_LEGACY_PROJECTS_BUCKET = "cocalc-projects";
const LEGACY_PROJECT_FINAL_ARCHIVE_SNAPSHOT_NAME = "final-cocalc-com-archive";
export const MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST = 50;
const LEGACY_STRIPE_UPGRADE_PLAN_IDS = new Set([
  "standard",
  "premium",
  "professional",
  "standard2",
  "premium2",
  "professional2",
]);
const LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS = 30;

const logger = getLogger("server:legacy-migration");

const ACCOUNT_VERIFIED_EMAILS_JSON =
  "CASE WHEN jsonb_typeof(email_address_verified)='object' THEN email_address_verified ELSE '{}'::jsonb END";

type LegacyMigrationMembershipSubscription = {
  id: number;
  status: string | null;
  interval: "month" | "year" | null;
  current_period_end: Date | string | null;
  metadata: Record<string, any> | null;
};

type AccountEmailRow = {
  email_address: string | null;
  email_address_verified: Record<string, unknown> | null;
};

type LegacyAccountRow = {
  legacy_account_id: string;
  email_address: string | null;
  first_name?: string | null;
  last_name?: string | null;
  display_name: string | null;
  stripe_customer_id: string | null;
  last_active?: Date | string | null;
};

type AccountPrimaryEmailStatus = {
  email: string | null;
  verified: boolean;
};

type LegacyProjectRow = {
  legacy_project_id: string;
  name?: string | null;
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

type LegacyPublicPathRawRecord = {
  legacy_id: string;
  payload: Record<string, any>;
};

let importSchemaReady: Promise<void> | undefined;
let financialSchemaReady: Promise<void> | undefined;
let rawRecordsSchemaReady: Promise<void> | undefined;
let adminLinkSchemaReady: Promise<void> | undefined;
let lookupIndexesReady: Promise<void> | undefined;
let rawRecordIndexesReady: Promise<void> | undefined;

type IndexStatusRow = {
  relname: string;
  indisvalid: boolean;
  indisready: boolean;
};

const LEGACY_MIGRATION_LOOKUP_INDEXES = [
  "legacy_migration_accounts_lower_email_address_idx",
  "legacy_migration_accounts_gmail_canonical_email_idx",
  "legacy_migration_projects_owner_legacy_account_id_idx",
  "legacy_migration_projects_legacy_users_gin_idx",
] as const;

const LEGACY_MIGRATION_RAW_RECORD_INDEXES = [
  "legacy_migration_raw_records_public_paths_project_id_idx",
  "legacy_migration_raw_records_source_legacy_account_id_idx",
  "legacy_migration_raw_records_site_license_account_idx",
  "legacy_migration_raw_records_stripe_customer_idx",
  "legacy_migration_raw_records_lower_customer_email_idx",
  "legacy_migration_raw_records_gmail_customer_email_idx",
] as const;

function resetSchemaPromiseOnFailure<T>(
  promise: Promise<T>,
  reset: () => void,
): Promise<T> {
  return promise.catch((err) => {
    reset();
    throw err;
  });
}

async function validateLegacyMigrationIndexes({
  kind,
  names,
}: {
  kind: string;
  names: readonly string[];
}): Promise<void> {
  const { rows } = await getPool().query<IndexStatusRow>(
    `
      SELECT i.relname, ix.indisvalid, ix.indisready
        FROM pg_class i
        JOIN pg_index ix ON ix.indexrelid=i.oid
       WHERE i.relname=ANY($1::TEXT[])
    `,
    [names],
  );
  const ready = new Set(
    rows
      .filter(({ indisvalid, indisready }) => indisvalid && indisready)
      .map(({ relname }) => relname),
  );
  const missingOrInvalid = names.filter((name) => !ready.has(name));
  if (missingOrInvalid.length === 0) return;
  logger.warn(
    "legacy migration index prerequisites are missing or invalid; run bay scaffold/reconcile or a manual database migration",
    {
      kind,
      missing_or_invalid: missingOrInvalid,
      observed: rows,
    },
  );
}

async function ensureLegacyMigrationLookupIndexes(): Promise<void> {
  lookupIndexesReady ??= resetSchemaPromiseOnFailure(
    validateLegacyMigrationIndexes({
      kind: "lookup",
      names: LEGACY_MIGRATION_LOOKUP_INDEXES,
    }),
    () => {
      lookupIndexesReady = undefined;
    },
  );
  await lookupIndexesReady;
}

async function ensureLegacyMigrationRawRecordIndexes(): Promise<void> {
  rawRecordIndexesReady ??= resetSchemaPromiseOnFailure(
    validateLegacyMigrationIndexes({
      kind: "raw-record",
      names: LEGACY_MIGRATION_RAW_RECORD_INDEXES,
    }),
    () => {
      rawRecordIndexesReady = undefined;
    },
  );
  await rawRecordIndexesReady;
}

async function ensureLegacyMigrationProjectImportSchema(): Promise<void> {
  importSchemaReady ??= resetSchemaPromiseOnFailure(
    (async () => {
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
        ADD COLUMN IF NOT EXISTS name TEXT,
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
      await ensureLegacyMigrationLookupIndexes();
    })(),
    () => {
      importSchemaReady = undefined;
    },
  );
  await importSchemaReady;
}

async function ensureLegacyMigrationFinancialSchema(): Promise<void> {
  financialSchemaReady ??= resetSchemaPromiseOnFailure(
    (async () => {
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
      await ensureLegacyMigrationRawRecordIndexes();
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
    })(),
    () => {
      financialSchemaReady = undefined;
    },
  );
  await financialSchemaReady;
}

async function ensureLegacyMigrationAdminLinkSchema(): Promise<void> {
  adminLinkSchemaReady ??= resetSchemaPromiseOnFailure(
    (async () => {
      await getPool().query(`
      CREATE TABLE IF NOT EXISTS legacy_migration_account_link_events (
        id UUID PRIMARY KEY,
        legacy_account_id VARCHAR(128) NOT NULL,
        account_id UUID NOT NULL,
        actor_account_id UUID NOT NULL,
        action VARCHAR(32) NOT NULL,
        reason TEXT NOT NULL,
        support_reference TEXT,
        claim_method VARCHAR(64),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
      await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_account_link_events_account_id_idx
        ON legacy_migration_account_link_events(account_id)
    `);
      await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_account_link_events_legacy_account_id_idx
        ON legacy_migration_account_link_events(legacy_account_id)
    `);
      await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_account_link_events_actor_account_id_idx
        ON legacy_migration_account_link_events(actor_account_id)
    `);
      await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_account_link_events_action_idx
        ON legacy_migration_account_link_events(action)
    `);
      await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_account_link_events_created_idx
        ON legacy_migration_account_link_events(created)
    `);
    })(),
    () => {
      adminLinkSchemaReady = undefined;
    },
  );
  await adminLinkSchemaReady;
}

async function ensureLegacyMigrationRawRecordsSchema(): Promise<void> {
  rawRecordsSchemaReady ??= resetSchemaPromiseOnFailure(
    getPool()
      .query(
        `
    CREATE TABLE IF NOT EXISTS legacy_migration_raw_records (
      source VARCHAR(64) NOT NULL,
      legacy_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, legacy_id)
    )
  `,
      )
      .then(async () => {
        await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_raw_records_updated_idx
        ON legacy_migration_raw_records(updated)
    `);
        await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_raw_records_public_paths_project_id_idx
        ON legacy_migration_raw_records ((payload->>'project_id'), updated DESC)
        WHERE source='public_paths'
    `);
        await ensureLegacyMigrationRawRecordIndexes();
      }),
    () => {
      rawRecordsSchemaReady = undefined;
    },
  );
  await rawRecordsSchemaReady;
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

function legacyBoolean(value: unknown): boolean {
  return (
    value === true || ["true", "t", "1"].includes(`${value}`.toLowerCase())
  );
}

type LegacyPublicPathTarget = {
  path: string;
  path_type: "directory" | "file";
};

type LegacyPublicPathResolution = {
  target: LegacyPublicPathTarget;
  availability_status: "available" | "pending" | "unavailable";
  availability_message: string | null;
};

function looksLikeLegacyFilePath(path: string): boolean {
  if (path === ".") return false;
  const tail = path.split("/").filter(Boolean).at(-1) ?? "";
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(tail);
}

export function legacyPublicPathTargetFromRetainedRecord(
  row: Record<string, any>,
): LegacyPublicPathTarget | undefined {
  const retainedType = clean(row.original_path_type);
  if (retainedType === "file" || retainedType === "directory") {
    return {
      path: normalizePublicDirectorySharePath(
        clean(row.original_path) ?? clean(row.path) ?? ".",
      ),
      path_type: retainedType,
    };
  }
  const path = normalizePublicDirectorySharePath(
    clean(row.original_path) ?? clean(row.path) ?? ".",
  );
  // Older raw imports predate original_path_type. Only infer a file here:
  // that narrows access. Inferring a directory could expose sibling files.
  return looksLikeLegacyFilePath(path)
    ? { path, path_type: "file" }
    : undefined;
}

function isMissingLegacyPublicPathError(err: unknown): boolean {
  const value = `${(err as any)?.code ?? ""} ${(err as Error)?.message ?? err}`;
  return /\bENOENT\b|no such file or directory|not found/i.test(value);
}

export async function resolveLegacyPublicPathTarget({
  row,
  fs,
  restoreComplete,
}: {
  row: Record<string, any>;
  fs?: Awaited<ReturnType<typeof getProjectFsClient>>;
  restoreComplete: boolean;
}): Promise<LegacyPublicPathResolution | undefined> {
  const retained = legacyPublicPathTargetFromRetainedRecord(row);
  const path = normalizePublicDirectorySharePath(
    clean(row.original_path) ?? clean(row.path) ?? ".",
  );
  if (fs == null) {
    if (!retained) return;
    return {
      target: retained,
      availability_status: "pending",
      availability_message: restoreComplete
        ? "This project is restored, but CoCalc could not verify the published path yet."
        : "This legacy project has been selected for migration, but its files have not finished restoring yet.",
    };
  }
  try {
    const stat = await fs.lstat(path);
    if (stat.isFile()) {
      return {
        target: { path, path_type: "file" },
        availability_status: "available",
        availability_message: null,
      };
    }
    if (stat.isDirectory()) {
      return {
        target: { path, path_type: "directory" },
        availability_status: "available",
        availability_message: null,
      };
    }
    if (!retained) return;
    return {
      target: retained,
      availability_status: "unavailable",
      availability_message: stat.isSymbolicLink()
        ? "The restored published path is a symbolic link, which cannot be published."
        : "The restored published path is not a regular file or directory.",
    };
  } catch (err) {
    logger.warn("unable to classify restored legacy public path", {
      path,
      error: `${err}`,
    });
    if (!retained) return;
    return {
      target: retained,
      availability_status: isMissingLegacyPublicPathError(err)
        ? "unavailable"
        : "pending",
      availability_message: isMissingLegacyPublicPathError(err)
        ? "The published path was not found in the restored project."
        : "This project is restored, but CoCalc could not verify the published path yet.",
    };
  }
}

function legacyPublicPathVisibility(
  row: Record<string, any>,
): "listed" | "unlisted" {
  if (legacyBoolean(row.unlisted)) return "unlisted";
  return "listed";
}

export function shouldReplayLegacyPublicPath(
  row: Record<string, any>,
): boolean {
  return (
    !legacyBoolean(row.disabled) && !isUnsupportedLegacyProxyPublicPath(row)
  );
}

function validLegacyPublicPathSiteLicenseId(
  row: Record<string, any>,
): string | null {
  const siteLicenseId = clean(row.site_license_id);
  return siteLicenseId && isValidUUID(siteLicenseId) ? siteLicenseId : null;
}

function legacyPublicPathMetadata(row: Record<string, any>) {
  return {
    authenticated: row.authenticated ?? null,
    auth: row.auth ?? null,
    compute_image: row.compute_image ?? null,
    counter: row.counter ?? null,
    legacy_path: clean(row.original_path) ?? clean(row.path) ?? null,
    legacy_path_type:
      clean(row.original_path_type) ??
      (looksLikeLegacyFilePath(
        clean(row.original_path) ?? clean(row.path) ?? ".",
      )
        ? "file"
        : "unknown"),
    legacy_site_license_id: clean(row.legacy_site_license_id),
    jupyter_api: row.jupyter_api ?? null,
    source: "legacy-migration",
    token: row.token ?? null,
    vhost: row.vhost ?? null,
  };
}

export async function replayLegacyPublicPathsForProject({
  account_id,
  legacy_project_id,
  project_id,
}: {
  account_id: string;
  legacy_project_id: string;
  project_id: string;
}): Promise<{ imported: number; skipped: number }> {
  await ensureLegacyMigrationRawRecordsSchema();
  const { rows } = await getPool().query<LegacyPublicPathRawRecord>(
    `
      SELECT raw.legacy_id, raw.payload
        FROM legacy_migration_raw_records raw
        LEFT JOIN legacy_migration_projects project
          ON project.legacy_project_id=raw.payload->>'project_id'
       WHERE raw.source='public_paths'
         AND raw.payload->>'project_id'=$1
         AND lower(COALESCE(project.title, '')) NOT LIKE 'github-proxy%'
       ORDER BY raw.payload->>'created', raw.legacy_id
    `,
    [legacy_project_id],
  );
  if (rows.length === 0) return { imported: 0, skipped: 0 };

  const restore = await getPool().query<{ restore_status: string | null }>(
    `SELECT restore_status
       FROM legacy_migration_project_imports
      WHERE legacy_project_id=$1
      LIMIT 1`,
    [legacy_project_id],
  );
  const restoreStatus = restore.rows[0]?.restore_status;
  const restoreComplete = restoreStatus === "restored";
  let fs: Awaited<ReturnType<typeof getProjectFsClient>> | undefined;
  if (restoreStatus === "restored") {
    try {
      fs = await getProjectFsClient({ account_id, project_id });
    } catch (err) {
      logger.warn("unable to inspect restored legacy public paths", {
        legacy_project_id,
        project_id,
        error: `${err}`,
      });
    }
  }

  let imported = 0;
  let skipped = 0;
  for (const { legacy_id, payload } of rows) {
    const legacyPublicPathId = clean(payload.id) ?? legacy_id;
    try {
      if (!shouldReplayLegacyPublicPath(payload)) {
        skipped += 1;
        continue;
      }
      const slug = await legacyPublicPathSlugForRecord(payload);
      if (!legacyPublicPathId || !slug) {
        skipped += 1;
        continue;
      }
      const resolution = await resolveLegacyPublicPathTarget({
        row: payload,
        fs,
        restoreComplete,
      });
      if (resolution == null) {
        skipped += 1;
        continue;
      }
      await upsertMigratedLegacyPublicDirectoryShare({
        account_id,
        project_id,
        path: resolution.target.path,
        path_type: resolution.target.path_type,
        slug,
        visibility: legacyPublicPathVisibility(payload),
        requires_auth: true,
        availability_status: resolution.availability_status,
        availability_message: resolution.availability_message,
        title: clean(payload.title) ?? clean(payload.name) ?? null,
        description:
          normalizeLegacyPublicPathDescription(payload.description) ?? null,
        license: clean(payload.license) ?? null,
        image: clean(payload.image) ?? null,
        redirect: clean(payload.redirect) ?? null,
        site_license_id: validLegacyPublicPathSiteLicenseId(payload),
        metadata: legacyPublicPathMetadata(payload),
        legacy_public_path_id: legacyPublicPathId,
        legacy_url: clean(payload.url) ?? null,
        last_edited: payload.last_edited ?? payload.last_saved ?? null,
        disabled: legacyBoolean(payload.disabled),
      });
      imported += 1;
    } catch (err) {
      skipped += 1;
      logger.warn("failed to replay legacy public path", {
        legacy_project_id,
        project_id,
        legacy_public_path_id: legacyPublicPathId,
        error: `${err}`,
      });
    }
  }
  logger.info("replayed legacy public paths for imported project", {
    legacy_project_id,
    project_id,
    imported,
    skipped,
  });
  return { imported, skipped };
}

export async function replayLegacyPublicPathsForProjectBestEffort(opts: {
  account_id: string;
  legacy_project_id: string;
  project_id: string;
}): Promise<{ imported: number; skipped: number } | undefined> {
  try {
    return await replayLegacyPublicPathsForProject(opts);
  } catch (err) {
    logger.warn("failed to replay legacy public paths for imported project", {
      legacy_project_id: opts.legacy_project_id,
      project_id: opts.project_id,
      error: `${err}`,
    });
  }
}

export async function adminReplayPublicPaths({
  account_id,
  legacy_project_id,
  commit,
  reason,
  support_reference,
}: LegacyMigrationAdminReplayPublicPathsOptions): Promise<LegacyMigrationAdminReplayPublicPathsResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationRawRecordsSchema();
  const actorAccountId = requireActorAccountId(account_id);
  const auditReason = requireAuditReason(reason);
  const legacyProjectId = `${legacy_project_id ?? ""}`.trim();
  if (!isValidUUID(legacyProjectId)) {
    throw Error("invalid legacy_project_id");
  }
  const migration = await getPool().query<{
    project_id: string;
    owner_account_id: string;
    restore_status: LegacyMigrationProjectRestoreStatus | null;
  }>(
    `SELECT imports.project_id, imports.owner_account_id, imports.restore_status
       FROM legacy_migration_project_imports imports
       JOIN projects p ON p.project_id=imports.project_id
        AND COALESCE(p.deleted, false)=false
      WHERE imports.legacy_project_id=$1
      LIMIT 1`,
    [legacyProjectId],
  );
  const target = migration.rows[0];
  if (!target?.project_id) {
    throw Error("legacy project has not been explicitly imported");
  }
  const counts = await getPool().query<{
    public_path_count: number | string;
    file_path_count: number | string;
  }>(
    `SELECT COUNT(*) AS public_path_count,
            COUNT(*) FILTER (
              WHERE payload->>'original_path_type'='file'
                 OR (
                   COALESCE(payload->>'original_path_type', '')=''
                   AND COALESCE(payload->>'original_path', payload->>'path', '')
                     ~ '\\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$'
                 )
            ) AS file_path_count
       FROM legacy_migration_raw_records
      WHERE source='public_paths'
        AND payload->>'project_id'=$1`,
    [legacyProjectId],
  );
  const publicPathCount = Number(counts.rows[0]?.public_path_count ?? 0);
  const filePathCount = Number(counts.rows[0]?.file_path_count ?? 0);
  if (commit !== true) {
    return {
      legacy_project_id: legacyProjectId,
      project_id: target.project_id,
      restore_status: target.restore_status,
      public_path_count: publicPathCount,
      file_path_count: filePathCount,
      imported: 0,
      skipped: 0,
      committed: false,
    };
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS legacy_migration_public_share_replay_events (
      id UUID PRIMARY KEY,
      legacy_project_id UUID NOT NULL,
      project_id UUID NOT NULL,
      actor_account_id UUID NOT NULL,
      reason TEXT NOT NULL,
      support_reference TEXT,
      public_path_count INTEGER NOT NULL,
      file_path_count INTEGER NOT NULL,
      imported INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL,
      error TEXT,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await getPool().query(`
    ALTER TABLE legacy_migration_public_share_replay_events
      ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'succeeded',
      ADD COLUMN IF NOT EXISTS error TEXT
  `);
  const eventId = randomUUID();
  await getPool().query(
    `INSERT INTO legacy_migration_public_share_replay_events (
       id, legacy_project_id, project_id, actor_account_id, reason,
       support_reference, public_path_count, file_path_count, imported, skipped,
       status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,'running')`,
    [
      eventId,
      legacyProjectId,
      target.project_id,
      actorAccountId,
      auditReason,
      clean(support_reference) ?? null,
      publicPathCount,
      filePathCount,
    ],
  );
  let replay: { imported: number; skipped: number };
  try {
    replay = await replayLegacyPublicPathsForProject({
      account_id: target.owner_account_id,
      legacy_project_id: legacyProjectId,
      project_id: target.project_id,
    });
    await getPool().query(
      `UPDATE legacy_migration_public_share_replay_events
          SET imported=$2, skipped=$3, status='succeeded'
        WHERE id=$1`,
      [eventId, replay.imported, replay.skipped],
    );
  } catch (err) {
    await getPool().query(
      `UPDATE legacy_migration_public_share_replay_events
          SET status='failed', error=$2
        WHERE id=$1`,
      [eventId, `${err}`.slice(0, 4000)],
    );
    throw err;
  }
  return {
    legacy_project_id: legacyProjectId,
    project_id: target.project_id,
    restore_status: target.restore_status,
    public_path_count: publicPathCount,
    file_path_count: filePathCount,
    imported: replay.imported,
    skipped: replay.skipped,
    committed: true,
  };
}

const MAX_PUBLIC_SHARE_REPLAY_BATCH = 50;

function publicShareReplayBatchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 25;
  return Math.max(
    1,
    Math.min(MAX_PUBLIC_SHARE_REPLAY_BATCH, Math.floor(limit!)),
  );
}

export async function adminReplayRestoredPublicPaths({
  account_id,
  after_legacy_project_id,
  commit,
  limit,
  reason,
  support_reference,
}: LegacyMigrationAdminReplayRestoredPublicPathsOptions): Promise<LegacyMigrationAdminReplayRestoredPublicPathsResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationRawRecordsSchema();
  await ensureLegacyMigrationProjectImportSchema();
  await ensurePublicDirectorySharesSchema();
  const actorAccountId = requireActorAccountId(account_id);
  const auditReason = requireAuditReason(reason);
  const after = `${after_legacy_project_id ?? ""}`.trim();
  if (after && !isValidUUID(after)) {
    throw Error("invalid after_legacy_project_id");
  }
  const batchLimit = publicShareReplayBatchLimit(limit);
  const { rows } = await getPool().query<{
    legacy_project_id: string;
    project_id: string;
    public_path_count: number | string;
    missing_share_count: number | string;
    pending_share_count: number | string;
  }>(
    `
      WITH active_paths AS (
        SELECT DISTINCT COALESCE(NULLIF(raw.payload->>'id', ''), raw.legacy_id)
                 AS legacy_public_path_id,
               raw.payload->>'project_id' AS legacy_project_id
          FROM legacy_migration_raw_records raw
         WHERE raw.source='public_paths'
           AND lower(COALESCE(raw.payload->>'disabled', 'false'))
                 NOT IN ('true', 't', '1')
           AND lower(regexp_replace(
                 COALESCE(raw.payload->>'url', ''),
                 '^(https?://[^/]+/|/+)',
                 ''
               )) !~ '^(github|gist)(/|$)'
      ), candidates AS (
        SELECT imports.legacy_project_id,
               imports.project_id,
               COUNT(*)::INTEGER AS public_path_count,
               COUNT(*) FILTER (WHERE current.id IS NULL)::INTEGER
                 AS missing_share_count,
               COUNT(*) FILTER (
                 WHERE current.availability_status='pending'
                   AND COALESCE(current.disabled, false)=false
               )::INTEGER AS pending_share_count
          FROM legacy_migration_project_imports imports
          JOIN projects project
            ON project.project_id=imports.project_id
           AND COALESCE(project.deleted, false)=false
          JOIN legacy_migration_projects legacy_project
            ON legacy_project.legacy_project_id=imports.legacy_project_id
           AND lower(COALESCE(legacy_project.title, ''))
                 NOT LIKE 'github-proxy%'
          JOIN active_paths active
            ON active.legacy_project_id=imports.legacy_project_id
          LEFT JOIN public_project_paths current
            ON current.legacy_public_path_id=active.legacy_public_path_id
         WHERE imports.restore_status='restored'
         GROUP BY imports.legacy_project_id, imports.project_id
        HAVING COUNT(*) FILTER (
                 WHERE current.id IS NULL
                    OR (
                      current.availability_status='pending'
                      AND COALESCE(current.disabled, false)=false
                    )
               ) > 0
      )
      SELECT legacy_project_id, project_id, public_path_count,
             missing_share_count, pending_share_count
        FROM candidates
       WHERE ($1::TEXT='' OR legacy_project_id::TEXT>$1::TEXT)
       ORDER BY legacy_project_id
       LIMIT $2
    `,
    [after, batchLimit + 1],
  );
  const hasMore = rows.length > batchLimit;
  const candidates = rows.slice(0, batchLimit);
  const projects: LegacyMigrationAdminReplayRestoredPublicPathsResponse["projects"] =
    [];
  for (const candidate of candidates) {
    const summary = {
      legacy_project_id: candidate.legacy_project_id,
      project_id: candidate.project_id,
      public_path_count: Number(candidate.public_path_count),
      missing_share_count: Number(candidate.missing_share_count),
      pending_share_count: Number(candidate.pending_share_count),
      imported: 0,
      skipped: 0,
    };
    if (commit !== true) {
      projects.push(summary);
      continue;
    }
    try {
      const replay = await adminReplayPublicPaths({
        account_id: actorAccountId,
        legacy_project_id: candidate.legacy_project_id,
        commit: true,
        reason: auditReason,
        support_reference,
      });
      projects.push({
        ...summary,
        imported: replay.imported,
        skipped: replay.skipped,
      });
    } catch (err) {
      projects.push({
        ...summary,
        error: `${err}`.slice(0, 4000),
      });
    }
  }
  return {
    projects,
    committed: commit === true,
    has_more: hasMore,
    next_after_legacy_project_id:
      candidates[candidates.length - 1]?.legacy_project_id,
  };
}

function restoreStatusForProject(
  row: Pick<
    LegacyProjectRow,
    "artifact_status" | "artifact_key" | "artifact_manifest"
  >,
): LegacyMigrationProjectRestoreStatus {
  if (!legacyArchiveAvailable(row)) {
    return "skipped";
  }
  return "pending";
}

function normalizeRestoreMode(
  mode: unknown,
): LegacyMigrationProjectRestoreMode {
  if (mode == null || mode === "") return "full";
  if (mode === "full") return mode;
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
    const value = clean(nestedValue(manifest, path));
    if (value) return value.toLowerCase();
  }
  return undefined;
}

function legacyArchiveAvailable(
  row: Pick<
    LegacyProjectRow,
    "artifact_status" | "artifact_key" | "artifact_manifest"
  >,
): boolean {
  const artifactKey = clean(row.artifact_key);
  const r2Key = clean(nestedValue(row.artifact_manifest, ["r2_key"]));
  return (
    row.artifact_status === "available" &&
    !!artifactKey &&
    r2Key === artifactKey &&
    manifestCompressedBytes(row.artifact_manifest) != null
  );
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
  await ensureLegacyMigrationLookupIndexes();
  const { rows } = await getPool().query<LegacyMigrationMatchedAccount>(
    `
    WITH matches AS (
      SELECT legacy_account_id,
             email_address,
             display_name,
             lower(email_address) AS exact_email,
             NULL::TEXT AS gmail_canonical_email,
             last_active,
             'exact-email' AS match_method,
             0 AS priority
        FROM legacy_migration_accounts
       WHERE COALESCE(email_address, '') <> ''
         AND lower(email_address)=$1
      UNION ALL
      SELECT legacy_account_id,
             email_address,
             display_name,
             lower(email_address) AS exact_email,
             replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'
               AS gmail_canonical_email,
             last_active,
             'gmail-canonical' AS match_method,
             1 AS priority
        FROM legacy_migration_accounts
       WHERE $2::TEXT IS NOT NULL
         AND COALESCE(email_address, '') <> ''
         AND split_part(lower(email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
         AND replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'=$2::TEXT
    ),
    deduped AS (
      SELECT DISTINCT ON (legacy_account_id)
             legacy_account_id,
             email_address,
             display_name,
             match_method,
             gmail_canonical_email,
             last_active
        FROM matches
       ORDER BY legacy_account_id, priority
    )
    SELECT legacy_account_id,
           email_address,
           display_name,
           match_method,
           gmail_canonical_email
      FROM deduped
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
  await ensureLegacyMigrationLookupIndexes();
  await getPool().query(
    `
    WITH matches AS (
      SELECT legacy_account_id,
             email_address,
             lower(email_address) AS exact_email,
             NULL::TEXT AS gmail_canonical_email,
             'exact-email' AS match_method,
             0 AS priority
        FROM legacy_migration_accounts
       WHERE COALESCE(email_address, '') <> ''
         AND lower(email_address)=ANY($2::TEXT[])
      UNION ALL
      SELECT legacy_account_id,
             email_address,
             lower(email_address) AS exact_email,
             replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'
               AS gmail_canonical_email,
             'gmail-canonical' AS match_method,
             1 AS priority
        FROM legacy_migration_accounts
       WHERE COALESCE(email_address, '') <> ''
         AND split_part(lower(email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
         AND replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'=ANY($3::TEXT[])
    ),
    deduped AS (
      SELECT DISTINCT ON (legacy_account_id)
             legacy_account_id,
             email_address,
             match_method,
             gmail_canonical_email
        FROM matches
       ORDER BY legacy_account_id, priority
    )
    INSERT INTO legacy_migration_account_links
      (legacy_account_id, account_id, claim_method, metadata, created, updated)
    SELECT legacy_account_id,
           $1::UUID,
           'verified-email',
           jsonb_build_object(
             'email_address', email_address,
             'match_method', match_method,
             'gmail_canonical_email', gmail_canonical_email
           ),
           NOW(),
           NOW()
      FROM deduped
    ON CONFLICT (legacy_account_id, account_id)
    DO NOTHING
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

function adminLimitValue(value: unknown, defaultLimit = 50, max = 250): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(max, Math.floor(n));
}

function requireSearchQuery(query: unknown): string {
  const value = `${query ?? ""}`.trim().toLowerCase();
  if (value.length < 2) {
    throw new Error("search query must contain at least 2 characters");
  }
  return value;
}

function requireTargetAccountId(target_account_id: unknown): string {
  const value = `${target_account_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw new Error("target_account_id must be a valid account id");
  }
  return value;
}

function requireActorAccountId(account_id: unknown): string {
  const value = `${account_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw new Error("account_id must be a valid admin account id");
  }
  return value;
}

function requireLegacyAccountId(legacy_account_id: unknown): string {
  const value = `${legacy_account_id ?? ""}`.trim();
  if (!value) {
    throw new Error("legacy_account_id is required");
  }
  return value;
}

function requireAuditReason(reason: unknown): string {
  const value = `${reason ?? ""}`.trim();
  if (!value) {
    throw new Error("reason is required");
  }
  return value;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((x) => `${x}`).filter((x) => x.length > 0)
    : [];
}

function adminAccountSummary(
  row: LegacyMigrationAdminAccountSummary & {
    project_count?: number | string | null;
    target_claim_methods?: string[] | null;
    support_admin_linked_account_ids?: string[] | null;
  },
): LegacyMigrationAdminAccountSummary {
  return {
    legacy_account_id: row.legacy_account_id,
    email_address: normalizeEmail(row.email_address) || null,
    first_name: row.first_name ?? null,
    last_name: row.last_name ?? null,
    display_name: row.display_name ?? null,
    last_active: row.last_active ?? null,
    project_count:
      row.project_count == null
        ? null
        : Math.max(0, Number(row.project_count) || 0),
    target_claim_methods: arrayValue(row.target_claim_methods),
    support_admin_linked_account_ids: arrayValue(
      row.support_admin_linked_account_ids,
    ),
  };
}

function adminLinkSummary(
  row: LegacyMigrationAdminLinkSummary & {
    project_count?: number | string | null;
    target_claim_methods?: string[] | null;
    support_admin_linked_account_ids?: string[] | null;
  },
): LegacyMigrationAdminLinkSummary {
  return {
    ...adminAccountSummary(row),
    claim_method: row.claim_method,
    metadata: row.metadata ?? null,
    created: row.created ?? null,
    updated: row.updated ?? null,
  };
}

function adminProjectAccountCandidates(
  value: unknown,
): LegacyMigrationAdminProjectAccountCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((candidate) => {
      const record = asRecord(candidate);
      const legacyAccountId = clean(record.legacy_account_id);
      if (!legacyAccountId) return undefined;
      const summary: LegacyMigrationAdminProjectAccountCandidate = {
        legacy_account_id: legacyAccountId,
        email_address: normalizeEmail(record.email_address) || null,
        first_name: clean(record.first_name),
        last_name: clean(record.last_name),
        display_name: clean(record.display_name),
        last_active: record.last_active ?? null,
        role: record.role === "owner" ? "owner" : "collaborator",
        target_claim_methods: arrayValue(record.target_claim_methods),
        support_admin_linked_account_ids: arrayValue(
          record.support_admin_linked_account_ids,
        ),
      };
      return summary;
    })
    .filter(
      (candidate): candidate is LegacyMigrationAdminProjectAccountCandidate =>
        candidate != null,
    );
}

function adminProjectSummary(
  row: LegacyMigrationAdminProjectSummary &
    LegacyProjectRow & {
      candidate_legacy_account_ids?: string[] | null;
      candidate_legacy_accounts?: unknown;
      target_claim_methods?: string[] | null;
      owner_email_address?: string | null;
      owner_display_name?: string | null;
      name?: string | null;
    },
): LegacyMigrationAdminProjectSummary {
  return {
    legacy_project_id: row.legacy_project_id,
    name: row.name ?? null,
    title: projectTitle(row),
    owner_legacy_account_id: row.owner_legacy_account_id ?? null,
    owner_email_address: normalizeEmail(row.owner_email_address) || null,
    owner_display_name: row.owner_display_name ?? null,
    candidate_legacy_account_ids: arrayValue(row.candidate_legacy_account_ids),
    candidate_legacy_accounts: adminProjectAccountCandidates(
      row.candidate_legacy_accounts,
    ),
    target_claim_methods: arrayValue(row.target_claim_methods),
    last_edited: row.last_edited ?? null,
    last_active: row.last_active ?? null,
    disk_mb: nonnegativeNumber(row.disk_mb),
    artifact_status: row.artifact_status ?? null,
    artifact_bytes: manifestCompressedBytes(row.artifact_manifest) ?? null,
    project_id: row.project_id ?? null,
    owner_account_id: row.owner_account_id ?? null,
    import_status:
      row.status === "creating" || row.status === "failed"
        ? row.status
        : row.project_id
          ? "imported"
          : "not-imported",
    restore_status: row.restore_status ?? null,
    joined: !!row.joined,
  };
}

async function verifyTargetAccountExists(target_account_id: string) {
  if (await getClusterAccountById(target_account_id)) return;
  const { rows } = await getPool().query(
    `
    SELECT 1
      FROM accounts
     WHERE account_id=$1
       AND COALESCE(deleted, false)=false
     LIMIT 1
    `,
    [target_account_id],
  );
  if (rows.length === 0) {
    throw new Error(`target account ${target_account_id} was not found`);
  }
}

async function verifyLegacyAccountExists(legacy_account_id: string) {
  const { rows } = await getPool().query(
    `
    SELECT 1
      FROM legacy_migration_accounts
     WHERE legacy_account_id=$1
     LIMIT 1
    `,
    [legacy_account_id],
  );
  if (rows.length === 0) {
    throw new Error(`legacy account ${legacy_account_id} was not found`);
  }
}

async function getLegacyAccountLinkSummary({
  target_account_id,
  legacy_account_id,
}: {
  target_account_id: string;
  legacy_account_id: string;
}): Promise<LegacyMigrationAdminLinkSummary> {
  const { rows } = await getPool().query<
    LegacyMigrationAdminLinkSummary & {
      project_count: number | string | null;
      target_claim_methods: string[] | null;
      support_admin_linked_account_ids: string[] | null;
    }
  >(
    `
    SELECT accounts.legacy_account_id,
           accounts.email_address,
           accounts.first_name,
           accounts.last_name,
           accounts.display_name,
           accounts.last_active,
           linked.claim_method,
           linked.metadata,
           linked.created,
           linked.updated,
           ARRAY(
             SELECT DISTINCT COALESCE(target_link.claim_method, '')
               FROM legacy_migration_account_links target_link
              WHERE target_link.legacy_account_id=accounts.legacy_account_id
                AND target_link.account_id=$1
              ORDER BY COALESCE(target_link.claim_method, '')
           ) AS target_claim_methods,
           ARRAY(
             SELECT DISTINCT support_link.account_id::TEXT
               FROM legacy_migration_account_links support_link
              WHERE support_link.legacy_account_id=accounts.legacy_account_id
                AND support_link.claim_method='support-admin'
                AND support_link.account_id<>$1
              ORDER BY support_link.account_id::TEXT
           ) AS support_admin_linked_account_ids,
           NULL::INTEGER AS project_count
      FROM legacy_migration_account_links linked
      JOIN legacy_migration_accounts accounts
        ON accounts.legacy_account_id=linked.legacy_account_id
     WHERE linked.account_id=$1
       AND linked.legacy_account_id=$2
     LIMIT 1
    `,
    [target_account_id, legacy_account_id],
  );
  if (rows[0] == null) {
    throw new Error("legacy account link was not found");
  }
  return adminLinkSummary(rows[0]);
}

export async function adminSearchLegacyAccounts({
  target_account_id,
  query,
  limit,
}: LegacyMigrationAdminAccountSearchOptions): Promise<LegacyMigrationAdminAccountSearchResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationAdminLinkSchema();
  const targetAccountId = requireTargetAccountId(target_account_id);
  const search = requireSearchQuery(query);
  const prefixSearch = `${search}%`;
  const n = adminLimitValue(limit, 50, 100);
  const { rows } = await getPool().query<
    LegacyMigrationAdminAccountSummary & {
      project_count: number | string | null;
      target_claim_methods: string[] | null;
      support_admin_linked_account_ids: string[] | null;
    }
  >(
    `
    WITH matched_accounts AS (
      SELECT accounts.*
        FROM legacy_migration_accounts accounts
       WHERE accounts.legacy_account_id=$2
          OR accounts.legacy_account_id LIKE $3
          OR accounts.email_address=$2
          OR accounts.email_address LIKE $3
          OR lower(COALESCE(accounts.first_name, '')) LIKE $3
          OR lower(COALESCE(accounts.last_name, '')) LIKE $3
          OR lower(COALESCE(accounts.display_name, '')) LIKE $3
       ORDER BY accounts.last_active DESC NULLS LAST,
                accounts.email_address,
                accounts.legacy_account_id
       LIMIT $4
    )
    SELECT matched_accounts.legacy_account_id,
           matched_accounts.email_address,
           matched_accounts.first_name,
           matched_accounts.last_name,
           matched_accounts.display_name,
           matched_accounts.last_active,
           ARRAY(
             SELECT DISTINCT COALESCE(target_link.claim_method, '')
               FROM legacy_migration_account_links target_link
              WHERE target_link.legacy_account_id=matched_accounts.legacy_account_id
                AND target_link.account_id=$1
              ORDER BY COALESCE(target_link.claim_method, '')
           ) AS target_claim_methods,
           ARRAY(
             SELECT DISTINCT support_link.account_id::TEXT
               FROM legacy_migration_account_links support_link
              WHERE support_link.legacy_account_id=matched_accounts.legacy_account_id
                AND support_link.claim_method='support-admin'
                AND support_link.account_id<>$1
              ORDER BY support_link.account_id::TEXT
           ) AS support_admin_linked_account_ids,
           NULL::INTEGER AS project_count
      FROM matched_accounts
     ORDER BY matched_accounts.last_active DESC NULLS LAST,
              lower(COALESCE(matched_accounts.email_address, '')),
              matched_accounts.legacy_account_id
    `,
    [targetAccountId, search, prefixSearch, n],
  );
  return {
    accounts: rows.map(adminAccountSummary),
    total_count: rows.length,
  };
}

export async function adminSearchLegacyProjects({
  target_account_id,
  query,
  limit,
}: LegacyMigrationAdminProjectSearchOptions): Promise<LegacyMigrationAdminProjectSearchResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationProjectImportSchema();
  await ensureLegacyMigrationAdminLinkSchema();
  const targetAccountId = requireTargetAccountId(target_account_id);
  const search = `${requireSearchQuery(query)}%`;
  const n = adminLimitValue(limit, 50, 100);
  const { rows } = await getPool().query<
    LegacyMigrationAdminProjectSummary & LegacyProjectRow
  >(
    `
    WITH matched_projects AS (
      SELECT projects.*
        FROM legacy_migration_projects projects
       WHERE COALESCE(projects.hidden, false)=false
         AND (
           lower(projects.legacy_project_id) LIKE $2
           OR lower(COALESCE(projects.title, '')) LIKE $2
           OR lower(COALESCE(projects.name, '')) LIKE $2
         )
       ORDER BY projects.last_edited DESC NULLS LAST,
                projects.last_active DESC NULLS LAST,
                projects.legacy_project_id
       LIMIT $3
    )
    SELECT projects.legacy_project_id,
           projects.name,
           projects.title,
           projects.owner_legacy_account_id,
           owner.email_address AS owner_email_address,
           owner.display_name AS owner_display_name,
           ARRAY(
             SELECT DISTINCT ids.legacy_account_id
               FROM (
                 SELECT projects.owner_legacy_account_id AS legacy_account_id
                 UNION
                 SELECT users.key AS legacy_account_id
                   FROM jsonb_object_keys(COALESCE(projects.legacy_users, '{}'::jsonb)) AS users(key)
               ) ids
              WHERE COALESCE(ids.legacy_account_id, '') <> ''
              ORDER BY ids.legacy_account_id
           ) AS candidate_legacy_account_ids,
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'legacy_account_id', candidate.legacy_account_id,
                 'email_address', candidate_account.email_address,
                 'first_name', candidate_account.first_name,
                 'last_name', candidate_account.last_name,
                 'display_name', candidate_account.display_name,
                 'last_active', candidate_account.last_active,
                 'role',
                   CASE WHEN candidate.is_owner THEN 'owner' ELSE 'collaborator' END,
                 'target_claim_methods',
                   to_jsonb(ARRAY(
                     SELECT DISTINCT COALESCE(target_link.claim_method, '')
                       FROM legacy_migration_account_links target_link
                      WHERE target_link.legacy_account_id=candidate.legacy_account_id
                        AND target_link.account_id=$1
                      ORDER BY COALESCE(target_link.claim_method, '')
                   )),
                 'support_admin_linked_account_ids',
                   to_jsonb(ARRAY(
                     SELECT DISTINCT support_link.account_id::TEXT
                       FROM legacy_migration_account_links support_link
                      WHERE support_link.legacy_account_id=candidate.legacy_account_id
                        AND support_link.claim_method='support-admin'
                        AND support_link.account_id<>$1
                      ORDER BY support_link.account_id::TEXT
                   ))
               )
               ORDER BY CASE WHEN candidate.is_owner THEN 0 ELSE 1 END,
                        lower(COALESCE(candidate_account.email_address, '')),
                        candidate.legacy_account_id
             )
               FROM (
                 SELECT ids.legacy_account_id,
                        BOOL_OR(ids.is_owner) AS is_owner
                   FROM (
                     SELECT projects.owner_legacy_account_id AS legacy_account_id,
                            true AS is_owner
                     UNION ALL
                     SELECT users.key AS legacy_account_id,
                            false AS is_owner
                       FROM jsonb_object_keys(COALESCE(projects.legacy_users, '{}'::jsonb)) AS users(key)
                   ) ids
                  WHERE COALESCE(ids.legacy_account_id, '') <> ''
                  GROUP BY ids.legacy_account_id
               ) candidate
          LEFT JOIN legacy_migration_accounts candidate_account
                 ON candidate_account.legacy_account_id=candidate.legacy_account_id
           ), '[]'::jsonb) AS candidate_legacy_accounts,
           ARRAY(
             SELECT DISTINCT COALESCE(target_link.claim_method, '')
               FROM legacy_migration_account_links target_link
              WHERE target_link.account_id=$1
                AND (
                  target_link.legacy_account_id=projects.owner_legacy_account_id
                  OR COALESCE(projects.legacy_users, '{}'::jsonb) ? target_link.legacy_account_id
                )
              ORDER BY COALESCE(target_link.claim_method, '')
           ) AS target_claim_methods,
           projects.last_edited,
           projects.last_active,
           projects.disk_mb,
           projects.artifact_status,
           projects.artifact_manifest,
           active_import_project.project_id,
           CASE
             WHEN imports.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN imports.owner_account_id
             ELSE NULL
           END AS owner_account_id,
           CASE
             WHEN imports.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN imports.status
             ELSE NULL
           END AS status,
           CASE
             WHEN imports.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN imports.restore_status
             ELSE NULL
           END AS restore_status,
           EXISTS (
             SELECT 1
               FROM legacy_migration_project_import_accounts imported_accounts
              WHERE imported_accounts.legacy_project_id=projects.legacy_project_id
                AND imported_accounts.account_id=$1
                AND imported_accounts.project_id=imports.project_id
                AND active_import_project.project_id IS NOT NULL
           ) AS joined
      FROM matched_projects projects
      LEFT JOIN legacy_migration_accounts owner
        ON owner.legacy_account_id=projects.owner_legacy_account_id
      LEFT JOIN legacy_migration_project_imports imports
        ON imports.legacy_project_id=projects.legacy_project_id
      LEFT JOIN projects active_import_project
        ON active_import_project.project_id=imports.project_id
       AND COALESCE(active_import_project.deleted, false)=false
     ORDER BY projects.last_edited DESC NULLS LAST,
              projects.last_active DESC NULLS LAST,
              projects.legacy_project_id
    `,
    [targetAccountId, search, n],
  );
  return {
    projects: rows.map(adminProjectSummary),
    total_count: rows.length,
  };
}

export async function adminListLegacyAccountLinks({
  target_account_id,
}: LegacyMigrationAdminLinksOptions): Promise<LegacyMigrationAdminLinksResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationAdminLinkSchema();
  const targetAccountId = requireTargetAccountId(target_account_id);
  const { rows } = await getPool().query<
    LegacyMigrationAdminLinkSummary & {
      project_count: number | string | null;
      target_claim_methods: string[] | null;
      support_admin_linked_account_ids: string[] | null;
    }
  >(
    `
    SELECT accounts.legacy_account_id,
           accounts.email_address,
           accounts.first_name,
           accounts.last_name,
           accounts.display_name,
           accounts.last_active,
           linked.claim_method,
           linked.metadata,
           linked.created,
           linked.updated,
           ARRAY[COALESCE(linked.claim_method, '')] AS target_claim_methods,
           ARRAY(
             SELECT DISTINCT support_link.account_id::TEXT
               FROM legacy_migration_account_links support_link
              WHERE support_link.legacy_account_id=linked.legacy_account_id
                AND support_link.claim_method='support-admin'
                AND support_link.account_id<>$1
              ORDER BY support_link.account_id::TEXT
           ) AS support_admin_linked_account_ids,
           NULL::INTEGER AS project_count
      FROM legacy_migration_account_links linked
      LEFT JOIN legacy_migration_accounts accounts
        ON accounts.legacy_account_id=linked.legacy_account_id
     WHERE linked.account_id=$1
     ORDER BY linked.claim_method,
              lower(COALESCE(accounts.email_address, '')),
              linked.legacy_account_id
    `,
    [targetAccountId],
  );
  return { links: rows.map(adminLinkSummary) };
}

export async function adminLinkLegacyAccount({
  account_id,
  target_account_id,
  legacy_account_id,
  reason,
  support_reference,
  evidence,
}: LegacyMigrationAdminLinkLegacyAccountOptions): Promise<LegacyMigrationAdminLinkLegacyAccountResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationAdminLinkSchema();
  const actorAccountId = requireActorAccountId(account_id);
  const targetAccountId = requireTargetAccountId(target_account_id);
  const legacyAccountId = requireLegacyAccountId(legacy_account_id);
  const auditReason = requireAuditReason(reason);
  await verifyTargetAccountExists(targetAccountId);
  await verifyLegacyAccountExists(legacyAccountId);

  const otherSupportLinks = await getPool().query<{ account_id: string }>(
    `
    SELECT account_id::TEXT AS account_id
      FROM legacy_migration_account_links
     WHERE legacy_account_id=$1
       AND claim_method='support-admin'
       AND account_id<>$2
     ORDER BY account_id::TEXT
    `,
    [legacyAccountId, targetAccountId],
  );
  if (otherSupportLinks.rows.length > 0) {
    throw new Error(
      `legacy account is already support-linked to ${otherSupportLinks.rows
        .map((row) => row.account_id)
        .join(", ")}`,
    );
  }

  const metadata = {
    reason: auditReason,
    support_reference: clean(support_reference) ?? null,
    created_by: actorAccountId,
    evidence:
      evidence != null && typeof evidence === "object" ? evidence : undefined,
  };
  const client = await getTransactionClient();
  try {
    await client.query(
      `
      INSERT INTO legacy_migration_account_links
        (legacy_account_id, account_id, claim_method, metadata, created, updated)
      VALUES ($1, $2, 'support-admin', $3::jsonb, NOW(), NOW())
      ON CONFLICT (legacy_account_id, account_id)
      DO UPDATE SET claim_method='support-admin',
                    metadata=legacy_migration_account_links.metadata || EXCLUDED.metadata,
                    updated=NOW()
      `,
      [legacyAccountId, targetAccountId, metadata],
    );
    await client.query(
      `
      INSERT INTO legacy_migration_account_link_events
        (id, legacy_account_id, account_id, actor_account_id, action, reason,
         support_reference, claim_method, metadata, created)
      VALUES ($1, $2, $3, $4, 'link', $5, $6, 'support-admin', $7::jsonb, NOW())
      `,
      [
        randomUUID(),
        legacyAccountId,
        targetAccountId,
        actorAccountId,
        auditReason,
        clean(support_reference) ?? null,
        metadata,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const allOtherLinks = await getPool().query<{ account_id: string }>(
    `
    SELECT DISTINCT account_id::TEXT AS account_id
      FROM legacy_migration_account_links
     WHERE legacy_account_id=$1
       AND account_id<>$2
     ORDER BY account_id::TEXT
    `,
    [legacyAccountId, targetAccountId],
  );
  const warnings =
    allOtherLinks.rows.length > 0
      ? [
          `legacy account also has automatic links to ${allOtherLinks.rows
            .map((row) => row.account_id)
            .join(", ")}`,
        ]
      : [];
  return {
    link: await getLegacyAccountLinkSummary({
      target_account_id: targetAccountId,
      legacy_account_id: legacyAccountId,
    }),
    warnings,
  };
}

export async function adminUnlinkLegacyAccount({
  account_id,
  target_account_id,
  legacy_account_id,
  reason,
  support_reference,
}: LegacyMigrationAdminUnlinkLegacyAccountOptions): Promise<LegacyMigrationAdminUnlinkLegacyAccountResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationAdminLinkSchema();
  const actorAccountId = requireActorAccountId(account_id);
  const targetAccountId = requireTargetAccountId(target_account_id);
  const legacyAccountId = requireLegacyAccountId(legacy_account_id);
  const auditReason = requireAuditReason(reason);
  const client = await getTransactionClient();
  try {
    const existing = await client.query<{
      claim_method: string | null;
      metadata: Record<string, any> | null;
    }>(
      `
      SELECT claim_method, metadata
        FROM legacy_migration_account_links
       WHERE legacy_account_id=$1
         AND account_id=$2
       FOR UPDATE
      `,
      [legacyAccountId, targetAccountId],
    );
    const row = existing.rows[0];
    if (row == null) {
      await client.query("COMMIT");
      return { removed: false };
    }
    if (row.claim_method !== "support-admin") {
      throw new Error(
        `only support-admin links can be unlinked here; found ${row.claim_method}`,
      );
    }
    await client.query(
      `
      INSERT INTO legacy_migration_account_link_events
        (id, legacy_account_id, account_id, actor_account_id, action, reason,
         support_reference, claim_method, metadata, created)
      VALUES ($1, $2, $3, $4, 'unlink', $5, $6, $7, $8::jsonb, NOW())
      `,
      [
        randomUUID(),
        legacyAccountId,
        targetAccountId,
        actorAccountId,
        auditReason,
        clean(support_reference) ?? null,
        row.claim_method,
        {
          previous_metadata: row.metadata ?? {},
        },
      ],
    );
    await client.query(
      `
      DELETE FROM legacy_migration_account_links
       WHERE legacy_account_id=$1
         AND account_id=$2
      `,
      [legacyAccountId, targetAccountId],
    );
    await client.query("COMMIT");
    return { removed: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function adminListLinkedLegacyProjects({
  account_id,
  target_account_id,
  legacy_account_id,
  limit,
}: LegacyMigrationAdminLinkedProjectsOptions): Promise<LegacyMigrationAdminLinkedProjectsResponse> {
  await assertLegacyMigrationEnabled();
  await ensureLegacyMigrationProjectImportSchema();
  await ensureLegacyMigrationAdminLinkSchema();
  const actorAccountId = requireActorAccountId(account_id);
  const targetAccountId = requireTargetAccountId(target_account_id);
  const legacyAccountId = requireLegacyAccountId(legacy_account_id);
  const n = adminLimitValue(limit, 100, 250);
  const { rows } = await getPool().query<
    LegacyMigrationAdminProjectSummary &
      LegacyProjectRow & {
        total_count: number | string | null;
      }
  >(
    `
    WITH active_link AS (
      SELECT *
        FROM legacy_migration_account_links
       WHERE account_id=$1
         AND legacy_account_id=$2
       LIMIT 1
    ),
    matched_projects AS (
      SELECT projects.*
        FROM legacy_migration_projects projects
        JOIN active_link
          ON projects.owner_legacy_account_id=active_link.legacy_account_id
          OR COALESCE(projects.legacy_users, '{}'::jsonb) ? active_link.legacy_account_id
       WHERE COALESCE(projects.hidden, false)=false
    )
    SELECT projects.legacy_project_id,
           projects.name,
           projects.title,
           projects.owner_legacy_account_id,
           owner.email_address AS owner_email_address,
           owner.display_name AS owner_display_name,
           ARRAY(
             SELECT DISTINCT ids.legacy_account_id
               FROM (
                 SELECT projects.owner_legacy_account_id AS legacy_account_id
                 UNION
                 SELECT users.key AS legacy_account_id
                   FROM jsonb_object_keys(COALESCE(projects.legacy_users, '{}'::jsonb)) AS users(key)
               ) ids
              WHERE COALESCE(ids.legacy_account_id, '') <> ''
              ORDER BY ids.legacy_account_id
           ) AS candidate_legacy_account_ids,
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'legacy_account_id', candidate.legacy_account_id,
                 'email_address', candidate_account.email_address,
                 'first_name', candidate_account.first_name,
                 'last_name', candidate_account.last_name,
                 'display_name', candidate_account.display_name,
                 'last_active', candidate_account.last_active,
                 'role',
                   CASE WHEN candidate.is_owner THEN 'owner' ELSE 'collaborator' END,
                 'target_claim_methods',
                   to_jsonb(ARRAY(
                     SELECT DISTINCT COALESCE(target_link.claim_method, '')
                       FROM legacy_migration_account_links target_link
                      WHERE target_link.legacy_account_id=candidate.legacy_account_id
                        AND target_link.account_id=$1
                      ORDER BY COALESCE(target_link.claim_method, '')
                   )),
                 'support_admin_linked_account_ids',
                   to_jsonb(ARRAY(
                     SELECT DISTINCT support_link.account_id::TEXT
                       FROM legacy_migration_account_links support_link
                      WHERE support_link.legacy_account_id=candidate.legacy_account_id
                        AND support_link.claim_method='support-admin'
                        AND support_link.account_id<>$1
                      ORDER BY support_link.account_id::TEXT
                   ))
               )
               ORDER BY CASE WHEN candidate.is_owner THEN 0 ELSE 1 END,
                        lower(COALESCE(candidate_account.email_address, '')),
                        candidate.legacy_account_id
             )
               FROM (
                 SELECT ids.legacy_account_id,
                        BOOL_OR(ids.is_owner) AS is_owner
                   FROM (
                     SELECT projects.owner_legacy_account_id AS legacy_account_id,
                            true AS is_owner
                     UNION ALL
                     SELECT users.key AS legacy_account_id,
                            false AS is_owner
                       FROM jsonb_object_keys(COALESCE(projects.legacy_users, '{}'::jsonb)) AS users(key)
                   ) ids
                  WHERE COALESCE(ids.legacy_account_id, '') <> ''
                  GROUP BY ids.legacy_account_id
               ) candidate
          LEFT JOIN legacy_migration_accounts candidate_account
                 ON candidate_account.legacy_account_id=candidate.legacy_account_id
           ), '[]'::jsonb) AS candidate_legacy_accounts,
           ARRAY(
             SELECT DISTINCT COALESCE(target_link.claim_method, '')
               FROM legacy_migration_account_links target_link
              WHERE target_link.account_id=$1
                AND (
                  target_link.legacy_account_id=projects.owner_legacy_account_id
                  OR COALESCE(projects.legacy_users, '{}'::jsonb) ? target_link.legacy_account_id
                )
              ORDER BY COALESCE(target_link.claim_method, '')
           ) AS target_claim_methods,
           projects.last_edited,
           projects.last_active,
           projects.disk_mb,
           projects.artifact_status,
           projects.artifact_manifest,
           active_import_project.project_id,
           CASE
             WHEN imports.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN imports.owner_account_id
             ELSE NULL
           END AS owner_account_id,
           CASE
             WHEN imports.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN imports.status
             ELSE NULL
           END AS status,
           CASE
             WHEN imports.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN imports.restore_status
             ELSE NULL
           END AS restore_status,
           EXISTS (
             SELECT 1
               FROM legacy_migration_project_import_accounts imported_accounts
              WHERE imported_accounts.legacy_project_id=projects.legacy_project_id
                AND imported_accounts.account_id=$1
                AND imported_accounts.project_id=imports.project_id
                AND active_import_project.project_id IS NOT NULL
           ) AS joined,
           COUNT(*) OVER()::INTEGER AS total_count
      FROM matched_projects projects
      LEFT JOIN legacy_migration_accounts owner
        ON owner.legacy_account_id=projects.owner_legacy_account_id
      LEFT JOIN legacy_migration_project_imports imports
        ON imports.legacy_project_id=projects.legacy_project_id
      LEFT JOIN projects active_import_project
        ON active_import_project.project_id=imports.project_id
       AND COALESCE(active_import_project.deleted, false)=false
     ORDER BY projects.last_edited DESC NULLS LAST,
              projects.last_active DESC NULLS LAST,
              projects.legacy_project_id
     LIMIT $3
    `,
    [targetAccountId, legacyAccountId, n],
  );
  if (
    rows.length > 0 ||
    (await getLegacyAccountLinkExists(targetAccountId, legacyAccountId))
  ) {
    await getPool().query(
      `
      INSERT INTO legacy_migration_account_link_events
        (id, legacy_account_id, account_id, actor_account_id, action, reason,
         claim_method, metadata, created)
      VALUES ($1, $2, $3, $4, 'search-projects',
              'Admin loaded linked legacy projects', NULL, $5::jsonb, NOW())
      `,
      [
        randomUUID(),
        legacyAccountId,
        targetAccountId,
        actorAccountId,
        { limit: n, returned: rows.length },
      ],
    );
  }
  return {
    projects: rows.map(adminProjectSummary),
    total_count: Number(rows[0]?.total_count ?? rows.length) || 0,
    limit: n,
  };
}

async function getLegacyAccountLinkExists(
  target_account_id: string,
  legacy_account_id: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `
    SELECT 1
      FROM legacy_migration_account_links
     WHERE account_id=$1
       AND legacy_account_id=$2
     LIMIT 1
    `,
    [target_account_id, legacy_account_id],
  );
  return rows.length > 0;
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
  return ["basic", "member", "pro"]
    .map((id) => {
      const tier = tiers[id];
      if (tier != null) return tier;
      if (id === "pro") {
        return {
          id: "pro",
          label: "Pro",
          price_monthly: 200,
          price_yearly: 1800,
        } as MembershipTierRecord;
      }
      return undefined;
    })
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
         AND ${ACCOUNT_VERIFIED_EMAILS_JSON} ? lower(email_address)
      UNION
      SELECT account_id, lower(verified.email) AS email
        FROM accounts
        CROSS JOIN LATERAL jsonb_each(${ACCOUNT_VERIFIED_EMAILS_JSON})
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
       WHERE COALESCE(email_address, '') <> ''
      UNION
      SELECT legacy_account_id,
             ${legacyCanonical} AS email_key,
             lower(email_address) AS email_address,
             ${legacyCanonical} AS gmail_canonical_email
        FROM legacy_migration_accounts legacy
       WHERE COALESCE(email_address, '') <> ''
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

async function currentMembershipExists(
  account_id: string,
  client?: PoolClient,
): Promise<boolean> {
  const { rows } = await (client ?? getPool()).query(
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

async function currentLegacyMigrationMembershipSubscription(
  account_id: string,
  client?: PoolClient,
  { includeExpired = false }: { includeExpired?: boolean } = {},
): Promise<LegacyMigrationMembershipSubscription | null> {
  const { rows } = await (
    client ?? getPool()
  ).query<LegacyMigrationMembershipSubscription>(
    `
    SELECT id, status, interval, current_period_end, metadata
      FROM subscriptions
     WHERE account_id=$1
       AND metadata->>'type'='membership'
       AND metadata->>'source_id'='legacy-migration'
       AND ($2::BOOLEAN OR current_period_end >= NOW())
     ORDER BY current_period_end DESC
     LIMIT 1
    `,
    [account_id, includeExpired],
  );
  return rows[0] ?? null;
}

function legacyMigrationMembershipGrantResponse(
  subscription: LegacyMigrationMembershipSubscription | null,
): LegacyMigrationFinancialMembershipGrantHomeBayResponse {
  const metadata = subscription?.metadata ?? {};
  const membership_class =
    metadata.renewal_configured === true
      ? (clean(metadata.renewal_class) ?? clean(metadata.class) ?? null)
      : null;
  const membership_interval =
    metadata.renewal_configured === true &&
    metadata.renewal_interval === "month"
      ? "month"
      : metadata.renewal_configured === true &&
          metadata.renewal_interval === "year"
        ? "year"
        : null;
  return {
    subscription_id: subscription?.id ?? null,
    membership_class,
    membership_interval,
    membership_grant_ends_at:
      subscription?.current_period_end != null
        ? new Date(subscription.current_period_end).toISOString()
        : null,
    membership_renewal_configured: metadata.renewal_configured === true,
  };
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
      claimed_credit_amount: string | number | null;
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
         AND (
           (
             COALESCE(accounts.stripe_customer_id, '') <> ''
             AND raw.payload->>'stripe_customer_id'=accounts.stripe_customer_id
           )
           OR lower(raw.payload->>'customer_email')=lower(accounts.email_address)
           OR (
             split_part(lower(accounts.email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
             AND split_part(lower(raw.payload->>'customer_email'), '@', 2) IN ('gmail.com', 'googlemail.com')
             AND replace(split_part(split_part(lower(raw.payload->>'customer_email'), '@', 1), '+', 1), '.', '')
                 = replace(split_part(split_part(lower(accounts.email_address), '@', 1), '+', 1), '.', '')
           )
         )
       WHERE raw.payload->>'status' IN ('active', 'trialing', 'canceled')
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
           claims.credit_amount AS claimed_credit_amount,
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
    const stripeSubscriptionPayloads = asArray(
      row.stripe_subscription_payloads,
    ).map((payload) => asRecord(payload));
    const stripeInfo = legacyStripeSubscriptionRecordInfo(
      stripeSubscriptionPayloads,
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
    const credit_amount = row.claimed_by_account_id
      ? toMoneyNumber(row.claimed_credit_amount)
      : toMoneyNumber(balance_credit_amount + entitlement_credit_amount);
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
      stripe_customer_id:
        clean(row.stripe_customer_id) ??
        stripeSubscriptionPayloads
          .map((payload) => clean(payload.stripe_customer_id))
          .find((value): value is string => !!value) ??
        null,
      balance: toMoneyNumber(row.balance),
      balance_credit_amount,
      entitlement_credit_amount,
      entitlement_credits,
      unvalued_active_site_license_count: unvaluedActiveSiteLicenseCount,
      credit_amount,
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
  pending_credit_amount,
  membership_already_applied,
}: {
  active_subscription_count: number;
  pending_credit_amount: number;
  membership_already_applied: boolean;
}): string | null {
  if (
    membership_already_applied ||
    (active_subscription_count <= 0 && pending_credit_amount <= 5)
  ) {
    return null;
  }
  return "member";
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
  const [legacy_accounts, plans, hasActiveMembership, membershipGrant] =
    await Promise.all([
      financialRowsForAccount(account_id),
      membershipPlans(),
      currentMembershipExists(account_id),
      financialMembershipGrantForAccount({ account_id }),
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
    legacy_accounts
      .map((account) => account.stripe_customer_id)
      .find(Boolean) ??
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
      active_subscription_count,
      pending_credit_amount,
      membership_already_applied,
    }),
    suggested_membership_interval:
      suggestedFinancialMembershipInterval(pending),
    suggested_membership_grant_days: LEGACY_MIGRATION_MEMBERSHIP_GRANT_DAYS,
    applied_membership_class:
      appliedMembership?.selected_membership_class ?? null,
    applied_membership_interval:
      appliedMembership?.selected_membership_interval ?? null,
    membership_grant_ends_at: membershipGrant.membership_grant_ends_at,
    membership_renewal_class: membershipGrant.membership_class ?? null,
    membership_renewal_interval: membershipGrant.membership_interval ?? null,
    membership_already_applied,
    membership_renewal_configured:
      membershipGrant.membership_renewal_configured,
    stripe_customer_id,
    plans,
    can_apply:
      pending.length > 0 &&
      (pending_credit_amount > 0 ||
        active_subscription_count > 0 ||
        pending.some((account) => account.stripe_customer_id)),
  };
}

export async function getFinancialMembershipGrantHomeBay({
  account_id,
}: LegacyMigrationFinancialMembershipGrantHomeBayOptions): Promise<LegacyMigrationFinancialMembershipGrantHomeBayResponse> {
  if (!account_id) {
    throw Error("account_id is required");
  }
  const accountCheck = await getPool().query(
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
  return legacyMigrationMembershipGrantResponse(
    await currentLegacyMigrationMembershipSubscription(account_id),
  );
}

async function financialMembershipGrantForAccount({
  account_id,
}: LegacyMigrationFinancialMembershipGrantHomeBayOptions): Promise<LegacyMigrationFinancialMembershipGrantHomeBayResponse> {
  const account = await getClusterAccountById(account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  if (homeBayId && homeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: homeBayId,
      timeout: LEGACY_FINANCIAL_HOME_BAY_TIMEOUT_MS,
    }).legacyMigrationGetFinancialMembershipGrantHomeBay({ account_id });
  }
  return await getFinancialMembershipGrantHomeBay({ account_id });
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

async function lockLegacyMigrationMembershipGrant({
  account_id,
  client,
}: {
  account_id: string;
  client: PoolClient;
}): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `legacy-migration-membership-grant:${account_id}`,
  ]);
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
    await lockLegacyMigrationMembershipGrant({ account_id, client });
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
      { includeExpired: true },
    );
    if (
      selectedClass != null &&
      selectedCost != null &&
      existingGrant == null &&
      (await currentMembershipExists(account_id, client))
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
      timeout: LEGACY_FINANCIAL_HOME_BAY_TIMEOUT_MS,
    }).legacyMigrationApplyFinancialHomeBay(opts);
  }
  return await applyFinancialMigrationHomeBay(opts);
}

function validateLegacyRenewalMembershipClass(
  membership_class?: string | null,
): "basic" | "member" | "pro" | null {
  const value = clean(membership_class);
  if (value == null || value === "none") return null;
  if (value === "basic" || value === "member" || value === "pro") {
    return value;
  }
  throw new Error(
    "legacy migration renewal can only be basic, standard, or pro",
  );
}

export async function configureFinancialMembershipRenewalHomeBay({
  account_id,
  membership_class,
  membership_interval,
}: LegacyMigrationConfigureFinancialRenewalHomeBayOptions): Promise<LegacyMigrationConfigureFinancialRenewalResponse> {
  if (!account_id) {
    throw Error("account_id is required");
  }
  const selectedClass = validateLegacyRenewalMembershipClass(membership_class);
  const selectedInterval =
    membership_interval === "month"
      ? "month"
      : membership_interval === "year"
        ? "year"
        : selectedClass == null
          ? null
          : undefined;
  if (selectedClass != null && selectedInterval == null) {
    throw new Error("membership_interval must be month or year");
  }
  const selectedCost =
    selectedClass != null && selectedInterval != null
      ? await membershipCost({
          membership_class: selectedClass,
          interval: selectedInterval,
        })
      : null;

  const client = await getTransactionClient();
  try {
    await lockMembershipSubscriptionAccount({ account_id, client });
    await assertNoDueMembershipRenewal({ account_id, client });
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

    const grant = await currentLegacyMigrationMembershipSubscription(
      account_id,
      client,
    );
    if (grant == null) {
      throw new Error("no legacy migration membership grant was found");
    }

    const metadata = {
      ...(grant.metadata ?? {}),
      renewal_class: selectedClass,
      renewal_interval: selectedInterval,
      renewal_configured: selectedClass != null,
      renewal_configured_at: new Date().toISOString(),
    };
    await client.query(
      `
      UPDATE subscriptions
         SET status=$2,
             cost=COALESCE($3::numeric, cost),
             interval=COALESCE($4, interval),
             metadata=$5
       WHERE id=$1
      `,
      [
        grant.id,
        selectedClass == null ? "canceled" : "active",
        selectedCost == null ? null : moneyToDbString(selectedCost),
        selectedInterval,
        metadata,
      ],
    );
    await cancelOpenSubscriptionRenewalAttempts({
      account_id,
      subscription_id: grant.id,
      reason: "Legacy migration membership renewal was reconfigured",
      client,
    });
    if (selectedClass != null) {
      const attemptId = await scheduleSubscriptionRenewalAttempt({
        account_id,
        subscription_id: grant.id,
        client,
      });
      if (!attemptId) {
        throw new Error(
          "failed to schedule the legacy migration membership renewal",
        );
      }
    }
    await client.query("COMMIT");
    return {
      subscription_id: grant.id,
      membership_class: selectedClass,
      membership_interval: selectedInterval,
      membership_grant_ends_at:
        grant.current_period_end != null
          ? new Date(grant.current_period_end).toISOString()
          : null,
      membership_renewal_configured: selectedClass != null,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function configureFinancialMembershipRenewal({
  account_id,
  membership_class,
  membership_interval,
}: LegacyMigrationConfigureFinancialRenewalOptions = {}): Promise<LegacyMigrationConfigureFinancialRenewalResponse> {
  if (!account_id) {
    throw Error("account_id is required");
  }
  const account = await getClusterAccountById(account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  if (homeBayId && homeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: homeBayId,
      timeout: LEGACY_FINANCIAL_HOME_BAY_TIMEOUT_MS,
    }).legacyMigrationConfigureFinancialRenewalHomeBay({
      account_id,
      membership_class,
      membership_interval,
    });
  }
  return await configureFinancialMembershipRenewalHomeBay({
    account_id,
    membership_class,
    membership_interval,
  });
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
                    AND (
                      (
                        COALESCE(legacy.stripe_customer_id, '') <> ''
                        AND raw.payload->>'stripe_customer_id'=legacy.stripe_customer_id
                      )
                      OR lower(raw.payload->>'customer_email')=lower(legacy.email_address)
                      OR (
                        split_part(lower(legacy.email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
                        AND split_part(lower(raw.payload->>'customer_email'), '@', 2) IN ('gmail.com', 'googlemail.com')
                        AND replace(split_part(split_part(lower(raw.payload->>'customer_email'), '@', 1), '+', 1), '.', '')
                            = replace(split_part(split_part(lower(legacy.email_address), '@', 1), '+', 1), '.', '')
                      )
                    )
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
  include_not_available,
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
    WITH linked AS (
      SELECT unnest($1::TEXT[]) AS legacy_account_id
    ),
    matched_rows AS (
      SELECT p.legacy_project_id,
             linked.legacy_account_id
        FROM linked
        JOIN legacy_migration_projects p
          ON p.owner_legacy_account_id=linked.legacy_account_id
      UNION ALL
      SELECT p.legacy_project_id,
             linked.legacy_account_id
        FROM linked
        JOIN legacy_migration_projects p
          ON p.legacy_users ? linked.legacy_account_id
       WHERE p.legacy_users ?| $1::TEXT[]
    ),
    matched AS (
      SELECT matched_rows.legacy_project_id,
             ARRAY_AGG(DISTINCT matched_rows.legacy_account_id ORDER BY matched_rows.legacy_account_id)
               AS matched_legacy_account_ids
        FROM matched_rows
        JOIN legacy_migration_projects p
          ON p.legacy_project_id=matched_rows.legacy_project_id
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
       GROUP BY matched_rows.legacy_project_id
      HAVING (
        $2::BOOLEAN
        OR NOT BOOL_OR(COALESCE(p.legacy_users->matched_rows.legacy_account_id->>'hide', '')='true')
      )
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
           active_import_project.project_id,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.owner_account_id
             ELSE NULL
           END AS owner_account_id,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.status
             ELSE NULL
           END AS status,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.restore_mode
             ELSE NULL
           END AS restore_mode,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.restore_status
             ELSE NULL
           END AS restore_status,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.restore_error
             ELSE NULL
           END AS restore_error,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.restore_lro_op_id
             ELSE NULL
           END AS restore_lro_op_id,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.restore_progress
             ELSE NULL
           END AS restore_progress,
           CASE
             WHEN i.project_id IS NULL OR active_import_project.project_id IS NOT NULL
             THEN i.restore_result
             ELSE NULL
           END AS restore_result,
           COUNT(*) OVER()::INTEGER AS total_count,
           EXISTS (
             SELECT 1
               FROM legacy_migration_project_import_accounts a
              WHERE a.legacy_project_id=p.legacy_project_id
                AND a.account_id=$8
                AND a.project_id=i.project_id
                AND active_import_project.project_id IS NOT NULL
           ) AS joined
      FROM legacy_migration_projects p
      JOIN matched
        ON matched.legacy_project_id=p.legacy_project_id
      LEFT JOIN legacy_migration_project_imports i
        ON i.legacy_project_id=p.legacy_project_id
      LEFT JOIN projects active_import_project
        ON active_import_project.project_id=i.project_id
       AND COALESCE(active_import_project.deleted, false)=false
     WHERE (
       $6::BOOLEAN
       OR active_import_project.project_id IS NOT NULL
       OR (
         p.artifact_status='available'
         AND COALESCE(p.artifact_key, '') <> ''
         AND COALESCE(p.artifact_manifest->>'r2_key', '')=p.artifact_key
         AND p.artifact_manifest IS NOT NULL
         AND (
           p.artifact_manifest ?| ARRAY[
             'compressed_bytes',
             'compressed_size_bytes',
             'artifact_bytes',
             'object_bytes',
             'r2_bytes'
           ]
           OR COALESCE((p.artifact_manifest->'archive') ?| ARRAY[
             'compressed_bytes',
             'object_bytes'
           ], false)
           OR COALESCE((p.artifact_manifest->'artifact') ? 'bytes', false)
         )
       )
     )
     ORDER BY p.last_edited DESC NULLS LAST, p.legacy_project_id
     LIMIT $7
    `,
    [
      legacy_account_ids,
      !!include_hidden,
      useSearch,
      search,
      maxDiskMb,
      !!include_not_available,
      limitValue(limit),
      account_id,
    ],
  );
  return {
    legacy_account_ids,
    legacy_accounts,
    projects: rows.map(importStatus),
    total_count: rows[0]?.total_count ?? 0,
  };
}

function legacyPublicShareListLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_PUBLIC_SHARE_LIST_LIMIT, Math.floor(limit!)));
}

function legacyPublicShareListOffset(offset?: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset!));
}

function legacyPublicSharePathType(
  payload: Record<string, any>,
): LegacyMigrationPublicSharePathType {
  const explicit = clean(payload.original_path_type);
  if (explicit === "file" || explicit === "directory") return explicit;
  const path = clean(payload.original_path) ?? clean(payload.path) ?? ".";
  return looksLikeLegacyFilePath(path) ? "file" : "unknown";
}

function legacyPublicSharePath(payload: Record<string, any>): string {
  const pathType = legacyPublicSharePathType(payload);
  return (
    (pathType === "file" ? clean(payload.original_path) : undefined) ??
    clean(payload.path) ??
    clean(payload.original_path) ??
    "."
  );
}

function legacyPublicShareImportStatus({
  project_id,
  import_status,
}: {
  project_id?: string | null;
  import_status?: string | null;
}): LegacyMigrationProjectImportStatus {
  return import_status === "creating" || import_status === "failed"
    ? import_status
    : project_id
      ? "imported"
      : "not-imported";
}

export function legacyPublicShareUrl({
  legacy_public_path_id,
  payload,
}: {
  legacy_public_path_id: string;
  payload: Record<string, any>;
}): string | null {
  if (isUnsupportedLegacyProxyPublicPath(payload)) return null;
  const retainedUrl = clean(payload.url);
  if (/^https?:\/\//i.test(retainedUrl ?? "")) return retainedUrl ?? null;
  const base = `https://cocalc.com/share/public_paths/${encodeURIComponent(
    legacy_public_path_id,
  )}`;
  if (legacyPublicSharePathType(payload) !== "file") return base;
  const path = legacyPublicSharePath(payload)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return path ? `${base}/files/${path}` : base;
}

export async function listPublicShares({
  account_id,
  include_disabled,
  limit,
  offset,
  query,
}: LegacyMigrationListPublicSharesOptions = {}): Promise<LegacyMigrationListPublicSharesResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationProjectImportSchema();
  await ensureLegacyMigrationRawRecordsSchema();
  const legacy_accounts = await legacyAccounts(account_id);
  const legacy_account_ids = legacy_accounts.map(
    (account) => account.legacy_account_id,
  );
  if (legacy_account_ids.length === 0) {
    return { legacy_account_ids, shares: [], total_count: 0 };
  }
  const { rows } = await getPool().query<{
    legacy_id: string;
    payload: Record<string, any>;
    legacy_project_id: string;
    project_title: string | null;
    matched_legacy_account_ids: string[] | null;
    project_id: string | null;
    import_status: string | null;
    restore_status: LegacyMigrationProjectRestoreStatus | null;
    total_count: number | string;
  }>(
    `
    WITH matched_projects AS (
      SELECT projects.legacy_project_id,
             ARRAY(
               SELECT linked_id
                 FROM unnest($1::TEXT[]) AS linked(linked_id)
                WHERE projects.owner_legacy_account_id=linked_id
                   OR COALESCE(projects.legacy_users, '{}'::jsonb) ? linked_id
                ORDER BY linked_id
             ) AS matched_legacy_account_ids
        FROM legacy_migration_projects projects
       WHERE projects.owner_legacy_account_id=ANY($1::TEXT[])
          OR COALESCE(projects.legacy_users, '{}'::jsonb) ?| $1::TEXT[]
    )
    SELECT raw.legacy_id,
           raw.payload,
           projects.legacy_project_id,
           projects.title AS project_title,
           matched_projects.matched_legacy_account_ids,
           active_project.project_id,
           CASE WHEN active_project.project_id IS NULL THEN NULL ELSE imports.status END
             AS import_status,
           CASE WHEN active_project.project_id IS NULL THEN NULL ELSE imports.restore_status END
             AS restore_status,
           COUNT(*) OVER()::INTEGER AS total_count
      FROM matched_projects
      JOIN legacy_migration_projects projects
        ON projects.legacy_project_id=matched_projects.legacy_project_id
      JOIN legacy_migration_raw_records raw
        ON raw.source='public_paths'
       AND raw.payload->>'project_id'=projects.legacy_project_id
      LEFT JOIN legacy_migration_project_imports imports
        ON imports.legacy_project_id=projects.legacy_project_id
      LEFT JOIN projects active_project
        ON active_project.project_id=imports.project_id
       AND COALESCE(active_project.deleted, false)=false
     WHERE (
       $2::BOOLEAN
       OR lower(COALESCE(raw.payload->>'disabled', 'false')) NOT IN ('true', 't', '1')
     )
       AND lower(COALESCE(projects.title, '')) NOT LIKE 'github-proxy%'
       AND lower(trim(both '/' from COALESCE(raw.payload->>'url', '')))
             !~ '^(github|gist)(/|$)'
       AND (
         $5::TEXT=''
         OR raw.legacy_id ILIKE '%' || $5::TEXT || '%'
         OR COALESCE(raw.payload->>'path', '') ILIKE '%' || $5::TEXT || '%'
         OR COALESCE(raw.payload->>'original_path', '') ILIKE '%' || $5::TEXT || '%'
         OR COALESCE(raw.payload->>'name', '') ILIKE '%' || $5::TEXT || '%'
         OR COALESCE(raw.payload->>'title', '') ILIKE '%' || $5::TEXT || '%'
         OR COALESCE(projects.title, '') ILIKE '%' || $5::TEXT || '%'
         OR projects.legacy_project_id ILIKE '%' || $5::TEXT || '%'
       )
     ORDER BY NULLIF(
                COALESCE(
                  raw.payload->>'last_edited',
                  raw.payload->>'last_saved',
                  raw.payload->>'created'
                ),
                ''
              ) DESC NULLS LAST,
              lower(COALESCE(projects.title, '')),
              lower(COALESCE(raw.payload->>'path', raw.payload->>'original_path', '')),
              raw.legacy_id
     LIMIT $3
     OFFSET $4
    `,
    [
      legacy_account_ids,
      include_disabled === true,
      legacyPublicShareListLimit(limit),
      legacyPublicShareListOffset(offset),
      `${query ?? ""}`.trim().slice(0, 200),
    ],
  );
  const shares: LegacyMigrationPublicShareSummary[] = rows.map((row) => {
    const payload = row.payload ?? {};
    const legacy_public_path_id = clean(payload.id) ?? row.legacy_id;
    return {
      legacy_public_path_id,
      legacy_project_id: row.legacy_project_id,
      legacy_account_ids: row.matched_legacy_account_ids ?? [],
      project_title: row.project_title,
      path: legacyPublicSharePath(payload),
      path_type: legacyPublicSharePathType(payload),
      title: clean(payload.title) ?? clean(payload.name) ?? null,
      description:
        normalizeLegacyPublicPathDescription(payload.description) ?? null,
      legacy_url: legacyPublicShareUrl({
        legacy_public_path_id,
        payload,
      }),
      disabled: legacyBoolean(payload.disabled),
      created: payload.created ?? null,
      last_edited: payload.last_edited ?? payload.last_saved ?? null,
      project_id: row.project_id,
      import_status: legacyPublicShareImportStatus(row),
      restore_status: row.restore_status,
    };
  });
  return {
    legacy_account_ids,
    shares,
    total_count: Number(rows[0]?.total_count ?? 0),
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
  if (restoreStatusForProject(legacy) === "skipped") {
    const { rows } = await pool.query<{
      project_id: string | null;
      restore_status: LegacyMigrationProjectRestoreStatus | null;
      restore_lro_op_id: string | null;
    }>(
      `SELECT active_import_project.project_id,
              imports.restore_status,
              imports.restore_lro_op_id
         FROM legacy_migration_project_imports imports
         JOIN projects active_import_project
           ON active_import_project.project_id=imports.project_id
          AND COALESCE(active_import_project.deleted, false)=false
        WHERE imports.legacy_project_id=$1`,
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
      await replayLegacyPublicPathsForProjectBestEffort({
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
      error: "No recoverable archive is available for this legacy project.",
    };
  }
  const created = await pool.query<{ legacy_project_id: string }>(
    `
    INSERT INTO legacy_migration_project_imports
      (legacy_project_id, owner_account_id, status, restore_mode, restore_status,
       rootfs_image, rootfs_image_id, created, updated)
    VALUES ($1, $2, 'creating', $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (legacy_project_id) DO UPDATE
      SET owner_account_id=EXCLUDED.owner_account_id,
          project_id=NULL,
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
    WHERE (
      legacy_migration_project_imports.project_id IS NULL
      AND legacy_migration_project_imports.status = 'failed'
    ) OR (
      legacy_migration_project_imports.project_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM projects active_import_project
         WHERE active_import_project.project_id=legacy_migration_project_imports.project_id
           AND COALESCE(active_import_project.deleted, false)=false
      )
    )
    RETURNING legacy_project_id
    `,
    [
      legacy_project_id,
      account_id,
      restore_mode,
      restoreStatusForProject(legacy),
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
      `SELECT active_import_project.project_id,
              imports.restore_mode,
              imports.restore_status,
              imports.restore_lro_op_id,
              imports.status
         FROM legacy_migration_project_imports imports
         LEFT JOIN projects active_import_project
           ON active_import_project.project_id=imports.project_id
          AND COALESCE(active_import_project.deleted, false)=false
        WHERE imports.legacy_project_id=$1`,
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
    await replayLegacyPublicPathsForProjectBestEffort({
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
    const restore_status = restoreStatusForProject(legacy);
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
    await replayLegacyPublicPathsForProjectBestEffort({
      account_id,
      legacy_project_id,
      project_id,
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
  const ids = normalizeLegacyProjectImportIds(legacy_project_ids);
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

export function normalizeLegacyProjectImportIds(
  legacy_project_ids?: string[],
): string[] {
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
  if (ids.length > MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST) {
    throw Error(
      `import at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} legacy projects at a time`,
    );
  }
  return ids;
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
           active_import_project.project_id,
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
      JOIN projects active_import_project
        ON active_import_project.project_id=i.project_id
       AND COALESCE(active_import_project.deleted, false)=false
     WHERE i.legacy_project_id=$1
       AND (
         i.owner_account_id=$2
         OR EXISTS (
           SELECT 1
             FROM legacy_migration_project_import_accounts a
            WHERE a.legacy_project_id=i.legacy_project_id
              AND a.account_id=$2
              AND a.project_id=i.project_id
         )
       )
     LIMIT 1
    `,
    [legacy_project_id, account_id],
  );
  return rows[0] ?? null;
}

type ProjectRemediationMetadata = {
  prepared_at?: string | null;
  applied_at?: string | null;
  dismissed_at?: string | null;
  dismissed_forever?: boolean;
  snapshot_name?: string | null;
  snapshot_path?: string | null;
  safety_snapshot_name?: string | null;
  diff_counts?: Record<string, number>;
  diff_files?: LegacyMigrationProjectRemediationDiffEntry[];
  diff_file_count?: number;
  truncated?: boolean;
  file_count?: number;
  uncompressed_bytes?: number;
  skipped_file_count?: number;
  missing_archive_file_count?: number;
  duration_ms?: number;
  applied_by_account_id?: string | null;
  apply_reason?: string | null;
  apply_support_reference?: string | null;
};

type ProjectRemediationRow = LegacyProjectRow & {
  project_id: string;
  owner_account_id: string;
};

function isoTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function manifestArchiveRefreshedAt(
  manifest: Record<string, any> | null | undefined,
): string | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const paths = [
    ["r2_refreshed_at"],
    ["r2_uploaded_at"],
    ["r2_last_modified"],
    ["r2_last_modified_at"],
    ["artifact_refreshed_at"],
    ["artifact_uploaded_at"],
    ["uploaded_at"],
    ["last_modified"],
    ["last_modified_at"],
    ["updated_at"],
    ["created_at"],
    ["generated_at"],
    ["archive", "r2_refreshed_at"],
    ["archive", "uploaded_at"],
    ["archive", "updated_at"],
    ["archive", "created_at"],
    ["archive", "generated_at"],
    ["artifact", "uploaded_at"],
    ["artifact", "updated_at"],
    ["artifact", "created_at"],
    ["artifact", "generated_at"],
  ];
  for (const path of paths) {
    const ts = isoTimestamp(nestedValue(manifest, path));
    if (ts) return ts;
  }
  return undefined;
}

function remediationMetadata(
  row: Pick<LegacyProjectRow, "restore_result">,
): ProjectRemediationMetadata {
  const value = row.restore_result?.final_archive_remediation;
  return value && typeof value === "object"
    ? (value as ProjectRemediationMetadata)
    : {};
}

function emptyRemediationCounts(): Record<
  LegacyMigrationProjectRemediationDiffKind,
  number
> {
  return { add: 0, update: 0, delete: 0, other: 0 };
}

function normalizeRemediationCounts(
  counts: unknown,
): Record<LegacyMigrationProjectRemediationDiffKind, number> | undefined {
  if (!counts || typeof counts !== "object") return undefined;
  const normalized = emptyRemediationCounts();
  for (const kind of Object.keys(
    normalized,
  ) as LegacyMigrationProjectRemediationDiffKind[]) {
    const value = Number((counts as Record<string, unknown>)[kind]);
    normalized[kind] =
      Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return normalized;
}

function remediationNeed(row: ProjectRemediationRow): {
  needs_remediation: boolean;
  reason?: string;
  restored_at?: string;
  r2_refreshed_at?: string;
} {
  const restoredAt = isoTimestamp(row.restore_result?.restored_at);
  const r2RefreshedAt = manifestArchiveRefreshedAt(row.artifact_manifest);
  if (row.restore_status !== "restored") {
    return {
      needs_remediation: false,
      reason: "legacy project restore has not completed",
      restored_at: restoredAt,
      r2_refreshed_at: r2RefreshedAt,
    };
  }
  if (!legacyArchiveAvailable(row)) {
    return {
      needs_remediation: false,
      reason: "final legacy archive is not available",
      restored_at: restoredAt,
      r2_refreshed_at: r2RefreshedAt,
    };
  }
  if (!restoredAt) {
    return {
      needs_remediation: false,
      reason: "original restore timestamp is missing",
      r2_refreshed_at: r2RefreshedAt,
    };
  }
  if (!r2RefreshedAt) {
    return {
      needs_remediation: false,
      reason: "final archive timestamp is missing",
      restored_at: restoredAt,
    };
  }
  const restoredMs = Date.parse(restoredAt);
  const refreshedMs = Date.parse(r2RefreshedAt);
  const needs =
    Number.isFinite(restoredMs) &&
    Number.isFinite(refreshedMs) &&
    restoredMs < refreshedMs;
  return {
    needs_remediation: needs,
    reason: needs
      ? "project was restored before its final cocalc.com archive was refreshed"
      : "project restore is not older than the final archive",
    restored_at: restoredAt,
    r2_refreshed_at: r2RefreshedAt,
  };
}

function remediationResponse(
  row: ProjectRemediationRow,
): LegacyMigrationProjectRemediationStatusResponse {
  const meta = remediationMetadata(row);
  const need = remediationNeed(row);
  return {
    project_id: row.project_id,
    legacy_project_id: row.legacy_project_id,
    needs_remediation: need.needs_remediation,
    reason: need.reason ?? null,
    restored_at: need.restored_at ?? null,
    r2_refreshed_at: need.r2_refreshed_at ?? null,
    snapshot_name: meta.snapshot_name ?? null,
    snapshot_path: meta.snapshot_path ?? null,
    diff_counts: normalizeRemediationCounts(meta.diff_counts),
    diff_files: Array.isArray(meta.diff_files) ? meta.diff_files : undefined,
    diff_file_count:
      typeof meta.diff_file_count === "number"
        ? meta.diff_file_count
        : undefined,
    truncated: !!meta.truncated,
    prepared_at: meta.prepared_at ?? null,
    applied_at: meta.applied_at ?? null,
    dismissed_forever: !!meta.dismissed_forever,
    safety_snapshot_name: meta.safety_snapshot_name ?? null,
  };
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
    throw new Error("missing R2 credentials for legacy project remediation");
  }
  return { endpoint, accessKey, secretKey };
}

async function remediationProjectForAccount({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectRemediationRow | null> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const { rows } = await getPool().query<ProjectRemediationRow>(
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
      JOIN projects active_import_project
        ON active_import_project.project_id=i.project_id
       AND COALESCE(active_import_project.deleted, false)=false
     WHERE i.project_id=$1
       AND (
         i.owner_account_id=$2::uuid
         OR COALESCE(active_import_project.users, '{}'::jsonb) ? $2::text
       )
     LIMIT 1
    `,
    [project_id, account_id],
  );
  return rows[0] ?? null;
}

async function remediationProjectByProjectId({
  project_id,
}: {
  project_id: string;
}): Promise<ProjectRemediationRow | null> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const { rows } = await getPool().query<ProjectRemediationRow>(
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
      JOIN projects active_import_project
        ON active_import_project.project_id=i.project_id
       AND COALESCE(active_import_project.deleted, false)=false
     WHERE i.project_id=$1
     LIMIT 1
    `,
    [project_id],
  );
  return rows[0] ?? null;
}

async function updateProjectRemediationMetadata({
  project_id,
  metadata,
}: {
  project_id: string;
  metadata: ProjectRemediationMetadata;
}): Promise<void> {
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_result=jsonb_set(
             COALESCE(restore_result, '{}'::jsonb),
             '{final_archive_remediation}',
             $2::jsonb,
             true
           ),
           updated=NOW()
     WHERE project_id=$1
    `,
    [project_id, JSON.stringify(metadata)],
  );
}

async function connectProjectFileServerForRemediation({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}) {
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    timeout: PROJECT_ARCHIVE_TIMEOUT_MS,
  });
  await ensureProjectFileServerClientReady({
    project_id,
    client,
    maxWait: 60_000,
  });
  return client;
}

function assertProjectNeedsRemediation(row: ProjectRemediationRow): void {
  const need = remediationNeed(row);
  if (!need.needs_remediation) {
    throw new Error(need.reason ?? "project does not need remediation");
  }
}

async function prepareProjectRemediationForRow({
  account_id,
  row,
  snapshot_name,
  allow_custom_snapshot_name = false,
}: {
  account_id: string;
  row: ProjectRemediationRow;
  snapshot_name?: string;
  allow_custom_snapshot_name?: boolean;
}): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  assertProjectNeedsRemediation(row);
  const requestedSnapshotName = clean(snapshot_name);
  if (
    requestedSnapshotName &&
    !allow_custom_snapshot_name &&
    requestedSnapshotName !== LEGACY_PROJECT_FINAL_ARCHIVE_SNAPSHOT_NAME
  ) {
    throw new Error("custom remediation snapshot names are admin-only");
  }
  const snapshotName = assertValidSnapshotName(
    requestedSnapshotName ?? LEGACY_PROJECT_FINAL_ARCHIVE_SNAPSHOT_NAME,
  );
  const bucket =
    clean(row.artifact_bucket) ??
    clean(process.env.COCALC_LEGACY_PROJECTS_BUCKET) ??
    DEFAULT_LEGACY_PROJECTS_BUCKET;
  const key = clean(row.artifact_key);
  if (!key) {
    throw new Error("legacy project archive key is missing");
  }
  const { endpoint, accessKey, secretKey } = await getR2Credentials();
  const signed = issueSignedObjectDownload({
    endpoint,
    accessKey,
    secretKey,
    bucket,
    key,
  });
  const client = await connectProjectFileServerForRemediation({
    project_id: row.project_id,
    account_id,
  });
  const result = await client.prepareLegacyProjectArchiveRemediation({
    project_id: row.project_id,
    snapshot_name: snapshotName,
    download: {
      ...signed,
      bucket,
      key,
      bytes: manifestCompressedBytes(row.artifact_manifest),
      sha256: manifestSha256(row.artifact_manifest),
    },
  });
  const current = remediationMetadata(row);
  const metadata: ProjectRemediationMetadata = {
    ...current,
    dismissed_forever: false,
    prepared_at: new Date().toISOString(),
    snapshot_name: result.snapshot_name,
    snapshot_path: result.snapshot_path,
    diff_counts: result.diff_counts,
    diff_files: result.diff_files,
    diff_file_count: result.diff_file_count,
    truncated: result.truncated,
    file_count: result.file_count,
    uncompressed_bytes: result.uncompressed_bytes,
    skipped_file_count: result.skipped_file_count,
    missing_archive_file_count: result.missing_archive_file_count,
    duration_ms: result.duration_ms,
  };
  await updateProjectRemediationMetadata({
    project_id: row.project_id,
    metadata,
  });
  return remediationResponse({
    ...row,
    restore_result: {
      ...(row.restore_result ?? {}),
      final_archive_remediation: metadata,
    },
  });
}

export async function getProjectRemediation({
  account_id,
  project_id,
}: LegacyMigrationProjectRemediationStatusOptions): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = await remediationProjectForAccount({ account_id, project_id });
  if (row == null) {
    return {
      project_id,
      needs_remediation: false,
      reason: "not a linked legacy project",
    };
  }
  return remediationResponse(row);
}

export async function prepareProjectRemediation({
  account_id,
  project_id,
  snapshot_name,
}: LegacyMigrationPrepareProjectRemediationOptions): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = await remediationProjectForAccount({ account_id, project_id });
  if (row == null) {
    throw new Error("legacy project import is not available for this account");
  }
  return await prepareProjectRemediationForRow({
    account_id,
    row,
    snapshot_name,
  });
}

export async function adminPrepareProjectRemediation({
  account_id,
  project_id,
  snapshot_name,
}: LegacyMigrationPrepareProjectRemediationOptions): Promise<LegacyMigrationPrepareProjectRemediationResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = await remediationProjectByProjectId({ project_id });
  if (row == null) {
    throw new Error("legacy project import is not available for this project");
  }
  return await prepareProjectRemediationForRow({
    account_id: clean(row.owner_account_id) ?? account_id,
    row,
    snapshot_name,
    allow_custom_snapshot_name: true,
  });
}

async function applyProjectRemediationForRow({
  authority_account_id,
  actor_account_id,
  row,
  snapshot_name,
  reason,
  support_reference,
}: {
  authority_account_id: string;
  actor_account_id: string;
  row: ProjectRemediationRow;
  snapshot_name?: string;
  reason?: string;
  support_reference?: string;
}): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  assertProjectNeedsRemediation(row);
  const meta = remediationMetadata(row);
  const effectiveSnapshotName = assertValidSnapshotName(
    clean(meta.snapshot_name) ?? LEGACY_PROJECT_FINAL_ARCHIVE_SNAPSHOT_NAME,
  );
  const requestedSnapshotName = clean(snapshot_name);
  if (
    requestedSnapshotName &&
    requestedSnapshotName !== effectiveSnapshotName
  ) {
    throw new Error("remediation snapshot must match the prepared snapshot");
  }
  const client = await connectProjectFileServerForRemediation({
    project_id: row.project_id,
    account_id: authority_account_id,
  });
  const result = await client.applyLegacyProjectArchiveRemediation({
    project_id: row.project_id,
    snapshot_name: effectiveSnapshotName,
  });
  const metadata: ProjectRemediationMetadata = {
    ...meta,
    applied_at: new Date().toISOString(),
    snapshot_name: result.snapshot_name,
    safety_snapshot_name: result.safety_snapshot_name,
    diff_counts: result.applied_counts,
    diff_files: result.applied_files,
    diff_file_count: result.applied_file_count,
    truncated: result.truncated,
    applied_by_account_id: actor_account_id,
    apply_reason: clean(reason) ?? null,
    apply_support_reference: clean(support_reference) ?? null,
  };
  await updateProjectRemediationMetadata({
    project_id: row.project_id,
    metadata,
  });
  return remediationResponse({
    ...row,
    restore_result: {
      ...(row.restore_result ?? {}),
      final_archive_remediation: metadata,
    },
  });
}

export async function applyProjectRemediation({
  account_id,
  project_id,
  snapshot_name,
}: LegacyMigrationApplyProjectRemediationOptions): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = await remediationProjectForAccount({ account_id, project_id });
  if (row == null) {
    throw new Error("legacy project import is not available for this account");
  }
  return await applyProjectRemediationForRow({
    authority_account_id: account_id,
    actor_account_id: account_id,
    row,
    snapshot_name,
  });
}

export async function adminApplyProjectRemediation({
  account_id,
  project_id,
  snapshot_name,
  reason,
  support_reference,
}: LegacyMigrationAdminApplyProjectRemediationOptions): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const auditReason = requireAuditReason(reason);
  const row = await remediationProjectByProjectId({ project_id });
  if (row == null) {
    throw new Error("legacy project import is not available for this project");
  }
  return await applyProjectRemediationForRow({
    authority_account_id: clean(row.owner_account_id) ?? account_id,
    actor_account_id: account_id,
    row,
    snapshot_name,
    reason: auditReason,
    support_reference,
  });
}

export async function dismissProjectRemediation({
  account_id,
  project_id,
  forever,
}: LegacyMigrationDismissProjectRemediationOptions): Promise<LegacyMigrationProjectRemediationStatusResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = await remediationProjectForAccount({ account_id, project_id });
  if (row == null) {
    throw new Error("legacy project import is not available for this account");
  }
  if (forever) {
    const metadata: ProjectRemediationMetadata = {
      ...remediationMetadata(row),
      dismissed_forever: true,
      dismissed_at: new Date().toISOString(),
    };
    await updateProjectRemediationMetadata({
      project_id: row.project_id,
      metadata,
    });
    return remediationResponse({
      ...row,
      restore_result: {
        ...(row.restore_result ?? {}),
        final_archive_remediation: metadata,
      },
    });
  }
  return remediationResponse(row);
}
