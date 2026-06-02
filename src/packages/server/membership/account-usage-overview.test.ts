/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const resolveMembershipDetailsForAccountMock = jest.fn();
const getAIUsageStatusMock = jest.fn();
const getDedicatedHostPolicySnapshotLocalMock = jest.fn();

jest.mock("./resolve", () => ({
  resolveMembershipDetailsForAccount: (...args: any[]) =>
    resolveMembershipDetailsForAccountMock(...args),
}));

jest.mock("@cocalc/server/ai/usage-status", () => ({
  getAIUsageStatus: (...args: any[]) => getAIUsageStatusMock(...args),
}));

jest.mock("@cocalc/server/project-host/admission", () => ({
  getDedicatedHostPolicySnapshotLocal: (...args: any[]) =>
    getDedicatedHostPolicySnapshotLocalMock(...args),
}));

describe("getAccountUsageOverviewForAccount", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveMembershipDetailsForAccountMock.mockResolvedValue({
      selected: { class: "standard", source: "subscription" },
      candidates: [],
      usage_status: {
        collected_at: "2026-06-02T12:00:00.000Z",
        owned_project_count: 2,
        sampled_project_count: 1,
        unsampled_project_count: 1,
        measurement_error_count: 0,
        total_storage_bytes: 80,
        total_storage_hard_bytes: 100,
        total_storage_hard_remaining_bytes: 20,
        max_projects: 10,
        remaining_project_slots: 8,
        managed_cpu_5h_seconds: 1800,
        managed_cpu_5h_remaining_seconds: 1800,
        managed_cpu_5h_starts_at: new Date("2026-06-02T10:00:00.000Z"),
        managed_cpu_5h_reset_at: new Date("2026-06-02T15:00:00.000Z"),
        managed_cpu_5h_reset_in: "3 hours",
        managed_egress_5h_bytes: 90,
        managed_egress_5h_remaining_bytes: 10,
        managed_egress_5h_starts_at: new Date("2026-06-02T10:00:00.000Z"),
        managed_egress_5h_reset_at: new Date("2026-06-02T15:00:00.000Z"),
        managed_egress_5h_reset_in: "3 hours",
        managed_egress_recent_events: [{ bytes: 50, category: "download" }],
        managed_cpu_recent_events: [{ cpu_seconds: 60 }],
      },
    });
    getAIUsageStatusMock.mockResolvedValue({
      units_per_dollar: 1000,
      windows: [
        {
          window: "5h",
          used: 25,
          limit: 100,
          remaining: 75,
          starts_at: new Date("2026-06-02T10:00:00.000Z"),
          resets_at: new Date("2026-06-02T15:00:00.000Z"),
          reset_at: new Date("2026-06-02T15:00:00.000Z"),
          reset_in: "3 hours",
        },
        {
          window: "7d",
          used: 100,
          limit: 1000,
          remaining: 900,
        },
      ],
    });
    getDedicatedHostPolicySnapshotLocalMock.mockResolvedValue({
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 100,
        credit_spend_limit_7d_usd: 200,
      },
      dedicated_host_window_usage: {
        prepaid_5h_usd: "20",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "50",
      },
    });
  });

  it("normalizes current meters and selects max pressure per window", async () => {
    const { getAccountUsageOverviewForAccount } =
      await import("./account-usage-overview");

    const overview = await getAccountUsageOverviewForAccount({
      account_id: "account-1",
    });

    expect(resolveMembershipDetailsForAccountMock).toHaveBeenCalledWith(
      "account-1",
      { refresh_usage_status: true },
    );
    expect(getAIUsageStatusMock).toHaveBeenCalledWith({
      account_id: "account-1",
    });
    expect(overview.membership_label).toBe("standard");
    expect(overview.meters.map((meter) => meter.id)).toContain("ai-5h");
    expect(overview.meters.map((meter) => meter.id)).toContain(
      "managed-egress-5h",
    );
    expect(overview.meters.map((meter) => meter.id)).toContain(
      "project-storage-hard",
    );
    expect(overview.meters.map((meter) => meter.id)).toContain(
      "dedicated-host-prepaid-5h",
    );
    expect(overview.summary.pressure_5h?.limiting_meter_id).toBe(
      "managed-egress-5h",
    );
    expect(overview.summary.pressure_5h?.percent).toBe(90);
    expect(overview.summary.storage?.limiting_meter_id).toBe(
      "project-storage-hard",
    );
    expect(overview.measurement_warnings).toContain(
      "1 running project storage sample(s) were not available.",
    );
    expect(overview.recent_events.managed_egress?.length).toBe(1);
    expect(overview.recent_events.managed_cpu?.length).toBe(1);
  });

  it("keeps the overview usable when dedicated-host spend is unavailable", async () => {
    getDedicatedHostPolicySnapshotLocalMock.mockRejectedValue(
      new Error("not configured"),
    );
    const { getAccountUsageOverviewForAccount } =
      await import("./account-usage-overview");

    const overview = await getAccountUsageOverviewForAccount({
      account_id: "account-1",
    });

    expect(overview.meters.map((meter) => meter.id)).toContain("ai-5h");
    expect(
      overview.measurement_warnings.some((warning) =>
        warning.includes("Dedicated-host spend usage is not available"),
      ),
    ).toBe(true);
  });
});
