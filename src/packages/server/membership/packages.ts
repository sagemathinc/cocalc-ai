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
import { getConfiguredBayId } from "@cocalc/server/bay-config";
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
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import {
  canonicalizeInstitutionalClaimEmail,
  getMembershipClaimIdentity,
  reserveMembershipClaimIdentity,
  revokeMembershipClaimIdentity,
} from "./claim-directory";
import { createMembershipGrant, revokeMembershipGrantById } from "./grants";
import { setProjectUsageAccountId } from "./project-usage";
import {
  queueMembershipClaimIdentitySyncEffect,
  queueMembershipGrantSyncEffect,
  queueMembershipProjectUsageSyncEffect,
} from "./side-effects";
import { getMembershipPrice, getMembershipTierById } from "./tiers";
import {
  resolveProjectBayAcrossCluster,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { getConfiguredClusterBayIdsForStaticEnumerationOnly } from "@cocalc/server/cluster-config";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

type Queryable = PoolClient | ReturnType<typeof getPool>;
type ClaimableMembershipPackageWithBay = ClaimableMembershipPackage & {
  owner_bay_id: string;
};
type InstitutionalClaimDescriptor = {
  scope_key: string;
  scope_kind: string;
  canonical_identity: string;
  matched_email_address: string;
  claimed_domain: string;
};

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

function normalizeStoredPackageKind(kind?: string): MembershipPackageKind {
  // "domain" was an older name for the same product. Keep existing rows
  // readable, but do not expose or create a separate package kind.
  if (kind === "domain") {
    return "site";
  }
  return normalizePackageKind(kind);
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
    kind: normalizeStoredPackageKind(row.kind),
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
  const metadata = normalizeMetadata(row.metadata);
  const metadataGrantId = `${metadata?.grant_id ?? ""}`.trim() || undefined;
  const metadataGrantSource =
    `${metadata?.grant_source ?? ""}`.trim() || undefined;
  const metadataGrantPurchaseId = toNumber(metadata?.grant_purchase_id);
  return {
    ...row,
    account_id: row.account_id ?? undefined,
    email_address: row.email_address ?? undefined,
    assigned_at: asDate(row.assigned_at),
    revoked_at: asDate(row.revoked_at),
    metadata,
    grant_id: row.grant_id ?? metadataGrantId,
    grant_source: row.grant_source ?? metadataGrantSource,
    grant_purchase_id: row.grant_purchase_id ?? metadataGrantPurchaseId,
  };
}

function grantSourceForKind(kind: MembershipPackageKind): string {
  switch (kind) {
    case "course":
      return "course-seat";
    case "team":
      return "team-seat";
    case "site":
      return "site-license";
  }
}

function grantSourceForAssignment(
  pkg: MembershipPackageRecord,
  metadata?: Record<string, unknown> | null,
): string {
  if (
    pkg.kind === "course" &&
    metadata?.grant_source === "student-course-purchase"
  ) {
    return "student-course-purchase";
  }
  return grantSourceForKind(pkg.kind);
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

function getInstitutionalClaimScopeKey(
  metadata?: Record<string, unknown> | null,
): string | undefined {
  const explicit = `${metadata?.claim_scope_key ?? ""}`.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const domains = Array.from(new Set(getPackageDomains(metadata))).sort();
  if (domains.length === 0) {
    return;
  }
  return `institutional-domains:${domains.join(",")}`;
}

function getInstitutionalClaimScopeKind(
  metadata?: Record<string, unknown> | null,
): string {
  const explicit = `${metadata?.claim_scope_kind ?? ""}`.trim().toLowerCase();
  return explicit || "institutional-domain-set";
}

function getInstitutionalClaimDescriptorForEmail({
  pkg,
  matched_email_address,
}: {
  pkg: MembershipPackageRecord;
  matched_email_address: string;
}): InstitutionalClaimDescriptor | undefined {
  if (pkg.kind !== "site") {
    return;
  }
  const normalizedEmail = normalizeEmailAddress(matched_email_address);
  if (!normalizedEmail) {
    return;
  }
  const scope_key = getInstitutionalClaimScopeKey(pkg.metadata);
  if (!scope_key) {
    return;
  }
  const claimed_domain = `${normalizedEmail.split("@")[1] ?? ""}`
    .trim()
    .toLowerCase();
  if (!claimed_domain) {
    return;
  }
  return {
    scope_key,
    scope_kind: getInstitutionalClaimScopeKind(pkg.metadata),
    canonical_identity: canonicalizeInstitutionalClaimEmail(normalizedEmail),
    matched_email_address: normalizedEmail,
    claimed_domain,
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

function sortClaimableMembershipPackages<T extends ClaimableMembershipPackage>(
  claimables: T[],
): T[] {
  return claimables.sort((left, right) => {
    const rightStart = right.starts_at?.getTime() ?? 0;
    const leftStart = left.starts_at?.getTime() ?? 0;
    return (
      rightStart - leftStart || `${left.kind}`.localeCompare(`${right.kind}`)
    );
  });
}

type AssignmentGrantInfo = {
  grant_id: string;
  grant_source: string;
  grant_purchase_id?: number | null;
  grant_home_bay_id?: string;
};

async function prepareGrantForAssignment({
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
  grant: {
    id: string;
    account_id: string;
    membership_class: MembershipClass;
    source: string;
    package_id: string;
    purchase_id?: number | null;
    granted_by_account_id?: string | null;
    starts_at?: Date | null;
    expires_at?: Date | null;
    metadata?: Record<string, unknown> | null;
  };
  info: AssignmentGrantInfo;
}> {
  const pkg = await getMembershipPackage({ package_id, client });
  if (!pkg) {
    throw Error("membership package not found");
  }
  const grant_id = uuid();
  const grant_source = grantSourceForAssignment(pkg, metadata);
  return {
    grant: {
      id: grant_id,
      account_id,
      membership_class: pkg.membership_class,
      source: grant_source,
      package_id,
      purchase_id: pkg.purchase_id ?? null,
      granted_by_account_id: assigned_by_account_id ?? null,
      starts_at: pkg.starts_at ?? null,
      expires_at: pkg.expires_at ?? null,
      metadata: {
        ...normalizeMetadata(metadata),
        assignment_id,
      },
    },
    info: {
      grant_id,
      grant_source,
      grant_purchase_id: pkg.purchase_id ?? null,
    },
  };
}

async function getHomeBayForAccount(account_id: string): Promise<string> {
  const account = await getClusterAccountById(account_id);
  if (!account) {
    throw Error(`account ${account_id} not found`);
  }
  return `${account.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

async function createGrantForAssignment({
  owner_account_id,
  package_id,
  account_id,
  assigned_by_account_id,
  assignment_id,
  metadata,
  client,
}: {
  owner_account_id: string;
  package_id: string;
  account_id: string;
  assigned_by_account_id?: string | null;
  assignment_id: string;
  metadata?: Record<string, unknown> | null;
  client?: PoolClient;
}): Promise<AssignmentGrantInfo> {
  const { grant, info } = await prepareGrantForAssignment({
    package_id,
    account_id,
    assigned_by_account_id,
    assignment_id,
    metadata,
    client,
  });
  const home_bay_id = await getHomeBayForAccount(account_id);
  if (home_bay_id === getConfiguredBayId()) {
    await createMembershipGrant(grant, client);
  }
  await queueMembershipGrantSyncEffect({
    owner_account_id,
    package_id,
    assignment_id,
    desired_payload: {
      desired_state: "active",
      grant,
    },
    client,
  });
  return {
    ...info,
    grant_home_bay_id: home_bay_id,
  };
}

async function syncProjectUsageForAssignment({
  owner_account_id,
  package_id,
  assignment_id,
  project_id,
  account_id,
  expected_current_usage_account_id,
  client,
}: {
  owner_account_id: string;
  package_id: string;
  assignment_id: string;
  project_id: string;
  account_id?: string | null;
  expected_current_usage_account_id?: string | null;
  client: PoolClient;
}): Promise<void> {
  const localOwnership = await resolveProjectBayDirect(project_id);
  const ownership =
    localOwnership ?? (await resolveProjectBayAcrossCluster(project_id));
  if (ownership == null) {
    throw Error(
      `cannot route course package seat write for project ${project_id}; owning bay is unknown`,
    );
  }
  if (ownership.bay_id === getConfiguredBayId()) {
    const updated = await setProjectUsageAccountId(
      {
        project_id,
        account_id,
        expected_current_usage_account_id,
      },
      client,
    );
    if (!updated) {
      throw Error(
        `cannot update course package seat usage attribution for project ${project_id}`,
      );
    }
  }
  await queueMembershipProjectUsageSyncEffect({
    owner_account_id,
    package_id,
    assignment_id,
    desired_payload: {
      project_id,
      desired_account_id: account_id ?? null,
      expected_current_usage_account_id,
    },
    client,
  });
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
  const membership_class = `${product.membership_class ?? ""}`.trim();
  if (!membership_class) {
    throw Error("membership_class is required for course packages");
  }
  const tier = await getMembershipTierById({
    id: membership_class,
    client,
  });
  if (!tier || tier.disabled || !tier.course_store_visible) {
    throw Error(
      `course membership tier "${membership_class}" is not available`,
    );
  }
  const seat_price = toDecimal(tier.course_price ?? NaN).toNumber();
  if (!Number.isFinite(seat_price) || seat_price < 0) {
    throw Error(
      `course membership tier "${membership_class}" has invalid price`,
    );
  }
  const duration_days = Number(tier.course_duration_days);
  if (
    !Number.isFinite(duration_days) ||
    !Number.isInteger(duration_days) ||
    duration_days <= 0
  ) {
    throw Error(
      `course membership tier "${membership_class}" has invalid duration`,
    );
  }
  const configured_grace_days = Number(tier.course_grace_days);
  if (
    tier.course_grace_days != null &&
    (!Number.isFinite(configured_grace_days) ||
      !Number.isInteger(configured_grace_days) ||
      configured_grace_days < 0)
  ) {
    throw Error(
      `course membership tier "${membership_class}" has invalid grace period`,
    );
  }
  const starts_at = new Date();
  const expires_at = dayjs(starts_at).add(duration_days, "day").toDate();
  const grace_days =
    tier.course_grace_days == null ? undefined : configured_grace_days;
  return {
    kind: "course",
    membership_class,
    seat_count: normalizeSeatCount(product.seat_count),
    seat_price,
    total_price: moneyRound2Up(
      toDecimal(seat_price).mul(product.seat_count),
    ).toNumber(),
    starts_at,
    expires_at,
    metadata: {
      ...normalizeMetadata(product.metadata),
      course_project_id,
      course_path: course?.path,
      course_title: row.title,
      course_duration_days: duration_days,
      course_grace_days: grace_days,
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
              product: {
                ...product,
                membership_class:
                  product.membership_class ?? existing.membership_class,
              },
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

  const kind = normalizePackageKind(product.kind);
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

async function syncUpdatedGrantForAssignment({
  pkg,
  assignment,
  client,
}: {
  pkg: MembershipPackageRecord;
  assignment: MembershipPackageAssignment;
  client: PoolClient;
}): Promise<void> {
  if (!assignment.account_id || !assignment.grant_id) {
    return;
  }
  const grant = {
    id: assignment.grant_id,
    account_id: assignment.account_id,
    membership_class: pkg.membership_class,
    source: grantSourceForAssignment(pkg, assignment.metadata),
    package_id: pkg.id,
    purchase_id: pkg.purchase_id ?? null,
    granted_by_account_id: assignment.assigned_by_account_id ?? null,
    starts_at: pkg.starts_at ?? null,
    expires_at: pkg.expires_at ?? null,
    metadata: {
      ...normalizeMetadata(assignment.metadata),
      assignment_id: assignment.id,
    },
  };
  const home_bay_id = await getHomeBayForAccount(assignment.account_id);
  if (home_bay_id === getConfiguredBayId()) {
    await getQueryClient(client).query(
      `
        UPDATE membership_grants
        SET membership_class=$3,
            source=$4,
            purchase_id=$5,
            granted_by_account_id=$6,
            starts_at=$7,
            expires_at=$8,
            metadata=$9::jsonb,
            updated=NOW()
        WHERE id=$1
          AND account_id=$2
          AND revoked_at IS NULL
      `,
      [
        grant.id,
        grant.account_id,
        grant.membership_class,
        grant.source,
        grant.purchase_id,
        grant.granted_by_account_id,
        grant.starts_at,
        grant.expires_at,
        grant.metadata,
      ],
    );
  }
  await queueMembershipGrantSyncEffect({
    owner_account_id: pkg.owner_account_id,
    package_id: pkg.id,
    assignment_id: assignment.id,
    desired_payload: {
      desired_state: "active",
      grant,
    },
    client,
  });
}

export async function updateMembershipPackage({
  package_id,
  seat_count,
  expires_at,
  client,
}: {
  package_id: string;
  seat_count?: number;
  expires_at?: Date | string | null;
  client?: PoolClient;
}): Promise<MembershipPackageDetails> {
  return await withPackageOwnerWriteFence({
    package_id,
    action: "update membership package",
    client,
    fn: async ({ client: dbClient }) => {
      const assignments = await listMembershipPackageAssignments({
        package_id,
        include_revoked: false,
        client: dbClient,
      });
      const activeSeatCount = assignments.filter(
        (assignment) => !assignment.revoked_at,
      ).length;
      const normalizedSeatCount =
        seat_count == null ? undefined : normalizeSeatCount(seat_count);
      if (
        normalizedSeatCount != null &&
        normalizedSeatCount < activeSeatCount
      ) {
        throw Error(
          `seat_count cannot be less than the ${activeSeatCount} active assigned seats`,
        );
      }
      const nextExpiresAt =
        expires_at === undefined ? undefined : asDate(expires_at);
      const { rows } = await getQueryClient(
        dbClient,
      ).query<RawMembershipPackageRecord>(
        `
          UPDATE membership_packages
          SET seat_count = COALESCE($2::integer, seat_count),
              expires_at = CASE WHEN $3::boolean THEN $4::timestamp ELSE expires_at END,
              updated = NOW()
          WHERE id = $1
          RETURNING id, owner_account_id, kind, membership_class, seat_count,
                    purchase_id, starts_at, expires_at, metadata, created, updated
        `,
        [
          package_id,
          normalizedSeatCount ?? null,
          expires_at !== undefined,
          nextExpiresAt ?? null,
        ],
      );
      const updatedPackage = normalizePackageRecord(rows[0]);
      if (!updatedPackage) {
        throw Error("membership package not found");
      }
      for (const assignment of assignments) {
        await syncUpdatedGrantForAssignment({
          pkg: updatedPackage,
          assignment,
          client: dbClient,
        });
      }
      const details = await listMembershipPackageDetailsForOwner({
        owner_account_id: updatedPackage.owner_account_id,
        client: dbClient,
      });
      const updatedDetails = details.find(({ id }) => id === package_id);
      if (!updatedDetails) {
        throw Error("updated membership package not found");
      }
      return updatedDetails;
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
      let grantInfo: AssignmentGrantInfo | undefined;
      if (normalizedAccountId) {
        grantInfo = await createGrantForAssignment({
          owner_account_id: pkg.owner_account_id,
          package_id,
          account_id: normalizedAccountId,
          assigned_by_account_id,
          assignment_id,
          metadata,
          client: dbClient,
        });
      }
      const assignmentMetadata = {
        ...normalizeMetadata(metadata),
        ...(grantInfo
          ? {
              grant_id: grantInfo.grant_id,
              grant_source: grantInfo.grant_source,
              grant_purchase_id: grantInfo.grant_purchase_id ?? null,
              grant_home_bay_id: grantInfo.grant_home_bay_id,
            }
          : {}),
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
      if (normalizedAccountId) {
        const project_id = `${metadata?.project_id ?? ""}`.trim();
        if (pkg.kind === "course" && isValidUUID(project_id)) {
          await syncProjectUsageForAssignment({
            owner_account_id: pkg.owner_account_id,
            package_id,
            assignment_id,
            project_id,
            account_id: normalizedAccountId,
            client: dbClient,
          });
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
  const revoked = await withPackageOwnerWriteFence({
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
      const currentGrantHomeBayId = assignment.account_id
        ? await getHomeBayForAccount(assignment.account_id)
        : getConfiguredBayId();
      if (
        assignment.account_id &&
        currentGrantHomeBayId === getConfiguredBayId()
      ) {
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
      if (assignment.account_id && assignment.grant_id) {
        if (currentGrantHomeBayId === getConfiguredBayId()) {
          await revokeMembershipGrantById(
            {
              account_id: assignment.account_id,
              grant_id: assignment.grant_id,
            },
            dbClient,
          );
        }
        await queueMembershipGrantSyncEffect({
          owner_account_id: pkg.owner_account_id,
          package_id,
          assignment_id: assignment.id,
          desired_payload: {
            desired_state: "revoked",
            account_id: assignment.account_id,
            grant_id: assignment.grant_id,
          },
          client: dbClient,
        });
      }
      const claim_scope_key =
        `${assignment.metadata?.claim_scope_key ?? ""}`.trim() || undefined;
      const claim_identity_key =
        `${assignment.metadata?.claim_identity_key ?? ""}`.trim() || undefined;
      const claim_reservation_id =
        `${assignment.metadata?.claim_reservation_id ?? ""}`.trim() ||
        undefined;
      if (
        assignment.account_id &&
        claim_scope_key &&
        claim_identity_key &&
        pkg.kind === "site"
      ) {
        await queueMembershipClaimIdentitySyncEffect({
          owner_account_id: pkg.owner_account_id,
          package_id,
          assignment_id: assignment.id,
          desired_payload: {
            desired_state: "revoked",
            scope_key: claim_scope_key,
            canonical_identity: claim_identity_key,
            account_id: assignment.account_id,
            assignment_id: assignment.id,
            reservation_id: claim_reservation_id,
          },
          client: dbClient,
        });
      }
      const project_id = `${assignment.metadata?.project_id ?? ""}`.trim();
      if (
        pkg.kind === "course" &&
        isValidUUID(project_id) &&
        assignment.account_id
      ) {
        await syncProjectUsageForAssignment({
          owner_account_id: pkg.owner_account_id,
          package_id,
          assignment_id: assignment.id,
          project_id,
          account_id: null,
          expected_current_usage_account_id: assignment.account_id,
          client: dbClient,
        });
      }
      return true;
    },
  });
  return revoked;
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
  const claimables = await listClaimableMembershipPackagesAcrossCluster({
    account_id,
    verified_email_addresses: verifiedEmailAddresses,
    client,
  });
  return sortClaimableMembershipPackages(
    claimables.map(
      ({ owner_bay_id: _owner_bay_id, ...claimable }) => claimable,
    ),
  );
}

export async function listLocalClaimableMembershipPackagesForVerifiedEmails({
  account_id,
  verified_email_addresses,
  client,
}: {
  account_id: string;
  verified_email_addresses: string[];
  client?: PoolClient;
}): Promise<ClaimableMembershipPackage[]> {
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
  const claimIdentityCache = new Map<string, boolean>();
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
      pkg.kind === "site"
    ) {
      const allowedDomains = new Set(getPackageDomains(pkg.metadata));
      if (allowedDomains.size === 0) {
        continue;
      }
      const matchedEmailAddress = verifiedEmailAddresses.find((email) =>
        allowedDomains.has(email.split("@")[1] ?? ""),
      );
      if (matchedEmailAddress) {
        const claimDescriptor = getInstitutionalClaimDescriptorForEmail({
          pkg,
          matched_email_address: matchedEmailAddress,
        });
        const claimIdentityKey =
          claimDescriptor == null
            ? null
            : `${claimDescriptor.scope_key}\u0000${claimDescriptor.canonical_identity}`;
        let blocked = false;
        if (claimDescriptor != null && claimIdentityKey != null) {
          if (!claimIdentityCache.has(claimIdentityKey)) {
            const currentClaim = await getMembershipClaimIdentity({
              scope_key: claimDescriptor.scope_key,
              canonical_identity: claimDescriptor.canonical_identity,
            });
            claimIdentityCache.set(claimIdentityKey, currentClaim != null);
          }
          blocked = claimIdentityCache.get(claimIdentityKey) ?? false;
        }
        if (blocked) {
          continue;
        }
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
  return sortClaimableMembershipPackages(Array.from(claimables.values()));
}

async function listClaimableMembershipPackagesAcrossCluster({
  account_id,
  verified_email_addresses,
  client,
}: {
  account_id: string;
  verified_email_addresses: string[];
  client?: PoolClient;
}): Promise<ClaimableMembershipPackageWithBay[]> {
  const claimables = new Map<string, ClaimableMembershipPackageWithBay>();
  const addClaimables = (
    rows: ClaimableMembershipPackage[],
    owner_bay_id: string,
  ) => {
    for (const row of rows) {
      claimables.set(row.package_id, { ...row, owner_bay_id });
    }
  };
  addClaimables(
    await listLocalClaimableMembershipPackagesForVerifiedEmails({
      account_id,
      verified_email_addresses,
      client,
    }),
    getConfiguredBayId(),
  );
  for (const bay_id of getConfiguredClusterBayIdsForStaticEnumerationOnly()) {
    if (bay_id === getConfiguredBayId()) continue;
    const remoteRows = await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: bay_id,
    }).getClaimableMembershipPackages({
      account_id,
      verified_email_addresses,
    });
    addClaimables(remoteRows, bay_id);
  }
  return sortClaimableMembershipPackages(Array.from(claimables.values()));
}

export async function claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay({
  package_id,
  account_id,
  verified_email_addresses,
  client,
}: {
  package_id: string;
  account_id: string;
  verified_email_addresses: string[];
  client?: PoolClient;
}): Promise<MembershipPackageAssignment> {
  let reservedInstitutionalClaim:
    | (InstitutionalClaimDescriptor & {
        reservation_id: string;
      })
    | undefined;
  try {
    return await withPackageOwnerWriteFence({
      package_id,
      action: "claim membership package seat",
      client,
      fn: async ({ client: dbClient, pkg }) => {
        const pool = getQueryClient(dbClient);
        if (pkg.expires_at && pkg.expires_at <= new Date()) {
          throw Error("membership package has expired");
        }
        const verifiedEmailAddresses = Array.from(
          new Set(
            verified_email_addresses
              .map((email) => normalizeEmailAddress(email))
              .filter((email): email is string => !!email),
          ),
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
        const pendingClaimDescriptor =
          pendingAssignment?.email_address == null
            ? undefined
            : getInstitutionalClaimDescriptorForEmail({
                pkg,
                matched_email_address: pendingAssignment.email_address,
              });
        if (pendingClaimDescriptor != null) {
          const reserved = await reserveMembershipClaimIdentity({
            scope_key: pendingClaimDescriptor.scope_key,
            scope_kind: pendingClaimDescriptor.scope_kind,
            canonical_identity: pendingClaimDescriptor.canonical_identity,
            account_id,
            reservation_id: uuid(),
            matched_email_address: pendingClaimDescriptor.matched_email_address,
            claimed_domain: pendingClaimDescriptor.claimed_domain,
            metadata: {
              package_kind: pkg.kind,
              package_id,
            },
          });
          reservedInstitutionalClaim = {
            ...pendingClaimDescriptor,
            reservation_id: reserved.reservation_id,
          };
        }
        if (pendingAssignment) {
          const grantInfo = await createGrantForAssignment({
            owner_account_id: pkg.owner_account_id,
            package_id,
            account_id,
            assigned_by_account_id:
              pendingAssignment.assigned_by_account_id ?? null,
            assignment_id: pendingAssignment.id,
            metadata: pendingAssignment.metadata,
            client: dbClient,
          });
          const nextMetadata = {
            ...normalizeMetadata(pendingAssignment.metadata),
            grant_id: grantInfo.grant_id,
            grant_source: grantInfo.grant_source,
            grant_purchase_id: grantInfo.grant_purchase_id ?? null,
            grant_home_bay_id: grantInfo.grant_home_bay_id,
            claimed_at: new Date().toISOString(),
            ...(reservedInstitutionalClaim
              ? {
                  claim_scope_key: reservedInstitutionalClaim.scope_key,
                  claim_scope_kind: reservedInstitutionalClaim.scope_kind,
                  claim_identity_key:
                    reservedInstitutionalClaim.canonical_identity,
                  claim_reservation_id:
                    reservedInstitutionalClaim.reservation_id,
                }
              : {}),
          };
          await pool.query(
            `
              UPDATE membership_package_assignments
              SET account_id = $2,
                  metadata = $3::jsonb,
                  updated = NOW()
              WHERE id = $1
            `,
            [pendingAssignment.id, account_id, nextMetadata],
          );
          if (reservedInstitutionalClaim) {
            await queueMembershipClaimIdentitySyncEffect({
              owner_account_id: pkg.owner_account_id,
              package_id,
              assignment_id: pendingAssignment.id,
              desired_payload: {
                desired_state: "active",
                scope_key: reservedInstitutionalClaim.scope_key,
                scope_kind: reservedInstitutionalClaim.scope_kind,
                canonical_identity:
                  reservedInstitutionalClaim.canonical_identity,
                reservation_id: reservedInstitutionalClaim.reservation_id,
                account_id,
                package_id,
                assignment_id: pendingAssignment.id,
                grant_id: grantInfo.grant_id,
                matched_email_address:
                  reservedInstitutionalClaim.matched_email_address,
                claimed_domain: reservedInstitutionalClaim.claimed_domain,
                metadata: {
                  package_kind: pkg.kind,
                },
              },
              client: dbClient,
            });
          }
          const project_id =
            `${pendingAssignment.metadata?.project_id ?? ""}`.trim();
          if (pkg.kind === "course" && isValidUUID(project_id)) {
            await syncProjectUsageForAssignment({
              owner_account_id: pkg.owner_account_id,
              package_id,
              assignment_id: pendingAssignment.id,
              project_id,
              account_id,
              client: dbClient,
            });
          }
          return {
            ...pendingAssignment,
            account_id,
            metadata: nextMetadata,
            grant_id: grantInfo.grant_id,
            grant_source: grantInfo.grant_source,
            grant_purchase_id: grantInfo.grant_purchase_id,
          };
        }

        if (pkg.kind !== "site") {
          throw Error("no claimable seat found for this account");
        }
        const allowedDomains = new Set(getPackageDomains(pkg.metadata));
        const matchedEmailAddress = verifiedEmailAddresses.find((email) =>
          allowedDomains.has(email.split("@")[1] ?? ""),
        );
        if (!matchedEmailAddress) {
          throw Error("no verified email matches this package");
        }
        const institutionalClaim = getInstitutionalClaimDescriptorForEmail({
          pkg,
          matched_email_address: matchedEmailAddress,
        });
        if (institutionalClaim == null) {
          throw Error("no claimable seat found for this account");
        }
        const reserved = await reserveMembershipClaimIdentity({
          scope_key: institutionalClaim.scope_key,
          scope_kind: institutionalClaim.scope_kind,
          canonical_identity: institutionalClaim.canonical_identity,
          account_id,
          reservation_id: uuid(),
          matched_email_address: institutionalClaim.matched_email_address,
          claimed_domain: institutionalClaim.claimed_domain,
          metadata: {
            package_kind: pkg.kind,
            package_id,
          },
        });
        reservedInstitutionalClaim = {
          ...institutionalClaim,
          reservation_id: reserved.reservation_id,
        };
        const claimed = await assignMembershipPackageSeat(
          {
            package_id,
            account_id,
            email_address: matchedEmailAddress,
            assigned_by_account_id: pkg.owner_account_id,
            metadata: {
              claimed_from_domain: matchedEmailAddress.split("@")[1],
              claimed_email_address: matchedEmailAddress,
              claim_scope_key: reservedInstitutionalClaim.scope_key,
              claim_scope_kind: reservedInstitutionalClaim.scope_kind,
              claim_identity_key: reservedInstitutionalClaim.canonical_identity,
              claim_reservation_id: reservedInstitutionalClaim.reservation_id,
            },
          },
          dbClient,
        );
        await queueMembershipClaimIdentitySyncEffect({
          owner_account_id: pkg.owner_account_id,
          package_id,
          assignment_id: claimed.id,
          desired_payload: {
            desired_state: "active",
            scope_key: reservedInstitutionalClaim.scope_key,
            scope_kind: reservedInstitutionalClaim.scope_kind,
            canonical_identity: reservedInstitutionalClaim.canonical_identity,
            reservation_id: reservedInstitutionalClaim.reservation_id,
            account_id,
            package_id,
            assignment_id: claimed.id,
            grant_id: claimed.grant_id ?? null,
            matched_email_address:
              reservedInstitutionalClaim.matched_email_address,
            claimed_domain: reservedInstitutionalClaim.claimed_domain,
            metadata: {
              package_kind: pkg.kind,
            },
          },
          client: dbClient,
        });
        return claimed;
      },
    });
  } catch (err) {
    if (reservedInstitutionalClaim) {
      await revokeMembershipClaimIdentity({
        scope_key: reservedInstitutionalClaim.scope_key,
        canonical_identity: reservedInstitutionalClaim.canonical_identity,
        account_id,
        reservation_id: reservedInstitutionalClaim.reservation_id,
      }).catch(() => undefined);
    }
    throw err;
  }
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
  const verifiedEmailAddresses = await getVerifiedEmailAddressesForAccount(
    account_id,
    client,
  );
  if (verifiedEmailAddresses.length === 0) {
    throw Error("verify an email address before claiming this package");
  }
  const claimables = await listClaimableMembershipPackagesAcrossCluster({
    account_id,
    verified_email_addresses: verifiedEmailAddresses,
    client,
  });
  const claimable = claimables.find((row) => row.package_id === package_id);
  if (!claimable) {
    throw Error("no claimable seat found for this account");
  }
  if (claimable.owner_bay_id === getConfiguredBayId()) {
    return await claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay({
      package_id,
      account_id,
      verified_email_addresses: verifiedEmailAddresses,
      client,
    });
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: claimable.owner_bay_id,
  }).claimMembershipPackageSeat({
    package_id,
    account_id,
    verified_email_addresses: verifiedEmailAddresses,
  });
}
