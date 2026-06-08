import {
  ACCOUNT_SETTINGS_NAVIGATION,
  getSettingsNavigationGroupKey,
  getSettingsOverviewSections,
  getVisibleSettingsNavigation,
  type SettingsNavigationContext,
} from "./settings-navigation";
import { getRegisteredSettingsPageDefinition } from "./settings-page-registry";

const visibleContext: SettingsNavigationContext = {
  isAdmin: false,
  isLite: false,
  stripeEnabled: true,
  zendesk: true,
};

describe("settings-navigation", () => {
  it("keeps site-license page title separate from the menu label", () => {
    const definition = getRegisteredSettingsPageDefinition("site-licenses");
    expect(definition?.label.defaultMessage).toBe("Site");
    expect(definition?.title?.defaultMessage).toBe("Site License");
  });

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
      isLite: true,
      stripeEnabled: false,
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

  it("keeps non-Stripe billing and license pages visible without Stripe", () => {
    const noStripeUser = getVisibleSettingsNavigation({
      ...visibleContext,
      isAdmin: false,
      stripeEnabled: false,
    });
    const userLicenses = noStripeUser.find(
      (node) => node.type === "group" && node.key === "licenses",
    );
    expect(userLicenses?.type).toBe("group");
    if (userLicenses?.type === "group") {
      expect(userLicenses.pages.map(({ page }) => page)).toEqual([
        "team-licenses",
        "site-licenses",
        "software-licenses",
      ]);
    }

    const billing = noStripeUser.find(
      (node) => node.type === "group" && node.key === "billing",
    );
    expect(billing?.type).toBe("group");
    if (billing?.type === "group") {
      expect(billing.pages.map(({ page }) => page)).toEqual([
        "purchases",
        "statements",
        "vouchers",
      ]);
    }
  });

  it("shows Stripe billing pages only when Stripe is configured", () => {
    const stripeNavigation = getVisibleSettingsNavigation({
      ...visibleContext,
      stripeEnabled: true,
    });
    const billing = stripeNavigation.find(
      (node) => node.type === "group" && node.key === "billing",
    );
    expect(billing?.type).toBe("group");
    if (billing?.type === "group") {
      expect(billing.pages.map(({ page }) => page)).toEqual([
        "subscriptions",
        "purchases",
        "payments",
        "payment-methods",
        "statements",
        "vouchers",
      ]);
    }
  });
});
