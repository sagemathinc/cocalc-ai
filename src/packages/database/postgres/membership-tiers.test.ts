/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import membershipTiersQuery from "./membership-tiers";

type QueryCall = {
  query: string;
  params?: unknown[];
  cb: (err?: Error | null, result?: unknown) => void;
};

function createDb({
  siteLicenseTablesExist = true,
  siteLicenseRows = [],
  adminAssignedRows = [],
}: {
  siteLicenseTablesExist?: boolean;
  siteLicenseRows?: { tier_id: string; site_license_count: number }[];
  adminAssignedRows?: { tier_id: string; admin_assigned_count: number }[];
} = {}) {
  const calls: QueryCall[] = [];
  const db = {
    _query: (opts: QueryCall) => {
      calls.push(opts);
      const sql = opts.query;
      if (sql.includes("to_regclass('public.site_licenses')")) {
        opts.cb(null, { rows: [{ exists: siteLicenseTablesExist }] });
      } else if (
        sql.includes("COUNT(DISTINCT s.id)") &&
        sql.includes("membership_packages")
      ) {
        opts.cb(null, { rows: siteLicenseRows });
      } else if (sql === "SELECT * FROM membership_tiers") {
        opts.cb(null, {
          rows: [
            { id: "student", label: "Student" },
            { id: "instructor", label: "Instructor" },
          ],
        });
      } else if (sql.includes("FROM subscriptions")) {
        opts.cb(null, {
          rows: [
            {
              tier_id: "student",
              subscription_count: 3,
              account_count: 2,
            },
          ],
        });
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
  it("includes active site-license counts by membership tier", async () => {
    const { db } = createDb({
      siteLicenseRows: [{ tier_id: "instructor", site_license_count: 2 }],
      adminAssignedRows: [
        { tier_id: "student", admin_assigned_count: 1 },
        { tier_id: "instructor", admin_assigned_count: 4 },
      ],
    });

    const result = await membershipTiersQuery(db, [], { id: "*" });

    expect(result).toEqual([
      {
        id: "student",
        label: "Student",
        subscription_count: 3,
        subscribed_account_count: 2,
        admin_assigned_count: 1,
        site_license_count: 0,
      },
      {
        id: "instructor",
        label: "Instructor",
        subscription_count: 0,
        subscribed_account_count: 0,
        admin_assigned_count: 4,
        site_license_count: 2,
      },
    ]);
  });

  it("blocks deleting a tier used by active site licenses", async () => {
    const { db, calls } = createDb({
      siteLicenseRows: [{ tier_id: "instructor", site_license_count: 1 }],
    });

    await expect(
      membershipTiersQuery(db, [{ delete: true }], { id: "instructor" }),
    ).rejects.toThrow(
      'cannot delete membership tier "instructor" because it is used by 1 active site license',
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
