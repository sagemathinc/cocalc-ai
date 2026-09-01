/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getTransactionClient,
  initEphemeralDatabase,
  type PoolClient,
} from "@cocalc/database/pool";
import { ensureMembershipAnalyticsTables } from "@cocalc/server/membership/analytics";
import { uuid } from "@cocalc/util/misc";
import { backfillMembershipAllocationFacts } from "./allocation-analytics-backfill";

describe("membership allocation analytics backfill", () => {
  let client: PoolClient;

  beforeAll(async () => {
    await initEphemeralDatabase({});
    client = await getTransactionClient();
    await ensureMembershipAnalyticsTables(client);
  }, 30_000);

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  }, 30_000);

  it("reconstructs current personal, direct-student, and refund facts idempotently", async () => {
    const suffix = uuid().slice(0, 8);
    const basic = `backfill-basic-${suffix}`;
    const standard = `backfill-standard-${suffix}`;
    const pro = `backfill-pro-${suffix}`;
    const upgradeAccount = uuid();
    const downgradeAccount = uuid();
    const studentAccount = uuid();
    const courseAccount = uuid();
    const teamAccount = uuid();
    const assignmentAccount = uuid();
    const trialAccount = uuid();

    for (const [id, priority] of [
      [basic, 10],
      [standard, 20],
      [pro, 30],
    ] as const) {
      await client.query(
        `INSERT INTO membership_tiers
           (id, label, priority, disabled, created, updated)
         VALUES ($1,$1,$2,false,NOW(),NOW())`,
        [id, priority],
      );
    }

    const oldUpgradeSubscription = await insertSubscription(client, {
      account_id: upgradeAccount,
      membership_class: basic,
      cost: 105,
      interval: "month",
      created: "2026-06-01T12:00:00Z",
      period_start: "2026-06-01T12:00:00Z",
      period_end: "2026-06-08T12:00:00Z",
      canceled_at: "2026-06-04T12:00:00Z",
    });
    const oldUpgradePurchase = await insertMembershipPurchase(client, {
      account_id: upgradeAccount,
      subscription_id: oldUpgradeSubscription,
      membership_class: basic,
      interval: "month",
      cost: 105,
      time: "2026-06-01T12:00:00Z",
      period_start: "2026-06-01T12:00:00Z",
      period_end: "2026-06-08T12:00:00Z",
    });
    await client.query(
      "UPDATE subscriptions SET latest_purchase_id=$1 WHERE id=$2",
      [oldUpgradePurchase, oldUpgradeSubscription],
    );
    const newUpgradeSubscription = await insertSubscription(client, {
      account_id: upgradeAccount,
      membership_class: standard,
      cost: 180,
      interval: "month",
      created: "2026-06-04T12:00:00Z",
      period_start: "2026-06-04T12:00:00Z",
      period_end: "2026-07-04T12:00:00Z",
    });
    const upgradePurchase = await insertMembershipPurchase(client, {
      account_id: upgradeAccount,
      subscription_id: newUpgradeSubscription,
      membership_class: standard,
      interval: "month",
      cost: 120,
      time: "2026-06-04T12:00:00Z",
      period_start: "2026-06-04T12:00:00Z",
      period_end: "2026-07-04T12:00:00Z",
    });
    await insertCreatedEvent(client, {
      subscription_id: newUpgradeSubscription,
      account_id: upgradeAccount,
      membership_class: standard,
      previous_membership_class: basic,
      event_time: "2026-06-04T12:00:00Z",
    });

    const oldDowngradeSubscription = await insertSubscription(client, {
      account_id: downgradeAccount,
      membership_class: pro,
      cost: 200,
      interval: "month",
      created: "2026-06-01T12:00:00Z",
      period_start: "2026-06-01T12:00:00Z",
      period_end: "2026-07-01T12:00:00Z",
      canceled_at: "2026-06-10T12:00:00Z",
    });
    expect(oldDowngradeSubscription).toBeGreaterThan(0);
    const newDowngradeSubscription = await insertSubscription(client, {
      account_id: downgradeAccount,
      membership_class: basic,
      cost: 10,
      interval: "month",
      created: "2026-06-10T12:00:00Z",
      period_start: "2026-06-10T12:00:00Z",
      period_end: "2026-07-01T12:00:00Z",
    });
    await insertMembershipPurchase(client, {
      account_id: downgradeAccount,
      subscription_id: newDowngradeSubscription,
      membership_class: basic,
      interval: "month",
      cost: 10,
      time: "2026-07-01T12:00:00Z",
      period_start: "2026-07-01T12:00:00Z",
      period_end: "2026-08-01T12:00:00Z",
    });
    await insertCreatedEvent(client, {
      subscription_id: newDowngradeSubscription,
      account_id: downgradeAccount,
      membership_class: basic,
      previous_membership_class: pro,
      event_time: "2026-06-10T12:00:00Z",
    });

    const directStudentPurchase = await insertDirectStudentPurchase(client, {
      account_id: studentAccount,
      membership_class: standard,
    });
    await insertCoursePackagePurchase(client, {
      account_id: courseAccount,
      membership_class: standard,
    });
    await insertTeamLicensePurchase(client, {
      account_id: teamAccount,
      membership_class: pro,
    });
    await insertPackageAssignment(client, {
      account_id: assignmentAccount,
      membership_class: basic,
    });
    await insertSubscription(client, {
      account_id: trialAccount,
      membership_class: standard,
      cost: 180,
      interval: "month",
      created: "2026-08-01T12:00:00Z",
      period_start: "2026-08-01T12:00:00Z",
      period_end: "2026-08-08T12:00:00Z",
      trial_ends_at: "2026-08-08T12:00:00Z",
    });
    await client.query(
      `INSERT INTO purchases
         (time, account_id, cost, service, description)
       VALUES ($1,$2,$3,'refund',$4::jsonb)`,
      [
        "2026-06-05T12:00:00Z",
        upgradeAccount,
        -120,
        JSON.stringify({
          type: "refund",
          purchase_id: upgradePurchase,
          reason: "requested_by_customer",
          notes: "test",
        }),
      ],
    );

    const first = await backfillMembershipAllocationFacts({
      limit: 100,
      client,
    });
    // This workstation database may contain other unprojected development
    // records. The assertions below isolate this test's accounts.
    expect(first.trials).toBeGreaterThanOrEqual(1);
    expect(first.personal_purchases).toBeGreaterThanOrEqual(4);
    expect(first.direct_student_purchases).toBeGreaterThanOrEqual(1);
    expect(first.course_purchases).toBeGreaterThanOrEqual(1);
    expect(first.team_license_purchases).toBeGreaterThanOrEqual(1);
    expect(first.package_assignments).toBeGreaterThanOrEqual(1);
    expect(first.refunds).toBeGreaterThanOrEqual(2);
    expect(
      await backfillMembershipAllocationFacts({ limit: 100, client }),
    ).toEqual({
      trials: 0,
      personal_purchases: 0,
      direct_student_purchases: 0,
      course_purchases: 0,
      team_license_purchases: 0,
      package_assignments: 0,
      refunds: 0,
    });

    const { rows } = await client.query(
      `SELECT channel, lifecycle, tier_change,
              previous_membership_class,
              SUM(active_memberships)::int AS active_memberships,
              SUM(purchased_capacity)::int AS purchased_capacity,
              SUM(revenue_cents)::int AS revenue_cents,
              COUNT(*)::int AS facts
         FROM membership_allocation_facts
        WHERE account_id IN ($1,$2,$3,$4,$5,$6,$7)
        GROUP BY channel, lifecycle, tier_change,
                 previous_membership_class
        ORDER BY channel, lifecycle, tier_change,
                 previous_membership_class`,
      [
        upgradeAccount,
        downgradeAccount,
        studentAccount,
        trialAccount,
        courseAccount,
        teamAccount,
        assignmentAccount,
      ],
    );
    expect(rows).toEqual([
      {
        channel: "course",
        lifecycle: "first_paid",
        tier_change: "none",
        previous_membership_class: null,
        active_memberships: 0,
        purchased_capacity: 3,
        revenue_cents: 5400,
        facts: 1,
      },
      {
        channel: "direct-student",
        lifecycle: "first_paid",
        tier_change: "none",
        previous_membership_class: null,
        active_memberships: 2,
        purchased_capacity: 2,
        revenue_cents: 3600,
        facts: 1,
      },
      {
        channel: "personal",
        lifecycle: "first_paid",
        tier_change: "none",
        previous_membership_class: null,
        active_memberships: 1,
        purchased_capacity: 0,
        revenue_cents: 10500,
        facts: 1,
      },
      {
        channel: "personal",
        lifecycle: "plan_change",
        tier_change: "downgrade",
        previous_membership_class: pro,
        active_memberships: 1,
        purchased_capacity: 0,
        revenue_cents: 1000,
        facts: 1,
      },
      {
        channel: "personal",
        lifecycle: "plan_change",
        tier_change: "upgrade",
        previous_membership_class: basic,
        active_memberships: 0,
        purchased_capacity: 0,
        revenue_cents: 0,
        facts: 2,
      },
      {
        channel: "personal",
        lifecycle: "plan_change",
        tier_change: "upgrade",
        previous_membership_class: null,
        active_memberships: -1,
        purchased_capacity: 0,
        revenue_cents: 0,
        facts: 2,
      },
      {
        channel: "personal",
        lifecycle: "trial",
        tier_change: "none",
        previous_membership_class: null,
        active_memberships: 1,
        purchased_capacity: 0,
        revenue_cents: 0,
        facts: 1,
      },
      {
        channel: "site",
        lifecycle: "first_paid",
        tier_change: "none",
        previous_membership_class: null,
        active_memberships: 1,
        purchased_capacity: 0,
        revenue_cents: 0,
        facts: 1,
      },
      {
        channel: "team",
        lifecycle: "first_paid",
        tier_change: "none",
        previous_membership_class: null,
        active_memberships: 0,
        purchased_capacity: 4,
        revenue_cents: 48000,
        facts: 1,
      },
    ]);
    expect(directStudentPurchase).toBeGreaterThan(0);
  }, 30_000);
});

async function insertSubscription(
  client: PoolClient,
  opts: {
    account_id: string;
    membership_class: string;
    cost: number;
    interval: "month" | "year";
    created: string;
    period_start: string;
    period_end: string;
    canceled_at?: string;
    trial_ends_at?: string;
  },
): Promise<number> {
  const metadata = {
    type: "membership",
    class: opts.membership_class,
    ...(opts.trial_ends_at
      ? {
          trial: true,
          trial_days: 7,
          trial_ends_at: opts.trial_ends_at,
        }
      : {}),
  };
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO subscriptions
       (account_id, created, cost, interval, current_period_start,
        current_period_end, status, canceled_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING id`,
    [
      opts.account_id,
      opts.created,
      opts.cost,
      opts.interval,
      opts.period_start,
      opts.period_end,
      opts.canceled_at ? "canceled" : "active",
      opts.canceled_at ?? null,
      JSON.stringify(metadata),
    ],
  );
  return rows[0].id;
}

async function insertMembershipPurchase(
  client: PoolClient,
  opts: {
    account_id: string;
    subscription_id: number;
    membership_class: string;
    interval: "month" | "year";
    cost: number;
    time: string;
    period_start: string;
    period_end: string;
  },
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO purchases
       (time, account_id, cost, service, description, period_start, period_end)
     VALUES ($1,$2,$3,'membership',$4::jsonb,$5,$6)
     RETURNING id`,
    [
      opts.time,
      opts.account_id,
      opts.cost,
      JSON.stringify({
        type: "membership",
        subscription_id: opts.subscription_id,
        class: opts.membership_class,
        interval: opts.interval,
      }),
      opts.period_start,
      opts.period_end,
    ],
  );
  return rows[0].id;
}

async function insertCreatedEvent(
  client: PoolClient,
  opts: {
    subscription_id: number;
    account_id: string;
    membership_class: string;
    previous_membership_class: string;
    event_time: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO membership_analytics_events
       (event_key, event_type, event_time, bay_id, account_id,
        membership_class, previous_membership_class, source,
        interval, subscription_id)
     VALUES ($1,'membership_changed',$2,'test-bay',$3,$4,$5,
             'subscription','month',$6)`,
    [
      `subscription:${opts.subscription_id}:created`,
      opts.event_time,
      opts.account_id,
      opts.membership_class,
      opts.previous_membership_class,
      opts.subscription_id,
    ],
  );
}

async function insertDirectStudentPurchase(
  client: PoolClient,
  opts: { account_id: string; membership_class: string },
): Promise<number> {
  const startsAt = "2026-09-01T12:00:00Z";
  const expiresAt = "2026-12-01T12:00:00Z";
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO purchases
       (time, account_id, cost, service, description, period_start, period_end)
     VALUES ($1,$2,36,'membership',$3::jsonb,$1,$4)
     RETURNING id`,
    [
      startsAt,
      opts.account_id,
      JSON.stringify({
        type: "membership-package",
        package_id: uuid(),
        kind: "course",
        membership_class: opts.membership_class,
        seat_count: 2,
        seat_price: 18,
        total_price: 36,
        starts_at: startsAt,
        expires_at: expiresAt,
        interval: "year",
        metadata: { direct_student_purchase: true },
      }),
      expiresAt,
    ],
  );
  return rows[0].id;
}

async function insertCoursePackagePurchase(
  client: PoolClient,
  opts: { account_id: string; membership_class: string },
): Promise<number> {
  const startsAt = "2026-09-01T12:00:00Z";
  const expiresAt = "2026-12-01T12:00:00Z";
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO purchases
       (time, account_id, cost, service, description, period_start, period_end)
     VALUES ($1,$2,54,'membership',$3::jsonb,$1,$4)
     RETURNING id`,
    [
      startsAt,
      opts.account_id,
      JSON.stringify({
        type: "membership-package",
        package_id: uuid(),
        kind: "course",
        membership_class: opts.membership_class,
        seat_count: 3,
        seat_price: 18,
        total_price: 54,
        starts_at: startsAt,
        expires_at: expiresAt,
        interval: "year",
        metadata: {},
      }),
      expiresAt,
    ],
  );
  return rows[0].id;
}

async function insertTeamLicensePurchase(
  client: PoolClient,
  opts: { account_id: string; membership_class: string },
): Promise<number> {
  const startsAt = "2026-09-01T12:00:00Z";
  const expiresAt = "2027-09-01T12:00:00Z";
  await client.query(
    `INSERT INTO team_licenses
       (id, owner_account_id, status, current_period_start,
        current_period_end, metadata, created, updated)
     VALUES ($1,$2,'active',$3,$4,'{}'::jsonb,$3,$3)`,
    [uuid(), opts.account_id, startsAt, expiresAt],
  );
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO purchases
       (time, account_id, cost, service, tag, description,
        period_start, period_end)
     VALUES ($1,$2,480,'membership','team-license-change',$3::jsonb,$1,$4)
     RETURNING id`,
    [
      startsAt,
      opts.account_id,
      JSON.stringify({
        type: "team-license-change",
        interval: "year",
        line_items: [
          {
            description: `4 ${opts.membership_class} annual team seats at $120/seat`,
            amount: 480,
          },
        ],
      }),
      expiresAt,
    ],
  );
  return rows[0].id;
}

async function insertPackageAssignment(
  client: PoolClient,
  opts: { account_id: string; membership_class: string },
): Promise<void> {
  const packageId = uuid();
  await client.query(
    `INSERT INTO membership_packages
       (id, owner_account_id, kind, membership_class, seat_count,
        starts_at, metadata, created, updated)
     VALUES ($1,$2,'site',$3,1,date_trunc('month', NOW()),'{}'::jsonb,
             NOW(),NOW())`,
    [packageId, uuid(), opts.membership_class],
  );
  await client.query(
    `INSERT INTO membership_package_assignments
       (id, package_id, account_id, assigned_at, metadata, created, updated)
     VALUES ($1,$2,$3,date_trunc('month', NOW()),'{}'::jsonb,NOW(),NOW())`,
    [uuid(), packageId, opts.account_id],
  );
}
