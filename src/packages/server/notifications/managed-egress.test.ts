/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const connectMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ connect: (...args: any[]) => connectMock(...args) }),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: async (ids: string[]) =>
    ids.map((account_id) => ({ account_id, home_bay_id: "bay-0" })),
}));

import {
  __test__,
  managedEgressNoticeDue,
  managedEgressNotificationId,
  managedEgressNoticeSummary,
  maybeNotifyManagedEgressLimit,
} from "./managed-egress";

describe("managed egress notices", () => {
  beforeEach(() => {
    connectMock.mockReset();
    __test__.clearRecentlyChecked();
  });

  it("names the pool, usage, limit, reset and what to do for control-plane blocks", () => {
    const summary = managedEgressNoticeSummary({
      account_id: "a",
      pool: "control-plane",
      window: "7d",
      used: 101_000_000_000,
      limit: 100_000_000_000,
      blocked: true,
      resets_at: new Date("2026-10-20T12:00:00.000Z"),
    });
    expect(summary).toMatchObject({
      title: "Browser control traffic limit reached",
      severity: "error",
      notice_type: "managed_egress_blocked",
      action_link: "/settings/membership",
    });
    expect(summary.body_markdown).toContain("(101%) in the last 7 days");
    expect(summary.body_markdown).toContain("2026-10-20T12:00:00.000Z");
    expect(summary.body_markdown).toContain("cocalc CLI) still works");
    expect(summary.body_markdown).toContain("contact support");
  });

  it("warns at 90% of the shared pool before anything is blocked", () => {
    const summary = managedEgressNoticeSummary({
      account_id: "a",
      pool: "shared",
      window: "5h",
      used: 900,
      limit: 1000,
      blocked: false,
    });
    expect(summary.title).toBe(
      "Managed network traffic is at 90% of its limit",
    );
    expect(summary.notice_type).toBe("managed_egress_near_limit");
    expect(summary.body_markdown).toContain("Over the limit");
    expect(summary.body_markdown).toContain("Upgrade your membership");
  });

  it("does not touch the database below 90%, and checks at most once per process interval", async () => {
    const input = {
      account_id: "a",
      pool: "shared" as const,
      window: "5h" as const,
      used: 899,
      limit: 1000,
      blocked: false,
    };
    maybeNotifyManagedEgressLimit(input);
    expect(connectMock).not.toHaveBeenCalled();
    connectMock.mockRejectedValue(new Error("no db in this test"));
    maybeNotifyManagedEgressLimit({ ...input, used: 950 });
    maybeNotifyManagedEgressLimit({ ...input, used: 960 });
    // the home-bay lookup is awaited before connecting
    await new Promise((resolve) => setImmediate(resolve));
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("always notifies a block, including under a 0 limit, without an Infinity percentage", () => {
    expect(managedEgressNoticeDue({ used: 5, limit: 0, blocked: true })).toBe(
      true,
    );
    // a 0 limit with no usage is not blocked and never "near"
    expect(managedEgressNoticeDue({ used: 0, limit: 0, blocked: false })).toBe(
      false,
    );
    expect(
      managedEgressNoticeDue({ used: 899, limit: 1000, blocked: false }),
    ).toBe(false);
    expect(
      managedEgressNoticeDue({ used: 900, limit: 1000, blocked: false }),
    ).toBe(true);
    const summary = managedEgressNoticeSummary({
      account_id: "a",
      pool: "control-plane",
      window: "5h",
      used: 5_000_000,
      limit: 0,
      blocked: true,
    });
    expect(summary.title).toBe("Browser control traffic limit reached");
    expect(summary.body_markdown).toContain("limit of 0");
    expect(summary.body_markdown).not.toMatch(/Infinity|NaN/);
  });

  it("derives the same notification id on every bay for a key and UTC day", () => {
    const at = new Date("2026-10-19T00:30:00.000Z");
    const id = managedEgressNotificationId(
      "managed-egress:shared:7d:blocked:a",
      at,
    );
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      managedEgressNotificationId(
        "managed-egress:shared:7d:blocked:a",
        new Date("2026-10-19T23:59:00.000Z"),
      ),
    ).toBe(id);
    expect(
      managedEgressNotificationId(
        "managed-egress:shared:7d:blocked:a",
        new Date("2026-10-20T00:00:00.000Z"),
      ),
    ).not.toBe(id);
    expect(
      managedEgressNotificationId("managed-egress:shared:7d:near:a", at),
    ).not.toBe(id);
  });
});
