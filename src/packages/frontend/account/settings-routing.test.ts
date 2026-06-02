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
    expect(parseAccountSettingsRoute("settings/vouchers")).toEqual({
      page: "vouchers",
    });
    expect(parseAccountSettingsRoute("settings/editor")).toEqual({
      page: "editor",
    });
  });

  it("does not map menu groups as settings routes", () => {
    expect(parseAccountSettingsRoute("settings/preferences")).toBeUndefined();
    expect(parseAccountSettingsRoute("settings/billing")).toBeUndefined();
  });

  it("builds canonical settings paths from leaf pages", () => {
    expect(getSettingsTargetPath({ page: "index" })).toBe("settings");
    expect(getSettingsTargetPath({ page: "store" })).toBe("settings/store");
    expect(getSettingsTargetPath({ page: "membership" })).toBe(
      "settings/membership",
    );
    expect(getSettingsTargetPath({ page: "appearance" })).toBe(
      "settings/appearance",
    );
    expect(getSettingsUrlPath({ page: "profile" })).toBe("/settings/profile");
    expect(getSettingsPushStatePath({ page: "profile" })).toBe("/profile");
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

    applyAccountSettingsRoute(actions, { page: "vouchers" });
    expect(actions.setState).toHaveBeenCalledWith({
      active_page: "vouchers",
    });
    expect(actions.push_state).toHaveBeenCalledWith("/vouchers");

    applyAccountSettingsRoute(
      actions,
      { page: "appearance" },
      { pushHistory: false },
    );
    expect(actions.setState).toHaveBeenCalledWith({
      active_page: "appearance",
    });
  });

  it("validates settings page keys centrally", () => {
    expect(isAccountSettingsPageKey("ai")).toBe(true);
    expect(isAccountSettingsPageKey("not-real")).toBe(false);
  });
});
