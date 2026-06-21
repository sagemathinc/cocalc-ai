import {
  applyMembershipTierTemplateFallbacks,
  TIER_TEMPLATES,
} from "./membership-tier-templates";

describe("membership tier templates", () => {
  it("defines the exported preset catalog", () => {
    expect(Object.keys(TIER_TEMPLATES)).toEqual([
      "admin",
      "basic",
      "free",
      "instructor",
      "member",
      "pro",
      "student",
    ]);
    expect(TIER_TEMPLATES).not.toHaveProperty("standard");
    expect(TIER_TEMPLATES).not.toHaveProperty("researcher");
  });

  it("fills missing entitlements from the built-in tier template", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "pro",
      project_defaults: undefined,
      ai_limits: undefined,
      features: undefined,
    });

    expect(tier.project_defaults).toEqual({
      disk_quota: 40000,
      memory: 16000,
      memory_request: 250,
    });
    expect(tier.features).toEqual({
      create_hosts: true,
      project_host_tier: 2,
    });
    expect(tier.ai_limits).toEqual({ units_5h: 0, units_7d: 0 });
    expect(tier.store_visible).toBe(true);
    expect(tier.team_visible).toBe(true);
    expect(tier.course_store_visible).toBe(false);
    expect(tier.price_monthly).toBe(200);
    expect(tier.price_yearly).toBe(1800);
    expect(tier.store_highlights).toContain(
      "Pay at the end of the month for powerful dedicated VMs",
    );
    expect(
      (tier.usage_limits as Record<string, unknown>)
        ?.max_sponsored_running_projects,
    ).toBe(16);
    expect((tier.usage_limits as Record<string, unknown>)?.rootfs_count).toBe(
      250,
    );
    expect(
      (tier.usage_limits as Record<string, unknown>)?.rootfs_oci_images,
    ).toBe(true);
  });

  it("merges explicit entitlements over built-in defaults", () => {
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

    expect(tier.course_store_visible).toBe(true);
    expect(tier.course_price).toBe(10);
    expect(tier.course_duration_days).toBe(30);
    expect(tier.course_grace_days).toBe(3);
    expect(tier.project_defaults).toEqual(
      expect.objectContaining({
        disk_quota: 16000,
        memory: 1234,
        memory_request: 0,
      }),
    );
    expect(tier.ai_limits).toEqual(
      expect.objectContaining({
        units_5h: 7,
        units_7d: 0,
      }),
    );
    expect(tier.features).toEqual(
      expect.objectContaining({
        create_hosts: false,
        project_host_tier: 1,
      }),
    );
    expect(tier.usage_limits).toEqual(
      expect.objectContaining({
        shared_compute_priority: 99,
        max_sponsored_running_projects: 3,
        max_projects: 20,
        total_storage_soft_bytes: 45_000_000_000,
        total_storage_hard_bytes: 50_000_000_000,
        notification_email_send_limit_5h: 200,
        notification_email_send_limit_7d: 1000,
        prepaid_host_usage_limit_5h_usd: 100,
        prepaid_host_usage_limit_7d_usd: 1000,
        rootfs_count: 20,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 10,
        rootfs_oci_images: false,
        invite_email_send_enabled: true,
        invite_email_daily_count: 50,
        project_max_collaborators_and_pending_invites: 50,
      }),
    );
  });

  it("marks the student template as course-visible with the exported course price", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "student",
      course_store_visible: undefined,
      course_price: undefined,
      course_duration_days: undefined,
      course_grace_days: undefined,
    });

    expect(tier.course_store_visible).toBe(true);
    expect(tier.course_price).toBe(18);
    expect(tier.course_duration_days).toBe(122);
    expect(tier.course_grace_days).toBe(10);
    expect((tier.project_defaults as Record<string, unknown>).memory).toBe(
      8000,
    );
    expect((tier.usage_limits as Record<string, unknown>).max_projects).toBe(
      10,
    );
  });

  it("defines free, basic, member, instructor, pro, and admin visibility", () => {
    expect(applyMembershipTierTemplateFallbacks({ id: "free" })).toEqual(
      expect.objectContaining({
        label: "Free",
        store_visible: true,
        team_visible: false,
        course_store_visible: false,
        price_monthly: 0,
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "basic" })).toEqual(
      expect.objectContaining({
        label: "Basic",
        store_visible: true,
        team_visible: false,
        trial_days: 7,
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "member" })).toEqual(
      expect.objectContaining({
        label: "Member",
        store_visible: true,
        team_visible: true,
        price_monthly: 25,
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "instructor" })).toEqual(
      expect.objectContaining({
        label: "Instructor",
        store_visible: false,
        team_visible: false,
        notes:
          "This is meant to be provided FOR FREE to instructors who will using student-pay or institute pay after we connect with them. ",
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "admin" })).toEqual(
      expect.objectContaining({
        label: "Admin",
        store_visible: false,
        priority: 31,
        notes: "bootstrap admin tier",
      }),
    );
  });

  it("does not emit eliminated legacy project quota fields from built-in templates", () => {
    const eliminated = [
      "cores",
      "cpu_shares",
      "mintime",
      "network",
      "member_host",
      "always_running",
      "ephemeral_state",
      "ephemeral_disk",
    ];

    for (const id of Object.keys(TIER_TEMPLATES)) {
      const tier = applyMembershipTierTemplateFallbacks({ id });
      const projectDefaults = tier.project_defaults as Record<string, unknown>;
      for (const key of eliminated) {
        expect(projectDefaults).not.toHaveProperty(key);
      }
    }
  });
});
