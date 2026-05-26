import { buildMembershipTierPresentation } from "./membership-tier-presentation";
import { applyMembershipTierTemplateFallbacks } from "./membership-tier-templates";

describe("buildMembershipTierPresentation", () => {
  it("derives benefits, limits, and billing from a built-in paid tier", () => {
    const tier = applyMembershipTierTemplateFallbacks({ id: "pro" });
    const presentation = buildMembershipTierPresentation(tier);

    expect(presentation.tagline).toContain("Higher limits");
    expect(presentation.benefits).toContain("Internet-enabled projects.");
    expect(presentation.benefits).toContain(
      "Can rent custom project hosts and use shared host tier 2.",
    );
    expect(presentation.benefits).toContain(
      "Advanced OCI RootFS image import.",
    );
    expect(presentation.limits).toEqual(
      expect.arrayContaining([
        "CPU: 3 cores",
        "Memory: 16 GB",
        "RootFS: 250 images, 250 GB total, 30 GB per image",
      ]),
    );
    expect(presentation.billing).toContain("$150.00 per month");
    expect(presentation.billing).toContain(
      "$1,350.00 per year (about 25% less than monthly)",
    );
  });

  it("includes course-specific terms for course-visible tiers", () => {
    const tier = applyMembershipTierTemplateFallbacks({ id: "student" });
    const presentation = buildMembershipTierPresentation(tier);

    expect(presentation.billing).toContain(
      "Course option: $25.00 for 122 days.",
    );
    expect(presentation.billing).toContain("Course grace period: 14 days.");
  });

  it("falls back to a configured-tier tagline for custom tiers", () => {
    const presentation = buildMembershipTierPresentation({
      id: "custom",
      label: "Custom",
      project_defaults: { network: 1, memory: 2000 },
    });

    expect(presentation.tagline).toBe(
      "Membership benefits configured for Custom.",
    );
    expect(presentation.benefits).toContain("Internet-enabled projects.");
    expect(presentation.limits).toContain("Memory: 2 GB");
  });
});
