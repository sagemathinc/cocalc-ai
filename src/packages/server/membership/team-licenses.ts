/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
  withAccountRehomeWriteFence,
} from "@cocalc/server/accounts/rehome-fence";
import {
  moneyRound2Up,
  moneyToCurrency,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import { uuid } from "@cocalc/util/misc";
import dayjs from "dayjs";
import type {
  MembershipClass,
  MembershipPackageDetails,
  TeamLicenseOverview,
  TeamLicenseQuote,
  TeamLicenseRecord,
  TeamLicenseSeatLine,
  TeamLicenseStatus,
} from "@cocalc/conat/hub/api/purchases";
import {
  addMembershipPackageSeats,
  createMembershipPackage,
  listMembershipPackageDetailsForOwner,
} from "./packages";
import {
  getMembershipPrice,
  getMembershipTierMap,
  type MembershipTierRecord,
} from "./tiers";

type TeamLicenseRow = Omit<TeamLicenseRecord, "status"> & {
  status: string;
};

type TeamLicenseSeatLineRow = Omit<
  TeamLicenseSeatLine,
  "membership_class" | "annual_price_per_seat" | "package"
> & {
  membership_class: string;
  annual_price_per_seat: number | string;
};

export const TEAM_LICENSE_INTERVAL = "year" as const;

function getQueryClient(client?: PoolClient) {
  return client ?? getPool();
}

function normalizeTeamLicenseStatus(status: string): TeamLicenseStatus {
  if (status === "past_due" || status === "canceled") {
    return status;
  }
  return "active";
}

function normalizeTeamLicenseRow(
  row: TeamLicenseRow | undefined,
): TeamLicenseRecord | undefined {
  if (!row) return undefined;
  return {
    ...row,
    status: normalizeTeamLicenseStatus(row.status),
  };
}

function normalizeTeamLicenseSeatLineRow(
  row: TeamLicenseSeatLineRow,
): TeamLicenseSeatLine {
  return {
    ...row,
    membership_class: row.membership_class as MembershipClass,
    annual_price_per_seat: toDecimal(row.annual_price_per_seat ?? 0).toNumber(),
  };
}

function normalizeSeatTarget(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function addYear(date: Date): Date {
  return dayjs(date).add(1, "year").toDate();
}

function getTierLabel(tier: MembershipTierRecord): string {
  return `${tier.label ?? tier.id}`.trim() || tier.id;
}

function getTeamVisibleTiers(
  tiers: Record<string, MembershipTierRecord>,
): MembershipTierRecord[] {
  return Object.values(tiers)
    .filter((tier) => tier.team_visible && !tier.disabled)
    .sort((a, b) => {
      const priority = (a.priority ?? 0) - (b.priority ?? 0);
      if (priority !== 0) return priority;
      return getTierLabel(a).localeCompare(getTierLabel(b));
    });
}

function normalizeTargetSeats({
  target_seats,
  teamTiers,
  currentSeats,
}: {
  target_seats?: Record<string, number>;
  teamTiers: MembershipTierRecord[];
  currentSeats: Record<string, number>;
}): Record<string, number> {
  const allowed = new Set(teamTiers.map((tier) => tier.id));
  const result: Record<string, number> = {};
  for (const tier of teamTiers) {
    result[tier.id] = normalizeSeatTarget(
      target_seats?.[tier.id] ?? currentSeats[tier.id] ?? 0,
    );
  }
  for (const key of Object.keys(target_seats ?? {})) {
    if (!allowed.has(key)) {
      throw Error(
        `membership tier "${key}" is not available for team licenses`,
      );
    }
  }
  return result;
}

function getProrationFactor({
  periodStart,
  periodEnd,
  now,
}: {
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}): number {
  const totalMs = periodEnd.valueOf() - periodStart.valueOf();
  if (totalMs <= 0) return 0;
  const remainingMs = Math.max(0, periodEnd.valueOf() - now.valueOf());
  return Math.min(1, remainingMs / totalMs);
}

function teamSeatLineDescription({
  seatCount,
  tier,
  annualPrice,
  prorated = false,
}: {
  seatCount: number;
  tier: MembershipTierRecord;
  annualPrice: MoneyValue;
  prorated?: boolean;
}): string {
  const price = toDecimal(annualPrice);
  return `${seatCount} ${getTierLabel(tier)} annual team seat${
    seatCount === 1 ? "" : "s"
  } at ${moneyToCurrency(annualPrice, price.isInteger() ? 0 : 2)}/seat${prorated ? ", prorated" : ""}`;
}

export async function getTeamLicenseRecordForOwner({
  owner_account_id,
  client,
}: {
  owner_account_id: string;
  client?: PoolClient;
}): Promise<TeamLicenseRecord | undefined> {
  const { rows } = await getQueryClient(client).query<TeamLicenseRow>(
    `
      SELECT id, owner_account_id, status, current_period_start,
             current_period_end, latest_purchase_id, payment,
             last_renewal_attempt_at, last_renewal_notice_at,
             metadata, created, updated
        FROM team_licenses
       WHERE owner_account_id=$1
         AND status != 'canceled'
       ORDER BY created DESC
       LIMIT 1
    `,
    [owner_account_id],
  );
  return normalizeTeamLicenseRow(rows[0]);
}

async function listTeamLicenseSeatLines({
  team_license_id,
  client,
}: {
  team_license_id: string;
  client?: PoolClient;
}): Promise<TeamLicenseSeatLine[]> {
  const { rows } = await getQueryClient(client).query<TeamLicenseSeatLineRow>(
    `
      SELECT id, team_license_id, owner_account_id, membership_class,
             package_id, seat_count, annual_price_per_seat,
             metadata, created, updated
        FROM team_license_seat_lines
       WHERE team_license_id=$1
       ORDER BY created ASC
    `,
    [team_license_id],
  );
  return rows.map(normalizeTeamLicenseSeatLineRow);
}

export async function getTeamLicenseOverviewForOwner({
  owner_account_id,
  client,
}: {
  owner_account_id: string;
  client?: PoolClient;
}): Promise<TeamLicenseOverview | null> {
  const license = await getTeamLicenseRecordForOwner({
    owner_account_id,
    client,
  });
  if (!license) return null;
  const [seatLines, ownerPackages] = await Promise.all([
    listTeamLicenseSeatLines({ team_license_id: license.id, client }),
    listMembershipPackageDetailsForOwner({ owner_account_id, client }),
  ]);
  const packageIds = new Set(
    seatLines.map((line) => line.package_id).filter(Boolean),
  );
  const packageById = new Map(
    ownerPackages
      .filter((pkg) => packageIds.has(pkg.id))
      .map((pkg) => [pkg.id, pkg]),
  );
  const lines = seatLines.map((line) => ({
    ...line,
    package: line.package_id ? packageById.get(line.package_id) : undefined,
  }));
  return {
    ...license,
    seat_lines: lines,
    packages: lines
      .map((line) => line.package)
      .filter((pkg): pkg is MembershipPackageDetails => pkg != null),
  };
}

export async function resolveTeamLicenseQuote({
  owner_account_id,
  target_seats,
  client,
  now = new Date(),
}: {
  owner_account_id: string;
  target_seats?: Record<string, number>;
  client?: PoolClient;
  now?: Date;
}): Promise<TeamLicenseQuote> {
  const tiers = await getMembershipTierMap({ includeDisabled: false, client });
  const teamTiers = getTeamVisibleTiers(tiers);
  const overview = await getTeamLicenseOverviewForOwner({
    owner_account_id,
    client,
  });
  const currentSeats: Record<string, number> = {};
  const assignedSeats: Record<string, number> = {};
  for (const line of overview?.seat_lines ?? []) {
    currentSeats[line.membership_class] = line.seat_count;
    assignedSeats[line.membership_class] =
      line.package?.active_assignment_count ?? 0;
  }
  const normalizedTargets = normalizeTargetSeats({
    target_seats,
    teamTiers,
    currentSeats,
  });

  const hasExistingLicense = overview != null;
  const periodStart = hasExistingLicense
    ? new Date(overview.current_period_start)
    : now;
  const periodEnd = hasExistingLicense
    ? new Date(overview.current_period_end)
    : addYear(periodStart);
  if (overview?.status === "past_due") {
    throw Error("team license renewal is past due");
  }
  if (overview?.status === "canceled") {
    throw Error("team license is canceled");
  }
  if (hasExistingLicense && periodEnd <= now) {
    throw Error("team license renewal is due");
  }

  const prorationFactor = hasExistingLicense
    ? getProrationFactor({ periodStart, periodEnd, now })
    : 1;
  const addedSeats: Record<string, number> = {};
  const lineItems: TeamLicenseQuote["line_items"] = [];
  for (const tier of teamTiers) {
    const current = currentSeats[tier.id] ?? 0;
    const assigned = assignedSeats[tier.id] ?? 0;
    const target = normalizedTargets[tier.id] ?? 0;
    if (target < current) {
      throw Error("team license seat reductions are not supported yet");
    }
    if (target < assigned) {
      throw Error("team license seats cannot be less than assigned seats");
    }
    const added = target - current;
    addedSeats[tier.id] = added;
    if (added <= 0) continue;
    const annualPrice = getMembershipPrice(tier, TEAM_LICENSE_INTERVAL);
    const amount = moneyRound2Up(
      toDecimal(annualPrice).mul(added).mul(prorationFactor),
    ).toNumber();
    lineItems.push({
      description: teamSeatLineDescription({
        seatCount: added,
        tier,
        annualPrice,
        prorated: prorationFactor < 0.999,
      }),
      amount,
    });
  }
  const totalPrice = moneyRound2Up(
    lineItems.reduce(
      (sum, item) => sum.add(toDecimal(item.amount)),
      toDecimal(0),
    ),
  ).toNumber();
  return {
    team_license_id: overview?.id,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    target_seats: normalizedTargets,
    current_seats: currentSeats,
    assigned_seats: assignedSeats,
    added_seats: addedSeats,
    line_items: lineItems,
    total_price: totalPrice,
    interval: TEAM_LICENSE_INTERVAL,
  };
}

async function assertTeamLicenseOwnerWriteAllowed({
  owner_account_id,
  client,
  action,
}: {
  owner_account_id: string;
  client: PoolClient;
  action: string;
}): Promise<void> {
  await assertAccountNotRehoming({
    db: client,
    account_id: owner_account_id,
    action,
  });
  await assertAccountWriteOnHomeBay({
    db: client,
    account_id: owner_account_id,
    action,
  });
}

export async function applyTeamLicenseSeatConfiguration({
  owner_account_id,
  target_seats,
  latest_purchase_id,
  client,
}: {
  owner_account_id: string;
  target_seats: Record<string, number>;
  latest_purchase_id?: number | null;
  client?: PoolClient;
}): Promise<TeamLicenseOverview> {
  if (client == null) {
    return await withAccountRehomeWriteFence({
      account_id: owner_account_id,
      action: "update team license",
      fn: async (db) =>
        await applyTeamLicenseSeatConfiguration({
          owner_account_id,
          target_seats,
          latest_purchase_id,
          client: db as PoolClient,
        }),
    });
  }
  await assertTeamLicenseOwnerWriteAllowed({
    owner_account_id,
    client,
    action: "update team license",
  });
  const quote = await resolveTeamLicenseQuote({
    owner_account_id,
    target_seats,
    client,
  });
  if (quote.total_price <= 0) {
    return (
      (await getTeamLicenseOverviewForOwner({ owner_account_id, client })) ??
      (await createEmptyTeamLicense({
        owner_account_id,
        period_start: new Date(quote.current_period_start),
        period_end: new Date(quote.current_period_end),
        latest_purchase_id,
        client,
      }))
    );
  }
  let overview = await getTeamLicenseOverviewForOwner({
    owner_account_id,
    client,
  });
  if (!overview) {
    overview = await createEmptyTeamLicense({
      owner_account_id,
      period_start: new Date(quote.current_period_start),
      period_end: new Date(quote.current_period_end),
      latest_purchase_id,
      client,
    });
  }
  const tiers = await getMembershipTierMap({ includeDisabled: false, client });
  const lineByClass = new Map(
    overview.seat_lines.map((line) => [line.membership_class, line]),
  );
  for (const [membershipClass, target] of Object.entries(quote.target_seats)) {
    const current = quote.current_seats[membershipClass] ?? 0;
    const added = target - current;
    if (added <= 0) continue;
    const tier = tiers[membershipClass];
    const annualPrice = getMembershipPrice(tier, TEAM_LICENSE_INTERVAL);
    const existingLine = lineByClass.get(membershipClass);
    if (existingLine?.package_id) {
      await addMembershipPackageSeats(
        { package_id: existingLine.package_id, seat_count: added },
        client,
      );
      await client.query(
        `
          UPDATE team_license_seat_lines
             SET seat_count=$2,
                 annual_price_per_seat=$3,
                 updated=NOW()
           WHERE id=$1
        `,
        [existingLine.id, target, annualPrice],
      );
      continue;
    }
    const lineId = uuid();
    const packageId = await createMembershipPackage(
      {
        owner_account_id,
        kind: "team",
        membership_class: membershipClass,
        seat_count: target,
        purchase_id: latest_purchase_id,
        starts_at: overview.current_period_start,
        expires_at: null,
        metadata: {
          interval: TEAM_LICENSE_INTERVAL,
          seat_price: annualPrice,
          team_license_id: overview.id,
          team_license_line_id: lineId,
        },
      },
      client,
    );
    await client.query(
      `
        INSERT INTO team_license_seat_lines
          (id, team_license_id, owner_account_id, membership_class, package_id,
           seat_count, annual_price_per_seat, metadata, created, updated)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
      `,
      [
        lineId,
        overview.id,
        owner_account_id,
        membershipClass,
        packageId,
        target,
        annualPrice,
        { package_id: packageId },
      ],
    );
  }
  if (latest_purchase_id != null) {
    await client.query(
      `
        UPDATE team_licenses
           SET latest_purchase_id=$2,
               status='active',
               updated=NOW()
         WHERE id=$1
      `,
      [overview.id, latest_purchase_id],
    );
  }
  const updated = await getTeamLicenseOverviewForOwner({
    owner_account_id,
    client,
  });
  if (!updated) {
    throw Error("team license was not created");
  }
  return updated;
}

async function createEmptyTeamLicense({
  owner_account_id,
  period_start,
  period_end,
  latest_purchase_id,
  client,
}: {
  owner_account_id: string;
  period_start: Date;
  period_end: Date;
  latest_purchase_id?: number | null;
  client: PoolClient;
}): Promise<TeamLicenseOverview> {
  const id = uuid();
  await client.query(
    `
      INSERT INTO team_licenses
        (id, owner_account_id, status, current_period_start,
         current_period_end, latest_purchase_id, metadata, created, updated)
      VALUES
        ($1, $2, 'active', $3, $4, $5, '{}'::jsonb, NOW(), NOW())
    `,
    [
      id,
      owner_account_id,
      period_start,
      period_end,
      latest_purchase_id ?? null,
    ],
  );
  const overview = await getTeamLicenseOverviewForOwner({
    owner_account_id,
    client,
  });
  if (!overview) {
    throw Error("team license was not created");
  }
  return overview;
}

export async function getTeamLicenseRenewalQuote({
  team_license_id,
  client,
}: {
  team_license_id: string;
  client?: PoolClient;
}): Promise<{
  license: TeamLicenseRecord;
  line_items: TeamLicenseQuote["line_items"];
  total_price: MoneyValue;
  next_period_start: Date;
  next_period_end: Date;
}> {
  const { rows } = await getQueryClient(client).query<TeamLicenseRow>(
    `
      SELECT id, owner_account_id, status, current_period_start,
             current_period_end, latest_purchase_id, payment,
             last_renewal_attempt_at, last_renewal_notice_at,
             metadata, created, updated
        FROM team_licenses
       WHERE id=$1
         AND status != 'canceled'
    `,
    [team_license_id],
  );
  const license = normalizeTeamLicenseRow(rows[0]);
  if (!license) {
    throw Error("team license not found");
  }
  const overview = await getTeamLicenseOverviewForOwner({
    owner_account_id: license.owner_account_id,
    client,
  });
  if (!overview || overview.id !== team_license_id) {
    throw Error("team license not found");
  }
  const tiers = await getMembershipTierMap({ includeDisabled: false, client });
  const lineItems = overview.seat_lines
    .filter((line) => line.seat_count > 0)
    .map((line) => {
      const tier = tiers[line.membership_class];
      const annualPrice = getMembershipPrice(tier, TEAM_LICENSE_INTERVAL);
      return {
        description: teamSeatLineDescription({
          seatCount: line.seat_count,
          tier,
          annualPrice,
        }),
        amount: moneyRound2Up(
          toDecimal(annualPrice).mul(line.seat_count),
        ).toNumber(),
      };
    });
  const nextPeriodStart = new Date(license.current_period_end);
  const nextPeriodEnd = addYear(nextPeriodStart);
  return {
    license,
    line_items: lineItems,
    total_price: moneyRound2Up(
      lineItems.reduce(
        (sum, item) => sum.add(toDecimal(item.amount)),
        toDecimal(0),
      ),
    ).toNumber(),
    next_period_start: nextPeriodStart,
    next_period_end: nextPeriodEnd,
  };
}

export async function markTeamLicensePastDue({
  team_license_id,
  payment,
  client,
}: {
  team_license_id: string;
  payment?: Record<string, unknown> | null;
  client?: PoolClient;
}): Promise<TeamLicenseRecord> {
  const { rows } = await getQueryClient(client).query<TeamLicenseRow>(
    `
      UPDATE team_licenses
         SET status='past_due',
             payment=$2::jsonb,
             last_renewal_notice_at=NOW(),
             updated=NOW()
       WHERE id=$1
       RETURNING id, owner_account_id, status, current_period_start,
                 current_period_end, latest_purchase_id, payment,
                 last_renewal_attempt_at, last_renewal_notice_at,
                 metadata, created, updated
    `,
    [team_license_id, payment ?? null],
  );
  const license = normalizeTeamLicenseRow(rows[0]);
  if (!license) {
    throw Error("team license not found");
  }
  return license;
}
