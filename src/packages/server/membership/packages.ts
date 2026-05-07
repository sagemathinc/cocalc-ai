/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
  withAccountRehomeWriteFence,
} from "@cocalc/server/accounts/rehome-fence";
import type {
  ClaimableMembershipPackage,
  MembershipClass,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageKind,
  MembershipPackageQuote,
  MembershipPackageRecord,
} from "@cocalc/conat/hub/api/purchases";
import type { CourseInfo } from "@cocalc/util/db-schema/projects";
import type { MembershipPackageProduct } from "@cocalc/util/db-schema/shopping-cart-items";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import {
  is_valid_email_address as isValidEmailAddress,
  isValidUUID,
  uuid,
} from "@cocalc/util/misc";
import { DEFAULT_PURCHASE_INFO } from "@cocalc/util/purchases/quota/student-pay";
import type { PurchaseInfo } from "@cocalc/util/purchases/quota/types";
import { getCost as getCoursePayCost } from "@cocalc/server/purchases/student-pay";
import { createMembershipGrant } from "./grants";
import { getMembershipPrice, getMembershipTierById } from "./tiers";

type Queryable = PoolClient | ReturnType<typeof getPool>;

interface RawMembershipPackageRecord {
  id: string;
  owner_account_id: string;
  kind: string;
  membership_class: MembershipClass;
  seat_count: number;
  purchase_id?: number | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
  updated?: Date | string;
}

interface RawMembershipPackageAssignment {
  id: string;
  package_id: string;
  account_id?: string | null;
  email_address?: string | null;
  assigned_by_account_id?: string | null;
  assigned_at?: Date | string;
  revoked_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  grant_id?: string | null;
  grant_source?: string | null;
  grant_purchase_id?: number | null;
}

const MEMBERSHIP_PACKAGE_KINDS = new Set<MembershipPackageKind>([
  "course",
  "team",
  "domain",
  "site",
]);

function getQueryClient(client?: PoolClient): Queryable {
  return client ?? getPool();
}

async function assertAccountPackageWriteAllowed({
  account_id,
  action,
  client,
}: {
  account_id: string;
  action: string;
  client: PoolClient;
}): Promise<void> {
  await assertAccountNotRehoming({
    db: client,
    account_id,
    action,
  });
  await assertAccountWriteOnHomeBay({
    db: client,
    account_id,
    action,
  });
}

function normalizePackageKind(kind?: string): MembershipPackageKind {
  if (!kind || !MEMBERSHIP_PACKAGE_KINDS.has(kind as MembershipPackageKind)) {
    throw Error(`unsupported membership package kind '${kind}'`);
  }
  return kind as MembershipPackageKind;
}

function normalizeSeatCount(seat_count: number): number {
  if (!Number.isInteger(seat_count) || seat_count <= 0) {
    throw Error("seat_count must be a positive integer");
  }
  return seat_count;
}

function normalizeMetadata(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (metadata == null) return null;
  return { ...metadata };
}

function normalizeEmailAddress(
  email_address?: string | null,
): string | undefined {
  const value = `${email_address ?? ""}`.trim().toLowerCase();
  if (!value) return;
  if (!isValidEmailAddress(value)) {
    throw Error("invalid email address");
  }
  return value;
}

function asDate(value?: Date | string | null): Date | undefined {
  if (value == null) return;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`invalid date '${value}'`);
  }
  return date;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
}

function normalizePackageRecord(
  row: RawMembershipPackageRecord | undefined,
): MembershipPackageRecord | undefined {
  if (!row) return;
  return {
    ...row,
    kind: normalizePackageKind(row.kind),
    seat_count: Number(row.seat_count),
    starts_at: asDate(row.starts_at),
    expires_at: asDate(row.expires_at),
    metadata: normalizeMetadata(row.metadata),
    created: asDate(row.created),
    updated: asDate(row.updated),
  };
}

function normalizeAssignmentRecord(
  row: RawMembershipPackageAssignment,
): MembershipPackageAssignment {
  return {
    ...row,
    account_id: row.account_id ?? undefined,
    email_address: row.email_address ?? undefined,
    assigned_at: asDate(row.assigned_at),
    revoked_at: asDate(row.revoked_at),
    metadata: normalizeMetadata(row.metadata),
  };
}

function grantSourceForKind(kind: MembershipPackageKind): string {
  switch (kind) {
    case "course":
      return "course-seat";
    case "team":
      return "team-seat";
    case "domain":
      return "domain-license";
    case "site":
      return "site-license";
  }
}

function getPackageDomains(
  metadata?: Record<string, unknown> | null,
): string[] {
  const candidates = [
    metadata?.allowed_domains,
    metadata?.domains,
    metadata?.email_domains,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((value) => `${value ?? ""}`.trim().toLowerCase())
        .filter((value) => value.length > 0);
    }
  }
  return [];
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
    .map((value) => normalizeEmailAddress(value))
    .filter((value): value is string => !!value);
  if (
    emails.length === 0 &&
    row.email_address &&
    verified?.[row.email_address] != null
  ) {
    const normalized = normalizeEmailAddress(row.email_address);
    return normalized ? [normalized] : [];
  }
  return Array.from(new Set(emails));
}

async function createGrantForAssignment({
  package_id,
  account_id,
  assigned_by_account_id,
  assignment_id,
  metadata,
  client,
}: {
  package_id: string;
  account_id: string;
  assigned_by_account_id?: string | null;
  assignment_id: string;
  metadata?: Record<string, unknown> | null;
  client?: PoolClient;
}): Promise<{
  grant_id: string;
  grant_source: string;
  grant_purchase_id?: number | null;
}> {
  const pkg = await getMembershipPackage({ package_id, client });
  if (!pkg) {
    throw Error("membership package not found");
  }
  const grant_id = uuid();
  await createMembershipGrant(
    {
      id: grant_id,
      account_id,
      membership_class: pkg.membership_class,
      source: grantSourceForKind(pkg.kind),
      package_id,
      purchase_id: pkg.purchase_id ?? null,
      granted_by_account_id: assigned_by_account_id ?? null,
      starts_at: pkg.starts_at,
      expires_at: pkg.expires_at,
      metadata: {
        ...normalizeMetadata(metadata),
        assignment_id,
      },
    },
    client,
  );
  return {
    grant_id,
    grant_source: grantSourceForKind(pkg.kind),
    grant_purchase_id: pkg.purchase_id ?? null,
  };
}

async function withPackageOwnerWriteFence<T>({
  package_id,
  action,
  client,
  fn,
}: {
  package_id: string;
  action: string;
  client?: PoolClient;
  fn: (opts: {
    client: PoolClient;
    pkg: MembershipPackageRecord;
  }) => Promise<T>;
}): Promise<T> {
  const pkg = await getMembershipPackage({ package_id, client });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (client != null) {
    await assertAccountPackageWriteAllowed({
      account_id: pkg.owner_account_id,
      action,
      client,
    });
    return await fn({ client, pkg });
  }
  return await withAccountRehomeWriteFence({
    account_id: pkg.owner_account_id,
    action,
    fn: async (db) => await fn({ client: db as PoolClient, pkg }),
  });
}

async function getCourseSeatQuote({
  product,
  course_project_id,
  client,
}: {
  product: MembershipPackageProduct;
  course_project_id: string;
  client?: PoolClient;
}): Promise<MembershipPackageQuote> {
  const { rows } = await getQueryClient(client).query(
    `SELECT course, title
     FROM projects
     WHERE project_id=$1`,
    [course_project_id],
  );
  const row = rows[0];
  if (!row) {
    throw Error("course project not found");
  }
  const course = row.course as CourseInfo | undefined;
  if (!course?.payInfo) {
    throw Error("course pay configuration not found");
  }
  const purchaseInfo = {
    ...DEFAULT_PURCHASE_INFO,
    ...course.payInfo,
  } as PurchaseInfo;
  if (purchaseInfo.type !== "quota") {
    throw Error("course seat packages require quota-based payInfo");
  }
  if (purchaseInfo.start == null || purchaseInfo.end == null) {
    throw Error("course payInfo must define start and end");
  }
  const seat_price = toDecimal(getCoursePayCost(purchaseInfo)).toNumber();
  return {
    kind: "course",
    membership_class: "student",
    seat_count: normalizeSeatCount(product.seat_count),
    seat_price,
    total_price: moneyRound2Up(
      toDecimal(seat_price).mul(product.seat_count),
    ).toNumber(),
    starts_at: asDate(purchaseInfo.start),
    expires_at: asDate(purchaseInfo.end),
    interval: product.interval,
    metadata: {
      ...normalizeMetadata(product.metadata),
      course_project_id,
      course_path: course.path,
      course_title: row.title,
      payInfo: purchaseInfo,
      seat_price,
    },
  };
}

async function getTierSeatQuote({
  product,
  membership_class,
  interval,
  starts_at,
  expires_at,
  client,
}: {
  product: MembershipPackageProduct;
  membership_class: MembershipClass;
  interval: "month" | "year";
  starts_at?: Date;
  expires_at?: Date;
  client?: PoolClient;
}): Promise<MembershipPackageQuote> {
  const tier = await getMembershipTierById({
    id: membership_class,
    client,
  });
  if (!tier || tier.disabled) {
    throw Error(`membership tier "${membership_class}" is not available`);
  }
  const seat_price = getMembershipPrice(tier, interval);
  const start = starts_at ?? new Date();
  const end =
    expires_at ??
    (interval === "month"
      ? dayjs(start).add(1, "month").toDate()
      : dayjs(start).add(1, "year").toDate());
  return {
    kind: normalizePackageKind(product.kind),
    membership_class,
    seat_count: normalizeSeatCount(product.seat_count),
    seat_price,
    total_price: moneyRound2Up(
      toDecimal(seat_price).mul(product.seat_count),
    ).toNumber(),
    starts_at: start,
    expires_at: end,
    interval,
    metadata: {
      ...normalizeMetadata(product.metadata),
      interval,
      seat_price,
    },
  };
}

export async function resolveMembershipPackageQuote(
  product: MembershipPackageProduct,
  client?: PoolClient,
): Promise<MembershipPackageQuote> {
  const kind = normalizePackageKind(product.kind);
  const seat_count = normalizeSeatCount(product.seat_count);
  if (product.package_id) {
    const existing = await getMembershipPackage({
      package_id: product.package_id,
      client,
    });
    if (!existing) {
      throw Error("membership package not found");
    }
    const seat_price =
      toNumber(existing.metadata?.seat_price) ??
      (existing.kind === "course" &&
      isValidUUID(`${existing.metadata?.course_project_id ?? ""}`)
        ? (
            await getCourseSeatQuote({
              product,
              course_project_id: `${existing.metadata?.course_project_id}`,
              client,
            })
          ).seat_price
        : (
            await getTierSeatQuote({
              product,
              membership_class: existing.membership_class,
              interval:
                (`${existing.metadata?.interval ?? product.interval ?? ""}` ===
                "year"
                  ? "year"
                  : "month") as "month" | "year",
              starts_at: existing.starts_at,
              expires_at: existing.expires_at ?? undefined,
              client,
            })
          ).seat_price);
    return {
      package_id: existing.id,
      kind: existing.kind,
      membership_class: existing.membership_class,
      seat_count,
      seat_price,
      total_price: moneyRound2Up(
        toDecimal(seat_price).mul(seat_count),
      ).toNumber(),
      starts_at: existing.starts_at,
      expires_at: existing.expires_at ?? undefined,
      interval:
        `${existing.metadata?.interval ?? product.interval ?? ""}` === "year"
          ? "year"
          : `${existing.metadata?.interval ?? product.interval ?? ""}` ===
              "month"
            ? "month"
            : undefined,
      metadata: normalizeMetadata(existing.metadata),
    };
  }

  if (kind === "course") {
    const course_project_id = `${product.course_project_id ?? ""}`.trim();
    if (!isValidUUID(course_project_id)) {
      throw Error("course_project_id is required for course packages");
    }
    return await getCourseSeatQuote({
      product: { ...product, kind, seat_count },
      course_project_id,
      client,
    });
  }

  const interval = product.interval;
  if (interval !== "month" && interval !== "year") {
    throw Error("interval must be 'month' or 'year'");
  }
  const membership_class = `${product.membership_class ?? ""}`.trim();
  if (!membership_class) {
    throw Error("membership_class is required");
  }
  return await getTierSeatQuote({
    product: { ...product, kind, seat_count },
    membership_class,
    interval,
    starts_at: asDate(product.starts_at),
    expires_at: asDate(product.expires_at),
    client,
  });
}

export async function createMembershipPackage(
  {
    id = uuid(),
    owner_account_id,
    kind,
    membership_class,
    seat_count,
    purchase_id,
    starts_at,
    expires_at,
    metadata,
  }: {
    id?: string;
    owner_account_id: string;
    kind: MembershipPackageKind;
    membership_class: MembershipClass;
    seat_count: number;
    purchase_id?: number | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
  },
  client?: PoolClient,
): Promise<string> {
  if (client == null) {
    return await withAccountRehomeWriteFence({
      account_id: owner_account_id,
      action: "create membership package",
      fn: async (db) =>
        await createMembershipPackage(
          {
            id,
            owner_account_id,
            kind,
            membership_class,
            seat_count,
            purchase_id,
            starts_at,
            expires_at,
            metadata,
          },
          db as PoolClient,
        ),
    });
  }
  await assertAccountPackageWriteAllowed({
    account_id: owner_account_id,
    action: "create membership package",
    client,
  });
  await getQueryClient(client).query(
    `
      INSERT INTO membership_packages
        (id, owner_account_id, kind, membership_class, seat_count, purchase_id,
         starts_at, expires_at, metadata, created, updated)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
    `,
    [
      id,
      owner_account_id,
      normalizePackageKind(kind),
      membership_class,
      normalizeSeatCount(seat_count),
      purchase_id ?? null,
      starts_at ?? null,
      expires_at ?? null,
      normalizeMetadata(metadata),
    ],
  );
  return id;
}

export async function addMembershipPackageSeats(
  {
    package_id,
    seat_count,
  }: {
    package_id: string;
    seat_count: number;
  },
  client?: PoolClient,
): Promise<number> {
  return await withPackageOwnerWriteFence({
    package_id,
    action: "expand membership package",
    client,
    fn: async ({ client: dbClient }) => {
      const delta = normalizeSeatCount(seat_count);
      const { rows } = await getQueryClient(dbClient).query(
        `
          UPDATE membership_packages
          SET seat_count = seat_count + $2,
              updated = NOW()
          WHERE id = $1
          RETURNING seat_count
        `,
        [package_id, delta],
      );
      if (!rows[0]) {
        throw Error("membership package not found");
      }
      return rows[0].seat_count;
    },
  });
}

export async function setMembershipPackagePurchaseId(
  {
    package_id,
    purchase_id,
  }: {
    package_id: string;
    purchase_id: number;
  },
  client?: PoolClient,
): Promise<void> {
  await withPackageOwnerWriteFence({
    package_id,
    action: "update membership package purchase",
    client,
    fn: async ({ client: dbClient }) => {
      await getQueryClient(dbClient).query(
        `UPDATE membership_packages
         SET purchase_id=$2, updated=NOW()
         WHERE id=$1`,
        [package_id, purchase_id],
      );
    },
  });
}

export async function getMembershipPackage({
  package_id,
  client,
}: {
  package_id: string;
  client?: PoolClient;
}): Promise<MembershipPackageRecord | undefined> {
  const { rows } = await getQueryClient(
    client,
  ).query<RawMembershipPackageRecord>(
    `
      SELECT
        id,
        owner_account_id,
        kind,
        membership_class,
        seat_count,
        purchase_id,
        starts_at,
        expires_at,
        metadata,
        created,
        updated
      FROM membership_packages
      WHERE id=$1
    `,
    [package_id],
  );
  return normalizePackageRecord(rows[0]);
}

export async function listMembershipPackagesForOwner({
  owner_account_id,
  client,
}: {
  owner_account_id: string;
  client?: PoolClient;
}): Promise<MembershipPackageRecord[]> {
  const { rows } = await getQueryClient(
    client,
  ).query<RawMembershipPackageRecord>(
    `
      SELECT
        id,
        owner_account_id,
        kind,
        membership_class,
        seat_count,
        purchase_id,
        starts_at,
        expires_at,
        metadata,
        created,
        updated
      FROM membership_packages
      WHERE owner_account_id=$1
      ORDER BY created DESC
    `,
    [owner_account_id],
  );
  return rows
    .map((row) => normalizePackageRecord(row))
    .filter((row) => row != null);
}

export async function listMembershipPackageAssignments({
  package_id,
  include_revoked = false,
  client,
}: {
  package_id: string;
  include_revoked?: boolean;
  client?: PoolClient;
}): Promise<MembershipPackageAssignment[]> {
  const { rows } = await getQueryClient(
    client,
  ).query<RawMembershipPackageAssignment>(
    `
      SELECT
        a.id,
        a.package_id,
        a.account_id,
        a.email_address,
        a.assigned_by_account_id,
        a.assigned_at,
        a.revoked_at,
        a.metadata,
        g.id AS grant_id,
        g.source AS grant_source,
        g.purchase_id AS grant_purchase_id
      FROM membership_package_assignments a
      LEFT JOIN membership_grants g
        ON g.package_id = a.package_id
       AND g.account_id = a.account_id
       AND g.revoked_at IS NULL
       AND (g.metadata->>'assignment_id' = a.id::text OR g.metadata->>'assignment_id' IS NULL)
      WHERE a.package_id = $1
        AND ($2::boolean OR a.revoked_at IS NULL)
      ORDER BY a.assigned_at DESC NULLS LAST, a.created DESC NULLS LAST
    `,
    [package_id, include_revoked],
  );
  return rows.map(normalizeAssignmentRecord);
}

export async function listMembershipPackageDetailsForOwner({
  owner_account_id,
  client,
}: {
  owner_account_id: string;
  client?: PoolClient;
}): Promise<MembershipPackageDetails[]> {
  const packages = await listMembershipPackagesForOwner({
    owner_account_id,
    client,
  });
  const details: MembershipPackageDetails[] = [];
  for (const pkg of packages) {
    const assignments = await listMembershipPackageAssignments({
      package_id: pkg.id,
      include_revoked: true,
      client,
    });
    const active_assignment_count = assignments.filter(
      (assignment) => !assignment.revoked_at,
    ).length;
    details.push({
      ...pkg,
      assignments,
      active_assignment_count,
      available_seat_count: Math.max(
        0,
        pkg.seat_count - active_assignment_count,
      ),
    });
  }
  return details;
}

async function getActiveSeatCountAndLimit(
  package_id: string,
  client?: PoolClient,
): Promise<{ activeSeatCount: number; activeSeatLimit: number }> {
  const countResult = await getQueryClient(client).query(
    `
      SELECT
        COUNT(*)::int AS count,
        (
          SELECT seat_count::int
          FROM membership_packages
          WHERE id = $1
        ) AS seat_limit
      FROM membership_package_assignments
      WHERE package_id = $1
        AND revoked_at IS NULL
    `,
    [package_id],
  );
  return {
    activeSeatCount: Number(countResult.rows[0]?.count ?? 0),
    activeSeatLimit: Number(countResult.rows[0]?.seat_limit ?? 0),
  };
}

export async function assignMembershipPackageSeat(
  {
    package_id,
    account_id,
    email_address,
    assigned_by_account_id,
    metadata,
  }: {
    package_id: string;
    account_id?: string;
    email_address?: string;
    assigned_by_account_id: string;
    metadata?: Record<string, unknown> | null;
  },
  client?: PoolClient,
): Promise<MembershipPackageAssignment> {
  return await withPackageOwnerWriteFence({
    package_id,
    action: "assign membership package seat",
    client,
    fn: async ({ client: dbClient, pkg }) => {
      const pool = getQueryClient(dbClient);
      const normalizedAccountId = `${account_id ?? ""}`.trim() || undefined;
      const normalizedEmailAddress = normalizeEmailAddress(email_address);
      if (!normalizedAccountId && !normalizedEmailAddress) {
        throw Error("account_id or email_address required");
      }
      if (pkg.expires_at && pkg.expires_at <= new Date()) {
        throw Error("membership package has expired");
      }

      const existing = await listMembershipPackageAssignments({
        package_id,
        include_revoked: false,
        client: dbClient,
      });
      const existingAssignment = existing.find(
        (assignment) =>
          (normalizedAccountId &&
            assignment.account_id === normalizedAccountId) ||
          (normalizedEmailAddress &&
            assignment.email_address === normalizedEmailAddress),
      );
      if (existingAssignment) {
        return existingAssignment;
      }
      const { activeSeatCount, activeSeatLimit } =
        await getActiveSeatCountAndLimit(package_id, dbClient);
      if (activeSeatCount >= activeSeatLimit) {
        throw Error("no seats available in membership package");
      }

      const assignment_id = uuid();
      const assignmentMetadata = {
        ...normalizeMetadata(metadata),
      };
      await pool.query(
        `
          INSERT INTO membership_package_assignments
            (id, package_id, account_id, email_address, assigned_by_account_id, assigned_at, metadata, created, updated)
          VALUES
            ($1, $2, $3, $4, $5, NOW(), $6::jsonb, NOW(), NOW())
        `,
        [
          assignment_id,
          package_id,
          normalizedAccountId ?? null,
          normalizedEmailAddress ?? null,
          assigned_by_account_id,
          assignmentMetadata,
        ],
      );
      let grantInfo:
        | {
            grant_id: string;
            grant_source: string;
            grant_purchase_id?: number | null;
          }
        | undefined;
      if (normalizedAccountId) {
        grantInfo = await createGrantForAssignment({
          package_id,
          account_id: normalizedAccountId,
          assigned_by_account_id,
          assignment_id,
          metadata,
          client: dbClient,
        });
        const project_id = `${metadata?.project_id ?? ""}`.trim();
        if (pkg.kind === "course" && isValidUUID(project_id)) {
          const result = await pool.query(
            "UPDATE projects SET usage_account_id=$2 WHERE project_id=$1 RETURNING project_id",
            [project_id, normalizedAccountId],
          );
          if (!result.rows[0]) {
            throw Error(
              `cannot assign course package seat for project ${project_id}; route this write to the project-owning bay first`,
            );
          }
        }
      }

      return {
        id: assignment_id,
        package_id,
        account_id: normalizedAccountId,
        email_address: normalizedEmailAddress,
        assigned_by_account_id,
        assigned_at: new Date(),
        revoked_at: undefined,
        metadata: assignmentMetadata,
        grant_id: grantInfo?.grant_id,
        grant_source: grantInfo?.grant_source,
        grant_purchase_id: grantInfo?.grant_purchase_id,
      };
    },
  });
}

export async function revokeMembershipPackageSeat(
  {
    package_id,
    account_id,
    email_address,
  }: {
    package_id: string;
    account_id?: string;
    email_address?: string;
  },
  client?: PoolClient,
): Promise<boolean> {
  return await withPackageOwnerWriteFence({
    package_id,
    action: "revoke membership package seat",
    client,
    fn: async ({ client: dbClient, pkg }) => {
      const pool = getQueryClient(dbClient);
      const normalizedAccountId = `${account_id ?? ""}`.trim() || undefined;
      const normalizedEmailAddress = normalizeEmailAddress(email_address);
      if (!normalizedAccountId && !normalizedEmailAddress) {
        throw Error("account_id or email_address required");
      }
      const assignments = await listMembershipPackageAssignments({
        package_id,
        include_revoked: false,
        client: dbClient,
      });
      const assignment = assignments.find(
        (row) =>
          (normalizedAccountId && row.account_id === normalizedAccountId) ||
          (normalizedEmailAddress &&
            row.email_address === normalizedEmailAddress),
      );
      if (!assignment) {
        return false;
      }
      if (assignment.account_id) {
        await assertAccountPackageWriteAllowed({
          account_id: assignment.account_id,
          action: "revoke membership package seat grant",
          client: dbClient,
        });
      }
      await pool.query(
        `
          UPDATE membership_package_assignments
          SET revoked_at = NOW(), updated = NOW()
          WHERE id = $1
        `,
        [assignment.id],
      );
      await pool.query(
        `
          UPDATE membership_grants
          SET revoked_at = NOW(), updated = NOW()
          WHERE package_id = $1
            AND account_id = $2
            AND revoked_at IS NULL
            AND (metadata->>'assignment_id' = $3::text OR metadata->>'assignment_id' IS NULL)
        `,
        [package_id, assignment.account_id ?? null, assignment.id],
      );
      const project_id = `${assignment.metadata?.project_id ?? ""}`.trim();
      if (
        pkg.kind === "course" &&
        isValidUUID(project_id) &&
        assignment.account_id
      ) {
        const result = await pool.query(
          "UPDATE projects SET usage_account_id=NULL WHERE project_id=$1 AND usage_account_id=$2 RETURNING project_id",
          [project_id, assignment.account_id],
        );
        if (!result.rows[0]) {
          throw Error(
            `cannot revoke course package seat for project ${project_id}; route this write to the project-owning bay first`,
          );
        }
      }
      return true;
    },
  });
}

export async function listClaimableMembershipPackagesForAccount({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<ClaimableMembershipPackage[]> {
  const verifiedEmailAddresses = await getVerifiedEmailAddressesForAccount(
    account_id,
    client,
  );
  if (verifiedEmailAddresses.length === 0) {
    return [];
  }
  const emailSet = new Set(verifiedEmailAddresses);
  const pool = getQueryClient(client);
  const { rows } = await pool.query<RawMembershipPackageRecord>(
    `
      SELECT
        id,
        owner_account_id,
        kind,
        membership_class,
        seat_count,
        purchase_id,
        starts_at,
        expires_at,
        metadata,
        created,
        updated
      FROM membership_packages
      WHERE (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
    `,
  );
  const allPackages = rows
    .map((row) => normalizePackageRecord(row))
    .filter((row): row is MembershipPackageRecord => !!row);
  const claimables = new Map<string, ClaimableMembershipPackage>();
  for (const pkg of allPackages) {
    const assignments = await listMembershipPackageAssignments({
      package_id: pkg.id,
      include_revoked: false,
      client,
    });
    if (
      assignments.some((assignment) => assignment.account_id === account_id)
    ) {
      continue;
    }
    const active_assignment_count = assignments.filter(
      (assignment) => !assignment.revoked_at,
    ).length;
    const available_seat_count = Math.max(
      0,
      pkg.seat_count - active_assignment_count,
    );
    for (const assignment of assignments) {
      if (
        assignment.account_id == null &&
        assignment.email_address &&
        emailSet.has(assignment.email_address)
      ) {
        claimables.set(pkg.id, {
          package_id: pkg.id,
          assignment_id: assignment.id,
          kind: pkg.kind,
          membership_class: pkg.membership_class,
          owner_account_id: pkg.owner_account_id,
          starts_at: pkg.starts_at,
          expires_at: pkg.expires_at ?? null,
          available_seat_count,
          matched_email_address: assignment.email_address,
          reason: "email-assignment",
          metadata: normalizeMetadata(pkg.metadata),
        });
      }
    }
    if (
      !claimables.has(pkg.id) &&
      available_seat_count > 0 &&
      (pkg.kind === "domain" || pkg.kind === "site")
    ) {
      const allowedDomains = new Set(getPackageDomains(pkg.metadata));
      if (allowedDomains.size === 0) {
        continue;
      }
      const matchedEmailAddress = verifiedEmailAddresses.find((email) =>
        allowedDomains.has(email.split("@")[1] ?? ""),
      );
      if (matchedEmailAddress) {
        claimables.set(pkg.id, {
          package_id: pkg.id,
          kind: pkg.kind,
          membership_class: pkg.membership_class,
          owner_account_id: pkg.owner_account_id,
          starts_at: pkg.starts_at,
          expires_at: pkg.expires_at ?? null,
          available_seat_count,
          matched_email_address: matchedEmailAddress,
          reason: "domain-match",
          metadata: normalizeMetadata(pkg.metadata),
        });
      }
    }
  }
  return Array.from(claimables.values()).sort((left, right) => {
    const rightStart = right.starts_at?.getTime() ?? 0;
    const leftStart = left.starts_at?.getTime() ?? 0;
    return (
      rightStart - leftStart || `${left.kind}`.localeCompare(`${right.kind}`)
    );
  });
}

export async function claimMembershipPackageSeat({
  package_id,
  account_id,
  client,
}: {
  package_id: string;
  account_id: string;
  client?: PoolClient;
}): Promise<MembershipPackageAssignment> {
  return await withPackageOwnerWriteFence({
    package_id,
    action: "claim membership package seat",
    client,
    fn: async ({ client: dbClient, pkg }) => {
      const pool = getQueryClient(dbClient);
      if (pkg.expires_at && pkg.expires_at <= new Date()) {
        throw Error("membership package has expired");
      }
      const verifiedEmailAddresses = await getVerifiedEmailAddressesForAccount(
        account_id,
        dbClient,
      );
      if (verifiedEmailAddresses.length === 0) {
        throw Error("verify an email address before claiming this package");
      }
      const assignments = await listMembershipPackageAssignments({
        package_id,
        include_revoked: false,
        client: dbClient,
      });
      const existing = assignments.find(
        (assignment) => assignment.account_id === account_id,
      );
      if (existing) {
        return existing;
      }

      const emailSet = new Set(verifiedEmailAddresses);
      const pendingAssignment = assignments.find(
        (assignment) =>
          assignment.account_id == null &&
          assignment.email_address &&
          emailSet.has(assignment.email_address),
      );
      if (pendingAssignment) {
        const grantInfo = await createGrantForAssignment({
          package_id,
          account_id,
          assigned_by_account_id:
            pendingAssignment.assigned_by_account_id ?? null,
          assignment_id: pendingAssignment.id,
          metadata: pendingAssignment.metadata,
          client: dbClient,
        });
        await pool.query(
          `
            UPDATE membership_package_assignments
            SET account_id = $2,
                metadata = $3::jsonb,
                updated = NOW()
            WHERE id = $1
          `,
          [
            pendingAssignment.id,
            account_id,
            {
              ...normalizeMetadata(pendingAssignment.metadata),
              grant_id: grantInfo.grant_id,
              claimed_at: new Date().toISOString(),
            },
          ],
        );
        return {
          ...pendingAssignment,
          account_id,
          metadata: {
            ...normalizeMetadata(pendingAssignment.metadata),
            grant_id: grantInfo.grant_id,
            claimed_at: new Date().toISOString(),
          },
          grant_id: grantInfo.grant_id,
          grant_source: grantInfo.grant_source,
          grant_purchase_id: grantInfo.grant_purchase_id,
        };
      }

      if (pkg.kind !== "domain" && pkg.kind !== "site") {
        throw Error("no claimable seat found for this account");
      }
      const allowedDomains = new Set(getPackageDomains(pkg.metadata));
      const matchedEmailAddress = verifiedEmailAddresses.find((email) =>
        allowedDomains.has(email.split("@")[1] ?? ""),
      );
      if (!matchedEmailAddress) {
        throw Error("no verified email matches this package");
      }
      return await assignMembershipPackageSeat(
        {
          package_id,
          account_id,
          email_address: matchedEmailAddress,
          assigned_by_account_id: pkg.owner_account_id,
          metadata: {
            claimed_from_domain: matchedEmailAddress.split("@")[1],
            claimed_email_address: matchedEmailAddress,
          },
        },
        dbClient,
      );
    },
  });
}
