import { MEMBERSHIP_TIER_FIELDS } from "./membership-tier-field-metadata";
import {
  applyMembershipTierTemplateFallbacks,
  membershipTierTemplates,
  STAR_FREE_TIER_TEMPLATE,
  STAR_GENEROUS_USAGE_LIMITS,
  STAR_RETAINED_USAGE_LIMITS,
  STAR_UNLIMITED_USAGE_LIMITS,
  TIER_TEMPLATES,
} from "./membership-tier-templates";

describe("membership tier templates", () => {
  it("provides generous named-agent defaults without changing explicit limits", () => {
    expect(
      Object.fromEntries(
        Object.entries(TIER_TEMPLATES).map(([id, tier]) => [
          id,
          tier.usage_limits.max_named_agents,
        ]),
      ),
    ).toEqual({
      admin: 1000,
      basic: 250,
      free: 100,
      instructor: 1000,
      standard: 250,
      pro: 1000,
      student: 250,
    });
    expect(
      applyMembershipTierTemplateFallbacks({ id: "free", usage_limits: {} })
        .usage_limits,
    ).toMatchObject({ max_named_agents: 100 });
    expect(
      applyMembershipTierTemplateFallbacks({
        id: "free",
        usage_limits: { max_named_agents: 5 },
      }).usage_limits,
    ).toMatchObject({ max_named_agents: 5 });
  });
  it("defines the exported preset catalog", () => {
    expect(Object.keys(TIER_TEMPLATES)).toEqual([
      "admin",
      "basic",
      "free",
      "instructor",
      "standard",
      "pro",
      "student",
    ]);
    expect(TIER_TEMPLATES).not.toHaveProperty("member");
    expect(TIER_TEMPLATES).not.toHaveProperty("researcher");
  });

  it("does not include member as a built-in template", () => {
    // IT SHOULD NOT BE RECREATED. Local admins may create a tier named
    // "member", but the built-in template name is confusing.
    expect(TIER_TEMPLATES).not.toHaveProperty("member");
    expect(Object.keys(TIER_TEMPLATES)).not.toContain("member");
  });

  it("preconfigures a free trial only for the standard template", () => {
    const trialTemplateIds = Object.entries(TIER_TEMPLATES)
      .filter(([, template]) => (template.trial_days ?? 0) > 0)
      .map(([id]) => id);

    expect(trialTemplateIds).toEqual(["standard"]);
    expect(TIER_TEMPLATES.standard.trial_days).toBe(7);
  });

  it("keeps built-in templates hidden until admins explicitly expose them", () => {
    // Templates are scaffolds, not publication decisions. Hidden-by-default
    // tiers are easy to enable deliberately; accidentally published tiers are
    // confusing in the public store, team-license flows, and course checkout.
    for (const template of Object.values(TIER_TEMPLATES)) {
      expect(template.store_visible).toBe(false);
      expect(template.team_visible).toBe(false);
      expect(template.course_store_visible).toBe(false);
      expect(template.course_allowed_domains).toEqual([]);
    }
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
      private_app_hostnames_per_project: 30,
    });
    expect(tier.ai_limits).toEqual({ units_5h: 0, units_7d: 0 });
    expect(tier.store_visible).toBe(false);
    expect(tier.team_visible).toBe(false);
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
      (tier.usage_limits as Record<string, unknown>)?.public_directory_shares,
    ).toBe(1000);
    expect(
      (tier.usage_limits as Record<string, unknown>)?.rootfs_oci_images,
    ).toBe(true);
  });

  it("merges explicit entitlements over built-in defaults", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "standard",
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
        public_directory_shares: 100,
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

  it("leaves local tiers named member untouched", () => {
    const localTier = {
      id: "member",
      label: "Local Member",
      store_visible: false,
      usage_limits: { max_projects: 7 },
    };

    expect(applyMembershipTierTemplateFallbacks(localTier)).toBe(localTier);
  });

  it("allows Basic members to send bounded invitation email", () => {
    expect(TIER_TEMPLATES.basic.usage_limits).toEqual(
      expect.objectContaining({
        invite_email_send_enabled: true,
        invite_email_hourly_count: 10,
        invite_email_daily_count: 20,
      }),
    );
  });

  it("limits background runtime only for the free tier", () => {
    expect(TIER_TEMPLATES.free.usage_limits).toEqual(
      expect.objectContaining({ browser_idle_timeout_seconds: 1800 }),
    );
    for (const [id, tier] of Object.entries(TIER_TEMPLATES)) {
      if (id === "free") continue;
      expect(tier.usage_limits).not.toHaveProperty(
        "browser_idle_timeout_seconds",
      );
    }
  });

  it("keeps the student template price without exposing course checkout", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "student",
      course_store_visible: undefined,
      course_price: undefined,
      course_duration_days: undefined,
      course_grace_days: undefined,
    });

    expect(tier.course_store_visible).toBe(false);
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

  it("defines selected tier pricing and labels", () => {
    expect(applyMembershipTierTemplateFallbacks({ id: "free" })).toEqual(
      expect.objectContaining({
        label: "Free",
        price_monthly: 0,
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "basic" })).toEqual(
      expect.objectContaining({
        label: "Basic",
        trial_days: null,
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "standard" })).toEqual(
      expect.objectContaining({
        label: "Standard",
        store_description: "A solid choice for everyday work.",
        price_monthly: 24,
        price_yearly: 216,
        trial_days: 7,
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "instructor" })).toEqual(
      expect.objectContaining({
        label: "Instructor",
        notes:
          "This is meant to be provided FOR FREE to instructors who will using student-pay or institute pay after we connect with them. ",
      }),
    );
    expect(applyMembershipTierTemplateFallbacks({ id: "admin" })).toEqual(
      expect.objectContaining({
        label: "Admin",
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

describe("CoCalc Star free tier", () => {
  const classified = [
    ...STAR_UNLIMITED_USAGE_LIMITS,
    ...STAR_GENEROUS_USAGE_LIMITS,
    ...STAR_RETAINED_USAGE_LIMITS,
  ] as string[];

  it("classifies every known usage limit exactly once", () => {
    expect(new Set(classified).size).toBe(classified.length);
    const known = new Set([
      ...Object.values(TIER_TEMPLATES).flatMap((tier) =>
        Object.keys(tier.usage_limits),
      ),
      ...MEMBERSHIP_TIER_FIELDS.map(({ id }) => id)
        .filter((id) => id.startsWith("usage_limits."))
        .map((id) => id.slice("usage_limits.".length)),
    ]);
    expect([...known].filter((key) => !classified.includes(key))).toEqual([]);
  });

  it("has no per-account limits and moderate project sizes", () => {
    const usage = STAR_FREE_TIER_TEMPLATE.usage_limits;
    for (const key of STAR_UNLIMITED_USAGE_LIMITS) {
      expect(usage).not.toHaveProperty(key);
    }
    for (const key of STAR_GENEROUS_USAGE_LIMITS) {
      expect(usage[key]).toEqual(TIER_TEMPLATES.admin.usage_limits[key]);
    }
    for (const key of STAR_RETAINED_USAGE_LIMITS) {
      if (key in TIER_TEMPLATES.free.usage_limits) {
        expect(usage[key]).toEqual(TIER_TEMPLATES.free.usage_limits[key]);
      }
    }
    expect(STAR_FREE_TIER_TEMPLATE.project_defaults).toEqual({
      ...TIER_TEMPLATES.free.project_defaults,
      memory: 8000,
      disk_quota: 20000,
    });
    expect(STAR_FREE_TIER_TEMPLATE.id).toBe("free");
    expect(STAR_FREE_TIER_TEMPLATE.features.project_network).toBe(true);
    expect(TIER_TEMPLATES.free.features).not.toHaveProperty("project_network");
  });

  it("is the free template only on Star", () => {
    expect(membershipTierTemplates("star").free).toBe(STAR_FREE_TIER_TEMPLATE);
    expect(membershipTierTemplates("star").admin).toBe(TIER_TEMPLATES.admin);
    expect(membershipTierTemplates(undefined)).toBe(TIER_TEMPLATES);
    expect(membershipTierTemplates("launchpad-cloud")).toBe(TIER_TEMPLATES);
  });

  it("keeps blank limits of an edited Star free tier unlimited", () => {
    const edited = applyMembershipTierTemplateFallbacks(
      { id: "free", usage_limits: { max_named_agents: 7 } },
      membershipTierTemplates("star"),
    ).usage_limits as Record<string, unknown>;
    expect(edited.max_named_agents).toBe(7);
    expect(edited).not.toHaveProperty("max_projects");
    expect(
      (
        applyMembershipTierTemplateFallbacks({ id: "free", usage_limits: {} })
          .usage_limits as Record<string, unknown>
      ).max_projects,
    ).toBe(TIER_TEMPLATES.free.usage_limits.max_projects);
  });
});
