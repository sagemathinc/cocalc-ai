/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import membershipTiersQuery, {
  getMembershipTierUsageReport,
} from "./membership-tiers";

type QueryCall = {
  query: string;
  params?: unknown[];
  cb: (err?: Error | null, result?: unknown) => void;
};

function createDb({
  existingTables = [
    "subscriptions",
    "membership_packages",
    "membership_grants",
    "admin_assigned_memberships",
    "team_license_seat_lines",
    "membership_trial_claims",
    "site_license_pool_requests",
    "site_license_external_claim_pools",
    "site_license_external_claim_consumptions",
  ],
  siteLicenseTablesExist = true,
  membershipPackageTablesExist = true,
  tierRows = [
    { id: "student", label: "Student" },
    { id: "instructor", label: "Instructor" },
  ],
  subscriptionRows = [
    {
      tier_id: "student",
      subscription_count: 3,
      subscribed_account_count: 2,
    },
  ],
  siteLicenseRows = [],
  teamSeatRows = [],
  packageAccountRows = [],
  adminAssignedRows = [],
  totalAccountRows = [],
  totalActiveAccountCount = 12,
  usageHistoryRows = [],
}: {
  existingTables?: string[];
  siteLicenseTablesExist?: boolean;
  membershipPackageTablesExist?: boolean;
  tierRows?: { id: string; label?: string }[];
  subscriptionRows?: {
    tier_id: string;
    subscription_count: number;
    subscribed_account_count: number;
  }[];
  siteLicenseRows?: { tier_id: string; site_license_count: number }[];
  teamSeatRows?: { tier_id: string; team_seat_count: number }[];
  packageAccountRows?: {
    tier_id: string;
    team_account_count: number;
    course_account_count: number;
    site_account_count: number;
  }[];
  adminAssignedRows?: { tier_id: string; admin_assigned_count: number }[];
  totalAccountRows?: { tier_id: string; total_account_count: number }[];
  totalActiveAccountCount?: number;
  usageHistoryRows?: { tier_id: string; usage_history_count: number }[];
} = {}) {
  const calls: QueryCall[] = [];
  const db = {
    _query: (opts: QueryCall) => {
      calls.push(opts);
      const sql = opts.query;
      if (sql.includes("FROM unnest($1::text[])")) {
        const requested = (opts.params?.[0] ?? []) as string[];
        opts.cb(null, {
          rows: requested
            .filter((tableName) => existingTables.includes(tableName))
            .map((table_name) => ({ table_name })),
        });
      } else if (sql.includes("to_regclass('public.site_licenses')")) {
        opts.cb(null, { rows: [{ exists: siteLicenseTablesExist }] });
      } else if (
        sql.includes("to_regclass('public.membership_packages')") &&
        sql.includes("to_regclass('public.membership_package_assignments')")
      ) {
        opts.cb(null, { rows: [{ exists: membershipPackageTablesExist }] });
      } else if (
        sql.includes("COUNT(DISTINCT s.id)") &&
        sql.includes("membership_packages")
      ) {
        opts.cb(null, { rows: siteLicenseRows });
      } else if (
        sql.includes("SUM(seat_count)") &&
        sql.includes("kind = 'team'")
      ) {
        opts.cb(null, { rows: teamSeatRows });
      } else if (
        sql.includes("team_account_count") &&
        sql.includes("course_account_count") &&
        sql.includes("site_account_count")
      ) {
        opts.cb(null, { rows: packageAccountRows });
      } else if (sql === "SELECT * FROM membership_tiers") {
        opts.cb(null, {
          rows: tierRows,
        });
      } else if (sql.includes("usage_history_count")) {
        opts.cb(null, { rows: usageHistoryRows });
      } else if (sql.includes("total_active_account_count")) {
        opts.cb(null, {
          rows: [{ total_active_account_count: totalActiveAccountCount }],
        });
      } else if (sql.includes("total_account_count")) {
        opts.cb(null, { rows: totalAccountRows });
      } else if (sql.includes("subscription_count")) {
        opts.cb(null, { rows: subscriptionRows });
      } else if (sql.includes("FROM admin_assigned_memberships")) {
        opts.cb(null, { rows: adminAssignedRows });
      } else if (sql === "DELETE FROM membership_tiers WHERE id = $1") {
        opts.cb(null, { rows: [] });
      } else {
        opts.cb(new Error(`unexpected query: ${sql}`));
      }
    },
  };
  return { db: db as any, calls };
}

describe("membershipTiersQuery", () => {
  it("includes usage counts by membership tier", async () => {
    const { db } = createDb({
      siteLicenseRows: [{ tier_id: "instructor", site_license_count: 2 }],
      teamSeatRows: [{ tier_id: "student", team_seat_count: 7 }],
      packageAccountRows: [
        {
          tier_id: "student",
          team_account_count: 3,
          course_account_count: 5,
          site_account_count: 2,
        },
      ],
      adminAssignedRows: [
        { tier_id: "student", admin_assigned_count: 1 },
        { tier_id: "instructor", admin_assigned_count: 4 },
      ],
      usageHistoryRows: [{ tier_id: "student", usage_history_count: 1 }],
      totalAccountRows: [
        { tier_id: "student", total_account_count: 10 },
        { tier_id: "instructor", total_account_count: 4 },
      ],
      totalActiveAccountCount: 99,
    });

    const result = await membershipTiersQuery(db, [], { id: "*" });

    expect(result).toEqual([
      {
        id: "student",
        label: "Student",
        subscription_count: 3,
        subscribed_account_count: 2,
        team_seat_count: 7,
        team_account_count: 3,
        course_account_count: 5,
        site_account_count: 2,
        admin_assigned_count: 1,
        site_license_count: 0,
        total_account_count: 10,
        total_active_account_count: 99,
        has_usage_history: true,
      },
      {
        id: "instructor",
        label: "Instructor",
        subscription_count: 0,
        subscribed_account_count: 0,
        team_seat_count: 0,
        team_account_count: 0,
        course_account_count: 0,
        site_account_count: 0,
        admin_assigned_count: 4,
        site_license_count: 2,
        total_account_count: 4,
        total_active_account_count: 99,
        has_usage_history: false,
      },
    ]);
  });

  it("counts only live membership subscriptions in tier usage aggregates", async () => {
    const { db, calls } = createDb();

    await membershipTiersQuery(db, [], { id: "*" });

    const subscriptionCountQuery = calls.find((call) =>
      call.query.includes("subscription_count"),
    )?.query;
    const totalAccountQuery = calls.find((call) =>
      call.query.includes("total_account_count"),
    )?.query;
    for (const query of [subscriptionCountQuery, totalAccountQuery]) {
      expect(query).toContain("metadata->>'type'='membership'");
      expect(query).toContain("status IN ('active','canceled')");
      expect(query).toContain("current_period_end >= NOW()");
    }
  });

  it("includes an active account summary with tier rows", async () => {
    const { db, calls } = createDb({ totalActiveAccountCount: 123 });

    const result = await membershipTiersQuery(db, [], { id: "*" });

    expect(result).toEqual([
      expect.objectContaining({ total_active_account_count: 123 }),
      expect.objectContaining({ total_active_account_count: 123 }),
    ]);
    const accountSummaryQuery = calls.find((call) =>
      call.query.includes("total_active_account_count"),
    )?.query;
    expect(accountSummaryQuery).toContain("FROM accounts");
    expect(accountSummaryQuery).toContain("coalesce(deleted,false)=false");
  });

  it("counts site admins as admin-tier admin memberships", async () => {
    const { db, calls } = createDb({
      tierRows: [{ id: "admin", label: "Admin" }],
      subscriptionRows: [],
      adminAssignedRows: [{ tier_id: "admin", admin_assigned_count: 4 }],
      totalAccountRows: [{ tier_id: "admin", total_account_count: 4 }],
    });

    const result = await membershipTiersQuery(db, [], { id: "*" });

    expect(result).toEqual([
      {
        id: "admin",
        label: "Admin",
        subscription_count: 0,
        subscribed_account_count: 0,
        team_seat_count: 0,
        team_account_count: 0,
        course_account_count: 0,
        site_account_count: 0,
        admin_assigned_count: 4,
        site_license_count: 0,
        total_account_count: 4,
        total_active_account_count: 12,
        has_usage_history: false,
      },
    ]);
    const adminAssignedQuery = calls.find((call) =>
      call.query.includes("admin_assigned_count"),
    )?.query;
    const totalAccountQuery = calls.find((call) =>
      call.query.includes("total_account_count"),
    )?.query;
    for (const query of [adminAssignedQuery, totalAccountQuery]) {
      expect(query).toContain("'admin' = ANY(a.groups)");
      expect(query).toContain("coalesce(t.disabled,false)=false");
      expect(query).toContain("coalesce(a.deleted,false)=false");
    }
  });

  it("builds bay-local usage reports with home-bay filtered active account counts", async () => {
    const { db, calls } = createDb({
      siteLicenseRows: [{ tier_id: "instructor", site_license_count: 2 }],
      teamSeatRows: [{ tier_id: "student", team_seat_count: 7 }],
      packageAccountRows: [
        {
          tier_id: "student",
          team_account_count: 3,
          course_account_count: 5,
          site_account_count: 2,
        },
      ],
      adminAssignedRows: [
        { tier_id: "student", admin_assigned_count: 1 },
        { tier_id: "instructor", admin_assigned_count: 4 },
      ],
      usageHistoryRows: [{ tier_id: "student", usage_history_count: 1 }],
      totalAccountRows: [
        { tier_id: "student", total_account_count: 10 },
        { tier_id: "instructor", total_account_count: 4 },
      ],
      totalActiveAccountCount: 44,
    });

    const result = await getMembershipTierUsageReport(db, "bay-1");

    expect(result).toEqual({
      bay_id: "bay-1",
      total_active_account_count: 44,
      tiers: [
        {
          tier_id: "instructor",
          subscription_count: 0,
          subscribed_account_count: 0,
          team_seat_count: 0,
          team_account_count: 0,
          course_account_count: 0,
          site_account_count: 0,
          admin_assigned_count: 4,
          site_license_count: 2,
          total_account_count: 4,
          usage_history_count: 0,
        },
        {
          tier_id: "student",
          subscription_count: 3,
          subscribed_account_count: 2,
          team_seat_count: 7,
          team_account_count: 3,
          course_account_count: 5,
          site_account_count: 2,
          admin_assigned_count: 1,
          site_license_count: 0,
          total_account_count: 10,
          usage_history_count: 1,
        },
      ],
    });
    const accountSummaryCall = calls.find((call) =>
      call.query.includes("total_active_account_count"),
    );
    expect(accountSummaryCall?.query).toContain("home_bay_id");
    expect(accountSummaryCall?.params).toEqual(["bay-1"]);
  });

  it("blocks deleting a tier used by active site licenses", async () => {
    const { db, calls } = createDb({
      siteLicenseRows: [{ tier_id: "instructor", site_license_count: 1 }],
    });

    await expect(
      membershipTiersQuery(db, [{ delete: true }], { id: "instructor" }),
    ).rejects.toThrow("1 active site license");

    expect(
      calls.some(
        (call) => call.query === "DELETE FROM membership_tiers WHERE id = $1",
      ),
    ).toBe(false);
  });

  it("blocks deleting a tier used by live personal subscriptions", async () => {
    const { db, calls } = createDb();

    await expect(
      membershipTiersQuery(db, [{ delete: true }], { id: "student" }),
    ).rejects.toThrow("3 live personal subscriptions");

    expect(
      calls.some(
        (call) => call.query === "DELETE FROM membership_tiers WHERE id = $1",
      ),
    ).toBe(false);
  });

  it("blocks deleting a tier used by active team package seats", async () => {
    const { db, calls } = createDb({
      subscriptionRows: [],
      teamSeatRows: [{ tier_id: "student", team_seat_count: 2 }],
    });

    await expect(
      membershipTiersQuery(db, [{ delete: true }], { id: "student" }),
    ).rejects.toThrow("2 active team seats");

    expect(
      calls.some(
        (call) => call.query === "DELETE FROM membership_tiers WHERE id = $1",
      ),
    ).toBe(false);
  });

  it("blocks deleting a tier used by active course package assignments", async () => {
    const { db, calls } = createDb({
      subscriptionRows: [],
      packageAccountRows: [
        {
          tier_id: "student",
          team_account_count: 0,
          course_account_count: 1,
          site_account_count: 0,
        },
      ],
    });

    await expect(
      membershipTiersQuery(db, [{ delete: true }], { id: "student" }),
    ).rejects.toThrow("1 active course account");

    expect(
      calls.some(
        (call) => call.query === "DELETE FROM membership_tiers WHERE id = $1",
      ),
    ).toBe(false);
  });

  it("blocks deleting a tier with usage history", async () => {
    const { db, calls } = createDb({
      subscriptionRows: [],
      usageHistoryRows: [{ tier_id: "legacy", usage_history_count: 1 }],
    });

    await expect(
      membershipTiersQuery(db, [{ delete: true }], { id: "legacy" }),
    ).rejects.toThrow(
      'cannot delete membership tier "legacy" because it has usage history',
    );

    expect(
      calls.some(
        (call) => call.query === "DELETE FROM membership_tiers WHERE id = $1",
      ),
    ).toBe(false);
  });

  it("allows deletion when site-license tables do not exist", async () => {
    const { db, calls } = createDb({ siteLicenseTablesExist: false });

    await membershipTiersQuery(db, [{ delete: true }], { id: "legacy" });

    expect(
      calls.some(
        (call) => call.query === "DELETE FROM membership_tiers WHERE id = $1",
      ),
    ).toBe(true);
  });
});
