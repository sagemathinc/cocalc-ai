/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  createInterBayAccountDirectoryClient,
  type MembershipClaimIdentityActivateRequest,
  type MembershipClaimIdentityEntry,
  type MembershipClaimIdentityGetRequest,
  type MembershipClaimIdentityReserveRequest,
  type MembershipClaimIdentityReserveResult,
  type MembershipClaimIdentityRevokeRequest,
} from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  is_valid_email_address as isValidEmailAddress,
  uuid,
} from "@cocalc/util/misc";

const CLAIM_SCOPE_TABLE = "membership_claim_scopes";
const CLAIM_IDENTITY_TABLE = "membership_claim_identities";
const CLAIM_STATE_PENDING = "pending";
const CLAIM_STATE_ACTIVE = "active";
const CLAIM_STATE_REVOKED = "revoked";
const DEFAULT_RESERVATION_TTL_MS = clampInt(
  process.env.COCALC_MEMBERSHIP_CLAIM_RESERVATION_TTL_MS,
  24 * 60 * 60_000,
  60_000,
  30 * 24 * 60 * 60_000,
);

type Queryable = PoolClient | ReturnType<typeof getPool>;

interface RawMembershipClaimIdentityRow {
  scope_id: string;
  scope_key: string;
  scope_kind: string;
  canonical_identity: string;
  account_id: string;
  state: string;
  reservation_id: string;
  package_id?: string | null;
  assignment_id?: string | null;
  grant_id?: string | null;
  matched_email_address: string;
  claimed_domain: string;
  reservation_expires_at?: Date | string | null;
  activated_at?: Date | string | null;
  revoked_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string | null;
  updated?: Date | string | null;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getQueryClient(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function asDate(value?: Date | string | null): Date | undefined {
  if (value == null) return;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`invalid date '${value}'`);
  }
  return date;
}

function normalizeEmailAddress(email_address: string): string {
  const normalized = `${email_address ?? ""}`.trim().toLowerCase();
  if (!normalized || !isValidEmailAddress(normalized)) {
    throw Error("invalid email address");
  }
  return normalized;
}

function normalizeScopeKey(scope_key: string): string {
  const normalized = `${scope_key ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    throw Error("claim scope key is required");
  }
  return normalized;
}

function normalizeScopeKind(scope_kind: string): string {
  const normalized = `${scope_kind ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    throw Error("claim scope kind is required");
  }
  return normalized;
}

function normalizeClaimedDomain(claimed_domain: string): string {
  const normalized = `${claimed_domain ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    throw Error("claimed domain is required");
  }
  return normalized;
}

function normalizeMetadata(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (metadata == null) return null;
  return { ...metadata };
}

export function canonicalizeInstitutionalClaimEmail(
  email_address: string,
): string {
  const normalized = normalizeEmailAddress(email_address);
  const [localPart, domain] = normalized.split("@");
  const canonicalLocalPart = `${localPart ?? ""}`.split("+")[0] ?? "";
  if (!canonicalLocalPart || !domain) {
    throw Error("invalid institutional claim email address");
  }
  return `${canonicalLocalPart}@${domain}`;
}

function normalizeMembershipClaimIdentityRow(
  row: RawMembershipClaimIdentityRow | undefined,
): MembershipClaimIdentityEntry | null {
  if (!row) return null;
  return {
    scope_id: row.scope_id,
    scope_key: normalizeScopeKey(row.scope_key),
    scope_kind: normalizeScopeKind(row.scope_kind),
    canonical_identity: normalizeEmailAddress(row.canonical_identity),
    account_id: row.account_id,
    state:
      row.state === CLAIM_STATE_ACTIVE ||
      row.state === CLAIM_STATE_PENDING ||
      row.state === CLAIM_STATE_REVOKED
        ? row.state
        : CLAIM_STATE_REVOKED,
    reservation_id: row.reservation_id,
    package_id: row.package_id ?? undefined,
    assignment_id: row.assignment_id ?? undefined,
    grant_id: row.grant_id ?? undefined,
    matched_email_address: normalizeEmailAddress(row.matched_email_address),
    claimed_domain: normalizeClaimedDomain(row.claimed_domain),
    reservation_expires_at: asDate(row.reservation_expires_at) ?? null,
    activated_at: asDate(row.activated_at) ?? null,
    revoked_at: asDate(row.revoked_at) ?? null,
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created) ?? undefined,
    updated: asDate(row.updated) ?? undefined,
  };
}

function isPendingReservationExpired(
  record: MembershipClaimIdentityEntry,
  now = new Date(),
): boolean {
  return (
    record.state === CLAIM_STATE_PENDING &&
    record.reservation_expires_at != null &&
    record.reservation_expires_at.getTime() <= now.getTime()
  );
}

function isCurrentBlockingRecord(
  record: MembershipClaimIdentityEntry | null,
  now = new Date(),
): boolean {
  if (record == null) return false;
  if (record.state === CLAIM_STATE_ACTIVE) {
    return true;
  }
  if (record.state === CLAIM_STATE_PENDING) {
    return !isPendingReservationExpired(record, now);
  }
  return false;
}

async function ensureMembershipClaimDirectorySchema(
  client?: PoolClient,
): Promise<void> {
  const db = getQueryClient(client);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${CLAIM_SCOPE_TABLE} (
      scope_id UUID PRIMARY KEY,
      scope_key VARCHAR(512) NOT NULL UNIQUE,
      scope_kind VARCHAR(64) NOT NULL,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_SCOPE_TABLE}_scope_kind_idx ON ${CLAIM_SCOPE_TABLE} (scope_kind)`,
  );
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${CLAIM_SCOPE_TABLE}_scope_key_unique_idx ON ${CLAIM_SCOPE_TABLE} (scope_key)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_SCOPE_TABLE}_updated_idx ON ${CLAIM_SCOPE_TABLE} (updated)`,
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${CLAIM_IDENTITY_TABLE} (
      scope_id UUID NOT NULL,
      canonical_identity VARCHAR(320) NOT NULL,
      account_id UUID NOT NULL,
      state VARCHAR(16) NOT NULL,
      reservation_id UUID NOT NULL,
      package_id UUID,
      assignment_id UUID,
      grant_id UUID,
      matched_email_address VARCHAR(254) NOT NULL,
      claimed_domain VARCHAR(254) NOT NULL,
      reservation_expires_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scope_id, canonical_identity)
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_account_id_idx ON ${CLAIM_IDENTITY_TABLE} (account_id)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_state_idx ON ${CLAIM_IDENTITY_TABLE} (state)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_assignment_id_idx ON ${CLAIM_IDENTITY_TABLE} (assignment_id)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_package_id_idx ON ${CLAIM_IDENTITY_TABLE} (package_id)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_grant_id_idx ON ${CLAIM_IDENTITY_TABLE} (grant_id)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_reservation_expires_at_idx ON ${CLAIM_IDENTITY_TABLE} (reservation_expires_at)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${CLAIM_IDENTITY_TABLE}_updated_idx ON ${CLAIM_IDENTITY_TABLE} (updated)`,
  );
}

async function getOrCreateClaimScope({
  scope_key,
  scope_kind,
  metadata,
  client,
}: {
  scope_key: string;
  scope_kind: string;
  metadata?: Record<string, unknown> | null;
  client: PoolClient;
}): Promise<{ scope_id: string; scope_key: string; scope_kind: string }> {
  const { rows } = await client.query<{
    scope_id: string;
    scope_key: string;
    scope_kind: string;
  }>(
    `
      INSERT INTO ${CLAIM_SCOPE_TABLE}
        (scope_id, scope_key, scope_kind, metadata, created, updated)
      VALUES
        ($1, $2, $3, $4::jsonb, NOW(), NOW())
      ON CONFLICT (scope_key) DO UPDATE SET
        scope_kind = EXCLUDED.scope_kind,
        metadata = COALESCE(EXCLUDED.metadata, ${CLAIM_SCOPE_TABLE}.metadata),
        updated = NOW()
      RETURNING scope_id, scope_key, scope_kind
    `,
    [uuid(), scope_key, scope_kind, normalizeMetadata(metadata)],
  );
  const row = rows[0];
  if (!row) {
    throw Error("failed to create claim scope");
  }
  return row;
}

async function getMembershipClaimIdentityRow({
  scope_key,
  canonical_identity,
  client,
}: MembershipClaimIdentityGetRequest & {
  client?: PoolClient;
}): Promise<MembershipClaimIdentityEntry | null> {
  await ensureMembershipClaimDirectorySchema(client);
  const { rows } = await getQueryClient(
    client,
  ).query<RawMembershipClaimIdentityRow>(
    `
      SELECT
        s.scope_id,
        s.scope_key,
        s.scope_kind,
        i.canonical_identity,
        i.account_id,
        i.state,
        i.reservation_id,
        i.package_id,
        i.assignment_id,
        i.grant_id,
        i.matched_email_address,
        i.claimed_domain,
        i.reservation_expires_at,
        i.activated_at,
        i.revoked_at,
        i.metadata,
        i.created,
        i.updated
      FROM ${CLAIM_IDENTITY_TABLE} i
      JOIN ${CLAIM_SCOPE_TABLE} s
        ON s.scope_id = i.scope_id
      WHERE s.scope_key = $1
        AND i.canonical_identity = $2
      LIMIT 1
    `,
    [normalizeScopeKey(scope_key), normalizeEmailAddress(canonical_identity)],
  );
  return normalizeMembershipClaimIdentityRow(rows[0]);
}

async function withClaimDirectoryTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureMembershipClaimDirectorySchema(client);
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

export async function getMembershipClaimIdentityDirect(
  opts: MembershipClaimIdentityGetRequest,
): Promise<MembershipClaimIdentityEntry | null> {
  const record = await getMembershipClaimIdentityRow(opts);
  return isCurrentBlockingRecord(record) ? record : null;
}

export async function getMembershipClaimIdentity(
  opts: MembershipClaimIdentityGetRequest,
): Promise<MembershipClaimIdentityEntry | null> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getMembershipClaimIdentityDirect(opts);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).getMembershipClaimIdentity(opts);
}

export async function reserveMembershipClaimIdentityDirect({
  scope_key,
  scope_kind,
  canonical_identity,
  account_id,
  reservation_id,
  matched_email_address,
  claimed_domain,
  reservation_ttl_ms,
  metadata,
}: MembershipClaimIdentityReserveRequest): Promise<MembershipClaimIdentityReserveResult> {
  return await withClaimDirectoryTransaction(async (client) => {
    const normalizedScopeKey = normalizeScopeKey(scope_key);
    const normalizedScopeKind = normalizeScopeKind(scope_kind);
    const normalizedCanonicalIdentity =
      normalizeEmailAddress(canonical_identity);
    const normalizedMatchedEmail = normalizeEmailAddress(matched_email_address);
    const normalizedClaimedDomain = normalizeClaimedDomain(claimed_domain);
    const ttlMs = clampInt(
      reservation_ttl_ms == null ? undefined : `${reservation_ttl_ms}`,
      DEFAULT_RESERVATION_TTL_MS,
      60_000,
      30 * 24 * 60 * 60_000,
    );
    const scope = await getOrCreateClaimScope({
      scope_key: normalizedScopeKey,
      scope_kind: normalizedScopeKind,
      metadata,
      client,
    });
    const { rows } = await client.query<RawMembershipClaimIdentityRow>(
      `
        SELECT
          s.scope_id,
          s.scope_key,
          s.scope_kind,
          i.canonical_identity,
          i.account_id,
          i.state,
          i.reservation_id,
          i.package_id,
          i.assignment_id,
          i.grant_id,
          i.matched_email_address,
          i.claimed_domain,
          i.reservation_expires_at,
          i.activated_at,
          i.revoked_at,
          i.metadata,
          i.created,
          i.updated
        FROM ${CLAIM_IDENTITY_TABLE} i
        JOIN ${CLAIM_SCOPE_TABLE} s
          ON s.scope_id = i.scope_id
        WHERE i.scope_id = $1
          AND i.canonical_identity = $2
        FOR UPDATE
      `,
      [scope.scope_id, normalizedCanonicalIdentity],
    );
    const existing = normalizeMembershipClaimIdentityRow(rows[0]);
    const now = new Date();
    if (existing != null) {
      if (
        existing.state === CLAIM_STATE_ACTIVE &&
        existing.account_id === account_id
      ) {
        throw Error("institutional membership already claimed on this account");
      }
      if (existing.state === CLAIM_STATE_ACTIVE) {
        throw Error(
          "institutional membership already claimed on another account",
        );
      }
      if (
        existing.state === CLAIM_STATE_PENDING &&
        !isPendingReservationExpired(existing, now) &&
        existing.account_id !== account_id
      ) {
        throw Error(
          "institutional membership claim is already pending on another account",
        );
      }
    }

    const nextReservationId = `${reservation_id ?? ""}`.trim() || uuid();
    const { rows: upsertedRows } =
      await client.query<RawMembershipClaimIdentityRow>(
        `
        INSERT INTO ${CLAIM_IDENTITY_TABLE}
          (
            scope_id,
            canonical_identity,
            account_id,
            state,
            reservation_id,
            package_id,
            assignment_id,
            grant_id,
            matched_email_address,
            claimed_domain,
            reservation_expires_at,
            activated_at,
            revoked_at,
            metadata,
            created,
            updated
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            NULL,
            NULL,
            NULL,
            $6,
            $7,
            NOW() + ($8 * INTERVAL '1 millisecond'),
            NULL,
            NULL,
            $9::jsonb,
            NOW(),
            NOW()
          )
        ON CONFLICT (scope_id, canonical_identity) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          state = EXCLUDED.state,
          reservation_id = EXCLUDED.reservation_id,
          package_id = NULL,
          assignment_id = NULL,
          grant_id = NULL,
          matched_email_address = EXCLUDED.matched_email_address,
          claimed_domain = EXCLUDED.claimed_domain,
          reservation_expires_at = EXCLUDED.reservation_expires_at,
          activated_at = NULL,
          revoked_at = NULL,
          metadata = EXCLUDED.metadata,
          updated = NOW()
        RETURNING
          $2 AS canonical_identity,
          $3 AS account_id,
          $4 AS state,
          reservation_id
      `,
        [
          scope.scope_id,
          normalizedCanonicalIdentity,
          account_id,
          CLAIM_STATE_PENDING,
          nextReservationId,
          normalizedMatchedEmail,
          normalizedClaimedDomain,
          ttlMs,
          normalizeMetadata(metadata),
        ],
      );
    const upsertedRow = upsertedRows[0];
    if (!upsertedRow?.reservation_id) {
      throw Error("failed to reserve institutional claim identity");
    }
    return {
      scope_id: scope.scope_id,
      reservation_id: upsertedRow.reservation_id,
    };
  });
}

export async function reserveMembershipClaimIdentity(
  opts: MembershipClaimIdentityReserveRequest,
): Promise<MembershipClaimIdentityReserveResult> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await reserveMembershipClaimIdentityDirect(opts);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).reserveMembershipClaimIdentity(opts);
}

export async function activateMembershipClaimIdentityDirect({
  scope_key,
  scope_kind,
  canonical_identity,
  account_id,
  reservation_id,
  package_id,
  assignment_id,
  grant_id,
  matched_email_address,
  claimed_domain,
  metadata,
}: MembershipClaimIdentityActivateRequest): Promise<void> {
  await withClaimDirectoryTransaction(async (client) => {
    const normalizedScopeKey = normalizeScopeKey(scope_key);
    const normalizedScopeKind = normalizeScopeKind(scope_kind);
    const normalizedCanonicalIdentity =
      normalizeEmailAddress(canonical_identity);
    const normalizedMatchedEmail = normalizeEmailAddress(matched_email_address);
    const normalizedClaimedDomain = normalizeClaimedDomain(claimed_domain);
    const scope = await getOrCreateClaimScope({
      scope_key: normalizedScopeKey,
      scope_kind: normalizedScopeKind,
      metadata,
      client,
    });
    const { rows } = await client.query<RawMembershipClaimIdentityRow>(
      `
        SELECT
          s.scope_id,
          s.scope_key,
          s.scope_kind,
          i.canonical_identity,
          i.account_id,
          i.state,
          i.reservation_id,
          i.package_id,
          i.assignment_id,
          i.grant_id,
          i.matched_email_address,
          i.claimed_domain,
          i.reservation_expires_at,
          i.activated_at,
          i.revoked_at,
          i.metadata,
          i.created,
          i.updated
        FROM ${CLAIM_IDENTITY_TABLE} i
        JOIN ${CLAIM_SCOPE_TABLE} s
          ON s.scope_id = i.scope_id
        WHERE i.scope_id = $1
          AND i.canonical_identity = $2
        FOR UPDATE
      `,
      [scope.scope_id, normalizedCanonicalIdentity],
    );
    const existing = normalizeMembershipClaimIdentityRow(rows[0]);
    if (
      existing != null &&
      existing.state === CLAIM_STATE_ACTIVE &&
      existing.account_id !== account_id
    ) {
      throw Error(
        "institutional membership already claimed on another account",
      );
    }
    if (
      existing != null &&
      existing.state === CLAIM_STATE_ACTIVE &&
      existing.account_id === account_id &&
      existing.assignment_id != null &&
      existing.assignment_id !== assignment_id
    ) {
      throw Error("institutional membership already claimed on this account");
    }
    const nextReservationId = `${reservation_id ?? ""}`.trim() || uuid();
    await client.query(
      `
        INSERT INTO ${CLAIM_IDENTITY_TABLE}
          (
            scope_id,
            canonical_identity,
            account_id,
            state,
            reservation_id,
            package_id,
            assignment_id,
            grant_id,
            matched_email_address,
            claimed_domain,
            reservation_expires_at,
            activated_at,
            revoked_at,
            metadata,
            created,
            updated
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            NULL,
            NOW(),
            NULL,
            $11::jsonb,
            NOW(),
            NOW()
          )
        ON CONFLICT (scope_id, canonical_identity) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          state = EXCLUDED.state,
          reservation_id = EXCLUDED.reservation_id,
          package_id = EXCLUDED.package_id,
          assignment_id = EXCLUDED.assignment_id,
          grant_id = EXCLUDED.grant_id,
          matched_email_address = EXCLUDED.matched_email_address,
          claimed_domain = EXCLUDED.claimed_domain,
          reservation_expires_at = NULL,
          activated_at = NOW(),
          revoked_at = NULL,
          metadata = EXCLUDED.metadata,
          updated = NOW()
      `,
      [
        scope.scope_id,
        normalizedCanonicalIdentity,
        account_id,
        CLAIM_STATE_ACTIVE,
        nextReservationId,
        package_id,
        assignment_id,
        grant_id ?? null,
        normalizedMatchedEmail,
        normalizedClaimedDomain,
        normalizeMetadata(metadata),
      ],
    );
  });
}

export async function activateMembershipClaimIdentity(
  opts: MembershipClaimIdentityActivateRequest,
): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await activateMembershipClaimIdentityDirect(opts);
    return;
  }
  await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).activateMembershipClaimIdentity(opts);
}

export async function revokeMembershipClaimIdentityDirect({
  scope_key,
  canonical_identity,
  account_id,
  assignment_id,
  reservation_id,
  revoked_at,
}: MembershipClaimIdentityRevokeRequest): Promise<void> {
  await withClaimDirectoryTransaction(async (client) => {
    const normalizedScopeKey = normalizeScopeKey(scope_key);
    const normalizedCanonicalIdentity =
      normalizeEmailAddress(canonical_identity);
    const { rows } = await client.query<RawMembershipClaimIdentityRow>(
      `
        SELECT
          s.scope_id,
          s.scope_key,
          s.scope_kind,
          i.canonical_identity,
          i.account_id,
          i.state,
          i.reservation_id,
          i.package_id,
          i.assignment_id,
          i.grant_id,
          i.matched_email_address,
          i.claimed_domain,
          i.reservation_expires_at,
          i.activated_at,
          i.revoked_at,
          i.metadata,
          i.created,
          i.updated
        FROM ${CLAIM_IDENTITY_TABLE} i
        JOIN ${CLAIM_SCOPE_TABLE} s
          ON s.scope_id = i.scope_id
        WHERE s.scope_key = $1
          AND i.canonical_identity = $2
        FOR UPDATE
      `,
      [normalizedScopeKey, normalizedCanonicalIdentity],
    );
    const existing = normalizeMembershipClaimIdentityRow(rows[0]);
    if (existing == null || existing.account_id !== account_id) {
      return;
    }
    const normalizedReservationId = `${reservation_id ?? ""}`.trim() || null;
    const matchesActiveAssignment =
      existing.state === CLAIM_STATE_ACTIVE &&
      existing.assignment_id != null &&
      existing.assignment_id === assignment_id;
    const matchesPendingReservation =
      existing.state === CLAIM_STATE_PENDING &&
      normalizedReservationId != null &&
      existing.reservation_id === normalizedReservationId;
    if (!matchesActiveAssignment && !matchesPendingReservation) {
      return;
    }
    await client.query(
      `
        UPDATE ${CLAIM_IDENTITY_TABLE}
        SET state = $3,
            reservation_expires_at = NULL,
            revoked_at = COALESCE($4, NOW()),
            updated = NOW()
        WHERE scope_id = $1
          AND canonical_identity = $2
      `,
      [
        existing.scope_id,
        normalizedCanonicalIdentity,
        CLAIM_STATE_REVOKED,
        normalizeOptionalDateLike(revoked_at),
      ],
    );
  });
}

function normalizeOptionalDateLike(
  value?: string | number | Date | null,
): string | Date | null | undefined {
  if (typeof value === "number") {
    return new Date(value);
  }
  return value;
}

export async function revokeMembershipClaimIdentity(
  opts: MembershipClaimIdentityRevokeRequest,
): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await revokeMembershipClaimIdentityDirect(opts);
    return;
  }
  await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).revokeMembershipClaimIdentity(opts);
}
