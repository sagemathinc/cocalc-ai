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
    expect(
      (tier.usage_limits as Record<string, unknown>)
        ?.max_sponsored_running_projects,
    ).toBe(10);
    expect((tier.usage_limits as Record<string, unknown>)?.rootfs_count).toBe(
      250,
    );
    expect(
      (tier.usage_limits as Record<string, unknown>)?.rootfs_oci_images,
    ).toBe(true);
    expect(
      (tier.usage_limits as Record<string, unknown>)
        ?.project_max_collaborators_and_pending_invites,
    ).toBe(500);
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
        disk_quota: 10000,
        memory: 1234,
      }),
    );
    expect(tier.ai_limits).toEqual(
      expect.objectContaining({
        units_5h: 7,
        units_7d: expect.any(Number),
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
        invite_email_send_enabled: true,
        invite_email_daily_count: 50,
        project_max_collaborators_and_pending_invites: 50,
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

  it("defines hidden basic and standard individual membership templates", () => {
    const free = applyMembershipTierTemplateFallbacks({ id: "free" });
    const basic = applyMembershipTierTemplateFallbacks({ id: "basic" });
    const standard = applyMembershipTierTemplateFallbacks({ id: "standard" });

    expect(free.store_description).toMatch(/explore the platform/);
    expect(free.store_highlights).toEqual([]);

    expect(basic.label).toBe("Basic");
    expect(basic.store_description).toMatch(/occasional light use/);
    expect(basic.store_highlights).toContain("More shared resources");
    expect(basic.store_visible).toBe(false);
    expect(basic.course_store_visible).toBe(false);
    expect(basic.price_monthly).toBe(8);
    expect(basic.price_yearly).toBe(72);
    expect((basic.project_defaults as Record<string, unknown>).disk_quota).toBe(
      1000,
    );
    expect(
      (basic.usage_limits as Record<string, unknown>)
        .max_sponsored_running_projects,
    ).toBe(3);

    expect(standard.label).toBe("Standard");
    expect(standard.store_description).toMatch(/everyday work/);
    expect(standard.store_highlights).toContain(
      "Dedicated project host access, including GPU",
    );
    expect(standard.store_visible).toBe(false);
    expect(standard.course_store_visible).toBe(false);
    expect(standard.price_monthly).toBe(25);
    expect(standard.price_yearly).toBe(225);
    expect((standard.features as Record<string, unknown>).create_hosts).toBe(
      true,
    );
    expect(
      (standard.usage_limits as Record<string, unknown>)
        .prepaid_host_usage_limit_7d_usd,
    ).toBe(1000);
  });

  it("defines an instructor tier with course-scale invite limits", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "instructor",
    });

    expect(tier.label).toBe("Instructor");
    expect(tier.store_visible).toBe(true);
    expect(tier.course_store_visible).toBe(false);
    expect((tier.project_defaults as Record<string, unknown>).disk_quota).toBe(
      50000,
    );
    expect((tier.usage_limits as Record<string, unknown>).max_projects).toBe(
      250,
    );
    expect(
      (tier.usage_limits as Record<string, unknown>).invite_email_daily_count,
    ).toBe(500);
    expect(
      (tier.usage_limits as Record<string, unknown>)
        .course_max_students_and_pending_invites,
    ).toBe(500);
  });

  it("defines a researcher tier with research-scale compute and storage", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "researcher",
    });

    expect(tier.label).toBe("Researcher");
    expect(tier.store_visible).toBe(false);
    expect(tier.course_store_visible).toBe(false);
    expect((tier.features as Record<string, unknown>).create_hosts).toBe(true);
    expect((tier.features as Record<string, unknown>).project_host_tier).toBe(
      2,
    );
    expect((tier.project_defaults as Record<string, unknown>).disk_quota).toBe(
      100000,
    );
    expect((tier.project_defaults as Record<string, unknown>).memory).toBe(
      16000,
    );
    expect((tier.usage_limits as Record<string, unknown>).max_projects).toBe(
      150,
    );
    expect((tier.usage_limits as Record<string, unknown>).rootfs_count).toBe(
      100,
    );
    expect(
      (tier.usage_limits as Record<string, unknown>).rootfs_oci_images,
    ).toBe(true);
    expect(
      (tier.usage_limits as Record<string, unknown>)
        .project_max_collaborators_and_pending_invites,
    ).toBe(250);
    expect(
      (tier.usage_limits as Record<string, unknown>)
        .course_max_students_and_pending_invites,
    ).toBe(500);
  });
});
