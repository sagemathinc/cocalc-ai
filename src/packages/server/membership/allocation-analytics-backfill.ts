/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getTransactionClient, type PoolClient } from "@cocalc/database/pool";
import { ensureMembershipAnalyticsTables } from "@cocalc/server/membership/analytics";
import { moneyRound2Up, toDecimal, type MoneyValue } from "@cocalc/util/money";
import type {
  Interval,
  MembershipMetadata,
} from "@cocalc/util/db-schema/subscriptions";
import type { TeamLicenseQuoteLineItem } from "@cocalc/conat/hub/api/purchases";
import {
  recordMembershipAllocationFact,
  recordMembershipAllocationRefund,
  type MembershipAllocationTierChange,
} from "./allocation-analytics";
import {
  recordPersonalMembershipPeriod,
  recordPersonalMembershipUpgradeCredit,
} from "./personal-allocation-analytics";
import { recordTeamLicensePurchaseFacts } from "./team-license-allocation-analytics";
import {
  packageAssignmentAllocationMonths,
  packageAssignmentAllocationSource,
  recordPackageAssignmentMonth,
} from "./package-assignment-analytics";

const MAX_BACKFILL_BATCH = 1000;

interface TrialRow {
  id: number;
  account_id: string;
  created: Date;
  membership_class: string;
  trial_ends_at: string;
}

interface PersonalPurchaseRow {
  id: number;
  time: Date;
  account_id: string;
  cost: MoneyValue;
  period_start: Date;
  period_end: Date;
  subscription_id: number;
  membership_class: string;
  interval: Interval;
  metadata: MembershipMetadata;
  has_earlier_purchase: boolean;
  event_type?: string | null;
  event_time?: Date | null;
  previous_membership_class?: string | null;
}

interface PreviousSubscriptionRow {
  id: number;
  interval: Interval;
  current_period_start: Date;
  current_period_end: Date;
  canceled_at: Date;
  latest_purchase_id?: number | null;
  latest_purchase_cost?: MoneyValue | null;
  metadata: MembershipMetadata;
}

interface DirectStudentPurchaseRow {
  id: number;
  time: Date;
  account_id: string;
  cost: MoneyValue;
  membership_class: string;
  seat_count: number;
  starts_at: Date;
  expires_at: Date;
}

interface RefundRow {
  id: number;
  time: Date;
  original_purchase_id: number;
}

interface TeamLicensePurchaseRow {
  id: number;
  time: Date;
  account_id: string;
  purchase_type: "team-license-change" | "team-license-renewal";
  lifecycle?: string | null;
  team_license_id: string;
  line_items: unknown;
  billing_interval: Interval;
  has_earlier_purchase: boolean;
  period_start: Date;
  period_end: Date;
}

interface TeamLicenseTierRow {
  id: string;
  label: string;
}

interface PackageAssignmentBackfillRow {
  assignment_id: string;
  package_id: string;
  account_id: string;
  assigned_at: Date;
  revoked_at?: Date | null;
  assignment_metadata?: Record<string, unknown> | null;
  grant_expires_at?: Date | null;
  owner_account_id: string;
  package_kind: "course" | "team" | "site";
  membership_class: string;
  seat_count: number;
  package_starts_at?: Date | null;
  package_expires_at?: Date | null;
  package_metadata?: Record<string, unknown> | null;
}

export interface MembershipAllocationBackfillResult {
  trials: number;
  personal_purchases: number;
  direct_student_purchases: number;
  course_purchases: number;
  team_license_purchases: number;
  package_assignments: number;
  refunds: number;
}

function batchLimit(limit: number | undefined): number {
  return Math.max(
    1,
    Math.min(MAX_BACKFILL_BATCH, Math.floor(Number(limit) || 100)),
  );
}

function classifyTierChange({
  membershipClass,
  previousMembershipClass,
  priorities,
}: {
  membershipClass: string;
  previousMembershipClass: string;
  priorities: Map<string, number>;
}): MembershipAllocationTierChange {
  if (membershipClass === previousMembershipClass) return "same";
  const current = priorities.get(membershipClass);
  const previous = priorities.get(previousMembershipClass);
  if (current == null || previous == null) return "none";
  return current > previous ? "upgrade" : "downgrade";
}

async function getTierPriorities(
  client: PoolClient,
): Promise<Map<string, number>> {
  const { rows } = await client.query<{ id: string; priority: number }>(
    "SELECT id, priority::float8 AS priority FROM membership_tiers",
  );
  return new Map(rows.map(({ id, priority }) => [id, Number(priority)]));
}

async function backfillTrials({
  client,
  limit,
}: {
  client: PoolClient;
  limit: number;
}): Promise<number> {
  const { rows } = await client.query<TrialRow>(
    `SELECT s.id, s.account_id, s.created,
            s.metadata->>'class' AS membership_class,
            s.metadata->>'trial_ends_at' AS trial_ends_at
       FROM subscriptions s
      WHERE s.metadata->>'type'='membership'
        AND s.metadata->>'trial'='true'
        AND COALESCE(s.metadata->>'class', '') <> ''
        AND COALESCE(s.metadata->>'trial_ends_at', '') <> ''
        AND NOT EXISTS (
          SELECT 1
            FROM membership_allocation_facts f
           WHERE f.fact_key='personal:subscription:' || s.id || ':trial'
        )
      ORDER BY s.created, s.id
      LIMIT $1`,
    [limit],
  );
  let recorded = 0;
  for (const row of rows) {
    if (
      await recordMembershipAllocationFact({
        fact_key: `personal:subscription:${row.id}:trial`,
        occurred_at: row.created,
        account_id: row.account_id,
        channel: "personal",
        source_kind: "trial",
        membership_class: row.membership_class,
        billing_interval: "trial",
        lifecycle: "trial",
        allocation_start: row.created,
        allocation_end: row.trial_ends_at,
        active_memberships: 1,
        subscription_id: row.id,
        client,
      })
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

async function findPreviousSubscription({
  row,
  client,
}: {
  row: PersonalPurchaseRow;
  client: PoolClient;
}): Promise<PreviousSubscriptionRow | undefined> {
  if (!row.previous_membership_class) return;
  const changeAt = row.event_time ?? row.time;
  const { rows } = await client.query<PreviousSubscriptionRow>(
    `SELECT s.id, s.interval, s.current_period_start, s.current_period_end,
            s.canceled_at, s.latest_purchase_id,
            p.cost AS latest_purchase_cost, s.metadata
       FROM subscriptions s
       LEFT JOIN purchases p ON p.id=s.latest_purchase_id
      WHERE s.account_id=$1
        AND s.id <> $2
        AND s.metadata->>'type'='membership'
        AND s.metadata->>'class'=$3
        AND s.canceled_at IS NOT NULL
      ORDER BY ABS(EXTRACT(EPOCH FROM (s.canceled_at - $4::timestamp))), s.id DESC
      LIMIT 1`,
    [
      row.account_id,
      row.subscription_id,
      row.previous_membership_class,
      changeAt,
    ],
  );
  return rows[0];
}

function reconstructUpgradeCredit({
  subscription,
  changeAt,
}: {
  subscription: PreviousSubscriptionRow;
  changeAt: Date;
}) {
  if (
    subscription.metadata?.trial === true &&
    subscription.latest_purchase_id == null
  ) {
    return toDecimal(0);
  }
  const start = new Date(subscription.current_period_start).valueOf();
  const end = new Date(subscription.current_period_end).valueOf();
  const changed = changeAt.valueOf();
  if (end <= changed || end <= start) return toDecimal(0);
  const basis = toDecimal(subscription.latest_purchase_cost ?? 0);
  const fraction = Math.max(0, Math.min(1, (end - changed) / (end - start)));
  return moneyRound2Up(basis.mul(fraction));
}

function previousBillingInterval(
  subscription: PreviousSubscriptionRow | undefined,
): "trial" | Interval | null {
  if (!subscription) return null;
  return subscription.metadata?.trial === true &&
    subscription.latest_purchase_id == null
    ? "trial"
    : subscription.interval;
}

async function backfillPersonalPurchases({
  client,
  limit,
}: {
  client: PoolClient;
  limit: number;
}): Promise<number> {
  const priorities = await getTierPriorities(client);
  const { rows } = await client.query<PersonalPurchaseRow>(
    `SELECT p.id, p.time, p.account_id, p.cost,
            p.period_start, p.period_end,
            (p.description->>'subscription_id')::int AS subscription_id,
            p.description->>'class' AS membership_class,
            p.description->>'interval' AS interval,
            s.metadata,
            EXISTS (
              SELECT 1
                FROM purchases earlier
               WHERE earlier.service='membership'
                 AND earlier.description->>'type'='membership'
                 AND earlier.description->>'subscription_id'=
                     p.description->>'subscription_id'
                 AND (earlier.time, earlier.id) < (p.time, p.id)
            ) AS has_earlier_purchase,
            e.event_type, e.event_time, e.previous_membership_class
       FROM purchases p
       JOIN subscriptions s
         ON s.id=(p.description->>'subscription_id')::int
       LEFT JOIN membership_analytics_events e
         ON e.event_key='subscription:' || s.id || ':created'
      WHERE p.service='membership'
        AND p.description->>'type'='membership'
        AND COALESCE(p.description->>'subscription_id', '') ~ '^[0-9]+$'
        AND COALESCE(p.description->>'class', '') <> ''
        AND p.description->>'interval' IN ('month', 'year')
        AND p.period_start IS NOT NULL
        AND p.period_end IS NOT NULL
        AND p.cost IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM membership_allocation_facts f
           WHERE f.purchase_id=p.id
             AND f.channel='personal'
        )
      ORDER BY p.time, p.id
      LIMIT $1`,
    [limit],
  );
  let recorded = 0;
  for (const row of rows) {
    const isPlanChange =
      row.event_type === "membership_changed" &&
      !!row.previous_membership_class;
    const previous = isPlanChange
      ? await findPreviousSubscription({ row, client })
      : undefined;
    const previousInterval = previousBillingInterval(previous);
    const tierChange = isPlanChange
      ? classifyTierChange({
          membershipClass: row.membership_class,
          previousMembershipClass: row.previous_membership_class!,
          priorities,
        })
      : "none";
    const lifecycle = isPlanChange
      ? "plan_change"
      : row.has_earlier_purchase
        ? "renewal"
        : "first_paid";
    const charge = toDecimal(row.cost);
    const canReconstructUpgrade =
      tierChange === "upgrade" &&
      previous != null &&
      new Date(previous.current_period_end) > new Date(row.period_start);
    const credit = canReconstructUpgrade
      ? reconstructUpgradeCredit({
          subscription: previous,
          changeAt: new Date(row.period_start),
        })
      : toDecimal(0);
    const revenue = charge.add(credit);

    if (
      await recordPersonalMembershipPeriod({
        account_id: row.account_id,
        subscription_id: row.subscription_id,
        purchase_id: row.id,
        occurred_at: row.time,
        membership_class: row.membership_class,
        billing_interval: row.interval,
        lifecycle,
        allocation_start: row.period_start,
        allocation_end: row.period_end,
        revenue,
        previous_membership_class: row.previous_membership_class ?? null,
        previous_billing_interval: previousInterval,
        tier_change: tierChange,
        client,
      })
    ) {
      recorded += 1;
    }

    if (canReconstructUpgrade) {
      if (
        await recordPersonalMembershipUpgradeCredit({
          account_id: row.account_id,
          old_subscription_id: previous.id,
          new_subscription_id: row.subscription_id,
          purchase_id: row.id,
          membership_class: row.previous_membership_class!,
          billing_interval: previousInterval!,
          allocation_start: row.period_start,
          allocation_end: previous.current_period_end,
          credit,
          client,
        })
      ) {
        recorded += 1;
      }
    }
  }
  return recorded;
}

async function backfillCoursePurchases({
  client,
  limit,
  directStudent,
}: {
  client: PoolClient;
  limit: number;
  directStudent: boolean;
}): Promise<number> {
  const { rows } = await client.query<DirectStudentPurchaseRow>(
    `SELECT p.id, p.time, p.account_id, p.cost,
            p.description->>'membership_class' AS membership_class,
            (p.description->>'seat_count')::int AS seat_count,
            COALESCE(p.period_start,
                     (p.description->>'starts_at')::timestamp) AS starts_at,
            COALESCE(p.period_end,
                     (p.description->>'expires_at')::timestamp) AS expires_at
       FROM purchases p
      WHERE p.service='membership'
        AND p.description->>'type'='membership-package'
        AND p.description->>'kind'='course'
        AND (($2::boolean AND
              p.description->'metadata'->>'direct_student_purchase'='true')
             OR
             (NOT $2::boolean AND
              COALESCE(p.description->'metadata'->>'direct_student_purchase',
                       'false') <> 'true'))
        AND COALESCE(p.description->>'membership_class', '') <> ''
        AND COALESCE(p.description->>'seat_count', '') ~ '^[0-9]+$'
        AND COALESCE(p.period_start,
                     (p.description->>'starts_at')::timestamp) IS NOT NULL
        AND COALESCE(p.period_end,
                     (p.description->>'expires_at')::timestamp) IS NOT NULL
        AND p.cost IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM membership_allocation_facts f
           WHERE f.purchase_id=p.id
             AND f.channel=$3
        )
      ORDER BY p.time, p.id
      LIMIT $1`,
    [limit, directStudent, directStudent ? "direct-student" : "course"],
  );
  let recorded = 0;
  const channel = directStudent ? "direct-student" : "course";
  for (const row of rows) {
    if (
      await recordMembershipAllocationFact({
        fact_key: `${channel}:purchase:${row.id}`,
        occurred_at: row.time,
        account_id: row.account_id,
        channel,
        source_kind: "purchase",
        membership_class: row.membership_class,
        billing_interval: "fixed",
        lifecycle: "first_paid",
        allocation_start: row.starts_at,
        allocation_end: row.expires_at,
        active_memberships: directStudent ? row.seat_count : 0,
        purchased_capacity: row.seat_count,
        revenue: row.cost,
        purchase_id: row.id,
        client,
      })
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

function normalizeTeamLicenseLineItems(
  value: unknown,
  tiers: TeamLicenseTierRow[],
): TeamLicenseQuoteLineItem[] {
  if (!Array.isArray(value)) return [];
  const labels = [...tiers].sort((a, b) => b.label.length - a.label.length);
  return value
    .map((item): TeamLicenseQuoteLineItem | undefined => {
      if (item == null || typeof item !== "object") return;
      const row = item as Record<string, unknown>;
      let membershipClass = `${row.membership_class ?? ""}`.trim();
      let seatCount = Number(row.seat_count);
      const amount = Number(row.amount);
      if (!membershipClass || !Number.isSafeInteger(seatCount)) {
        const description = `${row.description ?? ""}`.trim();
        const match = description.match(/^(\d+)\s+(.+)$/);
        const tier = match
          ? labels.find(({ label }) => {
              if (!match[2].startsWith(`${label} `)) return false;
              const qualifier = match[2].slice(label.length + 1);
              return /(^|\s)team seats?(\s|$)/.test(qualifier);
            })
          : undefined;
        if (match && tier) {
          membershipClass = tier.id;
          seatCount = Number(match[1]);
        }
      }
      if (
        !membershipClass ||
        !Number.isSafeInteger(seatCount) ||
        seatCount <= 0 ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return;
      }
      return {
        description: `${row.description ?? ""}`,
        amount,
        membership_class: membershipClass,
        seat_count: seatCount,
      };
    })
    .filter((item): item is TeamLicenseQuoteLineItem => item != null);
}

async function backfillTeamLicensePurchases({
  client,
  limit,
}: {
  client: PoolClient;
  limit: number;
}): Promise<number> {
  const { rows: tiers } = await client.query<TeamLicenseTierRow>(
    "SELECT id, COALESCE(NULLIF(label, ''), id) AS label FROM membership_tiers",
  );
  const { rows } = await client.query<TeamLicensePurchaseRow>(
    `SELECT p.id, p.time, p.account_id,
            p.description->>'type' AS purchase_type,
            p.description->>'lifecycle' AS lifecycle,
            COALESCE(NULLIF(p.description->>'team_license_id', ''),
                     tl.id::text) AS team_license_id,
            p.description->'line_items' AS line_items,
            p.description->>'interval' AS billing_interval,
            EXISTS (
              SELECT 1
                FROM purchases earlier
               WHERE earlier.account_id=p.account_id
                 AND earlier.service='membership'
                 AND earlier.description->>'type' IN
                     ('team-license-change', 'team-license-renewal')
                 AND (earlier.time, earlier.id) < (p.time, p.id)
            ) AS has_earlier_purchase,
            p.period_start, p.period_end
       FROM purchases p
       LEFT JOIN LATERAL (
         SELECT MIN(id::text) AS id
           FROM team_licenses
          WHERE owner_account_id=p.account_id
            AND NULLIF(p.description->>'team_license_id', '') IS NULL
         -- Canceled licenses also count: the purchase may belong to one.
         HAVING COUNT(*)=1
       ) tl ON TRUE
      WHERE p.service='membership'
        AND p.description->>'type' IN
            ('team-license-change', 'team-license-renewal')
        AND COALESCE(NULLIF(p.description->>'team_license_id', ''),
                     tl.id::text) IS NOT NULL
        AND jsonb_typeof(p.description->'line_items')='array'
        AND p.description->>'interval' IN ('month', 'year')
        AND p.period_start IS NOT NULL
        AND p.period_end IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM membership_allocation_facts f
           WHERE f.purchase_id=p.id
             AND f.channel='team'
        )
      ORDER BY p.time, p.id
      LIMIT $1`,
    [limit],
  );
  let recorded = 0;
  for (const row of rows) {
    const lineItems = normalizeTeamLicenseLineItems(row.line_items, tiers);
    if (lineItems.length === 0) continue;
    recorded += await recordTeamLicensePurchaseFacts({
      team_license_id: row.team_license_id,
      account_id: row.account_id,
      purchase_id: row.id,
      occurred_at: row.time,
      period_start: row.period_start,
      period_end: row.period_end,
      billing_interval: row.billing_interval,
      lifecycle:
        row.purchase_type === "team-license-renewal"
          ? "renewal"
          : row.lifecycle === "plan_change"
            ? "plan_change"
            : row.has_earlier_purchase
              ? "plan_change"
              : "first_paid",
      line_items: lineItems,
      client,
    });
  }
  return recorded;
}

async function backfillPackageAssignments({
  client,
  limit,
}: {
  client: PoolClient;
  limit: number;
}): Promise<number> {
  const { rows } = await client.query<PackageAssignmentBackfillRow>(
    `SELECT a.id AS assignment_id, a.package_id, a.account_id,
            a.assigned_at, a.revoked_at,
            a.metadata AS assignment_metadata,
            g.expires_at AS grant_expires_at,
            p.owner_account_id,
            CASE WHEN p.kind='domain' THEN 'site' ELSE p.kind END
              AS package_kind,
            p.membership_class, p.seat_count,
            p.starts_at AS package_starts_at,
            p.expires_at AS package_expires_at,
            p.metadata AS package_metadata
       FROM membership_package_assignments a
       JOIN membership_packages p ON p.id=a.package_id
       LEFT JOIN membership_grants g
         ON g.package_id=a.package_id
        AND g.account_id=a.account_id
        AND g.revoked_at IS NULL
        AND (g.metadata->>'assignment_id'=a.id::text OR
             g.metadata->>'assignment_id' IS NULL)
      WHERE a.account_id IS NOT NULL
        AND p.kind IN ('course', 'team', 'site', 'domain')
        AND NOT (
          p.kind='course' AND
          (COALESCE(p.metadata->>'direct_student_purchase', 'false')='true' OR
           COALESCE(a.metadata->>'direct_student_purchase', 'false')='true')
        )
        AND (
          NOT EXISTS (
            SELECT 1
              FROM membership_allocation_facts f
             WHERE f.fact_key LIKE
                   'package-assignment:' || a.id::text || ':%'
               AND f.source_kind='assignment'
          )
          OR (
            a.revoked_at IS NULL
            AND (p.starts_at IS NULL OR
                 p.starts_at < date_trunc('month', NOW()) + INTERVAL '1 month')
            AND (p.expires_at IS NULL OR
                 p.expires_at > date_trunc('month', NOW()))
            AND (NULLIF(a.metadata->>'grant_expires_at', '') IS NULL OR
                 (a.metadata->>'grant_expires_at')::timestamptz >
                   date_trunc('month', NOW()))
            AND NOT EXISTS (
              SELECT 1
                FROM membership_allocation_facts current_fact
               WHERE current_fact.fact_key=
                     'package-assignment:' || a.id::text || ':' ||
                     to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')
                 AND current_fact.source_kind='assignment'
            )
          )
        )
      ORDER BY a.assigned_at, a.id
      LIMIT $1`,
    [limit],
  );
  let recorded = 0;
  for (const row of rows) {
    const source = packageAssignmentAllocationSource({
      pkg: {
        id: row.package_id,
        owner_account_id: row.owner_account_id,
        kind: row.package_kind,
        membership_class: row.membership_class,
        seat_count: Number(row.seat_count),
        starts_at: row.package_starts_at ?? undefined,
        expires_at: row.package_expires_at,
        metadata: row.package_metadata,
      },
      assignment: {
        id: row.assignment_id,
        package_id: row.package_id,
        account_id: row.account_id,
        assigned_at: row.assigned_at,
        revoked_at: row.revoked_at,
        metadata: row.assignment_metadata,
        grant_expires_at: row.grant_expires_at,
      },
    });
    if (!source) continue;
    for (const month of packageAssignmentAllocationMonths({ source })) {
      const result = await recordPackageAssignmentMonth({
        source,
        month,
        client,
      });
      recorded += Number(result.assignment) + Number(result.correction);
    }
  }
  return recorded;
}

async function backfillRefunds({
  client,
  limit,
}: {
  client: PoolClient;
  limit: number;
}): Promise<number> {
  const { rows } = await client.query<RefundRow>(
    `SELECT p.id, p.time,
            (p.description->>'purchase_id')::int AS original_purchase_id
       FROM purchases p
      WHERE p.service='refund'
        AND p.description->>'type'='refund'
        AND COALESCE(p.description->>'purchase_id', '') ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1
            FROM membership_allocation_facts source
           WHERE source.purchase_id=(p.description->>'purchase_id')::int
        )
        AND NOT EXISTS (
          SELECT 1
            FROM membership_allocation_facts refund
           WHERE refund.purchase_id=p.id
             AND refund.source_kind='refund'
        )
      ORDER BY p.time, p.id
      LIMIT $1`,
    [limit],
  );
  let recorded = 0;
  for (const row of rows) {
    recorded += await recordMembershipAllocationRefund({
      original_purchase_id: row.original_purchase_id,
      refund_purchase_id: row.id,
      occurred_at: row.time,
      client,
    });
  }
  return recorded;
}

export async function backfillMembershipAllocationFacts({
  limit,
  client: existingClient,
}: {
  limit?: number;
  client?: PoolClient;
} = {}): Promise<MembershipAllocationBackfillResult> {
  const maxRows = batchLimit(limit);
  const client = existingClient ?? (await getTransactionClient());
  const ownsTransaction = existingClient == null;
  try {
    await ensureMembershipAnalyticsTables(client);
    const trials = await backfillTrials({ client, limit: maxRows });
    const personal_purchases = await backfillPersonalPurchases({
      client,
      limit: maxRows,
    });
    const direct_student_purchases = await backfillCoursePurchases({
      client,
      limit: maxRows,
      directStudent: true,
    });
    const course_purchases = await backfillCoursePurchases({
      client,
      limit: maxRows,
      directStudent: false,
    });
    const team_license_purchases = await backfillTeamLicensePurchases({
      client,
      limit: maxRows,
    });
    const package_assignments = await backfillPackageAssignments({
      client,
      limit: maxRows,
    });
    const refunds = await backfillRefunds({ client, limit: maxRows });
    if (ownsTransaction) {
      await client.query("COMMIT");
    }
    return {
      trials,
      personal_purchases,
      direct_student_purchases,
      course_purchases,
      team_license_purchases,
      package_assignments,
      refunds,
    };
  } catch (err) {
    if (ownsTransaction) {
      await client.query("ROLLBACK");
    }
    throw err;
  } finally {
    if (ownsTransaction) {
      client.release();
    }
  }
}
