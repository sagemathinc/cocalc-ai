import {
  applyAccountSettingsRoute,
  createPreferencesSubTabKey,
  getAccountSettingsRouteFromState,
  getAccountSettingsState,
  getSettingsPushStatePath,
  getSettingsTargetPath,
  parseAccountSettingsRoute,
} from "./settings-routing";

describe("settings-routing", () => {
  it("parses settings routes into explicit route objects", () => {
    expect(parseAccountSettingsRoute("settings")).toEqual({ kind: "index" });
    expect(parseAccountSettingsRoute("settings/profile")).toEqual({
      kind: "profile",
    });
    expect(parseAccountSettingsRoute("settings/vouchers")).toEqual({
      kind: "tab",
      page: "vouchers",
    });
    expect(parseAccountSettingsRoute("settings/preferences/editor")).toEqual({
      kind: "preferences",
      subTab: "editor",
      subTabKey: "preferences-editor",
    });
  });

  it("builds canonical settings paths from routes", () => {
    expect(getSettingsTargetPath({ kind: "index" })).toBe("settings/index");
    expect(getSettingsTargetPath({ kind: "tab", page: "store" })).toBe(
      "settings/store",
    );
    expect(
      getSettingsTargetPath({
        kind: "preferences",
        subTab: "appearance",
        subTabKey: "preferences-appearance",
      }),
    ).toBe("settings/preferences/appearance");
    expect(getSettingsPushStatePath({ kind: "profile" })).toBe("/profile");
  });

  it("derives account state without mutating history", () => {
    expect(
      getAccountSettingsState({
        kind: "preferences",
        subTab: "keyboard",
        subTabKey: "preferences-keyboard",
      }),
    ).toEqual({
      active_page: "preferences",
      active_sub_tab: "preferences-keyboard",
    });
    expect(getAccountSettingsState({ kind: "tab", page: "support" })).toEqual({
      active_page: "support",
      active_sub_tab: undefined,
    });
    expect(
      getAccountSettingsRouteFromState({
        active_page: "preferences",
        active_sub_tab: "preferences-keyboard",
      }),
    ).toEqual({
      kind: "preferences",
      subTab: "keyboard",
      subTabKey: "preferences-keyboard",
    });
    expect(
      getAccountSettingsRouteFromState({
        active_page: "support",
        active_sub_tab: undefined,
      }),
    ).toEqual({ kind: "tab", page: "support" });
  });

  it("applies routes with or without history changes", () => {
    const actions = {
      push_state: jest.fn(),
      setState: jest.fn(),
      set_active_tab: jest.fn(),
    };

    applyAccountSettingsRoute(actions, { kind: "tab", page: "vouchers" });
    expect(actions.set_active_tab).toHaveBeenCalledWith("vouchers");

    applyAccountSettingsRoute(
      actions,
      {
        kind: "preferences",
        subTab: "appearance",
        subTabKey: "preferences-appearance",
      },
      { pushHistory: false },
    );
    expect(actions.setState).toHaveBeenCalledWith({
      active_page: "preferences",
      active_sub_tab: "preferences-appearance",
    });
  });

  it("validates preference sub-tabs centrally", () => {
    expect(createPreferencesSubTabKey("ai")).toBe("preferences-ai");
    expect(createPreferencesSubTabKey("not-real")).toBeNull();
  });
});
