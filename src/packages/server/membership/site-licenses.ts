/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import type {
  MembershipPackageDetails,
  SiteLicenseManager,
  SiteLicenseManagerRole,
  SiteLicenseOverview,
  SiteLicensePoolConfig,
  SiteLicensePoolRequest,
  SiteLicensePoolRequestState,
  SiteLicensePoolSummary,
  SiteLicenseRecord,
  SiteLicenseVerificationPolicy,
} from "@cocalc/conat/hub/api/purchases";
import {
  is_valid_email_address as isValidEmailAddress,
  isValidUUID,
  uuid,
} from "@cocalc/util/misc";
import {
  canonicalizeInstitutionalClaimEmail,
  reserveMembershipClaimIdentity,
  revokeMembershipClaimIdentity,
} from "./claim-directory";
import {
  assignMembershipPackageSeat,
  createMembershipPackage,
  getMembershipPackage,
  listMembershipPackageAssignments,
  listMembershipPackageDetailsForOwner,
  revokeMembershipPackageSeat,
} from "./packages";
import { queueMembershipClaimIdentitySyncEffect } from "./side-effects";

type Queryable = PoolClient | ReturnType<typeof getPool>;

interface RawSiteLicenseRecord {
  id: string;
  name: string;
  organization_name: string;
  owner_account_id: string;
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

const SITE_LICENSE_MANAGER_ROLES = new Set<SiteLicenseManagerRole>([
  "owner",
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

let schemaEnsured: Promise<void> | undefined;

function getQueryClient(client?: PoolClient): Queryable {
  return client ?? getPool();
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_licenses (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      owner_account_id UUID NOT NULL,
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
    "CREATE INDEX IF NOT EXISTS site_licenses_owner_account_id_idx ON site_licenses (owner_account_id)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS site_licenses_updated_idx ON site_licenses (updated)",
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
  pkg: MembershipPackageDetails,
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

function getClaimScopeKey(site_license_id: string): string {
  return `site-license:${site_license_id}`;
}

function normalizeSiteLicenseRow(
  row: RawSiteLicenseRecord | undefined,
): SiteLicenseRecord | undefined {
  if (!row) return;
  return {
    id: row.id,
    name: row.name,
    organization_name: row.organization_name,
    owner_account_id: row.owner_account_id,
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

async function getVerifiedEmailAddressesForAccount(
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
  const emails = Object.keys(verified)
    .map((email) => normalizeEmailAddress(email))
    .filter((email) => !!verified[email]);
  if (
    emails.length === 0 &&
    row.email_address &&
    verified?.[row.email_address] != null
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
  pkg: NonNullable<Awaited<ReturnType<typeof getMembershipPackage>>>;
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
    ? ["owner", "manager"]
    : ["owner", "manager", "viewer"];
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
  if (!rows[0]) {
    throw Error(write ? "must manage site license" : "must view site license");
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

async function listSiteLicensePoolSummaries({
  site_license,
  client,
}: {
  site_license: SiteLicenseRecord;
  client?: PoolClient;
}): Promise<SiteLicensePoolSummary[]> {
  const details = await listMembershipPackageDetailsForOwner({
    owner_account_id: site_license.owner_account_id,
    client,
  });
  const pendingCounts = await countPendingRequestsByPackage({
    site_license_id: site_license.id,
    client,
  });
  return details
    .filter((pkg) => pkg.metadata?.site_license_id === site_license.id)
    .map((pkg) => ({
      ...pkg,
      pool_name: getPackagePoolName(pkg),
      requires_approval: pkg.metadata?.requires_approval === true,
      verification_policy: getPackageVerificationPolicy(pkg.metadata),
      affiliation_reverification_days: normalizeOptionalPositiveInt(
        pkg.metadata?.affiliation_reverification_days,
      ),
      affiliation_reverification_grace_days: normalizeOptionalPositiveInt(
        pkg.metadata?.affiliation_reverification_grace_days,
      ),
      pending_request_count: pendingCounts.get(pkg.id) ?? 0,
    }));
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
  await assertSiteLicenseManager({
    account_id: normalizedAccountId,
    site_license_id: normalizedSiteLicenseId,
    client,
  });
  const siteLicense = await getSiteLicense(normalizedSiteLicenseId, client);
  const [managers, pools, pending_requests] = await Promise.all([
    listSiteLicenseManagers(normalizedSiteLicenseId, client),
    listSiteLicensePoolSummaries({ site_license: siteLicense, client }),
    listSiteLicensePoolRequests({
      site_license_id: normalizedSiteLicenseId,
      states: ["pending"],
      client,
    }),
  ]);
  return { site_license: siteLicense, pools, managers, pending_requests };
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
}: {
  actor_account_id: string;
  owner_account_id: string;
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
}): Promise<SiteLicenseOverview> {
  const actorAccountId = normalizeAccountId(actor_account_id);
  if (!(await isAdmin(actorAccountId))) {
    throw Error("must be an admin");
  }
  const ownerAccountId = normalizeAccountId(
    owner_account_id,
    "owner_account_id",
  );
  const normalizedDomains = normalizeAllowedDomains(allowed_domains);
  const normalizedPools = normalizePools(pools, normalizedDomains);
  const site_license_id = uuid();
  return await withAccountRehomeWriteFence({
    account_id: ownerAccountId,
    action: "provision site license",
    fn: async (db) => {
      const client = db as PoolClient;
      await ensureSiteLicenseSchema(client);
      await client.query(
        `INSERT INTO site_licenses
           (id, name, organization_name, owner_account_id, allowed_domains,
            custom_terms_url, custom_policy_url, terms_version_label,
            renewal_policy, overage_policy, starts_at, expires_at, metadata,
            created, updated)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW(),NOW())`,
        [
          site_license_id,
          normalizeString(name, "name"),
          normalizeString(organization_name, "organization_name"),
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
      await client.query(
        `INSERT INTO site_license_managers
           (id, site_license_id, account_id, role, created_by_account_id,
            metadata, created, updated)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW(),NOW())`,
        [
          uuid(),
          site_license_id,
          ownerAccountId,
          "owner",
          actorAccountId,
          { provisioned_by_account_id: actorAccountId },
        ],
      );
      for (const pool of normalizedPools) {
        await createMembershipPackage(
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
              pool_name: pool.pool_name,
              allowed_domains: pool.allowed_domains,
              requires_approval: pool.requires_approval,
              verification_policy: pool.verification_policy,
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
      }
      return await getSiteLicenseOverview({
        account_id: actorAccountId,
        site_license_id,
        client,
      });
    },
  });
}

function normalizePools(
  pools: SiteLicensePoolConfig[] | undefined,
  defaultAllowedDomains: string[],
): Array<
  SiteLicensePoolConfig & {
    allowed_domains: string[];
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
      membership_class: normalizeString(
        pool.membership_class,
        "membership_class",
      ),
      seat_count: normalizeSeatCount(pool.seat_count),
      requires_approval: pool.requires_approval === true,
      verification_policy: verification_policy as SiteLicenseVerificationPolicy,
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
  const { siteLicense, pkg } = await getSiteLicenseForPackage(
    packageId,
    client,
  );
  if (pkg.metadata?.requires_approval !== true) {
    throw Error("this site-license pool does not require approval");
  }
  const verifiedEmailAddresses = await getVerifiedEmailAddressesForAccount(
    accountId,
    client,
  );
  const matchedEmailAddress = findMatchingVerifiedEmail({
    verified_email_addresses: verifiedEmailAddresses,
    allowed_domains: getPackageAllowedDomains(pkg.metadata),
  });
  const canonicalIdentity =
    canonicalizeInstitutionalClaimEmail(matchedEmailAddress);
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
  const existingRequestRows = await pool.query<RawSiteLicensePoolRequest>(
    `SELECT *
       FROM site_license_pool_requests
       WHERE site_license_id=$1
         AND package_id=$2
         AND state IN ('pending', 'approved')
         AND (account_id=$3 OR canonical_identity=$4)
       ORDER BY requested_at DESC
       LIMIT 1`,
    [siteLicense.id, packageId, accountId, canonicalIdentity],
  );
  const existingRequest = normalizeSiteLicensePoolRequestRow(
    existingRequestRows.rows[0],
  );
  if (existingRequest) {
    if (
      existingRequest.account_id === accountId &&
      existingRequest.state === "pending"
    ) {
      return existingRequest;
    }
    throw Error("site-license pool request already exists");
  }
  const request_id = uuid();
  const metadata = {
    accepted_terms: accepted_terms === true,
    custom_terms_url: siteLicense.custom_terms_url ?? null,
    custom_policy_url: siteLicense.custom_policy_url ?? null,
    terms_version_label: siteLicense.terms_version_label ?? null,
  };
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
  return normalizeSiteLicensePoolRequestRow(rows[0])!;
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
    return await withSiteLicenseRequestTransaction({
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
          return await updateRequestState({
            request_id: request.id,
            state: "rejected",
            reviewer_account_id: actorAccountId,
            review_note,
            client,
          });
        }
        const claimedDomain = request.matched_email_address.split("@")[1] ?? "";
        const scope_key = getClaimScopeKey(siteLicense.id);
        const scope_kind = "site-license";
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
          },
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
        await revokeOtherSiteLicenseAssignments({
          site_license_id: siteLicense.id,
          approved_package_id: pkg.id,
          account_id: request.account_id,
          client,
        });
        const assignment = await assignMembershipPackageSeat(
          {
            package_id: pkg.id,
            account_id: request.account_id,
            email_address: request.matched_email_address,
            assigned_by_account_id: actorAccountId,
            metadata: {
              site_license_id: siteLicense.id,
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
          owner_account_id: siteLicense.owner_account_id,
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
            },
          },
          client,
        });
        return await updateRequestState({
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
      },
    });
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
  state: "approved" | "rejected";
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

async function revokeOtherSiteLicenseAssignments({
  site_license_id,
  approved_package_id,
  account_id,
  client,
}: {
  site_license_id: string;
  approved_package_id: string;
  account_id: string;
  client: PoolClient;
}): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
     FROM membership_packages
     WHERE metadata->>'site_license_id'=$1
       AND id <> $2`,
    [site_license_id, approved_package_id],
  );
  for (const row of rows) {
    await revokeMembershipPackageSeat(
      {
        package_id: row.id,
        account_id,
      },
      client,
    );
  }
}

async function withSiteLicenseRequestTransaction<T>({
  request_id,
  action,
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
  return await withAccountRehomeWriteFence({
    account_id: siteLicense.owner_account_id,
    action,
    fn: async (db) => {
      const client = db as PoolClient;
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
      const { pkg } = await getSiteLicenseForPackage(
        request.package_id,
        client,
      );
      return await fn({ client, request, siteLicense, pkg });
    },
  });
}
