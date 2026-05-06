/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
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
import { isValidUUID, uuid } from "@cocalc/util/misc";
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
  account_id: string;
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
  const delta = normalizeSeatCount(seat_count);
  const { rows } = await getQueryClient(client).query(
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
  await getQueryClient(client).query(
    `UPDATE membership_packages
     SET purchase_id=$2, updated=NOW()
     WHERE id=$1`,
    [package_id, purchase_id],
  );
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

export async function assignMembershipPackageSeat(
  {
    package_id,
    account_id,
    assigned_by_account_id,
    metadata,
  }: {
    package_id: string;
    account_id: string;
    assigned_by_account_id: string;
    metadata?: Record<string, unknown> | null;
  },
  client?: PoolClient,
): Promise<MembershipPackageAssignment> {
  const pool = getQueryClient(client);
  const pkg = await getMembershipPackage({ package_id, client });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.expires_at && pkg.expires_at <= new Date()) {
    throw Error("membership package has expired");
  }

  const existing = await listMembershipPackageAssignments({
    package_id,
    include_revoked: false,
    client,
  });
  const existingAssignment = existing.find(
    (assignment) => assignment.account_id === account_id,
  );
  if (existingAssignment) {
    return existingAssignment;
  }
  const countResult = await pool.query(
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
  const activeSeatCount = Number(countResult.rows[0]?.count ?? 0);
  const activeSeatLimit = Number(countResult.rows[0]?.seat_limit ?? 0);
  if (activeSeatCount >= activeSeatLimit) {
    throw Error("no seats available in membership package");
  }

  const assignment_id = uuid();
  const grant_id = uuid();
  const assignmentMetadata = {
    ...normalizeMetadata(metadata),
    grant_id,
  };
  await pool.query(
    `
      INSERT INTO membership_package_assignments
        (id, package_id, account_id, assigned_by_account_id, assigned_at, metadata, created, updated)
      VALUES
        ($1, $2, $3, $4, NOW(), $5::jsonb, NOW(), NOW())
    `,
    [
      assignment_id,
      package_id,
      account_id,
      assigned_by_account_id,
      assignmentMetadata,
    ],
  );
  await createMembershipGrant(
    {
      id: grant_id,
      account_id,
      membership_class: pkg.membership_class,
      source: grantSourceForKind(pkg.kind),
      package_id,
      purchase_id: pkg.purchase_id ?? null,
      granted_by_account_id: assigned_by_account_id,
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
    id: assignment_id,
    package_id,
    account_id,
    assigned_by_account_id,
    assigned_at: new Date(),
    revoked_at: undefined,
    metadata: assignmentMetadata,
    grant_id,
    grant_source: grantSourceForKind(pkg.kind),
    grant_purchase_id: pkg.purchase_id ?? null,
  };
}

export async function revokeMembershipPackageSeat(
  {
    package_id,
    account_id,
  }: {
    package_id: string;
    account_id: string;
  },
  client?: PoolClient,
): Promise<boolean> {
  const pool = getQueryClient(client);
  const assignments = await listMembershipPackageAssignments({
    package_id,
    include_revoked: false,
    client,
  });
  const assignment = assignments.find((row) => row.account_id === account_id);
  if (!assignment) {
    return false;
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
    [package_id, account_id, assignment.id],
  );
  return true;
}
