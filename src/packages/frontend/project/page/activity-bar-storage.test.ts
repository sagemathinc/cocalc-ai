/** @jest-environment jsdom */

import {
  getActivityBarCollapsed,
  readActivityBarPreferences,
  setActivityBarCollapsed,
  setActivityBarHiddenTabs,
  setActivityBarLabels,
  setActivityBarTabOrder,
} from "./activity-bar-storage";

describe("activity-bar storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists rail preferences in localStorage", () => {
    setActivityBarCollapsed(true);
    setActivityBarLabels(false);
    setActivityBarTabOrder(["files", "agents", "workspaces"], {
      liteMode: true,
    });
    setActivityBarHiddenTabs(["settings", "log"], { liteMode: true });

    expect(getActivityBarCollapsed()).toBe(true);
    expect(
      readActivityBarPreferences({
        liteMode: true,
      }),
    ).toMatchObject({
      collapsed: true,
      labels: false,
      order: [
        "files",
        "agents",
        "workspaces",
        "new",
        "search",
        "settings",
        "active",
        "log",
        "servers",
        "info",
      ],
      hidden: ["settings", "log"],
    });
  });

  it("falls back to legacy account settings when local storage is empty", () => {
    expect(
      readActivityBarPreferences({
        liteMode: true,
        legacy: {
          collapsed: true,
          labels: false,
          order: ["search", "files"],
          hidden: ["servers", "info"],
        },
      }),
    ).toMatchObject({
      collapsed: true,
      labels: false,
      order: [
        "search",
        "files",
        "workspaces",
        "agents",
        "new",
        "settings",
        "active",
        "log",
        "servers",
        "info",
      ],
      hidden: ["servers", "info"],
    });
  });
});
