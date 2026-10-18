/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const connectMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ connect: (...args: any[]) => connectMock(...args) }),
}));

import {
  __test__,
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
    expect(summary.body_markdown).toContain("At 100%");
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
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
