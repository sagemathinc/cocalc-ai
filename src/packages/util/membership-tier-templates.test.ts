import { applyMembershipTierTemplateFallbacks } from "./membership-tier-templates";

describe("applyMembershipTierTemplateFallbacks", () => {
  it("fills missing entitlements from the built-in tier template", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "pro",
      project_defaults: undefined,
      llm_limits: undefined,
      features: undefined,
    });

    expect(tier.project_defaults).toBeDefined();
    expect(tier.features).toBeDefined();
    expect(tier.llm_limits).toBeDefined();

    const projectDefaults = tier.project_defaults as unknown as Record<
      string,
      unknown
    >;
    const features = tier.features as unknown as Record<string, unknown>;
    const llmLimits = tier.llm_limits as unknown as Record<string, unknown>;

    expect(projectDefaults.member_host).toBe(1);
    expect(features.create_hosts).toBe(true);
    expect(features.project_host_tier).toBe(2);
    expect(llmLimits.units_5h).toBeGreaterThan(0);
  });

  it("preserves explicit entitlements instead of overwriting them", () => {
    const tier = applyMembershipTierTemplateFallbacks({
      id: "member",
      project_defaults: { memory: 1234 },
      llm_limits: { units_5h: 7 },
      features: { create_hosts: false },
    });

    expect(tier.project_defaults).toEqual({ memory: 1234 });
    expect(tier.llm_limits).toEqual({ units_5h: 7 });
    expect(tier.features).toEqual({ create_hosts: false });
  });
});
