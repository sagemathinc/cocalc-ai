import { applyMembershipTierTemplateFallbacks } from "./membership-tier-templates";

describe("applyMembershipTierTemplateFallbacks", () => {
  it("fills missing entitlements from the built-in tier template", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "pro",
      project_defaults: undefined,
      ai_limits: undefined,
      features: undefined,
    });

    expect(tier.project_defaults).toBeDefined();
    expect(tier.features).toBeDefined();
    expect(tier.ai_limits).toBeDefined();

    const projectDefaults = tier.project_defaults as unknown as Record<
      string,
      unknown
    >;
    const features = tier.features as unknown as Record<string, unknown>;
    const aiLimits = tier.ai_limits as unknown as Record<string, unknown>;

    expect(projectDefaults.member_host).toBe(1);
    expect(features.create_hosts).toBe(true);
    expect(features.project_host_tier).toBe(2);
    expect(tier.course_store_visible).toBe(false);
    expect(aiLimits.units_5h).toBeGreaterThan(0);
    expect(
      (tier.usage_limits as Record<string, unknown>)?.shared_compute_priority,
    ).toBeGreaterThan(0);
    expect((tier.usage_limits as Record<string, unknown>)?.rootfs_count).toBe(
      250,
    );
    expect(
      (tier.usage_limits as Record<string, unknown>)?.rootfs_oci_images,
    ).toBe(true);
  });

  it("preserves explicit entitlements instead of overwriting them", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "member",
      course_store_visible: true,
      course_price: 10,
      course_duration_days: 30,
      course_grace_days: 3,
      project_defaults: { memory: 1234 },
      ai_limits: { units_5h: 7 },
      features: { create_hosts: false },
      usage_limits: { shared_compute_priority: 99 },
    });

    expect(tier.project_defaults).toEqual({ memory: 1234 });
    expect(tier.course_store_visible).toBe(true);
    expect(tier.course_price).toBe(10);
    expect(tier.course_duration_days).toBe(30);
    expect(tier.course_grace_days).toBe(3);
    expect(tier.ai_limits).toEqual({ units_5h: 7 });
    expect(tier.features).toEqual({ create_hosts: false });
    expect(tier.usage_limits).toEqual(
      expect.objectContaining({
        shared_compute_priority: 99,
        notification_email_send_limit_5h: 200,
        notification_email_send_limit_7d: 1000,
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
        acp_max_running_per_account: 10,
        acp_max_active_automations_per_project: 3,
        rootfs_count: 20,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 10,
        rootfs_oci_images: false,
      }),
    );
  });

  it("marks the student template as course-visible with a one-time course price", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "student",
      course_store_visible: undefined,
      course_price: undefined,
      course_duration_days: undefined,
      course_grace_days: undefined,
    });

    expect(tier.course_store_visible).toBe(true);
    expect(tier.course_price).toBe(25);
    expect(tier.course_duration_days).toBe(122);
    expect(tier.course_grace_days).toBe(14);
  });
});
