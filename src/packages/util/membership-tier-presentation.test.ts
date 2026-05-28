import { buildMembershipTierPresentation } from "./membership-tier-presentation";
import { applyMembershipTierTemplateFallbacks } from "./membership-tier-templates";

describe("buildMembershipTierPresentation", () => {
  it("derives benefits, limits, and billing from a built-in paid tier", () => {
    const tier = applyMembershipTierTemplateFallbacks({ id: "pro" });
    const presentation = buildMembershipTierPresentation(tier);

    expect(presentation.tagline).toContain("Higher limits");
    expect(presentation.benefits).not.toContain("Internet-enabled projects.");
    expect(presentation.benefits).toContain(
      "Can rent custom project hosts with tier 2 host access.",
    );
    expect(presentation.summaryBenefits).toEqual(
      expect.arrayContaining([
        "Shared project-host pool access, tier 2.",
        "Up to 10 simultaneous sponsored running projects.",
      ]),
    );
    expect(presentation.benefits).toContain(
      "Advanced OCI RootFS image import.",
    );
    expect(presentation.summaryLimits).toEqual(
      expect.arrayContaining([
        "Shared compute priority: 4",
        "Project RAM: 16 GB",
        "Per-project disk quota: 10 GB",
      ]),
    );
    expect(presentation.limits).toEqual(
      expect.arrayContaining([
        "Shared compute priority: 4",
        "Project RAM: 16 GB",
        "RootFS: 250 images, 250 GB total, 30 GB per image",
      ]),
    );
    expect(presentation.billing).toContain("$160.00 per month");
    expect(presentation.billing).toContain(
      "$1,440.00 per year (about 25% less than monthly)",
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
      project_defaults: { network: 1, memory: 2000, disk_quota: 5000 },
      usage_limits: {
        total_storage_hard_bytes: 125_000_000_000,
        max_sponsored_running_projects: 10,
      },
    });

    expect(presentation.tagline).toBe(
      "Membership benefits configured for Custom.",
    );
    expect(presentation.benefits).not.toContain("Internet-enabled projects.");
    expect(presentation.summaryBenefits).toContain(
      "Up to 10 simultaneous sponsored running projects.",
    );
    expect(presentation.summaryLimits).toEqual(
      expect.arrayContaining([
        "Total storage hard cap: 125 GB",
        "Project RAM: 2 GB",
        "Per-project disk quota: 5 GB",
      ]),
    );
    expect(presentation.limits).toContain("Project RAM: 2 GB");
  });
});
