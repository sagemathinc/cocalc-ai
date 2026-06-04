import {
  ACCOUNT_SETTINGS_NAVIGATION,
  getSettingsNavigationGroupKey,
  getSettingsOverviewSections,
  getVisibleSettingsNavigation,
  type SettingsNavigationContext,
} from "./settings-navigation";

const visibleContext: SettingsNavigationContext = {
  isAdmin: false,
  isCommercial: true,
  isLite: false,
  zendesk: true,
};

describe("settings-navigation", () => {
  it("keeps menu grouping separate from page identity", () => {
    expect(getSettingsNavigationGroupKey("vouchers")).toBe("billing");
    expect(getSettingsNavigationGroupKey("team-licenses")).toBe("licenses");
    expect(getSettingsNavigationGroupKey("ai")).toBe("preferences");
    const licenses = ACCOUNT_SETTINGS_NAVIGATION.find(
      (node) => node.type === "group" && node.key === "licenses",
    );
    const billing = ACCOUNT_SETTINGS_NAVIGATION.find(
      (node) => node.type === "group" && node.key === "billing",
    );
    const preferences = ACCOUNT_SETTINGS_NAVIGATION.find(
      (node) => node.type === "group" && node.key === "preferences",
    );
    expect(licenses?.type).toBe("group");
    expect(billing?.type).toBe("group");
    expect(preferences?.type).toBe("group");
    if (licenses?.type === "group") {
      expect(licenses.pages.map(({ page }) => page)).toContain("team-licenses");
    }
    if (billing?.type === "group") {
      expect(billing.pages.map(({ page }) => page)).toContain("vouchers");
    }
    if (preferences?.type === "group") {
      expect(preferences.pages.map(({ page }) => page)).toContain("ai");
    }
  });

  it("applies runtime visibility conditions to groups and pages", () => {
    const liteNavigation = getVisibleSettingsNavigation({
      ...visibleContext,
      isCommercial: false,
      isLite: true,
      zendesk: false,
    });

    const preferences = liteNavigation.find(
      (node) => node.type === "group" && node.key === "preferences",
    );
    expect(preferences?.type).toBe("group");
    if (preferences?.type === "group") {
      expect(preferences.pages.map(({ page }) => page)).not.toContain(
        "communication",
      );
      expect(preferences.pages.map(({ page }) => page)).not.toContain("keys");
    }
    expect(
      liteNavigation.some(
        (node) => node.type === "group" && node.key === "licenses",
      ),
    ).toBe(false);
    expect(
      liteNavigation.some(
        (node) => node.type === "group" && node.key === "billing",
      ),
    ).toBe(false);
    expect(
      liteNavigation.some(
        (node) => node.type === "page" && node.page === "support",
      ),
    ).toBe(false);
    expect(
      liteNavigation.some(
        (node) => node.type === "page" && node.page === "membership",
      ),
    ).toBe(false);
    expect(
      liteNavigation.some(
        (node) => node.type === "page" && node.page === "usage-limits",
      ),
    ).toBe(false);
  });

  it("derives overview sections from the visible navigation tree", () => {
    const overview = getSettingsOverviewSections(visibleContext);

    expect(overview.primaryPages).toContain("profile");
    expect(overview.primaryPages).toContain("membership");
    expect(overview.primaryPages).toContain("usage-limits");
    expect(overview.primaryPages).toContain("appearance");
    expect(overview.primaryPages).toContain("ai");
    expect(
      overview.sections.find((section) => section.key === "licenses")?.pages,
    ).toEqual(["team-licenses", "site-licenses", "software-licenses"]);
    expect(
      overview.sections.find((section) => section.key === "billing")?.pages,
    ).toEqual([
      "subscriptions",
      "purchases",
      "payments",
      "payment-methods",
      "statements",
      "vouchers",
    ]);
    expect(
      overview.sections.find((section) => section.key === "support")?.pages,
    ).toEqual(["support"]);
  });

  it("shows team license management only when commerce or admin access is available", () => {
    const nonCommercialUser = getVisibleSettingsNavigation({
      ...visibleContext,
      isAdmin: false,
      isCommercial: false,
    });
    const userLicenses = nonCommercialUser.find(
      (node) => node.type === "group" && node.key === "licenses",
    );
    expect(userLicenses?.type).toBe("group");
    if (userLicenses?.type === "group") {
      expect(userLicenses.pages.map(({ page }) => page)).toEqual([
        "site-licenses",
        "software-licenses",
      ]);
    }

    const nonCommercialAdmin = getVisibleSettingsNavigation({
      ...visibleContext,
      isAdmin: true,
      isCommercial: false,
    });
    const adminLicenses = nonCommercialAdmin.find(
      (node) => node.type === "group" && node.key === "licenses",
    );
    expect(adminLicenses?.type).toBe("group");
    if (adminLicenses?.type === "group") {
      expect(adminLicenses.pages.map(({ page }) => page)).toContain(
        "team-licenses",
      );
    }
  });
});
