/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getTransactionClient,
  initEphemeralDatabase,
  type PoolClient,
} from "@cocalc/database/pool";
import {
  generateMembershipAllocationFixture,
  MEMBERSHIP_ALLOCATION_FIXTURE_BAY,
  replaceMembershipAllocationFixture,
  type MembershipAllocationFixtureRow,
  type MembershipAllocationFixtureTier,
} from "./allocation-analytics-fixtures";

const tiers: MembershipAllocationFixtureTier[] = [
  {
    id: "free",
    label: "Free",
    priority: 0,
    price_monthly: 0,
    price_yearly: 0,
    trial_days: 0,
    course_price: 0,
    course_duration_days: 0,
  },
  {
    id: "basic",
    label: "Basic",
    priority: 10,
    price_monthly: 8,
    price_yearly: 72,
    trial_days: 0,
    course_price: 0,
    course_duration_days: 0,
  },
  {
    id: "student",
    label: "Student",
    priority: 10,
    price_monthly: 8,
    price_yearly: 72,
    trial_days: 0,
    course_price: 18,
    course_duration_days: 122,
  },
  {
    id: "standard",
    label: "Standard",
    priority: 20,
    price_monthly: 24,
    price_yearly: 216,
    trial_days: 7,
    course_price: 0,
    course_duration_days: 0,
  },
  {
    id: "pro",
    label: "Pro",
    priority: 30,
    price_monthly: 200,
    price_yearly: 1800,
    trial_days: 0,
    course_price: 0,
    course_duration_days: 0,
  },
];

describe("membership allocation analytics fixtures", () => {
  it("generates deterministic historical and future data from paid tiers", () => {
    const options = {
      tiers,
      asOf: "2026-08-12",
      months: 30,
      futureDays: 365,
      targetMonthlyRevenueCents: 10_000_000,
    };
    const fixture = generateMembershipAllocationFixture(options);
    expect(fixture.start).toBe("2024-03-01");
    expect(fixture.asOf).toBe("2026-08-12");
    expect(fixture.end).toBe("2027-08-12");
    expect(
      Math.abs(
        fixture.trailing30RevenueCents - options.targetMonthlyRevenueCents,
      ) / options.targetMonthlyRevenueCents,
    ).toBeLessThanOrEqual(0.02);
    expect(fixture.journeyCount).toBeGreaterThan(0);
    expect(fixture.factCount).toBeGreaterThan(fixture.journeyCount);
    expect(generateMembershipAllocationFixture(options)).toEqual(fixture);

    const revenueByDay = new Map<string, number>();
    const membershipsByDay = new Map<string, number>();
    const trialsByDay = new Map<string, number>();
    for (const { day, revenue_cents } of fixture.rows) {
      revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + revenue_cents);
    }
    for (const { day, active_memberships, billing_interval } of fixture.rows) {
      membershipsByDay.set(
        day,
        (membershipsByDay.get(day) ?? 0) + active_memberships,
      );
      if (billing_interval === "trial") {
        trialsByDay.set(day, (trialsByDay.get(day) ?? 0) + active_memberships);
      }
    }
    expect(revenueByDay.get("2027-08-12")).toBeGreaterThan(0);
    expect(membershipsByDay.get("2027-08-12")).toBeGreaterThan(0);
    expect(membershipsByDay.get("2027-08-12")!).toBeGreaterThan(
      membershipsByDay.get(fixture.asOf)!,
    );
    expect(
      [...revenueByDay]
        .filter(([day]) => day >= "2026-07-14" && day <= fixture.asOf)
        .reduce((sum, [, revenue]) => sum + revenue, 0),
    ).toBe(fixture.trailing30RevenueCents);

    const recentMemberships = [...membershipsByDay]
      .filter(([day]) => day >= "2026-06-14" && day <= fixture.asOf)
      .map(([, memberships]) => memberships);
    const averageRecentMemberships =
      recentMemberships.reduce((sum, value) => sum + value, 0) /
      recentMemberships.length;
    const largestDailyChange = recentMemberships
      .slice(1)
      .reduce(
        (largest, value, index) =>
          Math.max(largest, Math.abs(value - recentMemberships[index])),
        0,
      );
    expect(largestDailyChange / averageRecentMemberships).toBeLessThan(0.03);

    const recentTrials = [...trialsByDay]
      .filter(([day]) => day >= "2026-06-14" && day <= fixture.asOf)
      .map(([, trialCount]) => trialCount);
    const averageRecentTrials =
      recentTrials.reduce((sum, value) => sum + value, 0) / recentTrials.length;
    const largestDailyTrialChange = recentTrials
      .slice(1)
      .reduce(
        (largest, value, index) =>
          Math.max(largest, Math.abs(value - recentTrials[index])),
        0,
      );
    expect(largestDailyTrialChange / averageRecentTrials).toBeLessThan(0.3);

    const classes = new Set(
      fixture.rows.map(({ membership_class }) => membership_class),
    );
    expect(classes).toEqual(new Set(["basic", "student", "standard", "pro"]));
    expect(
      fixture.rows.every(
        ({ membership_class, channel }) =>
          membership_class !== "student" || channel === "direct-student",
      ),
    ).toBe(true);
    expect(
      fixture.rows.every(
        ({ membership_class, channel }) =>
          channel !== "personal" || membership_class !== "free",
      ),
    ).toBe(true);
    expect(new Set(fixture.rows.map(({ lifecycle }) => lifecycle))).toEqual(
      new Set(["trial", "first_paid", "renewal", "plan_change"]),
    );
    expect(new Set(fixture.rows.map(({ tier_change }) => tier_change))).toEqual(
      new Set(["none", "upgrade", "downgrade"]),
    );

    const firstAnnualRenewal = fixture.rows
      .filter(
        ({ billing_interval, lifecycle }) =>
          billing_interval === "year" && lifecycle === "renewal",
      )
      .map(({ day }) => day)
      .sort()[0];
    expect(firstAnnualRenewal).toBeDefined();
    expect(firstAnnualRenewal! >= "2025-03-01").toBe(true);
    expect(
      fixture.rows.every(
        ({ active_memberships, purchased_capacity, revenue_cents }) =>
          Number.isSafeInteger(active_memberships) &&
          Number.isSafeInteger(purchased_capacity) &&
          Number.isSafeInteger(revenue_cents),
      ),
    ).toBe(true);
  });

  it("limits generated future data to one year", () => {
    expect(() =>
      generateMembershipAllocationFixture({
        tiers,
        asOf: "2026-08-12",
        futureDays: 366,
      }),
    ).toThrow("futureDays must not exceed 365");
  });

  describe("database replacement", () => {
    let client: PoolClient | undefined;

    beforeAll(async () => {
      await initEphemeralDatabase({});
      client = await getTransactionClient();
    }, 30_000);

    afterAll(async () => {
      if (client == null) return;
      await client.query("ROLLBACK");
      client.release();
    }, 30_000);

    it("replaces only rows reserved for the development fixture", async () => {
      if (client == null) throw Error("database client was not initialized");
      await client.query(
        `INSERT INTO membership_daily_allocations
           (day, bay_id, channel, source_kind, membership_class,
            billing_interval, lifecycle, previous_membership_class,
            previous_billing_interval, tier_change, active_memberships,
            purchased_capacity, revenue_cents, fact_count)
         VALUES
           ('2026-08-01', 'fixture-test-real-bay', 'personal', 'purchase',
            'basic', 'month', 'first_paid', '', '', 'none', 1, 0, 10, 1)`,
      );
      const row = {
        day: "2026-08-01",
        bay_id: MEMBERSHIP_ALLOCATION_FIXTURE_BAY,
        channel: "personal",
        source_kind: "external-import",
        membership_class: "standard",
        billing_interval: "month",
        lifecycle: "first_paid",
        previous_membership_class: "",
        previous_billing_interval: "",
        tier_change: "none",
        active_memberships: 3,
        purchased_capacity: 0,
        revenue_cents: 237,
        fact_count: 3,
      } satisfies MembershipAllocationFixtureRow;
      await replaceMembershipAllocationFixture({ rows: [row], client });
      await replaceMembershipAllocationFixture({
        rows: [{ ...row, revenue_cents: 241 }],
        client,
      });

      const { rows } = await client.query<{
        bay_id: string;
        revenue_cents: number | string;
      }>(
        `SELECT bay_id, revenue_cents
           FROM membership_daily_allocations
          WHERE bay_id IN ($1, 'fixture-test-real-bay')
          ORDER BY bay_id`,
        [MEMBERSHIP_ALLOCATION_FIXTURE_BAY],
      );
      expect(
        rows.map(({ bay_id, revenue_cents }) => ({
          bay_id,
          revenue_cents: Number(revenue_cents),
        })),
      ).toEqual([
        { bay_id: MEMBERSHIP_ALLOCATION_FIXTURE_BAY, revenue_cents: 241 },
        { bay_id: "fixture-test-real-bay", revenue_cents: 10 },
      ]);
    });
  });
});
