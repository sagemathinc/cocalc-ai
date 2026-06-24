/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

describe("admin account membership status", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
  });

  it("batch resolves free, subscription, admin, admin-group, and grant memberships", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM membership_tiers")) {
        return {
          rows: [
            { id: "free", label: "Free", priority: 0, disabled: false },
            { id: "basic", label: "Basic", priority: 10, disabled: false },
            {
              id: "student-ucla",
              label: "UCLA Student",
              priority: 25,
              disabled: false,
            },
            {
              id: "instructor",
              label: "Instructor",
              priority: 30,
              disabled: false,
            },
            { id: "admin", label: "Admin", priority: 100, disabled: false },
          ],
        };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [
            {
              account_id: "acct-sub",
              membership_class: "basic",
              status: "active",
              current_period_end: "2026-07-01T00:00:00.000Z",
            },
            {
              account_id: "acct-admin",
              membership_class: "basic",
              status: "active",
              current_period_end: "2026-07-01T00:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM admin_assigned_memberships")) {
        return {
          rows: [
            {
              account_id: "acct-admin",
              membership_class: "instructor",
              expires_at: null,
            },
          ],
        };
      }
      if (sql.includes("'admin' = ANY(groups)")) {
        return { rows: [{ account_id: "acct-admin-group" }] };
      }
      if (sql.includes("FROM membership_grants")) {
        return {
          rows: [
            {
              account_id: "acct-grant",
              membership_class: "student-ucla",
              expires_at: "2026-08-01T00:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getAdminAccountMembershipStatusMap } =
      await import("./admin-account-status");
    const statuses = await getAdminAccountMembershipStatusMap([
      "acct-free",
      "acct-sub",
      "acct-admin",
      "acct-admin-group",
      "acct-grant",
    ]);

    expect(statuses.get("acct-free")).toEqual({
      membership_class: "free",
      membership_label: "Free",
      membership_source: "free",
    });
    expect(statuses.get("acct-sub")).toEqual({
      membership_class: "basic",
      membership_label: "Basic",
      membership_source: "subscription",
    });
    expect(statuses.get("acct-admin")).toEqual({
      membership_class: "instructor",
      membership_label: "Instructor",
      membership_source: "admin",
    });
    expect(statuses.get("acct-admin-group")).toEqual({
      membership_class: "admin",
      membership_label: "Admin",
      membership_source: "admin",
    });
    expect(statuses.get("acct-grant")).toEqual({
      membership_class: "student-ucla",
      membership_label: "UCLA Student",
      membership_source: "grant",
    });
  });
});
