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
    expect(getSettingsNavigationGroupKey("store")).toBe("billing");
    expect(getSettingsNavigationGroupKey("ai")).toBe("preferences");
    const billing = ACCOUNT_SETTINGS_NAVIGATION.find(
      (node) => node.type === "group" && node.key === "billing",
    );
    const preferences = ACCOUNT_SETTINGS_NAVIGATION.find(
      (node) => node.type === "group" && node.key === "preferences",
    );
    expect(billing?.type).toBe("group");
    expect(preferences?.type).toBe("group");
    if (billing?.type === "group") {
      expect(billing.pages.map(({ page }) => page)).toContain("store");
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
      overview.sections.find((section) => section.key === "billing")?.pages,
    ).toContain("subscriptions");
    expect(
      overview.sections.find((section) => section.key === "billing")?.pages,
    ).not.toContain("payment-methods");
    expect(
      overview.sections.find((section) => section.key === "support")?.pages,
    ).toEqual(["support"]);
  });
});
