import { membershipUsageSummary } from "./usage-summary";

describe("membershipUsageSummary", () => {
  it("keeps the limits and usage numbers, and nothing about where they come from", () => {
    const summary = membershipUsageSummary({
      selected: {
        class: "pro",
        source: "grant",
        entitlements: {
          project_defaults: { secret_default: "x" },
          usage_limits: { max_projects: 1 },
        },
        effective_limits: {
          max_projects: 50,
          total_storage_soft_bytes: 1024,
          egress_policy: "metered-shared-hosts",
          invite_email_allow_urls: false,
        },
        expires: new Date("2027-01-01T00:00:00Z"),
        subscription_id: 1234,
        subscription_cost: 99,
        grant_id: "grant-secret",
        grant_purchase_id: 5678,
        site_license_id: "license-secret",
        site_license_name: "Secret University",
        organization_name: "Secret Org",
        team_license_id: "team-secret",
      },
      candidates: [
        {
          class: "pro",
          source: "subscription",
          priority: 1,
          entitlements: {},
          subscription_id: 4321,
          subscription_cost: 77,
        },
      ],
      admin_override: {
        effects: ["secret effect"],
        updated_at: "2026-11-01T00:00:00Z",
      },
      usage_status: {
        collected_at: "2026-11-05T12:00:00.000Z",
        owned_project_count: 3,
        sampled_project_count: 3,
        unsampled_project_count: 0,
        total_storage_bytes: 512,
        over_total_storage_soft: false,
        managed_egress_5h_bytes: 10,
        managed_egress_5h_reset_at: new Date("2026-11-05T15:00:00Z"),
        managed_egress_5h_reset_in: "3 hours",
        managed_egress_categories_5h_bytes: { "file-download": 10 },
        managed_egress_recent_events: [
          {
            project_id: "p",
            project_title: "Secret project",
            category: "file-download",
            bytes: 10,
            occurred_at: "2026-11-05T11:00:00Z",
            metadata: { request_path: "/secret?download" },
          } as any,
        ],
        managed_cpu_recent_events: [{ project_title: "Secret cpu" } as any],
        ...({ account_id: "acct-secret" } as any),
      },
    });

    expect(JSON.stringify(summary)).not.toMatch(
      /secret|Secret|1234|4321|5678|99|77/,
    );
    expect(summary).toEqual({
      membership: {
        class: "pro",
        source: "grant",
        expires: "2027-01-01T00:00:00.000Z",
      },
      limits: {
        max_projects: 50,
        total_storage_soft_bytes: 1024,
        egress_policy: "metered-shared-hosts",
        invite_email_allow_urls: false,
      },
      usage: {
        collected_at: "2026-11-05T12:00:00.000Z",
        owned_project_count: 3,
        sampled_project_count: 3,
        unsampled_project_count: 0,
        total_storage_bytes: 512,
        over_total_storage_soft: false,
        managed_egress_5h_bytes: 10,
        managed_egress_5h_reset_at: "2026-11-05T15:00:00.000Z",
        managed_egress_5h_reset_in: "3 hours",
        managed_egress_categories_5h_bytes: { "file-download": 10 },
      },
    });
  });

  it("falls back to the tier's limits, and has no usage when not measured", () => {
    expect(
      membershipUsageSummary({
        selected: {
          class: "free",
          source: "free",
          entitlements: { usage_limits: { max_projects: 3 } },
        },
        candidates: [],
      }),
    ).toEqual({
      membership: { class: "free", source: "free" },
      limits: { max_projects: 3 },
      usage: null,
    });
  });
});
