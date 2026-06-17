/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, createHmac } from "crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type { MembershipClass } from "@cocalc/conat/hub/api/purchases";
import { checkAccountName } from "@cocalc/util/db-schema/name-rules";
import { isValidUUID, uuid } from "@cocalc/util/misc";

import { getMembershipPackage, assignMembershipPackageSeat } from "./packages";
import {
  ensureSiteLicenseSchema,
  recordSiteLicenseAuditEvent,
} from "./site-licenses";

export const SITE_LICENSE_EXTERNAL_CLAIM_AUDIENCE =
  "cocalc.ai.site-license-claim";

export type SiteLicenseExternalClaimConsumptionStatus =
  | "pending-side-effect"
  | "granted"
  | "failed-retryable"
  | "failed-terminal";

type Queryable = PoolClient | ReturnType<typeof getPool>;

interface RawExternalClaimPool {
  id: string;
  slug?: string | null;
  site_license_id: string;
  package_id: string;
  name: string;
  issuer: string;
  audience: string;
  default_membership_class?: string | null;
  allow_membership_class_override: boolean;
  default_membership_duration_days?: number | null;
  default_membership_expires_at?: Date | string | null;
  allow_membership_expires_at_override: boolean;
  min_membership_duration_days?: number | null;
  max_membership_duration_days?: number | null;
  max_membership_expires_at?: Date | string | null;
  default_rootfs_id?: string | null;
  max_claims?: number | null;
  max_claims_per_account?: number | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  disabled_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created_by_account_id?: string | null;
  created?: Date | string;
  updated?: Date | string;
}

interface RawSiteLicenseForClaim {
  id: string;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
}

interface RawExternalClaimConsumption {
  id: string;
  pool_id: string;
  site_license_id: string;
  package_id: string;
  jti: string;
  token_hash: string;
  issuer: string;
  kid?: string | null;
  account_id: string;
  status: SiteLicenseExternalClaimConsumptionStatus;
  side_effect_key: string;
  assignment_id?: string | null;
  membership_grant_id?: string | null;
  membership_class: MembershipClass;
  membership_expires_at?: Date | string | null;
  rootfs_id?: string | null;
  external_subject?: string | null;
  token_expires_at?: Date | string | null;
  error_code?: string | null;
  error_message?: string | null;
  retry_count: number;
  last_retry_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  consumed_at: Date | string;
  updated: Date | string;
}

export interface SiteLicenseExternalClaimPool {
  id: string;
  slug?: string | null;
  site_license_id: string;
  package_id: string;
  name: string;
  issuer: string;
  audience: string;
  default_membership_class?: MembershipClass | null;
  allow_membership_class_override: boolean;
  default_membership_duration_days?: number | null;
  default_membership_expires_at?: Date | null;
  allow_membership_expires_at_override: boolean;
  min_membership_duration_days?: number | null;
  max_membership_duration_days?: number | null;
  max_membership_expires_at?: Date | null;
  default_rootfs_id?: string | null;
  max_claims?: number | null;
  max_claims_per_account?: number | null;
  starts_at?: Date | null;
  expires_at?: Date | null;
  disabled_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created_by_account_id?: string | null;
  created?: Date;
  updated?: Date;
}

export interface SiteLicenseVerifiedExternalClaim {
  issuer: string;
  audience?: string;
  site_license_id: string;
  pool_id: string;
  jti: string;
  token_hash: string;
  account_id: string;
  kid?: string | null;
  membership_class?: MembershipClass | null;
  membership_expires_at?: Date | string | null;
  rootfs_id?: string | null;
  external_subject?: string | null;
  token_expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SiteLicenseExternalClaimConsumption {
  id: string;
  pool_id: string;
  site_license_id: string;
  package_id: string;
  jti: string;
  token_hash: string;
  issuer: string;
  kid?: string | null;
  account_id: string;
  status: SiteLicenseExternalClaimConsumptionStatus;
  side_effect_key: string;
  assignment_id?: string | null;
  membership_grant_id?: string | null;
  membership_class: MembershipClass;
  membership_expires_at?: Date | null;
  rootfs_id?: string | null;
  external_subject?: string | null;
  token_expires_at?: Date | null;
  error_code?: string | null;
  error_message?: string | null;
  retry_count: number;
  last_retry_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  consumed_at: Date;
  updated: Date;
}

function getQueryClient(client?: PoolClient): Queryable {
  return client ?? getPool();
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

function normalizeUUID(value: unknown, field: string): string {
  const id = normalizeString(value, field);
  if (!isValidUUID(id)) {
    throw Error(`${field} must be a uuid`);
  }
  return id;
}

function normalizeOptionalPositiveInt(
  value: unknown,
  field: string,
): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw Error(`${field} must be a positive integer`);
  }
  return number;
}

function asDate(value?: Date | string | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`invalid date '${value}'`);
  }
  return date;
}

function requireActiveWindow({
  starts_at,
  expires_at,
  disabled_at,
  label,
  now,
}: {
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  disabled_at?: Date | string | null;
  label: string;
  now: Date;
}): void {
  if (asDate(disabled_at) != null) {
    throw Error(`${label} is disabled`);
  }
  const startsAt = asDate(starts_at);
  if (startsAt != null && startsAt > now) {
    throw Error(`${label} is not active yet`);
  }
  const expiresAt = asDate(expires_at);
  if (expiresAt != null && expiresAt <= now) {
    throw Error(`${label} has expired`);
  }
}

function normalizePoolRow(
  row: RawExternalClaimPool,
): SiteLicenseExternalClaimPool {
  return {
    ...row,
    default_membership_duration_days:
      row.default_membership_duration_days == null
        ? null
        : Number(row.default_membership_duration_days),
    min_membership_duration_days:
      row.min_membership_duration_days == null
        ? null
        : Number(row.min_membership_duration_days),
    max_membership_duration_days:
      row.max_membership_duration_days == null
        ? null
        : Number(row.max_membership_duration_days),
    max_claims: row.max_claims == null ? null : Number(row.max_claims),
    max_claims_per_account:
      row.max_claims_per_account == null
        ? null
        : Number(row.max_claims_per_account),
    default_membership_expires_at: asDate(row.default_membership_expires_at),
    max_membership_expires_at: asDate(row.max_membership_expires_at),
    starts_at: asDate(row.starts_at),
    expires_at: asDate(row.expires_at),
    disabled_at: asDate(row.disabled_at),
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created) ?? undefined,
    updated: asDate(row.updated) ?? undefined,
  };
}

function normalizeConsumptionRow(
  row: RawExternalClaimConsumption,
): SiteLicenseExternalClaimConsumption {
  return {
    ...row,
    metadata: normalizeMetadata(row.metadata),
    membership_expires_at: asDate(row.membership_expires_at),
    token_expires_at: asDate(row.token_expires_at),
    last_retry_at: asDate(row.last_retry_at),
    consumed_at: asDate(row.consumed_at)!,
    updated: asDate(row.updated)!,
    retry_count: Number(row.retry_count ?? 0),
  };
}

function normalizeSlug(slug?: string | null): string | null {
  const normalized = normalizeOptionalString(slug);
  if (normalized == null) return null;
  checkAccountName(normalized);
  return normalized;
}

function claimSideEffectKey(consumption_id: string): string {
  return `site-license-external-claim:${consumption_id}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function resolveMembershipClass({
  pool,
  package_membership_class,
  claim_membership_class,
}: {
  pool: SiteLicenseExternalClaimPool;
  package_membership_class: MembershipClass;
  claim_membership_class?: MembershipClass | null;
}): MembershipClass {
  const claimClass = normalizeOptionalString(claim_membership_class);
  if (claimClass != null) {
    if (!pool.allow_membership_class_override) {
      throw Error("membership class override is not allowed for this pool");
    }
    return claimClass;
  }
  return (
    normalizeOptionalString(pool.default_membership_class) ??
    package_membership_class
  );
}

function resolveMembershipExpiresAt({
  pool,
  claim_membership_expires_at,
  package_expires_at,
  now,
}: {
  pool: SiteLicenseExternalClaimPool;
  claim_membership_expires_at?: Date | string | null;
  package_expires_at?: Date | string | null;
  now: Date;
}): Date | null {
  const claimExpiresAt = asDate(claim_membership_expires_at);
  if (claimExpiresAt != null) {
    if (!pool.allow_membership_expires_at_override) {
      throw Error(
        "membership expiration override is not allowed for this pool",
      );
    }
    if (claimExpiresAt <= now) {
      throw Error("membership expiration must be in the future");
    }
    const durationDays =
      (claimExpiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    if (
      pool.min_membership_duration_days != null &&
      durationDays < pool.min_membership_duration_days
    ) {
      throw Error("membership expiration is before the pool minimum duration");
    }
    if (
      pool.max_membership_duration_days != null &&
      durationDays > pool.max_membership_duration_days
    ) {
      throw Error("membership expiration exceeds the pool maximum duration");
    }
    if (
      pool.max_membership_expires_at != null &&
      claimExpiresAt > pool.max_membership_expires_at
    ) {
      throw Error("membership expiration exceeds the pool maximum expiration");
    }
    return claimExpiresAt;
  }
  if (pool.default_membership_expires_at != null) {
    return pool.default_membership_expires_at;
  }
  if (pool.default_membership_duration_days != null) {
    return addDays(now, pool.default_membership_duration_days);
  }
  return asDate(package_expires_at);
}

export function hashSiteLicenseExternalClaimToken({
  token,
  secret = process.env.COCALC_SITE_LICENSE_CLAIM_TOKEN_HASH_SECRET,
}: {
  token: string;
  secret?: string | null;
}): string {
  const normalizedToken = normalizeString(token, "token");
  if (`${secret ?? ""}`.trim()) {
    return `hmac-sha256:${createHmac("sha256", `${secret}`).update(normalizedToken).digest("hex")}`;
  }
  return `sha256:${createHash("sha256").update(normalizedToken).digest("hex")}`;
}

export async function createSiteLicenseExternalClaimPool(
  {
    id = uuid(),
    slug,
    site_license_id,
    package_id,
    name,
    issuer,
    audience = SITE_LICENSE_EXTERNAL_CLAIM_AUDIENCE,
    default_membership_class,
    allow_membership_class_override = false,
    default_membership_duration_days,
    default_membership_expires_at,
    allow_membership_expires_at_override = false,
    min_membership_duration_days,
    max_membership_duration_days,
    max_membership_expires_at,
    default_rootfs_id,
    max_claims,
    max_claims_per_account,
    starts_at,
    expires_at,
    disabled_at,
    metadata,
    created_by_account_id,
  }: {
    id?: string;
    slug?: string | null;
    site_license_id: string;
    package_id: string;
    name: string;
    issuer: string;
    audience?: string;
    default_membership_class?: MembershipClass | null;
    allow_membership_class_override?: boolean;
    default_membership_duration_days?: number | null;
    default_membership_expires_at?: Date | string | null;
    allow_membership_expires_at_override?: boolean;
    min_membership_duration_days?: number | null;
    max_membership_duration_days?: number | null;
    max_membership_expires_at?: Date | string | null;
    default_rootfs_id?: string | null;
    max_claims?: number | null;
    max_claims_per_account?: number | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    disabled_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
    created_by_account_id?: string | null;
  },
  client?: PoolClient,
): Promise<SiteLicenseExternalClaimPool> {
  await ensureSiteLicenseSchema(client);
  const pool = getQueryClient(client);
  const normalizedId = normalizeUUID(id, "id");
  const normalizedSiteLicenseId = normalizeUUID(
    site_license_id,
    "site_license_id",
  );
  const normalizedPackageId = normalizeUUID(package_id, "package_id");
  const pkg = await getMembershipPackage({
    package_id: normalizedPackageId,
    client,
  });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.kind !== "site") {
    throw Error("external claim pools must reference a site-license package");
  }
  if (`${pkg.metadata?.site_license_id ?? ""}` !== normalizedSiteLicenseId) {
    throw Error("membership package does not belong to site license");
  }
  const normalizedSlug = normalizeSlug(slug);
  const normalizedIssuer = normalizeString(issuer, "issuer");
  const { rows } = await pool.query<RawExternalClaimPool>(
    `INSERT INTO site_license_external_claim_pools
       (id, slug, site_license_id, package_id, name, issuer, audience,
        default_membership_class, allow_membership_class_override,
        default_membership_duration_days, default_membership_expires_at,
        allow_membership_expires_at_override, min_membership_duration_days,
        max_membership_duration_days, max_membership_expires_at,
        default_rootfs_id, max_claims, max_claims_per_account, starts_at,
        expires_at, disabled_at, metadata, created_by_account_id, created,
        updated)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22::jsonb,$23,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       slug=EXCLUDED.slug,
       site_license_id=EXCLUDED.site_license_id,
       package_id=EXCLUDED.package_id,
       name=EXCLUDED.name,
       issuer=EXCLUDED.issuer,
       audience=EXCLUDED.audience,
       default_membership_class=EXCLUDED.default_membership_class,
       allow_membership_class_override=EXCLUDED.allow_membership_class_override,
       default_membership_duration_days=EXCLUDED.default_membership_duration_days,
       default_membership_expires_at=EXCLUDED.default_membership_expires_at,
       allow_membership_expires_at_override=EXCLUDED.allow_membership_expires_at_override,
       min_membership_duration_days=EXCLUDED.min_membership_duration_days,
       max_membership_duration_days=EXCLUDED.max_membership_duration_days,
       max_membership_expires_at=EXCLUDED.max_membership_expires_at,
       default_rootfs_id=EXCLUDED.default_rootfs_id,
       max_claims=EXCLUDED.max_claims,
       max_claims_per_account=EXCLUDED.max_claims_per_account,
       starts_at=EXCLUDED.starts_at,
       expires_at=EXCLUDED.expires_at,
       disabled_at=EXCLUDED.disabled_at,
       metadata=EXCLUDED.metadata,
       created_by_account_id=EXCLUDED.created_by_account_id,
       updated=NOW()
     RETURNING *`,
    [
      normalizedId,
      normalizedSlug,
      normalizedSiteLicenseId,
      normalizedPackageId,
      normalizeString(name, "name"),
      normalizedIssuer,
      normalizeString(audience, "audience"),
      normalizeOptionalString(default_membership_class),
      allow_membership_class_override === true,
      normalizeOptionalPositiveInt(
        default_membership_duration_days,
        "default_membership_duration_days",
      ),
      asDate(default_membership_expires_at),
      allow_membership_expires_at_override === true,
      normalizeOptionalPositiveInt(
        min_membership_duration_days,
        "min_membership_duration_days",
      ),
      normalizeOptionalPositiveInt(
        max_membership_duration_days,
        "max_membership_duration_days",
      ),
      asDate(max_membership_expires_at),
      normalizeOptionalString(default_rootfs_id),
      normalizeOptionalPositiveInt(max_claims, "max_claims"),
      normalizeOptionalPositiveInt(
        max_claims_per_account,
        "max_claims_per_account",
      ),
      asDate(starts_at),
      asDate(expires_at),
      asDate(disabled_at),
      normalizeMetadata(metadata),
      normalizeOptionalString(created_by_account_id),
    ],
  );
  return normalizePoolRow(rows[0]!);
}

async function loadClaimPoolForUpdate({
  pool_id,
  client,
}: {
  pool_id: string;
  client: PoolClient;
}): Promise<SiteLicenseExternalClaimPool> {
  const { rows } = await client.query<RawExternalClaimPool>(
    `SELECT *
       FROM site_license_external_claim_pools
      WHERE id=$1
      FOR UPDATE`,
    [pool_id],
  );
  if (!rows[0]) {
    throw Error("external claim pool not found");
  }
  return normalizePoolRow(rows[0]);
}

async function loadSiteLicenseForUpdate({
  site_license_id,
  client,
}: {
  site_license_id: string;
  client: PoolClient;
}): Promise<RawSiteLicenseForClaim> {
  const { rows } = await client.query<RawSiteLicenseForClaim>(
    `SELECT id, starts_at, expires_at
       FROM site_licenses
      WHERE id=$1
      FOR UPDATE`,
    [site_license_id],
  );
  if (!rows[0]) {
    throw Error("site license not found");
  }
  return rows[0];
}

async function getExistingConsumptionForUpdate({
  pool_id,
  jti,
  client,
}: {
  pool_id: string;
  jti: string;
  client: PoolClient;
}): Promise<SiteLicenseExternalClaimConsumption | undefined> {
  const { rows } = await client.query<RawExternalClaimConsumption>(
    `SELECT *
       FROM site_license_external_claim_consumptions
      WHERE pool_id=$1
        AND jti=$2
      FOR UPDATE`,
    [pool_id, jti],
  );
  return rows[0] ? normalizeConsumptionRow(rows[0]) : undefined;
}

async function assertClaimLimits({
  pool,
  account_id,
  client,
}: {
  pool: SiteLicenseExternalClaimPool;
  account_id: string;
  client: PoolClient;
}): Promise<void> {
  if (pool.max_claims != null) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM site_license_external_claim_consumptions
        WHERE pool_id=$1`,
      [pool.id],
    );
    if (Number(rows[0]?.count ?? 0) >= pool.max_claims) {
      throw Error("external claim pool has no claims available");
    }
  }
  if (pool.max_claims_per_account != null) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM site_license_external_claim_consumptions
        WHERE pool_id=$1
          AND account_id=$2`,
      [pool.id, account_id],
    );
    if (Number(rows[0]?.count ?? 0) >= pool.max_claims_per_account) {
      throw Error("external claim pool already claimed for this account");
    }
  }
}

async function insertPendingConsumption({
  claim,
  pool,
  membership_class,
  membership_expires_at,
  rootfs_id,
  client,
}: {
  claim: SiteLicenseVerifiedExternalClaim;
  pool: SiteLicenseExternalClaimPool;
  membership_class: MembershipClass;
  membership_expires_at: Date | null;
  rootfs_id: string | null;
  client: PoolClient;
}): Promise<SiteLicenseExternalClaimConsumption> {
  const id = uuid();
  const sideEffectKey = claimSideEffectKey(id);
  const { rows } = await client.query<RawExternalClaimConsumption>(
    `INSERT INTO site_license_external_claim_consumptions
       (id, pool_id, site_license_id, package_id, jti, token_hash, issuer, kid,
        account_id, status, side_effect_key, membership_class,
        membership_expires_at, rootfs_id, external_subject, token_expires_at,
        metadata, consumed_at, updated)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending-side-effect',$10,$11,$12,$13,$14,
        $15,$16::jsonb,NOW(),NOW())
     RETURNING *`,
    [
      id,
      pool.id,
      pool.site_license_id,
      pool.package_id,
      normalizeString(claim.jti, "jti"),
      normalizeString(claim.token_hash, "token_hash"),
      normalizeString(claim.issuer, "issuer"),
      normalizeOptionalString(claim.kid),
      normalizeUUID(claim.account_id, "account_id"),
      sideEffectKey,
      membership_class,
      membership_expires_at,
      rootfs_id,
      normalizeOptionalString(claim.external_subject),
      asDate(claim.token_expires_at),
      normalizeMetadata(claim.metadata),
    ],
  );
  return normalizeConsumptionRow(rows[0]!);
}

async function seedConsumeVerifiedClaim(
  claim: SiteLicenseVerifiedExternalClaim,
): Promise<SiteLicenseExternalClaimConsumption> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureSiteLicenseSchema(client);
    const now = new Date();
    const pool = await loadClaimPoolForUpdate({
      pool_id: normalizeUUID(claim.pool_id, "pool_id"),
      client,
    });
    const packageRecord = await getMembershipPackage({
      package_id: pool.package_id,
      client,
    });
    if (!packageRecord) {
      throw Error("membership package not found");
    }
    if (
      pool.site_license_id !==
      normalizeUUID(claim.site_license_id, "site_license_id")
    ) {
      throw Error("claim site license does not match pool");
    }
    if (pool.issuer !== normalizeString(claim.issuer, "issuer")) {
      throw Error("claim issuer does not match pool");
    }
    const audience =
      normalizeOptionalString(claim.audience) ??
      SITE_LICENSE_EXTERNAL_CLAIM_AUDIENCE;
    if (pool.audience !== audience) {
      throw Error("claim audience does not match pool");
    }
    requireActiveWindow({ ...pool, label: "external claim pool", now });
    const siteLicense = await loadSiteLicenseForUpdate({
      site_license_id: pool.site_license_id,
      client,
    });
    requireActiveWindow({ ...siteLicense, label: "site license", now });
    const existing = await getExistingConsumptionForUpdate({
      pool_id: pool.id,
      jti: normalizeString(claim.jti, "jti"),
      client,
    });
    if (existing) {
      if (
        existing.account_id !== normalizeUUID(claim.account_id, "account_id")
      ) {
        throw Error("external claim token was already consumed");
      }
      await client.query("COMMIT");
      return existing;
    }
    await assertClaimLimits({
      pool,
      account_id: normalizeUUID(claim.account_id, "account_id"),
      client,
    });
    const membership_class = resolveMembershipClass({
      pool,
      package_membership_class: packageRecord.membership_class,
      claim_membership_class: claim.membership_class,
    });
    const membership_expires_at = resolveMembershipExpiresAt({
      pool,
      claim_membership_expires_at: claim.membership_expires_at,
      package_expires_at: packageRecord.expires_at,
      now,
    });
    const rootfs_id =
      normalizeOptionalString(claim.rootfs_id) ??
      normalizeOptionalString(pool.default_rootfs_id);
    const consumption = await insertPendingConsumption({
      claim,
      pool,
      membership_class,
      membership_expires_at,
      rootfs_id,
      client,
    });
    await recordSiteLicenseAuditEvent({
      site_license_id: pool.site_license_id,
      action: "external-claim-consumed",
      target_account_id: claim.account_id,
      package_id: pool.package_id,
      metadata: {
        pool_id: pool.id,
        issuer: pool.issuer,
        kid: normalizeOptionalString(claim.kid),
        jti: normalizeString(claim.jti, "jti"),
        token_hash: normalizeString(claim.token_hash, "token_hash"),
        side_effect_key: consumption.side_effect_key,
      },
      client,
    });
    await client.query("COMMIT");
    return consumption;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function markConsumptionSideEffectFailed({
  consumption,
  err,
}: {
  consumption: SiteLicenseExternalClaimConsumption;
  err: unknown;
}): Promise<void> {
  await ensureSiteLicenseSchema();
  await getPool().query(
    `UPDATE site_license_external_claim_consumptions
        SET status='failed-retryable',
            error_code=$2,
            error_message=$3,
            retry_count=retry_count + 1,
            last_retry_at=NOW(),
            updated=NOW()
      WHERE id=$1`,
    [
      consumption.id,
      err instanceof Error ? err.name : "Error",
      err instanceof Error ? err.message : `${err}`,
    ],
  );
  await recordSiteLicenseAuditEvent({
    site_license_id: consumption.site_license_id,
    action: "external-claim-side-effect-failed",
    target_account_id: consumption.account_id,
    package_id: consumption.package_id,
    metadata: {
      pool_id: consumption.pool_id,
      consumption_id: consumption.id,
      side_effect_key: consumption.side_effect_key,
      error: err instanceof Error ? err.message : `${err}`,
    },
    client: getPool(),
  });
}

async function markConsumptionGranted({
  consumption,
  assignment_id,
  membership_grant_id,
}: {
  consumption: SiteLicenseExternalClaimConsumption;
  assignment_id?: string | null;
  membership_grant_id?: string | null;
}): Promise<SiteLicenseExternalClaimConsumption> {
  const { rows } = await getPool().query<RawExternalClaimConsumption>(
    `UPDATE site_license_external_claim_consumptions
        SET status='granted',
            assignment_id=$2,
            membership_grant_id=$3,
            error_code=NULL,
            error_message=NULL,
            updated=NOW()
      WHERE id=$1
      RETURNING *`,
    [consumption.id, assignment_id ?? null, membership_grant_id ?? null],
  );
  await recordSiteLicenseAuditEvent({
    site_license_id: consumption.site_license_id,
    action: "external-claim-granted",
    target_account_id: consumption.account_id,
    package_id: consumption.package_id,
    metadata: {
      pool_id: consumption.pool_id,
      consumption_id: consumption.id,
      side_effect_key: consumption.side_effect_key,
      assignment_id: assignment_id ?? null,
      membership_grant_id: membership_grant_id ?? null,
    },
    client: getPool(),
  });
  return normalizeConsumptionRow(rows[0]!);
}

export async function applySiteLicenseExternalClaimSideEffect(
  consumption: SiteLicenseExternalClaimConsumption,
): Promise<SiteLicenseExternalClaimConsumption> {
  if (consumption.status === "granted") {
    return consumption;
  }
  try {
    const assignment = await assignMembershipPackageSeat({
      package_id: consumption.package_id,
      account_id: consumption.account_id,
      assigned_by_account_id: consumption.account_id,
      metadata: {
        ...normalizeMetadata(consumption.metadata),
        grant_source: "site-license-external-claim",
        grant_membership_class: consumption.membership_class,
        grant_expires_at:
          consumption.membership_expires_at?.toISOString() ?? null,
        site_license_id: consumption.site_license_id,
        site_license_external_claim_pool_id: consumption.pool_id,
        site_license_external_claim_consumption_id: consumption.id,
        site_license_external_claim_side_effect_key:
          consumption.side_effect_key,
        external_claim_issuer: consumption.issuer,
        external_claim_jti: consumption.jti,
        external_claim_subject: consumption.external_subject ?? null,
        rootfs_id: consumption.rootfs_id ?? null,
      },
    });
    return await markConsumptionGranted({
      consumption,
      assignment_id: assignment.id,
      membership_grant_id: assignment.grant_id ?? null,
    });
  } catch (err) {
    await markConsumptionSideEffectFailed({ consumption, err });
    throw err;
  }
}

export async function consumeVerifiedSiteLicenseExternalClaim(
  claim: SiteLicenseVerifiedExternalClaim,
): Promise<SiteLicenseExternalClaimConsumption> {
  const consumption = await seedConsumeVerifiedClaim(claim);
  return await applySiteLicenseExternalClaimSideEffect(consumption);
}
