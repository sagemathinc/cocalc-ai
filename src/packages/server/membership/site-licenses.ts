/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";

import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { createNotificationEventGraph } from "@cocalc/database/postgres/notifications-core";
import { getClusterAccountsByIdsDirect } from "@cocalc/server/accounts/cluster-directory";
import isAdmin from "@cocalc/server/accounts/is-admin";
import type {
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageRecord,
  SiteLicenseAffiliationReverificationUserSeat,
  SiteLicenseAffiliationReverificationUserStatus,
  SiteLicenseAffiliationReverificationSeat,
  SiteLicenseAffiliationReverificationState,
  SiteLicenseAuditAction,
  SiteLicenseAuditEvent,
  SiteLicenseManager,
  SiteLicenseManagerRole,
  SiteLicenseOverview,
  SiteLicensePoolConfig,
  SiteLicensePoolRequest,
  SiteLicensePoolRequestState,
  SiteLicensePoolSummary,
  SiteLicenseRecord,
  SiteLicenseViewerRole,
  SiteLicenseVerificationPolicy,
} from "@cocalc/conat/hub/api/purchases";
import {
  is_valid_email_address as isValidEmailAddress,
  isValidUUID,
  uuid,
} from "@cocalc/util/misc";
import {
  canonicalizeInstitutionalClaimEmail,
  getMembershipClaimIdentity,
  reserveMembershipClaimIdentity,
  revokeMembershipClaimIdentity,
} from "./claim-directory";
import {
  assignMembershipPackageSeat,
  assertNoActiveSiteLicenseDomainOverlap,
  cancelPendingSiteLicensePoolRequestsForAccount,
  createMembershipPackage,
  getMembershipPackage,
  listMembershipPackageAssignments,
  revokeOtherActiveSiteLicenseAssignmentsForAccount,
  revokeMembershipPackageSeat,
  updateMembershipPackage as updateMembershipPackageRecord,
  type SiteLicenseAccountSeatChange,
  type SiteLicenseCanceledPoolRequest,
} from "./packages";
import { listActiveMembershipGrantsForAccount } from "./grants";
import {
  queueMembershipClaimIdentitySyncEffect,
  queueMembershipGrantSyncEffect,
} from "./side-effects";

type Queryable = PoolClient | ReturnType<typeof getPool>;
type SiteLicenseMembershipPackage = NonNullable<
  Awaited<ReturnType<typeof getMembershipPackage>>
>;

const logger = getLogger("server:membership:site-licenses");
const SITE_LICENSE_NOTIFICATION_ORIGIN_LABEL = "Site licenses";
const SITE_LICENSE_MANAGER_NOTIFICATION_ACTION_LINK = "/settings/site-licenses";
const SITE_LICENSE_MANAGER_NOTIFICATION_ACTION_LABEL = "Open site licenses";
const SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LINK = "/settings/membership";
const SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LABEL = "Open membership";
const SITE_LICENSE_REVERIFICATION_WARNING_DAYS = [14, 3] as const;

type SiteLicenseAffiliationNotificationStage =
  | "pending"
  | "warning-14d"
  | "warning-3d";

interface RawSiteLicenseRecord {
  id: string;
  name: string;
  organization_name: string;
  bay_id?: string | null;
  owner_account_id?: string | null;
  allowed_domains?: string[] | null;
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  renewal_policy?: string | null;
  overage_policy?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
  updated?: Date | string;
}

interface RawSiteLicenseManager {
  id: string;
  site_license_id: string;
  account_id: string;
  role: string;
  created_by_account_id?: string | null;
  revoked_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
  updated?: Date | string;
}

interface RawSiteLicensePoolRequest {
  id: string;
  site_license_id: string;
  package_id: string;
  account_id: string;
  matched_email_address: string;
  canonical_identity: string;
  requested_membership_class: string;
  state: string;
  requester_note?: string | null;
  reviewer_account_id?: string | null;
  review_note?: string | null;
  requested_at?: Date | string;
  reviewed_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
  updated?: Date | string;
}

interface RawSiteLicenseAuditEvent {
  id: string;
  site_license_id: string;
  action: string;
  actor_account_id?: string | null;
  target_account_id?: string | null;
  package_id?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
}

interface RawSiteLicenseDomain {
  site_license_id: string;
  domain: string;
}

const SITE_LICENSE_MANAGER_ROLES = new Set<SiteLicenseManagerRole>([
  "manager",
  "viewer",
]);
const SITE_LICENSE_VERIFICATION_POLICIES =
  new Set<SiteLicenseVerificationPolicy>([
    "email-domain",
    "sso-affiliation",
    "manager-approval",
  ]);
const SITE_LICENSE_POOL_REQUEST_STATES = new Set<SiteLicensePoolRequestState>([
  "pending",
  "approved",
  "rejected",
  "canceled",
  "expired",
]);
const SITE_LICENSE_AUDIT_ACTIONS = new Set<SiteLicenseAuditAction>([
  "site-license-provisioned",
  "manager-added",
  "manager-updated",
  "manager-removed",
  "site-license-updated",
  "pool-created",
  "pool-updated",
  "pool-archived",
  "pool-request-created",
  "pool-request-canceled",
  "pool-request-approved",
  "pool-request-rejected",
  "seat-released-by-user",
  "seat-released-for-upgrade",
  "seat-affiliation-reverified",
  "seat-released-after-reverification-grace",
]);

let schemaEnsured: Promise<void> | undefined;

function getQueryClient(client?: PoolClient): Queryable {
  return client ?? getPool();
}

async function withLocalSiteLicenseTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function ensureSiteLicenseSchema(client?: PoolClient): Promise<void> {
  if (client == null) {
    schemaEnsured ??= ensureSiteLicenseSchemaWithClient(getPool());
    await schemaEnsured;
    return;
  }
  await ensureSiteLicenseSchemaWithClient(client);
}

async function ensureSiteLicenseSchemaWithClient(db: Queryable): Promise<void> {
  const seedBayId = getSiteLicenseSeedBayId();
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_licenses (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      bay_id TEXT NOT NULL,
      owner_account_id UUID,
      allowed_domains TEXT[],
      custom_terms_url TEXT,
      custom_policy_url TEXT,
      terms_version_label TEXT,
      renewal_policy TEXT,
      overage_policy TEXT,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    "ALTER TABLE site_licenses ADD COLUMN IF NOT EXISTS bay_id TEXT",
  );
  await db.query(
    "ALTER TABLE site_licenses ALTER COLUMN owner_account_id DROP NOT NULL",
  );
  await db.query(
    `
      UPDATE site_licenses
         SET bay_id = $1
       WHERE bay_id IS DISTINCT FROM $1
    `,
    [seedBayId],
  );
  await db.query("ALTER TABLE site_licenses ALTER COLUMN bay_id SET NOT NULL");
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_licenses_bay_id_idx ON site_licenses (bay_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_licenses_owner_account_id_idx ON site_licenses (owner_account_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_licenses_updated_idx ON site_licenses (updated)",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_license_domains (
      site_license_id UUID NOT NULL,
      domain TEXT NOT NULL,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (site_license_id, domain)
    )
  `);
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_domains_domain_idx ON site_license_domains (domain)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_domains_active_idx ON site_license_domains (expires_at, starts_at)",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_license_domain_locks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  await db.query(
    "INSERT INTO site_license_domain_locks (id, name) VALUES (1, 'site-license-domain-write-lock') ON CONFLICT (id) DO NOTHING",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_license_managers (
      id UUID PRIMARY KEY,
      site_license_id UUID NOT NULL,
      account_id UUID NOT NULL,
      role TEXT NOT NULL,
      created_by_account_id UUID,
      revoked_at TIMESTAMPTZ,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_managers_site_license_id_idx ON site_license_managers (site_license_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_managers_account_id_idx ON site_license_managers (account_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_managers_revoked_at_idx ON site_license_managers (revoked_at)",
  );
  await db.query(`
    UPDATE site_licenses s
       SET owner_account_id = owner_rows.account_id,
           updated = NOW()
      FROM (
        SELECT DISTINCT ON (site_license_id) site_license_id, account_id
          FROM site_license_managers
         WHERE role = 'owner'
           AND revoked_at IS NULL
         ORDER BY site_license_id, created ASC
      ) owner_rows
     WHERE s.id = owner_rows.site_license_id
       AND s.owner_account_id IS NULL
  `);
  await db.query(`
    UPDATE site_license_managers
       SET role = 'viewer',
           updated = NOW()
     WHERE role = 'owner'
       AND revoked_at IS NULL
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_license_pool_requests (
      id UUID PRIMARY KEY,
      site_license_id UUID NOT NULL,
      package_id UUID NOT NULL,
      account_id UUID NOT NULL,
      matched_email_address TEXT NOT NULL,
      canonical_identity VARCHAR(320) NOT NULL,
      requested_membership_class TEXT NOT NULL,
      state TEXT NOT NULL,
      requester_note TEXT,
      reviewer_account_id UUID,
      review_note TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_pool_requests_site_license_id_idx ON site_license_pool_requests (site_license_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_pool_requests_package_id_idx ON site_license_pool_requests (package_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_pool_requests_account_id_idx ON site_license_pool_requests (account_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_pool_requests_canonical_identity_idx ON site_license_pool_requests (canonical_identity)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_pool_requests_state_idx ON site_license_pool_requests (state)",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_license_audit_log (
      id UUID PRIMARY KEY,
      site_license_id UUID NOT NULL,
      action TEXT NOT NULL,
      actor_account_id UUID,
      target_account_id UUID,
      package_id UUID,
      request_id UUID,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_audit_log_site_license_id_idx ON site_license_audit_log (site_license_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_audit_log_created_idx ON site_license_audit_log (created)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_license_audit_log_action_idx ON site_license_audit_log (action)",
  );
}

function normalizeMetadata(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (metadata == null) return null;
  return { ...metadata };
}

function normalizeString(value: unknown, field: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw Error(`${field} is required`);
  }
  return normalized;
}

function getSiteLicenseSeedBayId(): string {
  return normalizeString(getConfiguredClusterSeedBayId(), "seed bay_id");
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = `${value ?? ""}`.trim();
  return normalized || null;
}

function normalizeAccountId(value: unknown, field = "account_id"): string {
  const account_id = `${value ?? ""}`.trim();
  if (!isValidUUID(account_id)) {
    throw Error(`${field} is required`);
  }
  return account_id;
}

function normalizePackageId(value: unknown): string {
  const package_id = `${value ?? ""}`.trim();
  if (!isValidUUID(package_id)) {
    throw Error("package_id is required");
  }
  return package_id;
}

function normalizeAllowedDomain(domain: string): string {
  const value = `${domain ?? ""}`.trim().toLowerCase().replace(/^@+/, "");
  if (
    !value ||
    value.includes("@") ||
    value.includes("/") ||
    value.includes(":") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      value,
    )
  ) {
    throw Error(`invalid allowed domain '${domain}'`);
  }
  return value;
}

function normalizeAllowedDomains(allowed_domains?: string[]): string[] {
  const domains = Array.from(
    new Set((allowed_domains ?? []).map(normalizeAllowedDomain)),
  ).sort();
  if (domains.length === 0) {
    throw Error("at least one allowed domain is required");
  }
  return domains;
}

function siteLicenseDomainsOverlap(left: string, right: string): boolean {
  return (
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
  );
}

function findSiteLicenseDomainOverlap({
  candidate_domains,
  existing_domains,
}: {
  candidate_domains: string[];
  existing_domains: string[];
}): { candidate_domain: string; existing_domain: string } | undefined {
  for (const candidate_domain of candidate_domains) {
    for (const existing_domain of existing_domains) {
      if (siteLicenseDomainsOverlap(candidate_domain, existing_domain)) {
        return { candidate_domain, existing_domain };
      }
    }
  }
}

function collectSiteLicenseDomains({
  allowed_domains,
  pools,
}: {
  allowed_domains: string[];
  pools: Array<{ allowed_domains: string[] }>;
}): string[] {
  return Array.from(
    new Set([
      ...allowed_domains,
      ...pools.flatMap((pool) => pool.allowed_domains),
    ]),
  ).sort();
}

async function assertNoActiveSiteLicenseDomainIndexOverlap({
  domains,
  site_license_id,
  starts_at,
  expires_at,
  client,
}: {
  domains: string[];
  site_license_id: string;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  client: PoolClient;
}): Promise<void> {
  const candidateDomains = normalizeAllowedDomains(domains);
  const candidateStartsAt = asDate(starts_at) ?? null;
  const candidateExpiresAt = asDate(expires_at) ?? null;
  if (
    candidateExpiresAt != null &&
    candidateExpiresAt.getTime() <= Date.now()
  ) {
    return;
  }
  const { rows } = await client.query<RawSiteLicenseDomain>(
    `SELECT site_license_id, domain
       FROM site_license_domains
      WHERE site_license_id != $1::uuid
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (expires_at IS NULL OR $2::timestamptz IS NULL OR expires_at > $2::timestamptz)
        AND (starts_at IS NULL OR $3::timestamptz IS NULL OR starts_at < $3::timestamptz)`,
    [site_license_id, candidateStartsAt, candidateExpiresAt],
  );
  const overlap = findSiteLicenseDomainOverlap({
    candidate_domains: candidateDomains,
    existing_domains: rows.map((row) => row.domain),
  });
  if (overlap == null) {
    return;
  }
  const owner = rows.find((row) => row.domain === overlap.existing_domain);
  throw Error(
    `site license domain '${overlap.candidate_domain}' overlaps active site license domain '${overlap.existing_domain}' in ${owner?.site_license_id ?? "site_license_domains"}`,
  );
}

async function acquireSiteLicenseDomainWriteLock(
  client: PoolClient,
): Promise<void> {
  await client.query(
    "SELECT id FROM site_license_domain_locks WHERE id=1 FOR UPDATE",
  );
}

async function upsertSiteLicenseDomainIndex({
  site_license_id,
  domains,
  starts_at,
  expires_at,
  client,
}: {
  site_license_id: string;
  domains: string[];
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  client: PoolClient;
}): Promise<void> {
  const normalizedDomains = normalizeAllowedDomains(domains);
  await client.query(
    `INSERT INTO site_license_domains
        (site_license_id, domain, starts_at, expires_at, created, updated)
     SELECT $1::uuid, domain, $3::timestamptz, $4::timestamptz, NOW(), NOW()
       FROM UNNEST($2::text[]) AS domain
     ON CONFLICT (site_license_id, domain) DO UPDATE
       SET starts_at=EXCLUDED.starts_at,
           expires_at=EXCLUDED.expires_at,
           updated=NOW()`,
    [site_license_id, normalizedDomains, starts_at ?? null, expires_at ?? null],
  );
}

async function rebuildSiteLicenseDomainIndex({
  site_license_id,
  client,
}: {
  site_license_id: string;
  client: PoolClient;
}): Promise<void> {
  const siteLicense = await getSiteLicense(site_license_id, client);
  const { rows } = await client.query<{
    metadata?: Record<string, unknown> | null;
  }>(
    `SELECT metadata
       FROM membership_packages
      WHERE kind='site'
        AND metadata->>'site_license_id'=$1
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [site_license_id],
  );
  const domains = collectSiteLicenseDomains({
    allowed_domains: siteLicense.allowed_domains,
    pools: rows.map((row) => ({
      allowed_domains: getPackageAllowedDomains(row.metadata),
    })),
  });
  await acquireSiteLicenseDomainWriteLock(client);
  await assertNoActiveSiteLicenseDomainIndexOverlap({
    domains,
    site_license_id,
    starts_at: siteLicense.starts_at,
    expires_at: siteLicense.expires_at,
    client,
  });
  await client.query(
    "DELETE FROM site_license_domains WHERE site_license_id=$1",
    [site_license_id],
  );
  await upsertSiteLicenseDomainIndex({
    site_license_id,
    domains,
    starts_at: siteLicense.starts_at,
    expires_at: siteLicense.expires_at,
    client,
  });
}

function normalizeSeatCount(seat_count: number): number {
  if (!Number.isInteger(seat_count) || seat_count <= 0) {
    throw Error("seat_count must be a positive integer");
  }
  return seat_count;
}

function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw Error("value must be a positive integer");
  }
  return normalized;
}

function normalizeEmailAddress(value: unknown): string {
  const email = `${value ?? ""}`.trim().toLowerCase();
  if (!email || !isValidEmailAddress(email)) {
    throw Error("invalid email address");
  }
  return email;
}

function asDate(value?: Date | string | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`invalid date '${value}'`);
  }
  return date;
}

function getPackageAllowedDomains(
  metadata?: Record<string, unknown> | null,
): string[] {
  return Array.isArray(metadata?.allowed_domains)
    ? metadata.allowed_domains
        .map((domain) => `${domain ?? ""}`.trim().toLowerCase())
        .filter((domain) => domain.length > 0)
    : [];
}

function getPackagePoolName(
  pkg: Pick<MembershipPackageRecord, "metadata">,
  fallback = "Site license pool",
): string {
  const poolName = `${pkg.metadata?.pool_name ?? ""}`.trim();
  return poolName || fallback;
}

function getPackageVerificationPolicy(
  metadata?: Record<string, unknown> | null,
): SiteLicenseVerificationPolicy {
  const policy = `${metadata?.verification_policy ?? "email-domain"}`.trim();
  if (SITE_LICENSE_VERIFICATION_POLICIES.has(policy as any)) {
    return policy as SiteLicenseVerificationPolicy;
  }
  return "email-domain";
}

function normalizeExclusiveGroup(
  exclusive_group: unknown,
  fallback: string,
): string {
  const normalized = `${exclusive_group ?? ""}`.trim().toLowerCase();
  if (normalized) {
    return normalized;
  }
  return normalizeString(fallback, "exclusive_group").toLowerCase();
}

function getPackageExclusiveGroup({
  membership_class,
  metadata,
}: {
  membership_class: string;
  metadata?: Record<string, unknown> | null;
}): string {
  return normalizeExclusiveGroup(metadata?.exclusive_group, membership_class);
}

function getClaimScopeKey(
  site_license_id: string,
  exclusive_group: string,
): string {
  return `site-license:${site_license_id}:group:${exclusive_group}`;
}

function getSiteLicenseAffiliationMetadata({
  site_license_id,
  site_license,
  pkg,
  matched_email_address,
  exclusive_group,
  verified_at = new Date(),
}: {
  site_license_id: string;
  site_license: SiteLicenseRecord;
  pkg: { metadata?: Record<string, unknown> | null };
  matched_email_address: string;
  exclusive_group: string;
  verified_at?: Date;
}): Record<string, unknown> {
  return {
    site_license_id,
    site_license_name: site_license.name,
    organization_name: site_license.organization_name,
    site_license_bay_id: site_license.bay_id,
    site_license_owner_account_id: site_license.owner_account_id ?? null,
    pool_name: `${pkg.metadata?.pool_name ?? ""}`.trim() || null,
    verification_policy: getPackageVerificationPolicy(pkg.metadata),
    exclusive_group,
    affiliation_reverification_days:
      pkg.metadata?.affiliation_reverification_days ?? null,
    affiliation_reverification_grace_days:
      pkg.metadata?.affiliation_reverification_grace_days ?? null,
    matched_email_address,
    affiliation_verified_at: verified_at.toISOString(),
  };
}

function getMetadataDate(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Date | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string" && !(value instanceof Date)) {
    return;
  }
  return asDate(value) ?? undefined;
}

function getAffiliationVerifiedAt(
  assignment: Pick<MembershipPackageAssignment, "assigned_at" | "metadata">,
): Date | undefined {
  return (
    getMetadataDate(assignment.metadata, "affiliation_verified_at") ??
    getMetadataDate(assignment.metadata, "approved_at") ??
    getMetadataDate(assignment.metadata, "claimed_at") ??
    assignment.assigned_at ??
    undefined
  );
}

function addDays(date: Date, days: number): Date {
  return dayjs(date).add(days, "day").toDate();
}

function classifyAffiliationReverification({
  verified_at,
  reverification_days,
  grace_days,
  now,
}: {
  verified_at?: Date;
  reverification_days?: number | null;
  grace_days?: number | null;
  now: Date;
}): {
  state: SiteLicenseAffiliationReverificationState;
  due_at?: Date | null;
  grace_expires_at?: Date | null;
} {
  if (verified_at == null || reverification_days == null) {
    return {
      state: "current",
      due_at: null,
      grace_expires_at: null,
    };
  }
  const due_at = addDays(verified_at, reverification_days);
  const grace_expires_at = addDays(due_at, grace_days ?? 0);
  if (due_at > now) {
    return { state: "current", due_at, grace_expires_at };
  }
  if (grace_expires_at > now) {
    return { state: "pending_reverification", due_at, grace_expires_at };
  }
  return { state: "grace_expired", due_at, grace_expires_at };
}

function getAssignmentVerificationPolicy({
  assignment,
  pool,
}: {
  assignment: MembershipPackageAssignment;
  pool: SiteLicensePoolSummary;
}): SiteLicenseVerificationPolicy {
  return SITE_LICENSE_VERIFICATION_POLICIES.has(
    assignment.metadata?.verification_policy as any,
  )
    ? (assignment.metadata
        ?.verification_policy as SiteLicenseVerificationPolicy)
    : pool.verification_policy;
}

function getAssignmentMatchedEmail(
  assignment: MembershipPackageAssignment,
): string | null {
  return (
    `${assignment.metadata?.matched_email_address ?? ""}`.trim() ||
    `${assignment.metadata?.claimed_email_address ?? ""}`.trim() ||
    assignment.email_address ||
    null
  );
}

function toAffiliationReverificationSeat({
  site_license_id,
  pool,
  assignment,
  now,
}: {
  site_license_id: string;
  pool: SiteLicensePoolSummary;
  assignment: MembershipPackageAssignment;
  now: Date;
}): SiteLicenseAffiliationReverificationSeat {
  const affiliation_verified_at = getAffiliationVerifiedAt(assignment);
  const classification = classifyAffiliationReverification({
    verified_at: affiliation_verified_at,
    reverification_days: pool.affiliation_reverification_days,
    grace_days: pool.affiliation_reverification_grace_days,
    now,
  });
  return {
    site_license_id,
    package_id: pool.id,
    assignment_id: assignment.id,
    account_id: assignment.account_id!,
    membership_class: pool.membership_class,
    pool_name: pool.pool_name,
    exclusive_group:
      `${assignment.metadata?.exclusive_group ?? ""}`.trim() ||
      pool.exclusive_group,
    verification_policy: getAssignmentVerificationPolicy({ assignment, pool }),
    matched_email_address: getAssignmentMatchedEmail(assignment),
    affiliation_verified_at: affiliation_verified_at ?? null,
    reverification_due_at: classification.due_at ?? null,
    reverification_grace_expires_at: classification.grace_expires_at ?? null,
    reverification_days: pool.affiliation_reverification_days ?? null,
    grace_days: pool.affiliation_reverification_grace_days ?? null,
    state: classification.state,
  };
}

function getMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return `${metadata?.[key] ?? ""}`.trim() || null;
}

function toUserAffiliationReverificationSeat({
  grant,
  now,
}: {
  grant: {
    account_id: string;
    membership_class: string;
    package_id?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  now: Date;
}): SiteLicenseAffiliationReverificationUserSeat | undefined {
  const metadata = normalizeMetadata(grant.metadata);
  const site_license_id = getMetadataString(metadata, "site_license_id");
  const package_id = `${grant.package_id ?? ""}`.trim();
  if (!site_license_id || !package_id) {
    return;
  }
  const affiliation_verified_at =
    getMetadataDate(metadata, "affiliation_verified_at") ??
    getMetadataDate(metadata, "approved_at") ??
    getMetadataDate(metadata, "claimed_at");
  const reverification_days = normalizeOptionalPositiveInt(
    metadata?.affiliation_reverification_days,
  );
  const grace_days = normalizeOptionalPositiveInt(
    metadata?.affiliation_reverification_grace_days,
  );
  const classification = classifyAffiliationReverification({
    verified_at: affiliation_verified_at,
    reverification_days,
    grace_days,
    now,
  });
  const verification_policy = SITE_LICENSE_VERIFICATION_POLICIES.has(
    metadata?.verification_policy as any,
  )
    ? (metadata?.verification_policy as SiteLicenseVerificationPolicy)
    : "email-domain";
  return {
    site_license_id,
    package_id,
    assignment_id: getMetadataString(metadata, "assignment_id") ?? "",
    account_id: grant.account_id,
    membership_class: grant.membership_class,
    pool_name: getMetadataString(metadata, "pool_name"),
    site_license_name: getMetadataString(metadata, "site_license_name"),
    organization_name: getMetadataString(metadata, "organization_name"),
    site_license_owner_account_id: getMetadataString(
      metadata,
      "site_license_owner_account_id",
    ),
    exclusive_group:
      getMetadataString(metadata, "exclusive_group") ??
      `${grant.membership_class}`.trim().toLowerCase(),
    verification_policy,
    matched_email_address: getMetadataString(metadata, "matched_email_address"),
    affiliation_verified_at: affiliation_verified_at ?? null,
    reverification_due_at: classification.due_at ?? null,
    reverification_grace_expires_at: classification.grace_expires_at ?? null,
    reverification_days,
    grace_days,
    state: classification.state,
    can_refresh_with_verified_email: verification_policy === "email-domain",
  };
}

function buildUserAffiliationReverificationStatus(
  seats: SiteLicenseAffiliationReverificationUserSeat[],
): SiteLicenseAffiliationReverificationUserStatus {
  const pendingSeats = seats.filter(
    (seat) =>
      seat.state === "pending_reverification" || seat.state === "grace_expired",
  );
  const dueDates = pendingSeats
    .map((seat) => seat.reverification_due_at)
    .filter((date): date is Date => date instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const graceDates = pendingSeats
    .map((seat) => seat.reverification_grace_expires_at)
    .filter((date): date is Date => date instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  return {
    seats,
    pending_count: seats.filter(
      (seat) => seat.state === "pending_reverification",
    ).length,
    grace_expired_count: seats.filter((seat) => seat.state === "grace_expired")
      .length,
    next_reverification_due_at: dueDates[0] ?? null,
    next_reverification_grace_expires_at: graceDates[0] ?? null,
  };
}

function normalizeSiteLicenseRow(
  row: RawSiteLicenseRecord | undefined,
): SiteLicenseRecord | undefined {
  if (!row) return;
  return {
    id: row.id,
    name: row.name,
    organization_name: row.organization_name,
    bay_id: `${row.bay_id ?? ""}`.trim() || getSiteLicenseSeedBayId(),
    owner_account_id: row.owner_account_id ?? null,
    allowed_domains: Array.isArray(row.allowed_domains)
      ? row.allowed_domains
      : [],
    custom_terms_url: row.custom_terms_url ?? null,
    custom_policy_url: row.custom_policy_url ?? null,
    terms_version_label: row.terms_version_label ?? null,
    renewal_policy: row.renewal_policy ?? null,
    overage_policy: row.overage_policy ?? null,
    starts_at: asDate(row.starts_at),
    expires_at: asDate(row.expires_at),
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created) ?? undefined,
    updated: asDate(row.updated) ?? undefined,
  };
}

function normalizeSiteLicenseManagerRow(
  row: RawSiteLicenseManager,
): SiteLicenseManager {
  const role = SITE_LICENSE_MANAGER_ROLES.has(row.role as any)
    ? (row.role as SiteLicenseManagerRole)
    : "viewer";
  return {
    id: row.id,
    site_license_id: row.site_license_id,
    account_id: row.account_id,
    role,
    created_by_account_id: row.created_by_account_id ?? null,
    revoked_at: asDate(row.revoked_at),
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created) ?? undefined,
    updated: asDate(row.updated) ?? undefined,
  };
}

function normalizeSiteLicensePoolRequestRow(
  row: RawSiteLicensePoolRequest | undefined,
): SiteLicensePoolRequest | undefined {
  if (!row) return;
  const state = SITE_LICENSE_POOL_REQUEST_STATES.has(row.state as any)
    ? (row.state as SiteLicensePoolRequestState)
    : "expired";
  return {
    id: row.id,
    site_license_id: row.site_license_id,
    package_id: row.package_id,
    account_id: row.account_id,
    matched_email_address: normalizeEmailAddress(row.matched_email_address),
    canonical_identity: normalizeEmailAddress(row.canonical_identity),
    requested_membership_class: row.requested_membership_class,
    state,
    requester_note: row.requester_note ?? null,
    reviewer_account_id: row.reviewer_account_id ?? null,
    review_note: row.review_note ?? null,
    requested_at: asDate(row.requested_at) ?? undefined,
    reviewed_at: asDate(row.reviewed_at),
    expires_at: asDate(row.expires_at),
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created) ?? undefined,
    updated: asDate(row.updated) ?? undefined,
  };
}

function normalizeSiteLicenseAuditEventRow(
  row: RawSiteLicenseAuditEvent,
): SiteLicenseAuditEvent {
  const action = SITE_LICENSE_AUDIT_ACTIONS.has(row.action as any)
    ? (row.action as SiteLicenseAuditAction)
    : "site-license-provisioned";
  return {
    id: row.id,
    site_license_id: row.site_license_id,
    action,
    actor_account_id: row.actor_account_id ?? null,
    target_account_id: row.target_account_id ?? null,
    package_id: row.package_id ?? null,
    request_id: row.request_id ?? null,
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created) ?? undefined,
  };
}

async function recordSiteLicenseAuditEvent({
  site_license_id,
  action,
  actor_account_id,
  target_account_id,
  package_id,
  request_id,
  metadata,
  client,
}: {
  site_license_id: string;
  action: SiteLicenseAuditAction;
  actor_account_id?: string | null;
  target_account_id?: string | null;
  package_id?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown> | null;
  client: Queryable;
}): Promise<void> {
  await client.query(
    `INSERT INTO site_license_audit_log
       (id, site_license_id, action, actor_account_id, target_account_id,
        package_id, request_id, metadata, created)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())`,
    [
      uuid(),
      site_license_id,
      action,
      normalizeOptionalString(actor_account_id),
      normalizeOptionalString(target_account_id),
      normalizeOptionalString(package_id),
      normalizeOptionalString(request_id),
      normalizeMetadata(metadata),
    ],
  );
}

async function listSiteLicenseAuditEvents({
  site_license_id,
  limit = 25,
  client,
}: {
  site_license_id: string;
  limit?: number;
  client?: PoolClient;
}): Promise<SiteLicenseAuditEvent[]> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(client).query<RawSiteLicenseAuditEvent>(
    `SELECT *
     FROM site_license_audit_log
     WHERE site_license_id=$1
     ORDER BY created DESC
     LIMIT $2`,
    [site_license_id, Math.max(1, Math.min(100, limit))],
  );
  return rows.map(normalizeSiteLicenseAuditEventRow);
}

async function resolveSiteLicenseNotificationTargets(
  account_ids: string[],
): Promise<Array<{ account_id: string; home_bay_id: string }>> {
  const uniqueAccountIds = Array.from(
    new Set(account_ids.map((id) => `${id ?? ""}`.trim()).filter(Boolean)),
  );
  if (uniqueAccountIds.length === 0) {
    return [];
  }
  const entries = await getClusterAccountsByIdsDirect(uniqueAccountIds);
  const byAccountId = new Map(
    entries.map((entry) => [
      entry.account_id,
      `${entry.home_bay_id ?? ""}`.trim() || getConfiguredBayId(),
    ]),
  );
  return uniqueAccountIds
    .map((account_id) => ({
      account_id,
      home_bay_id: byAccountId.get(account_id),
    }))
    .filter(
      (target): target is { account_id: string; home_bay_id: string } =>
        !!target.home_bay_id,
    );
}

async function createSiteLicenseAccountNoticeBestEffort({
  action_label = SITE_LICENSE_MANAGER_NOTIFICATION_ACTION_LABEL,
  action_link = SITE_LICENSE_MANAGER_NOTIFICATION_ACTION_LINK,
  actor_account_id,
  target_account_ids,
  title,
  body_markdown,
  severity = "info",
  dedupe_key,
  metadata = {},
}: {
  action_label?: string;
  action_link?: string;
  actor_account_id?: string | null;
  target_account_ids: string[];
  title: string;
  body_markdown: string;
  severity?: "info" | "warning" | "error";
  dedupe_key: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const targets =
      await resolveSiteLicenseNotificationTargets(target_account_ids);
    if (targets.length === 0) {
      logger.warn("skipping site-license notification with no valid targets", {
        dedupe_key,
        target_account_ids,
      });
      return false;
    }
    await createNotificationEventGraph({
      kind: "account_notice",
      source_bay_id: getConfiguredBayId(),
      actor_account_id: actor_account_id ?? null,
      origin_kind: "admin",
      payload_json: {
        severity,
        title,
        body_markdown,
        origin_label: SITE_LICENSE_NOTIFICATION_ORIGIN_LABEL,
        action_link,
        action_label,
        dedupe_key,
        ...metadata,
      },
      targets: targets.map((target) => ({
        target_account_id: target.account_id,
        target_home_bay_id: target.home_bay_id,
        dedupe_key: `${dedupe_key}:${target.account_id}`,
        summary_json: {
          title,
          body_markdown,
          severity,
          origin_label: SITE_LICENSE_NOTIFICATION_ORIGIN_LABEL,
          action_link,
          action_label,
          ...metadata,
        },
      })),
    });
    return true;
  } catch (err) {
    logger.warn("failed to create site-license notification", {
      dedupe_key,
      target_account_ids,
      error: `${(err as Error)?.message ?? err}`,
    });
    return false;
  }
}

async function notifySiteLicensePoolRequestCreatedBestEffort({
  siteLicense,
  pkg,
  request,
}: {
  siteLicense: SiteLicenseRecord;
  pkg: SiteLicenseMembershipPackage;
  request: SiteLicensePoolRequest;
}): Promise<void> {
  try {
    const managers = await listSiteLicenseManagers(siteLicense.id);
    const targetAccountIds = managers
      .filter((manager) => manager.role === "manager")
      .map((manager) => manager.account_id);
    const poolName = getPackagePoolName(pkg);
    await createSiteLicenseAccountNoticeBestEffort({
      actor_account_id: request.account_id,
      target_account_ids: targetAccountIds,
      title: `New ${siteLicense.name} request`,
      body_markdown: [
        `A user requested access to **${poolName}** for ${siteLicense.organization_name}.`,
        request.requester_note
          ? `Requester note: ${request.requester_note}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      severity: "info",
      dedupe_key: `site-license-pool-request:${request.id}:created`,
      metadata: {
        site_license_id: siteLicense.id,
        package_id: pkg.id,
        request_id: request.id,
        pool_name: poolName,
        request_state: request.state,
      },
    });
  } catch (err) {
    logger.warn("failed to prepare site-license request notification", {
      site_license_id: siteLicense.id,
      package_id: pkg.id,
      request_id: request.id,
      error: `${(err as Error)?.message ?? err}`,
    });
  }
}

async function notifySiteLicensePoolRequestReviewedBestEffort({
  actor_account_id,
  siteLicense,
  pkg,
  request,
}: {
  actor_account_id: string;
  siteLicense: SiteLicenseRecord;
  pkg: SiteLicenseMembershipPackage;
  request: SiteLicensePoolRequest;
}): Promise<void> {
  const poolName = getPackagePoolName(pkg);
  const approved = request.state === "approved";
  await createSiteLicenseAccountNoticeBestEffort({
    action_label: SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LABEL,
    action_link: SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LINK,
    actor_account_id,
    target_account_ids: [request.account_id],
    title: approved
      ? `${siteLicense.name} request approved`
      : `${siteLicense.name} request rejected`,
    body_markdown: [
      approved
        ? `Your request for **${poolName}** at ${siteLicense.organization_name} was approved.`
        : `Your request for **${poolName}** at ${siteLicense.organization_name} was rejected.`,
      request.review_note ? `Review note: ${request.review_note}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
    severity: approved ? "info" : "warning",
    dedupe_key: `site-license-pool-request:${request.id}:${request.state}`,
    metadata: {
      site_license_id: siteLicense.id,
      package_id: pkg.id,
      request_id: request.id,
      pool_name: poolName,
      request_state: request.state,
    },
  });
}

function formatNotificationDate(date?: Date | null): string {
  if (date == null) return "the scheduled deadline";
  return dayjs(date).format("MMM D, YYYY");
}

function getAffiliationNotificationStage({
  seat,
  now,
}: {
  seat: SiteLicenseAffiliationReverificationSeat;
  now: Date;
}): SiteLicenseAffiliationNotificationStage {
  const graceExpiresAt = seat.reverification_grace_expires_at;
  if (graceExpiresAt == null) return "pending";
  const daysUntilGraceExpires = dayjs(graceExpiresAt).diff(now, "day", true);
  if (daysUntilGraceExpires <= SITE_LICENSE_REVERIFICATION_WARNING_DAYS[1]) {
    return "warning-3d";
  }
  if (daysUntilGraceExpires <= SITE_LICENSE_REVERIFICATION_WARNING_DAYS[0]) {
    return "warning-14d";
  }
  return "pending";
}

function getAffiliationNotificationState(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> {
  const state = metadata?.affiliation_reverification_notifications;
  return state != null && typeof state === "object" && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>) }
    : {};
}

async function alreadySentAffiliationNotification({
  assignment_id,
  stage,
  grace_key,
  client,
}: {
  assignment_id: string;
  stage: SiteLicenseAffiliationNotificationStage;
  grace_key: string;
  client?: PoolClient;
}): Promise<boolean> {
  const { rows } = await getQueryClient(client).query<{
    metadata?: Record<string, unknown> | null;
  }>(
    `SELECT metadata
       FROM membership_package_assignments
      WHERE id=$1
        AND revoked_at IS NULL`,
    [assignment_id],
  );
  const metadata = normalizeMetadata(rows[0]?.metadata) ?? {};
  return getAffiliationNotificationState(metadata)[stage] === grace_key;
}

async function markAffiliationNotificationSent({
  assignment_id,
  stage,
  grace_key,
  sent_at,
  client,
}: {
  assignment_id: string;
  stage: SiteLicenseAffiliationNotificationStage;
  grace_key: string;
  sent_at: Date;
  client?: PoolClient;
}): Promise<void> {
  const db = getQueryClient(client);
  const { rows } = await db.query<{
    metadata?: Record<string, unknown> | null;
  }>(
    `SELECT metadata
       FROM membership_package_assignments
      WHERE id=$1
        AND revoked_at IS NULL`,
    [assignment_id],
  );
  if (rows.length === 0) return;
  const metadata = normalizeMetadata(rows[0]?.metadata) ?? {};
  const notifications = getAffiliationNotificationState(metadata);
  notifications[stage] = grace_key;
  notifications[`${stage}_sent_at`] = sent_at.toISOString();
  await db.query(
    `UPDATE membership_package_assignments
        SET metadata=$2::jsonb,
            updated=NOW()
      WHERE id=$1
        AND revoked_at IS NULL`,
    [
      assignment_id,
      {
        ...metadata,
        affiliation_reverification_notifications: notifications,
      },
    ],
  );
}

function getAffiliationReverificationNotificationCopy({
  siteLicense,
  seat,
  stage,
}: {
  siteLicense: SiteLicenseRecord;
  seat: SiteLicenseAffiliationReverificationSeat;
  stage: SiteLicenseAffiliationNotificationStage;
}): {
  title: string;
  body_markdown: string;
  severity: "info" | "warning";
} {
  const poolName = seat.pool_name || seat.membership_class;
  const dueDate = formatNotificationDate(seat.reverification_due_at);
  const graceDate = formatNotificationDate(
    seat.reverification_grace_expires_at,
  );
  const body = [
    `Your **${poolName}** membership for ${siteLicense.organization_name} needs affiliation reverification.`,
    `Reverify by confirming a matching institutional email address before **${graceDate}**. Your CoCalc account and projects remain available, but this site-license membership will end if it is not reverified.`,
  ];
  if (stage === "pending") {
    return {
      title: `${siteLicense.name} membership needs reverification`,
      body_markdown: [
        `Reverification was due on **${dueDate}**.`,
        ...body,
      ].join("\n\n"),
      severity: "info",
    };
  }
  return {
    title:
      stage === "warning-3d"
        ? `${siteLicense.name} membership grace period ends soon`
        : `${siteLicense.name} membership reverification reminder`,
    body_markdown: body.join("\n\n"),
    severity: "warning",
  };
}

export async function notifySiteLicenseAffiliationReverificationSeatsForSystem({
  site_license_id,
  now = new Date(),
  limit = 500,
  client,
}: {
  site_license_id: string;
  now?: Date;
  limit?: number;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId, client);
  const seats =
    await listSiteLicenseAffiliationReverificationSeatsForSiteLicense({
      site_license: siteLicense,
      states: ["pending_reverification"],
      now,
      client,
    });
  const notified: SiteLicenseAffiliationReverificationSeat[] = [];
  for (const seat of seats.slice(0, Math.max(1, Math.min(500, limit)))) {
    const graceKey =
      seat.reverification_grace_expires_at?.toISOString() ?? "no-grace-date";
    const stage = getAffiliationNotificationStage({ seat, now });
    if (
      await alreadySentAffiliationNotification({
        assignment_id: seat.assignment_id,
        stage,
        grace_key: graceKey,
        client,
      })
    ) {
      continue;
    }
    const copy = getAffiliationReverificationNotificationCopy({
      siteLicense,
      seat,
      stage,
    });
    const sent = await createSiteLicenseAccountNoticeBestEffort({
      action_label: SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LABEL,
      action_link: SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LINK,
      actor_account_id: null,
      target_account_ids: [seat.account_id],
      title: copy.title,
      body_markdown: copy.body_markdown,
      severity: copy.severity,
      dedupe_key: `site-license-affiliation-reverification:${seat.assignment_id}:${stage}:${graceKey}`,
      metadata: {
        site_license_id: normalizedSiteLicenseId,
        package_id: seat.package_id,
        assignment_id: seat.assignment_id,
        pool_name: seat.pool_name,
        membership_class: seat.membership_class,
        stage,
        reverification_due_at:
          seat.reverification_due_at?.toISOString() ?? null,
        reverification_grace_expires_at:
          seat.reverification_grace_expires_at?.toISOString() ?? null,
      },
    });
    if (!sent) {
      continue;
    }
    await markAffiliationNotificationSent({
      assignment_id: seat.assignment_id,
      stage,
      grace_key: graceKey,
      sent_at: now,
      client,
    });
    notified.push(seat);
  }
  return notified;
}

export async function notifySiteLicenseAffiliationSeatReleasesForSystem({
  site_license_id,
  seats,
}: {
  site_license_id: string;
  seats: SiteLicenseAffiliationReverificationSeat[];
}): Promise<void> {
  if (seats.length === 0) return;
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId);
  for (const seat of seats) {
    await createSiteLicenseAccountNoticeBestEffort({
      action_label: SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LABEL,
      action_link: SITE_LICENSE_MEMBERSHIP_NOTIFICATION_ACTION_LINK,
      actor_account_id: null,
      target_account_ids: [seat.account_id],
      title: `${siteLicense.name} membership ended`,
      body_markdown: [
        `Your **${seat.pool_name || seat.membership_class}** membership for ${siteLicense.organization_name} ended because the affiliation reverification grace period expired.`,
        "Your CoCalc account and projects remain available. Open Membership to see any other memberships or request access again if you are still eligible.",
      ].join("\n\n"),
      severity: "warning",
      dedupe_key: `site-license-affiliation-release:${seat.assignment_id}:${seat.reverification_grace_expires_at?.toISOString() ?? "expired"}`,
      metadata: {
        site_license_id: normalizedSiteLicenseId,
        package_id: seat.package_id,
        assignment_id: seat.assignment_id,
        pool_name: seat.pool_name,
        membership_class: seat.membership_class,
        reverification_due_at:
          seat.reverification_due_at?.toISOString() ?? null,
        reverification_grace_expires_at:
          seat.reverification_grace_expires_at?.toISOString() ?? null,
      },
    });
  }
}

export async function getVerifiedEmailAddressesForAccount(
  account_id: string,
  client?: PoolClient,
): Promise<string[]> {
  const { rows } = await getQueryClient(client).query(
    `SELECT email_address, email_address_verified
     FROM accounts
     WHERE account_id=$1`,
    [account_id],
  );
  const row = rows[0];
  if (!row) {
    throw Error("account not found");
  }
  const verified = row.email_address_verified ?? {};
  const emails = Object.entries(verified)
    .filter(([, verified_at]) => verified_at != null && verified_at !== false)
    .map(([email]) => normalizeEmailAddress(email));
  if (
    emails.length === 0 &&
    row.email_address &&
    verified?.[row.email_address] != null &&
    verified?.[row.email_address] !== false
  ) {
    return [normalizeEmailAddress(row.email_address)];
  }
  return Array.from(new Set(emails));
}

function findMatchingVerifiedEmail({
  verified_email_addresses,
  allowed_domains,
}: {
  verified_email_addresses: string[];
  allowed_domains: string[];
}): string {
  const domains = new Set(allowed_domains);
  const match = verified_email_addresses.find((email) =>
    domains.has(email.split("@")[1] ?? ""),
  );
  if (!match) {
    throw Error("no verified email matches this site license");
  }
  return match;
}

function findOptionalMatchingVerifiedEmail({
  verified_email_addresses,
  allowed_domains,
}: {
  verified_email_addresses: string[];
  allowed_domains: string[];
}): string | undefined {
  const domains = new Set(allowed_domains);
  return verified_email_addresses.find((email) =>
    domains.has(email.split("@")[1] ?? ""),
  );
}

async function getSiteLicense(
  site_license_id: string,
  client?: PoolClient,
): Promise<SiteLicenseRecord> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(client).query<RawSiteLicenseRecord>(
    `SELECT *
     FROM site_licenses
     WHERE id=$1`,
    [site_license_id],
  );
  const siteLicense = normalizeSiteLicenseRow(rows[0]);
  if (!siteLicense) {
    throw Error("site license not found");
  }
  return siteLicense;
}

async function getSiteLicenseForPackage(
  package_id: string,
  client?: PoolClient,
): Promise<{
  siteLicense: SiteLicenseRecord;
  pkg: SiteLicenseMembershipPackage;
}> {
  const pkg = await getMembershipPackage({ package_id, client });
  if (!pkg || pkg.kind !== "site") {
    throw Error("site-license pool not found");
  }
  const site_license_id = `${pkg.metadata?.site_license_id ?? ""}`.trim();
  if (!isValidUUID(site_license_id)) {
    throw Error("site-license pool is missing its site license");
  }
  const siteLicense = await getSiteLicense(site_license_id, client);
  return { siteLicense, pkg };
}

async function listSiteLicenseManagers(
  site_license_id: string,
  client?: PoolClient,
): Promise<SiteLicenseManager[]> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(client).query<RawSiteLicenseManager>(
    `SELECT *
     FROM site_license_managers
     WHERE site_license_id=$1
       AND revoked_at IS NULL
     ORDER BY role, created`,
    [site_license_id],
  );
  return rows.map(normalizeSiteLicenseManagerRow);
}

function addSiteLicenseViewerRole({
  account_id,
  admin = false,
  overview,
}: {
  account_id: string;
  admin?: boolean;
  overview: SiteLicenseOverview;
}): SiteLicenseOverview {
  if (admin) {
    return { ...overview, viewer_role: "admin" };
  }
  const viewer_role: SiteLicenseViewerRole = overview.managers.some(
    (manager) =>
      manager.account_id === account_id && manager.role === "manager",
  )
    ? "manager"
    : "viewer";
  return { ...overview, viewer_role };
}

async function assertSiteLicenseManager({
  account_id,
  site_license_id,
  write = false,
  client,
}: {
  account_id: string;
  site_license_id: string;
  write?: boolean;
  client?: PoolClient;
}): Promise<void> {
  await ensureSiteLicenseSchema(client);
  if (await isAdmin(account_id)) {
    return;
  }
  const allowedRoles: SiteLicenseManagerRole[] = write
    ? ["manager"]
    : ["manager", "viewer"];
  const { rows } = await getQueryClient(client).query(
    `SELECT 1
     FROM site_license_managers
     WHERE site_license_id=$1
       AND account_id=$2
       AND role = ANY($3)
       AND revoked_at IS NULL
     LIMIT 1`,
    [site_license_id, account_id, allowedRoles],
  );
  if (rows[0]) {
    return;
  }
  if (!write) {
    const { rows: ownerRows } = await getQueryClient(client).query(
      `SELECT 1
         FROM site_licenses
        WHERE id=$1
          AND owner_account_id=$2
        LIMIT 1`,
      [site_license_id, account_id],
    );
    if (ownerRows[0]) {
      return;
    }
  }
  throw Error(write ? "must manage site license" : "must view site license");
}

async function assertSiteLicenseAdmin({
  account_id,
}: {
  account_id: string;
}): Promise<void> {
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
}

async function listSiteLicensePoolRequests({
  site_license_id,
  states,
  client,
}: {
  site_license_id: string;
  states?: SiteLicensePoolRequestState[];
  client?: PoolClient;
}): Promise<SiteLicensePoolRequest[]> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(
    client,
  ).query<RawSiteLicensePoolRequest>(
    `SELECT *
     FROM site_license_pool_requests
     WHERE site_license_id=$1
       AND ($2::text[] IS NULL OR state = ANY($2::text[]))
     ORDER BY requested_at DESC, created DESC`,
    [site_license_id, states ?? null],
  );
  return rows
    .map((row) => normalizeSiteLicensePoolRequestRow(row))
    .filter((row): row is SiteLicensePoolRequest => !!row);
}

async function getRequestById(
  request_id: string,
  client?: PoolClient,
): Promise<SiteLicensePoolRequest> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(
    client,
  ).query<RawSiteLicensePoolRequest>(
    `SELECT *
     FROM site_license_pool_requests
     WHERE id=$1`,
    [request_id],
  );
  const request = normalizeSiteLicensePoolRequestRow(rows[0]);
  if (!request) {
    throw Error("site-license request not found");
  }
  return request;
}

async function countPendingRequestsByPackage({
  site_license_id,
  client,
}: {
  site_license_id: string;
  client?: PoolClient;
}): Promise<Map<string, number>> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(client).query<{
    package_id: string;
    count: number;
  }>(
    `SELECT package_id, COUNT(*)::int AS count
     FROM site_license_pool_requests
     WHERE site_license_id=$1
       AND state='pending'
     GROUP BY package_id`,
    [site_license_id],
  );
  return new Map(rows.map((row) => [row.package_id, Number(row.count)]));
}

async function listSiteLicensePackageIdsByExclusiveGroup({
  site_license_id,
  exclusive_group,
  client,
}: {
  site_license_id: string;
  exclusive_group: string;
  client?: PoolClient;
}): Promise<string[]> {
  const { rows } = await getQueryClient(client).query<{
    id: string;
    membership_class: string;
    metadata?: Record<string, unknown> | null;
  }>(
    `SELECT id, membership_class, metadata
     FROM membership_packages
     WHERE metadata->>'site_license_id'=$1`,
    [site_license_id],
  );
  const ids = rows
    .filter(
      (row) =>
        getPackageExclusiveGroup({
          membership_class: row.membership_class,
          metadata: row.metadata,
        }) === exclusive_group,
    )
    .map((row) => row.id);
  return ids.length === 0 ? [] : ids;
}

async function listSiteLicensePackageDetails({
  site_license_id,
  client,
}: {
  site_license_id: string;
  client?: PoolClient;
}): Promise<MembershipPackageDetails[]> {
  const { rows } = await getQueryClient(client).query<{
    id: string;
    owner_account_id: string;
    kind: string;
    membership_class: string;
    seat_count: number | string;
    purchase_id?: number | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
    created?: Date | string;
    updated?: Date | string;
  }>(
    `SELECT id, owner_account_id, kind, membership_class, seat_count,
            purchase_id, starts_at, expires_at, metadata, created, updated
       FROM membership_packages
      WHERE kind='site'
        AND metadata->>'site_license_id'=$1
      ORDER BY created ASC`,
    [site_license_id],
  );
  const details: MembershipPackageDetails[] = [];
  for (const row of rows) {
    const assignments = await listMembershipPackageAssignments({
      package_id: row.id,
      include_revoked: true,
      client,
    });
    const active_assignment_count = assignments.filter(
      (assignment) => assignment.revoked_at == null,
    ).length;
    const seat_count = Number(row.seat_count);
    details.push({
      id: row.id,
      owner_account_id: row.owner_account_id,
      kind: "site",
      membership_class: row.membership_class,
      seat_count,
      purchase_id: row.purchase_id ?? null,
      starts_at: asDate(row.starts_at) ?? undefined,
      expires_at: asDate(row.expires_at),
      metadata: normalizeMetadata(row.metadata),
      created: asDate(row.created) ?? undefined,
      updated: asDate(row.updated) ?? undefined,
      assignments,
      active_assignment_count,
      available_seat_count: Math.max(0, seat_count - active_assignment_count),
    });
  }
  return details;
}

async function listSiteLicensePoolSummaries({
  site_license,
  client,
}: {
  site_license: SiteLicenseRecord;
  client?: PoolClient;
}): Promise<SiteLicensePoolSummary[]> {
  const details = await listSiteLicensePackageDetails({
    site_license_id: site_license.id,
    client,
  });
  const pendingCounts = await countPendingRequestsByPackage({
    site_license_id: site_license.id,
    client,
  });
  return details
    .filter((pkg) => pkg.metadata?.site_license_id === site_license.id)
    .filter((pkg) => pkg.metadata?.archived_at == null)
    .map((pkg) => ({
      ...pkg,
      pool_name: getPackagePoolName(pkg),
      pool_description: normalizeOptionalString(pkg.metadata?.pool_description),
      requires_approval: pkg.metadata?.requires_approval === true,
      verification_policy: getPackageVerificationPolicy(pkg.metadata),
      exclusive_group: getPackageExclusiveGroup(pkg),
      affiliation_reverification_days: normalizeOptionalPositiveInt(
        pkg.metadata?.affiliation_reverification_days,
      ),
      affiliation_reverification_grace_days: normalizeOptionalPositiveInt(
        pkg.metadata?.affiliation_reverification_grace_days,
      ),
      pending_request_count: pendingCounts.get(pkg.id) ?? 0,
    }));
}

async function listSiteLicenseAffiliationReverificationSeatsForSiteLicense({
  site_license,
  states,
  now,
  client,
}: {
  site_license: SiteLicenseRecord;
  states?: SiteLicenseAffiliationReverificationState[];
  now: Date;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const pools = await listSiteLicensePoolSummaries({
    site_license,
    client,
  });
  const stateSet = states == null ? undefined : new Set(states);
  const seats: SiteLicenseAffiliationReverificationSeat[] = [];
  for (const pool of pools) {
    for (const assignment of pool.assignments) {
      if (assignment.revoked_at != null || !assignment.account_id) {
        continue;
      }
      const seat = toAffiliationReverificationSeat({
        site_license_id: site_license.id,
        pool,
        assignment,
        now,
      });
      if (stateSet != null && !stateSet.has(seat.state)) {
        continue;
      }
      seats.push(seat);
    }
  }
  return sortAffiliationReverificationSeats(seats);
}

function sortAffiliationReverificationSeats(
  seats: SiteLicenseAffiliationReverificationSeat[],
): SiteLicenseAffiliationReverificationSeat[] {
  return seats.sort((left, right) => {
    const stateOrder: Record<
      SiteLicenseAffiliationReverificationState,
      number
    > = {
      grace_expired: 0,
      pending_reverification: 1,
      current: 2,
    };
    return (
      stateOrder[left.state] - stateOrder[right.state] ||
      (left.reverification_due_at?.getTime() ?? 0) -
        (right.reverification_due_at?.getTime() ?? 0) ||
      left.account_id.localeCompare(right.account_id)
    );
  });
}

export async function listSiteLicenseAffiliationReverificationSeats({
  account_id,
  site_license_id,
  states,
  now = new Date(),
  client,
}: {
  account_id: string;
  site_license_id: string;
  states?: SiteLicenseAffiliationReverificationState[];
  now?: Date;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const normalizedAccountId = normalizeAccountId(account_id);
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  await assertSiteLicenseManager({
    account_id: normalizedAccountId,
    site_license_id: normalizedSiteLicenseId,
    client,
  });
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId, client);
  return await listSiteLicenseAffiliationReverificationSeatsForSiteLicense({
    site_license: siteLicense,
    states,
    now,
    client,
  });
}

export async function getSiteLicenseAffiliationReverificationStatusForAccount({
  account_id,
  now = new Date(),
  client,
}: {
  account_id: string;
  now?: Date;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationUserStatus> {
  const accountId = normalizeAccountId(account_id);
  const grants = await listActiveMembershipGrantsForAccount(accountId, client);
  const seats = sortAffiliationReverificationSeats(
    grants
      .filter((grant) => grant.source === "site-license")
      .map((grant) => toUserAffiliationReverificationSeat({ grant, now }))
      .filter(
        (seat): seat is SiteLicenseAffiliationReverificationUserSeat =>
          seat != null && seat.reverification_days != null,
      ),
  ) as SiteLicenseAffiliationReverificationUserSeat[];
  return buildUserAffiliationReverificationStatus(seats);
}

export async function refreshSiteLicenseAffiliationVerificationForAccount({
  account_id,
  site_license_id,
  now = new Date(),
  client,
}: {
  account_id: string;
  site_license_id: string;
  now?: Date;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const accountId = normalizeAccountId(account_id);
  const verifiedEmailAddresses = await getVerifiedEmailAddressesForAccount(
    accountId,
    client,
  );
  return await refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay(
    {
      account_id: accountId,
      site_license_id,
      verified_email_addresses: verifiedEmailAddresses,
      now,
      client,
    },
  );
}

export async function refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay({
  account_id,
  site_license_id,
  verified_email_addresses,
  now = new Date(),
  client,
}: {
  account_id: string;
  site_license_id: string;
  verified_email_addresses: string[];
  now?: Date;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const accountId = normalizeAccountId(account_id);
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  const verifiedEmailAddresses = Array.from(
    new Set(
      verified_email_addresses
        .map((email) => normalizeEmailAddress(email))
        .filter((email): email is string => !!email),
    ),
  );
  if (verifiedEmailAddresses.length === 0) {
    return [];
  }
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId, client);
  const refreshWithClient = async (
    dbClient: PoolClient,
  ): Promise<SiteLicenseAffiliationReverificationSeat[]> => {
    const refreshed: SiteLicenseAffiliationReverificationSeat[] = [];
    const pools = await listSiteLicensePoolSummaries({
      site_license: siteLicense,
      client: dbClient,
    });
    for (const pool of pools) {
      const matchedEmailAddress = findOptionalMatchingVerifiedEmail({
        verified_email_addresses: verifiedEmailAddresses,
        allowed_domains: getPackageAllowedDomains(pool.metadata),
      });
      if (matchedEmailAddress == null) {
        continue;
      }
      for (const assignment of pool.assignments) {
        if (
          assignment.revoked_at != null ||
          assignment.account_id !== accountId
        ) {
          continue;
        }
        const previousSeat = toAffiliationReverificationSeat({
          site_license_id: normalizedSiteLicenseId,
          pool,
          assignment,
          now,
        });
        if (previousSeat.verification_policy !== "email-domain") {
          continue;
        }
        const nextMetadata = {
          ...normalizeMetadata(assignment.metadata),
          site_license_id: normalizedSiteLicenseId,
          site_license_name: siteLicense.name,
          organization_name: siteLicense.organization_name,
          site_license_bay_id: siteLicense.bay_id,
          site_license_owner_account_id: siteLicense.owner_account_id ?? null,
          pool_name: pool.pool_name ?? null,
          verification_policy: "email-domain",
          exclusive_group: previousSeat.exclusive_group,
          affiliation_reverification_days: pool.affiliation_reverification_days,
          affiliation_reverification_grace_days:
            pool.affiliation_reverification_grace_days,
          matched_email_address: matchedEmailAddress,
          affiliation_verified_at: now.toISOString(),
          affiliation_reverified_at: now.toISOString(),
        };
        const { rows } = await dbClient.query<{
          metadata?: Record<string, unknown> | null;
        }>(
          `UPDATE membership_package_assignments
              SET metadata=$4::jsonb,
                  updated=NOW()
            WHERE id=$1
              AND package_id=$2
              AND account_id=$3
              AND revoked_at IS NULL
            RETURNING metadata`,
          [assignment.id, pool.id, accountId, nextMetadata],
        );
        if (rows.length === 0) {
          continue;
        }
        if (assignment.grant_id) {
          await queueMembershipGrantSyncEffect({
            owner_account_id: pool.owner_account_id,
            package_id: pool.id,
            assignment_id: assignment.id,
            desired_payload: {
              desired_state: "active",
              grant: {
                id: assignment.grant_id,
                account_id: accountId,
                membership_class: pool.membership_class,
                source: assignment.grant_source ?? "site-license",
                package_id: pool.id,
                purchase_id: assignment.grant_purchase_id ?? null,
                granted_by_account_id:
                  assignment.assigned_by_account_id ?? null,
                starts_at: pool.starts_at ?? null,
                expires_at: pool.expires_at ?? null,
                metadata: {
                  ...nextMetadata,
                  assignment_id: assignment.id,
                },
              },
            },
            client: dbClient,
          });
        }
        await recordSiteLicenseAuditEvent({
          site_license_id: normalizedSiteLicenseId,
          action: "seat-affiliation-reverified",
          actor_account_id: accountId,
          target_account_id: accountId,
          package_id: pool.id,
          metadata: {
            assignment_id: assignment.id,
            pool_name: pool.pool_name ?? null,
            membership_class: pool.membership_class,
            exclusive_group: previousSeat.exclusive_group,
            verification_policy: previousSeat.verification_policy,
            previous_state: previousSeat.state,
            previous_matched_email_address:
              previousSeat.matched_email_address ?? null,
            matched_email_address: matchedEmailAddress,
            previous_affiliation_verified_at:
              previousSeat.affiliation_verified_at?.toISOString() ?? null,
            affiliation_verified_at: now.toISOString(),
          },
          client: dbClient,
        });
        refreshed.push(
          toAffiliationReverificationSeat({
            site_license_id: normalizedSiteLicenseId,
            pool,
            assignment: {
              ...assignment,
              metadata: normalizeMetadata(rows[0].metadata),
            },
            now,
          }),
        );
      }
    }
    return refreshed;
  };
  if (client != null) {
    return await refreshWithClient(client);
  }
  return await withLocalSiteLicenseTransaction(refreshWithClient);
}

export async function releaseGraceExpiredSiteLicenseAffiliationSeats({
  account_id,
  site_license_id,
  now = new Date(),
  limit = 100,
  client,
}: {
  account_id: string;
  site_license_id: string;
  now?: Date;
  limit?: number;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const normalizedAccountId = normalizeAccountId(account_id);
  return await releaseGraceExpiredSiteLicenseAffiliationSeatsInternal({
    actor_account_id: normalizedAccountId,
    site_license_id,
    now,
    limit,
    require_manager: true,
    client,
  });
}

export async function releaseGraceExpiredSiteLicenseAffiliationSeatsForSystem({
  site_license_id,
  now = new Date(),
  limit = 100,
  client,
}: {
  site_license_id: string;
  now?: Date;
  limit?: number;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  return await releaseGraceExpiredSiteLicenseAffiliationSeatsInternal({
    actor_account_id: null,
    site_license_id,
    now,
    limit,
    require_manager: false,
    audit_metadata: {
      released_by: "site-license-affiliation-maintenance",
    },
    client,
  });
}

async function releaseGraceExpiredSiteLicenseAffiliationSeatsInternal({
  actor_account_id,
  site_license_id,
  now,
  limit,
  require_manager,
  audit_metadata,
  client,
}: {
  actor_account_id?: string | null;
  site_license_id: string;
  now: Date;
  limit: number;
  require_manager: boolean;
  audit_metadata?: Record<string, unknown> | null;
  client?: PoolClient;
}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId, client);
  const releaseLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const releaseWithClient = async (
    dbClient: PoolClient,
  ): Promise<SiteLicenseAffiliationReverificationSeat[]> => {
    if (require_manager) {
      await assertSiteLicenseManager({
        account_id: normalizeAccountId(actor_account_id, "actor_account_id"),
        site_license_id: normalizedSiteLicenseId,
        write: true,
        client: dbClient,
      });
    }
    const expired =
      await listSiteLicenseAffiliationReverificationSeatsForSiteLicense({
        site_license: siteLicense,
        states: ["grace_expired"],
        now,
        client: dbClient,
      });
    const released: SiteLicenseAffiliationReverificationSeat[] = [];
    for (const seat of expired.slice(0, releaseLimit)) {
      const revoked = await revokeMembershipPackageSeat(
        {
          package_id: seat.package_id,
          account_id: seat.account_id,
        },
        dbClient,
      );
      if (!revoked) {
        continue;
      }
      await recordSiteLicenseAuditEvent({
        site_license_id: normalizedSiteLicenseId,
        action: "seat-released-after-reverification-grace",
        actor_account_id: actor_account_id ?? null,
        target_account_id: seat.account_id,
        package_id: seat.package_id,
        metadata: {
          ...normalizeMetadata(audit_metadata),
          assignment_id: seat.assignment_id,
          pool_name: seat.pool_name ?? null,
          membership_class: seat.membership_class,
          exclusive_group: seat.exclusive_group,
          verification_policy: seat.verification_policy,
          matched_email_address: seat.matched_email_address ?? null,
          affiliation_verified_at:
            seat.affiliation_verified_at?.toISOString() ?? null,
          reverification_due_at:
            seat.reverification_due_at?.toISOString() ?? null,
          reverification_grace_expires_at:
            seat.reverification_grace_expires_at?.toISOString() ?? null,
          released_at: now.toISOString(),
        },
        client: dbClient,
      });
      released.push(seat);
    }
    return released;
  };
  if (client != null) {
    return await releaseWithClient(client);
  }
  return await withLocalSiteLicenseTransaction(releaseWithClient);
}

export async function listSiteLicenseIdsWithAffiliationReverification({
  limit = 10_000,
  client,
}: {
  limit?: number;
  client?: PoolClient;
} = {}): Promise<string[]> {
  await ensureSiteLicenseSchema(client);
  const { rows } = await getQueryClient(client).query<{ id: string }>(
    `SELECT s.id
       FROM site_licenses s
      WHERE (s.starts_at IS NULL OR s.starts_at <= NOW())
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
        AND EXISTS (
          SELECT 1
            FROM membership_packages p
           WHERE p.kind='site'
             AND p.metadata->>'site_license_id'=s.id::text
             AND p.metadata->>'affiliation_reverification_days' IS NOT NULL
             AND (p.starts_at IS NULL OR p.starts_at <= NOW())
             AND (p.expires_at IS NULL OR p.expires_at > NOW())
        )
      ORDER BY s.id
      LIMIT $1`,
    [Math.max(1, Math.min(100_000, Math.floor(limit)))],
  );
  return rows.map((row) => row.id);
}

export async function getSiteLicenseOverview({
  account_id,
  site_license_id,
  client,
}: {
  account_id: string;
  site_license_id: string;
  client?: PoolClient;
}): Promise<SiteLicenseOverview> {
  const normalizedAccountId = normalizeAccountId(account_id);
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  const admin = await isAdmin(normalizedAccountId);
  await assertSiteLicenseManager({
    account_id: normalizedAccountId,
    site_license_id: normalizedSiteLicenseId,
    client,
  });
  const overview = await getSiteLicenseOverviewWithoutAuthorization({
    site_license_id: normalizedSiteLicenseId,
    client,
  });
  return addSiteLicenseViewerRole({
    account_id: normalizedAccountId,
    admin,
    overview,
  });
}

export async function listSiteLicenseOverviews({
  account_id,
  admin = false,
  trusted_admin = false,
  client,
}: {
  account_id: string;
  admin?: boolean;
  trusted_admin?: boolean;
  client?: PoolClient;
}): Promise<SiteLicenseOverview[]> {
  const normalizedAccountId = normalizeAccountId(account_id);
  await ensureSiteLicenseSchema(client);
  const queryClient = getQueryClient(client);
  const rows = admin
    ? await (async () => {
        if (!trusted_admin && !(await isAdmin(normalizedAccountId))) {
          throw Error("must be an admin");
        }
        const { rows } = await queryClient.query<{ id: string }>(
          `SELECT id
             FROM site_licenses
            ORDER BY updated DESC, created DESC, name ASC`,
        );
        return rows;
      })()
    : await (async () => {
        const { rows } = await queryClient.query<{ id: string }>(
          `SELECT s.id
             FROM site_licenses s
            WHERE s.owner_account_id = $1
               OR EXISTS (
              SELECT 1
                FROM site_license_managers m
               WHERE m.site_license_id = s.id
                 AND m.account_id = $1
                 AND m.revoked_at IS NULL
            )
            ORDER BY s.updated DESC, s.created DESC, s.name ASC`,
          [normalizedAccountId],
        );
        return rows;
      })();
  const overviews = await Promise.all(
    rows.map((row) =>
      getSiteLicenseOverviewWithoutAuthorization({
        site_license_id: row.id,
        client,
      }),
    ),
  );
  return overviews.map((overview) =>
    addSiteLicenseViewerRole({
      account_id: normalizedAccountId,
      admin,
      overview,
    }),
  );
}

export async function revokeSiteLicensePoolSeat({
  actor_account_id,
  package_id,
  target_account_id,
  target_email_address,
  trusted_admin = false,
  client,
}: {
  actor_account_id: string;
  package_id: string;
  target_account_id?: string;
  target_email_address?: string;
  trusted_admin?: boolean;
  client?: PoolClient;
}): Promise<boolean> {
  const actorAccountId = normalizeAccountId(
    actor_account_id,
    "actor_account_id",
  );
  const packageId = normalizePackageId(package_id);
  const targetAccountId =
    target_account_id == null || `${target_account_id}`.trim() === ""
      ? undefined
      : normalizeAccountId(target_account_id, "target_account_id");
  const targetEmailAddress =
    target_email_address == null || `${target_email_address}`.trim() === ""
      ? undefined
      : normalizeEmailAddress(target_email_address);
  if (!targetAccountId && !targetEmailAddress) {
    throw Error("target_account_id or target_email_address required");
  }
  if (targetAccountId && targetEmailAddress) {
    throw Error("specify only one target");
  }

  const revokeWithClient = async (dbClient: PoolClient): Promise<boolean> => {
    const { siteLicense } = await getSiteLicenseForPackage(packageId, dbClient);
    if (!trusted_admin) {
      await assertSiteLicenseManager({
        account_id: actorAccountId,
        site_license_id: siteLicense.id,
        write: true,
        client: dbClient,
      });
    }
    return await revokeMembershipPackageSeat(
      {
        package_id: packageId,
        account_id: targetAccountId,
        email_address: targetEmailAddress,
      },
      dbClient,
    );
  };

  if (client != null) {
    return await revokeWithClient(client);
  }
  return await withLocalSiteLicenseTransaction(revokeWithClient);
}

export async function releaseSiteLicensePoolSeat({
  account_id,
  package_id,
  client,
}: {
  account_id: string;
  package_id: string;
  client?: PoolClient;
}): Promise<boolean> {
  const accountId = normalizeAccountId(account_id);
  const packageId = normalizePackageId(package_id);
  const releaseWithClient = async (dbClient: PoolClient): Promise<boolean> => {
    const { siteLicense } = await getSiteLicenseForPackage(packageId, dbClient);
    const assignments = await listMembershipPackageAssignments({
      package_id: packageId,
      include_revoked: false,
      client: dbClient,
    });
    const assignment = assignments.find((row) => row.account_id === accountId);
    if (!assignment) {
      return false;
    }
    const revoked = await revokeMembershipPackageSeat(
      {
        package_id: packageId,
        account_id: accountId,
      },
      dbClient,
    );
    if (revoked) {
      await recordSiteLicenseAuditEvent({
        site_license_id: siteLicense.id,
        action: "seat-released-by-user",
        actor_account_id: accountId,
        target_account_id: accountId,
        package_id: packageId,
        metadata: {
          assignment_id: assignment.id,
        },
        client: dbClient,
      });
    }
    return revoked;
  };

  if (client != null) {
    return await releaseWithClient(client);
  }
  return await withLocalSiteLicenseTransaction(releaseWithClient);
}

export async function cancelSiteLicensePoolRequest({
  account_id,
  request_id,
  client,
}: {
  account_id: string;
  request_id: string;
  client?: PoolClient;
}): Promise<SiteLicensePoolRequest> {
  const accountId = normalizeAccountId(account_id);
  const requestId = normalizeAccountId(request_id, "request_id");
  const cancelWithClient = async (
    dbClient: PoolClient,
  ): Promise<SiteLicensePoolRequest> => {
    const { rows } = await dbClient.query<RawSiteLicensePoolRequest>(
      `SELECT *
         FROM site_license_pool_requests
        WHERE id=$1
        FOR UPDATE`,
      [requestId],
    );
    const request = normalizeSiteLicensePoolRequestRow(rows[0]);
    if (!request) {
      throw Error("site-license request not found");
    }
    if (request.account_id !== accountId) {
      throw Error("can only cancel your own site-license request");
    }
    if (request.state !== "pending") {
      throw Error(`request is not pending (state=${request.state})`);
    }
    const { siteLicense } = await getSiteLicenseForPackage(
      request.package_id,
      dbClient,
    );
    const canceled = await updateRequestState({
      request_id: request.id,
      state: "canceled",
      reviewer_account_id: accountId,
      review_note: "Canceled by requester.",
      metadata: request.metadata,
      client: dbClient,
    });
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicense.id,
      action: "pool-request-canceled",
      actor_account_id: accountId,
      target_account_id: accountId,
      package_id: request.package_id,
      request_id: request.id,
      metadata: {
        reason: "requester-canceled",
      },
      client: dbClient,
    });
    return canceled;
  };

  if (client != null) {
    return await cancelWithClient(client);
  }
  return await withLocalSiteLicenseTransaction(cancelWithClient);
}

async function getSiteLicenseOverviewWithoutAuthorization({
  site_license_id,
  client,
}: {
  site_license_id: string;
  client?: PoolClient;
}): Promise<SiteLicenseOverview> {
  const normalizedSiteLicenseId = normalizeAccountId(
    site_license_id,
    "site_license_id",
  );
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId, client);
  const [managers, pools, pending_requests, recent_audit_events] =
    await Promise.all([
      listSiteLicenseManagers(normalizedSiteLicenseId, client),
      listSiteLicensePoolSummaries({ site_license: siteLicense, client }),
      listSiteLicensePoolRequests({
        site_license_id: normalizedSiteLicenseId,
        states: ["pending"],
        client,
      }),
      listSiteLicenseAuditEvents({
        site_license_id: normalizedSiteLicenseId,
        client,
      }),
    ]);
  return {
    site_license: siteLicense,
    pools,
    managers,
    pending_requests,
    recent_audit_events,
  };
}

export async function adminProvisionSiteLicense({
  actor_account_id,
  owner_account_id,
  name,
  organization_name,
  allowed_domains,
  pools,
  custom_terms_url,
  custom_policy_url,
  terms_version_label,
  renewal_policy,
  overage_policy,
  starts_at,
  expires_at,
  metadata,
  trusted_admin = false,
}: {
  actor_account_id: string;
  owner_account_id?: string | null;
  name: string;
  organization_name: string;
  allowed_domains: string[];
  pools: SiteLicensePoolConfig[];
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  renewal_policy?: string | null;
  overage_policy?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  trusted_admin?: boolean;
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  if (!trusted_admin && !(await isAdmin(actorAccountId))) {
    throw Error("must be an admin");
  }
  const normalizedBayId = getSiteLicenseSeedBayId();
  // The seed bay stores the durable site-license record.  The owner is the
  // single billing/accountability account and future self-service purchaser;
  // delegated manager rows separately control operational approvals.
  const ownerAccountId =
    owner_account_id == null || `${owner_account_id}`.trim() === ""
      ? actorAccountId
      : normalizeAccountId(owner_account_id, "owner_account_id");
  const normalizedDomains = normalizeAllowedDomains(allowed_domains);
  const normalizedPools = normalizePools(pools, normalizedDomains);
  const indexedDomains = collectSiteLicenseDomains({
    allowed_domains: normalizedDomains,
    pools: normalizedPools,
  });
  const site_license_id = uuid();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureSiteLicenseSchema(client);
    await assertSiteLicensePoolMembershipClassesAvailable(
      normalizedPools,
      client,
    );
    await acquireSiteLicenseDomainWriteLock(client);
    await assertNoActiveSiteLicenseDomainIndexOverlap({
      domains: indexedDomains,
      site_license_id,
      starts_at,
      expires_at,
      client,
    });
    for (const pool of normalizedPools) {
      await assertNoActiveSiteLicenseDomainOverlap({
        allowed_domains: pool.allowed_domains,
        site_license_id,
        starts_at,
        expires_at,
        client,
      });
    }
    await client.query(
      `INSERT INTO site_licenses
           (id, name, organization_name, bay_id, owner_account_id, allowed_domains,
            custom_terms_url, custom_policy_url, terms_version_label,
            renewal_policy, overage_policy, starts_at, expires_at, metadata,
            created, updated)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,NOW(),NOW())`,
      [
        site_license_id,
        normalizeString(name, "name"),
        normalizeString(organization_name, "organization_name"),
        normalizedBayId,
        ownerAccountId,
        normalizedDomains,
        normalizeOptionalString(custom_terms_url),
        normalizeOptionalString(custom_policy_url),
        normalizeOptionalString(terms_version_label),
        normalizeOptionalString(renewal_policy),
        normalizeOptionalString(overage_policy),
        starts_at ?? null,
        expires_at ?? null,
        normalizeMetadata(metadata),
      ],
    );
    await upsertSiteLicenseDomainIndex({
      site_license_id,
      domains: indexedDomains,
      starts_at,
      expires_at,
      client,
    });
    await recordSiteLicenseAuditEvent({
      site_license_id,
      action: "site-license-provisioned",
      actor_account_id: actorAccountId,
      target_account_id: ownerAccountId,
      metadata: {
        name: normalizeString(name, "name"),
        organization_name: normalizeString(
          organization_name,
          "organization_name",
        ),
        bay_id: normalizedBayId,
        allowed_domains: normalizedDomains,
        pool_count: normalizedPools.length,
      },
      client,
    });
    for (const pool of normalizedPools) {
      const packageId = await createMembershipPackage(
        {
          owner_account_id: ownerAccountId,
          kind: "site",
          membership_class: pool.membership_class,
          seat_count: pool.seat_count,
          starts_at,
          expires_at,
          metadata: {
            ...normalizeMetadata(pool.metadata),
            site_license_id,
            site_license_bay_id: normalizedBayId,
            pool_name: pool.pool_name,
            pool_description: pool.pool_description,
            allowed_domains: pool.allowed_domains,
            requires_approval: pool.requires_approval,
            verification_policy: pool.verification_policy,
            exclusive_group: pool.exclusive_group,
            claim_scope_key: getClaimScopeKey(
              site_license_id,
              pool.exclusive_group,
            ),
            claim_scope_kind: "site-license-exclusive-group",
            affiliation_reverification_days:
              pool.affiliation_reverification_days,
            affiliation_reverification_grace_days:
              pool.affiliation_reverification_grace_days,
            provisioned_by_account_id: actorAccountId,
            provisioned_via: "site-license",
          },
        },
        client,
      );
      await recordSiteLicenseAuditEvent({
        site_license_id,
        action: "pool-created",
        actor_account_id: actorAccountId,
        target_account_id: ownerAccountId,
        package_id: packageId,
        metadata: {
          pool_name: pool.pool_name,
          pool_description: pool.pool_description,
          membership_class: pool.membership_class,
          seat_count: pool.seat_count,
          requires_approval: pool.requires_approval,
          verification_policy: pool.verification_policy,
          exclusive_group: pool.exclusive_group,
        },
        client,
      });
    }
    const overview = await getSiteLicenseOverviewWithoutAuthorization({
      site_license_id,
      client,
    });
    await client.query("COMMIT");
    return overview;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateSiteLicensePool({
  actor_account_id,
  package_id,
  pool_name,
  seat_count,
  pool_description,
  requires_approval,
  affiliation_reverification_days,
  affiliation_reverification_grace_days,
  expires_at,
  allowed_domains,
}: {
  actor_account_id: string;
  package_id: string;
  pool_name?: string;
  seat_count?: number;
  pool_description?: string | null;
  requires_approval?: boolean;
  affiliation_reverification_days?: number | null;
  affiliation_reverification_grace_days?: number | null;
  expires_at?: Date | string | null;
  allowed_domains?: string[];
}): Promise<MembershipPackageDetails> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const packageId = normalizePackageId(package_id);
  return await withLocalSiteLicenseTransaction(async (client) => {
    const { siteLicense, pkg } = await getSiteLicenseForPackage(
      packageId,
      client,
    );
    await assertSiteLicenseAdmin({ account_id: actorAccountId });
    const metadataPatch: Record<string, unknown> = {};
    if (pool_name !== undefined) {
      metadataPatch.pool_name = normalizeString(pool_name, "pool_name");
    }
    if (pool_description !== undefined) {
      metadataPatch.pool_description =
        normalizeOptionalString(pool_description);
    }
    if (requires_approval !== undefined) {
      metadataPatch.requires_approval = requires_approval === true;
    }
    if (affiliation_reverification_days !== undefined) {
      metadataPatch.affiliation_reverification_days =
        normalizeOptionalPositiveInt(affiliation_reverification_days);
    }
    if (affiliation_reverification_grace_days !== undefined) {
      metadataPatch.affiliation_reverification_grace_days =
        normalizeOptionalPositiveInt(affiliation_reverification_grace_days);
    }
    const hasMetadataPatch = Object.keys(metadataPatch).length > 0;
    const normalizedAllowedDomains =
      allowed_domains === undefined
        ? undefined
        : normalizeAllowedDomains(allowed_domains);
    const updated = await updateMembershipPackageRecord({
      package_id: packageId,
      seat_count,
      metadata_patch: hasMetadataPatch ? metadataPatch : undefined,
      assignment_metadata_patch: hasMetadataPatch ? metadataPatch : undefined,
      expires_at,
      allowed_domains: normalizedAllowedDomains,
      client,
    });
    if (allowed_domains !== undefined) {
      await rebuildSiteLicenseDomainIndex({
        site_license_id: siteLicense.id,
        client,
      });
    }
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicense.id,
      action: "pool-updated",
      actor_account_id: actorAccountId,
      package_id: packageId,
      metadata: {
        pool_name:
          typeof metadataPatch.pool_name === "string"
            ? metadataPatch.pool_name
            : getPackagePoolName(pkg),
        pool_description: metadataPatch.pool_description,
        seat_count: seat_count ?? null,
        requires_approval: metadataPatch.requires_approval,
        affiliation_reverification_days:
          metadataPatch.affiliation_reverification_days,
        affiliation_reverification_grace_days:
          metadataPatch.affiliation_reverification_grace_days,
        expires_at: expires_at ?? null,
        allowed_domains: normalizedAllowedDomains,
      },
      client,
    });
    return updated;
  });
}

export async function archiveSiteLicensePool({
  actor_account_id,
  package_id,
}: {
  actor_account_id: string;
  package_id: string;
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const packageId = normalizePackageId(package_id);
  return await withLocalSiteLicenseTransaction(async (client) => {
    const { siteLicense, pkg } = await getSiteLicenseForPackage(
      packageId,
      client,
    );
    await assertSiteLicenseAdmin({ account_id: actorAccountId });
    const assignments = await listMembershipPackageAssignments({
      package_id: packageId,
      include_revoked: true,
      client,
    });
    const activeAssignmentCount = assignments.filter(
      (assignment) => assignment.revoked_at == null,
    ).length;
    if (activeAssignmentCount > 0) {
      throw Error("cannot archive a pool with active seats");
    }
    const pendingRequests = await countPendingRequestsByPackage({
      site_license_id: siteLicense.id,
      client,
    });
    if ((pendingRequests.get(packageId) ?? 0) > 0) {
      throw Error("cannot archive a pool with pending requests");
    }
    const archivedAt = new Date();
    await updateMembershipPackageRecord({
      package_id: packageId,
      expires_at: archivedAt,
      metadata_patch: {
        archived_at: archivedAt.toISOString(),
        archived_by_account_id: actorAccountId,
      },
      client,
    });
    await rebuildSiteLicenseDomainIndex({
      site_license_id: siteLicense.id,
      client,
    });
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicense.id,
      action: "pool-archived",
      actor_account_id: actorAccountId,
      package_id: packageId,
      metadata: {
        pool_name: getPackagePoolName(pkg),
        membership_class: pkg.membership_class,
        seat_count: pkg.seat_count,
        active_assignment_count: activeAssignmentCount,
        historical_assignment_count: assignments.length,
        pending_request_count: pendingRequests.get(packageId) ?? 0,
        archived_at: archivedAt.toISOString(),
      },
      client,
    });
    return await getSiteLicenseOverviewWithoutAuthorization({
      site_license_id: siteLicense.id,
      client,
    });
  });
}

export async function addSiteLicensePool({
  actor_account_id,
  site_license_id,
  pool,
}: {
  actor_account_id: string;
  site_license_id: string;
  pool: SiteLicensePoolConfig;
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const siteLicenseId = normalizeAccountId(site_license_id, "site_license_id");
  return await withLocalSiteLicenseTransaction(async (client) => {
    const siteLicense = await getSiteLicense(siteLicenseId, client);
    await assertSiteLicenseAdmin({ account_id: actorAccountId });
    const [normalizedPool] = normalizePools(
      [pool],
      siteLicense.allowed_domains,
    );
    await assertSiteLicensePoolMembershipClassesAvailable(
      [normalizedPool],
      client,
    );
    const existingPools = await listSiteLicensePoolSummaries({
      site_license: siteLicense,
      client,
    });
    const indexedDomains = collectSiteLicenseDomains({
      allowed_domains: siteLicense.allowed_domains,
      pools: [
        ...existingPools.map((existingPool) => ({
          allowed_domains: getPackageAllowedDomains(existingPool.metadata),
        })),
        { allowed_domains: normalizedPool.allowed_domains },
      ],
    });
    await acquireSiteLicenseDomainWriteLock(client);
    await assertNoActiveSiteLicenseDomainIndexOverlap({
      domains: indexedDomains,
      site_license_id: siteLicenseId,
      starts_at: siteLicense.starts_at,
      expires_at: siteLicense.expires_at,
      client,
    });
    const packageId = await createMembershipPackage(
      {
        owner_account_id: siteLicense.owner_account_id ?? actorAccountId,
        kind: "site",
        membership_class: normalizedPool.membership_class,
        seat_count: normalizedPool.seat_count,
        starts_at: siteLicense.starts_at,
        expires_at: siteLicense.expires_at,
        metadata: {
          ...normalizeMetadata(normalizedPool.metadata),
          site_license_id: siteLicenseId,
          site_license_bay_id: siteLicense.bay_id,
          pool_name: normalizedPool.pool_name,
          pool_description: normalizedPool.pool_description,
          allowed_domains: normalizedPool.allowed_domains,
          requires_approval: normalizedPool.requires_approval,
          verification_policy: normalizedPool.verification_policy,
          exclusive_group: normalizedPool.exclusive_group,
          claim_scope_key: getClaimScopeKey(
            siteLicenseId,
            normalizedPool.exclusive_group,
          ),
          claim_scope_kind: "site-license-exclusive-group",
          affiliation_reverification_days:
            normalizedPool.affiliation_reverification_days,
          affiliation_reverification_grace_days:
            normalizedPool.affiliation_reverification_grace_days,
          provisioned_by_account_id: actorAccountId,
          provisioned_via: "site-license-pool-add",
        },
      },
      client,
    );
    await rebuildSiteLicenseDomainIndex({
      site_license_id: siteLicenseId,
      client,
    });
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicenseId,
      action: "pool-created",
      actor_account_id: actorAccountId,
      package_id: packageId,
      metadata: {
        pool_name: normalizedPool.pool_name,
        pool_description: normalizedPool.pool_description,
        membership_class: normalizedPool.membership_class,
        seat_count: normalizedPool.seat_count,
        requires_approval: normalizedPool.requires_approval,
        verification_policy: normalizedPool.verification_policy,
        exclusive_group: normalizedPool.exclusive_group,
        source: "add-site-license-pool",
      },
      client,
    });
    return await getSiteLicenseOverviewWithoutAuthorization({
      site_license_id: siteLicenseId,
      client,
    });
  });
}

export async function updateSiteLicense({
  actor_account_id,
  site_license_id,
  name,
  organization_name,
  allowed_domains,
  custom_terms_url,
  custom_policy_url,
  terms_version_label,
  renewal_policy,
  overage_policy,
  starts_at,
  expires_at,
}: {
  actor_account_id: string;
  site_license_id: string;
  name?: string;
  organization_name?: string;
  allowed_domains?: string[];
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  renewal_policy?: string | null;
  overage_policy?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const siteLicenseId = normalizeAccountId(site_license_id, "site_license_id");
  return await withLocalSiteLicenseTransaction(async (client) => {
    const current = await getSiteLicense(siteLicenseId, client);
    await assertSiteLicenseAdmin({ account_id: actorAccountId });
    const nextAllowedDomains =
      allowed_domains === undefined
        ? current.allowed_domains
        : normalizeAllowedDomains(allowed_domains);
    const nextStartsAt =
      starts_at === undefined ? current.starts_at : asDate(starts_at);
    const nextExpiresAt =
      expires_at === undefined ? current.expires_at : asDate(expires_at);
    if (
      allowed_domains !== undefined ||
      starts_at !== undefined ||
      expires_at !== undefined
    ) {
      const { rows } = await client.query<{
        metadata?: Record<string, unknown> | null;
      }>(
        `SELECT metadata
           FROM membership_packages
          WHERE kind='site'
            AND metadata->>'site_license_id'=$1
            AND (expires_at IS NULL OR expires_at > NOW())`,
        [siteLicenseId],
      );
      const domains = collectSiteLicenseDomains({
        allowed_domains: nextAllowedDomains,
        pools: rows.map((row) => ({
          allowed_domains: getPackageAllowedDomains(row.metadata),
        })),
      });
      await acquireSiteLicenseDomainWriteLock(client);
      await assertNoActiveSiteLicenseDomainIndexOverlap({
        domains,
        site_license_id: siteLicenseId,
        starts_at: nextStartsAt,
        expires_at: nextExpiresAt,
        client,
      });
    }
    await client.query(
      `UPDATE site_licenses
          SET name=$2,
              organization_name=$3,
              allowed_domains=$4,
              custom_terms_url=$5,
              custom_policy_url=$6,
              terms_version_label=$7,
              renewal_policy=$8,
              overage_policy=$9,
              starts_at=$10,
              expires_at=$11,
              updated=NOW()
        WHERE id=$1`,
      [
        siteLicenseId,
        name === undefined ? current.name : normalizeString(name, "name"),
        organization_name === undefined
          ? current.organization_name
          : normalizeString(organization_name, "organization_name"),
        nextAllowedDomains,
        custom_terms_url === undefined
          ? current.custom_terms_url
          : normalizeOptionalString(custom_terms_url),
        custom_policy_url === undefined
          ? current.custom_policy_url
          : normalizeOptionalString(custom_policy_url),
        terms_version_label === undefined
          ? current.terms_version_label
          : normalizeOptionalString(terms_version_label),
        renewal_policy === undefined
          ? current.renewal_policy
          : normalizeOptionalString(renewal_policy),
        overage_policy === undefined
          ? current.overage_policy
          : normalizeOptionalString(overage_policy),
        nextStartsAt,
        nextExpiresAt,
      ],
    );
    if (
      allowed_domains !== undefined ||
      starts_at !== undefined ||
      expires_at !== undefined
    ) {
      await rebuildSiteLicenseDomainIndex({
        site_license_id: siteLicenseId,
        client,
      });
    }
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicenseId,
      action: "site-license-updated",
      actor_account_id: actorAccountId,
      metadata: {
        fields: Object.entries({
          name,
          organization_name,
          allowed_domains,
          custom_terms_url,
          custom_policy_url,
          terms_version_label,
          renewal_policy,
          overage_policy,
          starts_at,
          expires_at,
        })
          .filter(([, value]) => value !== undefined)
          .map(([field]) => field),
      },
      client,
    });
    return await getSiteLicenseOverviewWithoutAuthorization({
      site_license_id: siteLicenseId,
      client,
    });
  });
}

async function assertTargetAccountExists(account_id: string): Promise<void> {
  const entries = await getClusterAccountsByIdsDirect([account_id]);
  if (!entries.some((entry) => entry.account_id === account_id)) {
    throw Error(`account ${account_id} not found`);
  }
}

export async function setSiteLicenseManager({
  actor_account_id,
  site_license_id,
  target_account_id,
  role,
}: {
  actor_account_id: string;
  site_license_id: string;
  target_account_id: string;
  role: SiteLicenseManagerRole;
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const siteLicenseId = normalizeAccountId(site_license_id, "site_license_id");
  const targetAccountId = normalizeAccountId(
    target_account_id,
    "target_account_id",
  );
  if (!SITE_LICENSE_MANAGER_ROLES.has(role)) {
    throw Error(`unsupported manager role '${role}'`);
  }
  await assertSiteLicenseAdmin({ account_id: actorAccountId });
  await assertTargetAccountExists(targetAccountId);
  return await withLocalSiteLicenseTransaction(async (client) => {
    const { rows } = await client.query<RawSiteLicenseManager>(
      `SELECT *
         FROM site_license_managers
        WHERE site_license_id=$1
          AND account_id=$2
          AND revoked_at IS NULL
        ORDER BY created DESC
        LIMIT 1`,
      [siteLicenseId, targetAccountId],
    );
    const existing = rows[0] ? normalizeSiteLicenseManagerRow(rows[0]) : null;
    if (existing) {
      await client.query(
        `UPDATE site_license_managers
            SET role=$3,
                updated=NOW()
          WHERE id=$1
            AND site_license_id=$2`,
        [existing.id, siteLicenseId, role],
      );
    } else {
      await client.query(
        `INSERT INTO site_license_managers
           (id, site_license_id, account_id, role, created_by_account_id,
            metadata, created, updated)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW(),NOW())`,
        [uuid(), siteLicenseId, targetAccountId, role, actorAccountId, {}],
      );
    }
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicenseId,
      action: existing ? "manager-updated" : "manager-added",
      actor_account_id: actorAccountId,
      target_account_id: targetAccountId,
      metadata: {
        role,
        previous_role: existing?.role ?? null,
      },
      client,
    });
    return await getSiteLicenseOverviewWithoutAuthorization({
      site_license_id: siteLicenseId,
      client,
    });
  });
}

export async function removeSiteLicenseManager({
  actor_account_id,
  site_license_id,
  target_account_id,
}: {
  actor_account_id: string;
  site_license_id: string;
  target_account_id: string;
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const siteLicenseId = normalizeAccountId(site_license_id, "site_license_id");
  const targetAccountId = normalizeAccountId(
    target_account_id,
    "target_account_id",
  );
  await assertSiteLicenseAdmin({ account_id: actorAccountId });
  return await withLocalSiteLicenseTransaction(async (client) => {
    const { rows } = await client.query<RawSiteLicenseManager>(
      `SELECT *
         FROM site_license_managers
        WHERE site_license_id=$1
          AND account_id=$2
          AND revoked_at IS NULL
        ORDER BY created DESC
        LIMIT 1`,
      [siteLicenseId, targetAccountId],
    );
    const existing = rows[0] ? normalizeSiteLicenseManagerRow(rows[0]) : null;
    if (!existing) {
      return await getSiteLicenseOverviewWithoutAuthorization({
        site_license_id: siteLicenseId,
        client,
      });
    }
    await client.query(
      `UPDATE site_license_managers
          SET revoked_at=NOW(),
              updated=NOW()
        WHERE id=$1
          AND site_license_id=$2`,
      [existing.id, siteLicenseId],
    );
    await recordSiteLicenseAuditEvent({
      site_license_id: siteLicenseId,
      action: "manager-removed",
      actor_account_id: actorAccountId,
      target_account_id: targetAccountId,
      metadata: { role: existing.role },
      client,
    });
    return await getSiteLicenseOverviewWithoutAuthorization({
      site_license_id: siteLicenseId,
      client,
    });
  });
}

function normalizePools(
  pools: SiteLicensePoolConfig[] | undefined,
  defaultAllowedDomains: string[],
): Array<
  SiteLicensePoolConfig & {
    allowed_domains: string[];
    pool_description: string | null;
    exclusive_group: string;
    affiliation_reverification_days: number | null;
    affiliation_reverification_grace_days: number | null;
  }
> {
  if (!Array.isArray(pools) || pools.length === 0) {
    throw Error("at least one site-license pool is required");
  }
  return pools.map((pool) => {
    const verification_policy = `${pool.verification_policy ?? "email-domain"}`;
    if (
      !SITE_LICENSE_VERIFICATION_POLICIES.has(
        verification_policy as SiteLicenseVerificationPolicy,
      )
    ) {
      throw Error(`unsupported verification policy '${verification_policy}'`);
    }
    return {
      ...pool,
      pool_name: normalizeString(pool.pool_name, "pool_name"),
      pool_description: normalizeOptionalString(pool.pool_description),
      membership_class: normalizeString(
        pool.membership_class,
        "membership_class",
      ),
      seat_count: normalizeSeatCount(pool.seat_count),
      requires_approval: pool.requires_approval === true,
      verification_policy: verification_policy as SiteLicenseVerificationPolicy,
      exclusive_group: normalizeExclusiveGroup(
        pool.exclusive_group,
        pool.membership_class,
      ),
      affiliation_reverification_days: normalizeOptionalPositiveInt(
        pool.affiliation_reverification_days,
      ),
      affiliation_reverification_grace_days: normalizeOptionalPositiveInt(
        pool.affiliation_reverification_grace_days,
      ),
      allowed_domains:
        pool.allowed_domains == null
          ? defaultAllowedDomains
          : normalizeAllowedDomains(pool.allowed_domains),
    };
  });
}

async function assertSiteLicensePoolMembershipClassesAvailable(
  pools: Array<{ membership_class: string }>,
  client: PoolClient,
): Promise<void> {
  const membershipClasses = Array.from(
    new Set(pools.map((pool) => pool.membership_class).filter(Boolean)),
  );
  if (membershipClasses.length === 0) {
    throw Error("at least one site-license pool membership tier is required");
  }
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM membership_tiers
      WHERE id = ANY($1::text[])
        AND NOT COALESCE(disabled, false)`,
    [membershipClasses],
  );
  const available = new Set(rows.map((row) => row.id));
  const missing = membershipClasses.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw Error(
      `site-license pool membership tier not found or disabled: ${missing.join(", ")}`,
    );
  }
}

export async function requestSiteLicensePool({
  account_id,
  package_id,
  requester_note,
  accepted_terms,
  client,
}: {
  account_id: string;
  package_id: string;
  requester_note?: string | null;
  accepted_terms?: boolean;
  client?: PoolClient;
}): Promise<SiteLicensePoolRequest> {
  const accountId = normalizeAccountId(account_id);
  const packageId = normalizePackageId(package_id);
  const verifiedEmailAddresses = await getVerifiedEmailAddressesForAccount(
    accountId,
    client,
  );
  return await requestSiteLicensePoolWithVerifiedEmailsOnLocalBay({
    account_id: accountId,
    package_id: packageId,
    verified_email_addresses: verifiedEmailAddresses,
    requester_note,
    accepted_terms,
    client,
  });
}

export async function requestSiteLicensePoolWithVerifiedEmailsOnLocalBay({
  account_id,
  package_id,
  verified_email_addresses,
  requester_note,
  accepted_terms,
  client,
}: {
  account_id: string;
  package_id: string;
  verified_email_addresses: string[];
  requester_note?: string | null;
  accepted_terms?: boolean;
  client?: PoolClient;
}): Promise<SiteLicensePoolRequest> {
  const accountId = normalizeAccountId(account_id);
  const packageId = normalizePackageId(package_id);
  const { siteLicense, pkg } = await getSiteLicenseForPackage(
    packageId,
    client,
  );
  if (pkg.metadata?.requires_approval !== true) {
    throw Error("this site-license pool does not require approval");
  }
  const matchedEmailAddress = findMatchingVerifiedEmail({
    verified_email_addresses,
    allowed_domains: getPackageAllowedDomains(pkg.metadata),
  });
  const canonicalIdentity =
    canonicalizeInstitutionalClaimEmail(matchedEmailAddress);
  const exclusiveGroup = getPackageExclusiveGroup(pkg);
  const scopeKey = getClaimScopeKey(siteLicense.id, exclusiveGroup);
  const activeClaim = await getMembershipClaimIdentity({
    scope_key: scopeKey,
    canonical_identity: canonicalIdentity,
  });
  if (activeClaim != null && activeClaim.account_id !== accountId) {
    throw Error("site-license pool already claimed for this identity");
  }
  const pool = getQueryClient(client);
  const existingAssignments = await listMembershipPackageAssignments({
    package_id: packageId,
    include_revoked: false,
    client,
  });
  if (
    existingAssignments.some(
      (assignment) => assignment.account_id === accountId,
    )
  ) {
    throw Error("account already has this site-license pool");
  }
  const existingSamePackageRequestRows =
    await pool.query<RawSiteLicensePoolRequest>(
      `SELECT *
         FROM site_license_pool_requests
        WHERE site_license_id=$1
          AND package_id=$2
          AND state='pending'
          AND account_id=$3
        ORDER BY requested_at DESC
        LIMIT 1`,
      [siteLicense.id, packageId, accountId],
    );
  const existingSamePackageRequest = normalizeSiteLicensePoolRequestRow(
    existingSamePackageRequestRows.rows[0],
  );
  if (existingSamePackageRequest) {
    return existingSamePackageRequest;
  }
  const exclusivePackageIds = await listSiteLicensePackageIdsByExclusiveGroup({
    site_license_id: siteLicense.id,
    exclusive_group: exclusiveGroup,
    client,
  });
  const existingRequestRows = await pool.query<RawSiteLicensePoolRequest>(
    `SELECT *
       FROM site_license_pool_requests
       WHERE site_license_id=$1
         AND package_id = ANY($2::uuid[])
         AND state = 'pending'
         AND canonical_identity=$3
         AND account_id <> $4
       ORDER BY requested_at DESC
       LIMIT 1`,
    [siteLicense.id, exclusivePackageIds, canonicalIdentity, accountId],
  );
  const existingRequest = normalizeSiteLicensePoolRequestRow(
    existingRequestRows.rows[0],
  );
  if (existingRequest) {
    throw Error("site-license pool request already exists");
  }
  const request_id = uuid();
  if (
    (siteLicense.custom_terms_url || siteLicense.custom_policy_url) &&
    accepted_terms !== true
  ) {
    throw Error("accept the site-license terms and policies before requesting");
  }
  const metadata = {
    accepted_terms: accepted_terms === true,
    custom_terms_url: siteLicense.custom_terms_url ?? null,
    custom_policy_url: siteLicense.custom_policy_url ?? null,
    terms_version_label: siteLicense.terms_version_label ?? null,
    terms_accepted_at:
      accepted_terms === true ? new Date().toISOString() : null,
  };
  const canceledRequests = await cancelPendingSiteLicensePoolRequestsForAccount(
    {
      site_license_id: siteLicense.id,
      account_id: accountId,
      reviewer_account_id: accountId,
      review_note: "Canceled by a replacement site-license pool request.",
      client: pool,
    },
  );
  await recordCanceledPoolRequests({
    site_license_id: siteLicense.id,
    actor_account_id: accountId,
    requests: canceledRequests,
    reason: "replacement-request",
    client: pool,
  });
  const { rows } = await pool.query<RawSiteLicensePoolRequest>(
    `INSERT INTO site_license_pool_requests
       (id, site_license_id, package_id, account_id, matched_email_address,
        canonical_identity, requested_membership_class, state, requester_note,
        requested_at, expires_at, metadata, created, updated)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,'pending',$8,NOW(),$9,$10::jsonb,NOW(),NOW())
     RETURNING *`,
    [
      request_id,
      siteLicense.id,
      packageId,
      accountId,
      matchedEmailAddress,
      canonicalIdentity,
      pkg.membership_class,
      normalizeOptionalString(requester_note),
      dayjs().add(30, "day").toDate(),
      metadata,
    ],
  );
  await recordSiteLicenseAuditEvent({
    site_license_id: siteLicense.id,
    action: "pool-request-created",
    actor_account_id: accountId,
    target_account_id: accountId,
    package_id: packageId,
    request_id,
    metadata: {
      matched_email_domain: matchedEmailAddress.split("@")[1] ?? "",
      canonical_identity: canonicalIdentity,
      requested_membership_class: pkg.membership_class,
      exclusive_group: exclusiveGroup,
      requester_note: normalizeOptionalString(requester_note),
    },
    client: pool,
  });
  const request = normalizeSiteLicensePoolRequestRow(rows[0])!;
  await notifySiteLicensePoolRequestCreatedBestEffort({
    siteLicense,
    pkg,
    request,
  });
  return request;
}

export async function reviewSiteLicensePoolRequest({
  actor_account_id,
  request_id,
  action,
  review_note,
}: {
  actor_account_id: string;
  request_id: string;
  action: "approve" | "reject";
  review_note?: string | null;
}): Promise<SiteLicensePoolRequest> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  const requestId = normalizeAccountId(request_id, "request_id");
  if (action !== "approve" && action !== "reject") {
    throw Error("action must be approve or reject");
  }
  let reservedInstitutionalClaim:
    | {
        scope_key: string;
        scope_kind: string;
        canonical_identity: string;
        account_id: string;
        matched_email_address: string;
        claimed_domain: string;
        reservation_id: string;
      }
    | undefined;
  try {
    const reviewed = await withSiteLicenseRequestTransaction({
      request_id: requestId,
      action: "review site-license pool request",
      fn: async ({ client, request, siteLicense, pkg }) => {
        await assertSiteLicenseManager({
          account_id: actorAccountId,
          site_license_id: siteLicense.id,
          write: true,
          client,
        });
        if (request.state !== "pending") {
          throw Error(`request is not pending (state=${request.state})`);
        }
        if (action === "reject") {
          const rejected = await updateRequestState({
            request_id: request.id,
            state: "rejected",
            reviewer_account_id: actorAccountId,
            review_note,
            client,
          });
          await recordSiteLicenseAuditEvent({
            site_license_id: siteLicense.id,
            action: "pool-request-rejected",
            actor_account_id: actorAccountId,
            target_account_id: request.account_id,
            package_id: request.package_id,
            request_id: request.id,
            metadata: {
              review_note: normalizeOptionalString(review_note),
            },
            client,
          });
          return rejected;
        }
        const claimedDomain = request.matched_email_address.split("@")[1] ?? "";
        const exclusiveGroup = getPackageExclusiveGroup(pkg);
        const releasedAssignments =
          await revokeOtherActiveSiteLicenseAssignmentsForAccount({
            site_license_id: siteLicense.id,
            keep_package_id: pkg.id,
            account_id: request.account_id,
            client,
          });
        const scope_key = getClaimScopeKey(siteLicense.id, exclusiveGroup);
        const scope_kind = "site-license-exclusive-group";
        const reserved = await reserveMembershipClaimIdentity({
          scope_key,
          scope_kind,
          canonical_identity: request.canonical_identity,
          account_id: request.account_id,
          reservation_id: uuid(),
          matched_email_address: request.matched_email_address,
          claimed_domain: claimedDomain,
          metadata: {
            site_license_id: siteLicense.id,
            package_id: pkg.id,
            request_id: request.id,
            exclusive_group: exclusiveGroup,
          },
          client,
        });
        reservedInstitutionalClaim = {
          scope_key,
          scope_kind,
          canonical_identity: request.canonical_identity,
          account_id: request.account_id,
          matched_email_address: request.matched_email_address,
          claimed_domain: claimedDomain,
          reservation_id: reserved.reservation_id,
        };
        const assignment = await assignMembershipPackageSeat(
          {
            package_id: pkg.id,
            account_id: request.account_id,
            email_address: request.matched_email_address,
            assigned_by_account_id: actorAccountId,
            metadata: {
              site_license_id: siteLicense.id,
              ...getSiteLicenseAffiliationMetadata({
                site_license_id: siteLicense.id,
                site_license: siteLicense,
                pkg,
                matched_email_address: request.matched_email_address,
                exclusive_group: exclusiveGroup,
              }),
              site_license_request_id: request.id,
              approved_by_account_id: actorAccountId,
              approved_at: new Date().toISOString(),
              claim_scope_key: scope_key,
              claim_scope_kind: scope_kind,
              claim_identity_key: request.canonical_identity,
              claim_reservation_id: reserved.reservation_id,
            },
          },
          client,
        );
        await queueMembershipClaimIdentitySyncEffect({
          owner_account_id: pkg.owner_account_id,
          package_id: pkg.id,
          assignment_id: assignment.id,
          desired_payload: {
            desired_state: "active",
            scope_key,
            scope_kind,
            canonical_identity: request.canonical_identity,
            reservation_id: reserved.reservation_id,
            account_id: request.account_id,
            package_id: pkg.id,
            assignment_id: assignment.id,
            grant_id: assignment.grant_id ?? null,
            matched_email_address: request.matched_email_address,
            claimed_domain: claimedDomain,
            metadata: {
              site_license_id: siteLicense.id,
              request_id: request.id,
              exclusive_group: exclusiveGroup,
            },
          },
          client,
        });
        await recordReleasedSeatsForSwitch({
          site_license_id: siteLicense.id,
          actor_account_id: actorAccountId,
          target_account_id: request.account_id,
          replacement_package_id: pkg.id,
          request_id: request.id,
          released_assignments: releasedAssignments,
          client,
        });
        const approved = await updateRequestState({
          request_id: request.id,
          state: "approved",
          reviewer_account_id: actorAccountId,
          review_note,
          metadata: {
            ...normalizeMetadata(request.metadata),
            assignment_id: assignment.id,
            grant_id: assignment.grant_id ?? null,
          },
          client,
        });
        await recordSiteLicenseAuditEvent({
          site_license_id: siteLicense.id,
          action: "pool-request-approved",
          actor_account_id: actorAccountId,
          target_account_id: request.account_id,
          package_id: pkg.id,
          request_id: request.id,
          metadata: {
            assignment_id: assignment.id,
            grant_id: assignment.grant_id ?? null,
            review_note: normalizeOptionalString(review_note),
            exclusive_group: exclusiveGroup,
          },
          client,
        });
        return approved;
      },
    });
    try {
      const { siteLicense, pkg } = await getSiteLicenseForPackage(
        reviewed.package_id,
      );
      await notifySiteLicensePoolRequestReviewedBestEffort({
        actor_account_id: actorAccountId,
        siteLicense,
        pkg,
        request: reviewed,
      });
    } catch (err) {
      logger.warn("failed to prepare site-license review notification", {
        request_id: reviewed.id,
        package_id: reviewed.package_id,
        error: `${(err as Error)?.message ?? err}`,
      });
    }
    return reviewed;
  } catch (err) {
    if (reservedInstitutionalClaim) {
      await revokeMembershipClaimIdentity({
        scope_key: reservedInstitutionalClaim.scope_key,
        canonical_identity: reservedInstitutionalClaim.canonical_identity,
        account_id: reservedInstitutionalClaim.account_id,
        assignment_id: requestId,
        reservation_id: reservedInstitutionalClaim.reservation_id,
      }).catch(() => undefined);
    }
    throw err;
  }
}

async function updateRequestState({
  request_id,
  state,
  reviewer_account_id,
  review_note,
  metadata,
  client,
}: {
  request_id: string;
  state: "approved" | "rejected" | "canceled";
  reviewer_account_id: string;
  review_note?: string | null;
  metadata?: Record<string, unknown> | null;
  client: PoolClient;
}): Promise<SiteLicensePoolRequest> {
  const { rows } = await client.query<RawSiteLicensePoolRequest>(
    `UPDATE site_license_pool_requests
     SET state=$2,
         reviewer_account_id=$3,
         review_note=$4,
         reviewed_at=NOW(),
         metadata=COALESCE($5::jsonb, metadata),
         updated=NOW()
     WHERE id=$1
     RETURNING *`,
    [
      request_id,
      state,
      reviewer_account_id,
      normalizeOptionalString(review_note),
      metadata ?? null,
    ],
  );
  return normalizeSiteLicensePoolRequestRow(rows[0])!;
}

async function recordCanceledPoolRequests({
  site_license_id,
  actor_account_id,
  requests,
  reason,
  client,
}: {
  site_license_id: string;
  actor_account_id: string;
  requests: SiteLicenseCanceledPoolRequest[];
  reason: string;
  client: Queryable;
}): Promise<void> {
  for (const request of requests) {
    await recordSiteLicenseAuditEvent({
      site_license_id,
      action: "pool-request-canceled",
      actor_account_id,
      target_account_id: actor_account_id,
      package_id: request.package_id,
      request_id: request.id,
      metadata: { reason },
      client,
    });
  }
}

async function recordReleasedSeatsForSwitch({
  site_license_id,
  actor_account_id,
  target_account_id,
  replacement_package_id,
  request_id,
  released_assignments,
  client,
}: {
  site_license_id: string;
  actor_account_id: string;
  target_account_id: string;
  replacement_package_id: string;
  request_id?: string;
  released_assignments: SiteLicenseAccountSeatChange[];
  client: PoolClient;
}): Promise<void> {
  for (const released of released_assignments) {
    await recordSiteLicenseAuditEvent({
      site_license_id,
      action: "seat-released-for-upgrade",
      actor_account_id,
      target_account_id,
      package_id: released.package_id,
      request_id: request_id ?? null,
      metadata: {
        assignment_id: released.assignment_id,
        replacement_package_id,
      },
      client,
    });
  }
}

async function withSiteLicenseRequestTransaction<T>({
  request_id,
  fn,
}: {
  request_id: string;
  action: string;
  fn: (opts: {
    client: PoolClient;
    request: SiteLicensePoolRequest;
    siteLicense: SiteLicenseRecord;
    pkg: NonNullable<Awaited<ReturnType<typeof getMembershipPackage>>>;
  }) => Promise<T>;
}): Promise<T> {
  const initialRequest = await getRequestById(request_id);
  const { siteLicense } = await getSiteLicenseForPackage(
    initialRequest.package_id,
  );
  return await withLocalSiteLicenseTransaction(async (client) => {
    const { rows } = await client.query<RawSiteLicensePoolRequest>(
      `SELECT *
           FROM site_license_pool_requests
           WHERE id=$1
           FOR UPDATE`,
      [request_id],
    );
    const request = normalizeSiteLicensePoolRequestRow(rows[0]);
    if (!request) {
      throw Error("site-license request not found");
    }
    const { pkg } = await getSiteLicenseForPackage(request.package_id, client);
    return await fn({ client, request, siteLicense, pkg });
  });
}
