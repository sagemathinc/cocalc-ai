import {
  applyAccountSettingsRoute,
  getAccountSettingsRouteFromState,
  getAccountSettingsState,
  getSettingsPushStatePath,
  getSettingsTargetPath,
  getSettingsUrlPath,
  isAccountSettingsPageKey,
  parseAccountSettingsRoute,
} from "./settings-routing";

describe("settings-routing", () => {
  it("parses settings routes into leaf page route objects", () => {
    expect(parseAccountSettingsRoute("settings")).toEqual({ page: "index" });
    expect(parseAccountSettingsRoute("settings/profile")).toEqual({
      page: "profile",
    });
    expect(parseAccountSettingsRoute("settings/membership")).toEqual({
      page: "membership",
    });
    expect(parseAccountSettingsRoute("settings/usage-limits")).toEqual({
      page: "usage-limits",
    });
    expect(parseAccountSettingsRoute("settings/team-licenses")).toEqual({
      page: "team-licenses",
    });
    expect(parseAccountSettingsRoute("settings/site-licenses")).toEqual({
      page: "site-licenses",
    });
    expect(parseAccountSettingsRoute("settings/subscriptions")).toEqual({
      page: "subscriptions",
    });
    expect(parseAccountSettingsRoute("settings/balance")).toEqual({
      page: "balance",
    });
    expect(parseAccountSettingsRoute("settings/editor")).toEqual({
      page: "editor",
    });
  });

  it("does not map menu groups as settings routes", () => {
    expect(parseAccountSettingsRoute("settings/preferences")).toBeUndefined();
    expect(parseAccountSettingsRoute("settings/billing")).toBeUndefined();
    expect(parseAccountSettingsRoute("settings/licenses")).toBeUndefined();
    expect(parseAccountSettingsRoute("settings/licenses/team")).toBeUndefined();
    expect(parseAccountSettingsRoute("settings/not-real")).toBeUndefined();
  });

  it("builds canonical settings paths from leaf pages", () => {
    expect(getSettingsTargetPath({ page: "index" })).toBe("settings");
    expect(getSettingsTargetPath({ page: "subscriptions" })).toBe(
      "settings/subscriptions",
    );
    expect(getSettingsTargetPath({ page: "balance" })).toBe("settings/balance");
    expect(getSettingsTargetPath({ page: "membership" })).toBe(
      "settings/membership",
    );
    expect(getSettingsTargetPath({ page: "software-licenses" })).toBe(
      "settings/software-licenses",
    );
    expect(getSettingsTargetPath({ page: "appearance" })).toBe(
      "settings/appearance",
    );
    expect(getSettingsUrlPath({ page: "profile" })).toBe("/settings/profile");
    expect(getSettingsPushStatePath({ page: "profile" })).toBe(
      "/settings/profile",
    );
  });

  it("derives account state without nested sub-tab state", () => {
    expect(getAccountSettingsState({ page: "keyboard" })).toEqual({
      active_page: "keyboard",
    });
    expect(getAccountSettingsState({ page: "support" })).toEqual({
      active_page: "support",
    });
    expect(
      getAccountSettingsRouteFromState({
        active_page: "preferences-keyboard",
      }),
    ).toEqual({
      page: "keyboard",
    });
    expect(
      getAccountSettingsRouteFromState({
        active_page: "support",
      }),
    ).toEqual({ page: "support" });
  });

  it("normalizes legacy in-memory preference and billing state", () => {
    expect(
      getAccountSettingsRouteFromState({
        active_page: "preferences",
        active_sub_tab: "preferences-keyboard",
      }),
    ).toEqual({
      page: "keyboard",
    });
    expect(
      getAccountSettingsRouteFromState({
        active_page: "payment-methods",
      }),
    ).toEqual({
      page: "payment-methods",
    });
  });

  it("applies routes with or without history changes", () => {
    const actions = {
      push_state: jest.fn(),
      setState: jest.fn(),
    };

    applyAccountSettingsRoute(actions, { page: "appearance" });
    expect(actions.setState).toHaveBeenCalledWith({
      active_page: "appearance",
    });
    expect(actions.push_state).toHaveBeenCalledWith("/settings/appearance");

    applyAccountSettingsRoute(
      actions,
      { page: "editor" },
      { pushHistory: false },
    );
    expect(actions.setState).toHaveBeenCalledWith({
      active_page: "editor",
    });
  });

  it("validates settings page keys centrally", () => {
    expect(isAccountSettingsPageKey("ai")).toBe(true);
    expect(isAccountSettingsPageKey("not-real")).toBe(false);
  });
});
