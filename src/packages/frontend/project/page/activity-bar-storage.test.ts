/** @jest-environment jsdom */

import {
  getActivityBarCollapsed,
  isRelevantActivityBarStorageEvent,
  readActivityBarPreferences,
  setActivityBarCollapsed,
  setActivityBarHiddenTabs,
  setActivityBarLabels,
  setActivityBarTabOrder,
} from "./activity-bar-storage";
import {
  ACTIVITY_BAR_COLLAPSED,
  ACTIVITY_BAR_HIDDEN_TABS,
  ACTIVITY_BAR_LABELS,
  ACTIVITY_BAR_TAB_ORDER,
} from "./activity-bar-consts";

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

  it("uses local defaults when local storage is empty", () => {
    expect(
      readActivityBarPreferences({
        liteMode: true,
      }),
    ).toMatchObject({
      collapsed: false,
      labels: true,
      order: [
        "workspaces",
        "agents",
        "files",
        "new",
        "search",
        "settings",
        "active",
        "log",
        "servers",
        "info",
      ],
      hidden: ["active", "log", "servers", "info"],
    });
  });

  it("ignores unrelated cross-tab storage events", () => {
    expect(
      isRelevantActivityBarStorageEvent({
        key: ACTIVITY_BAR_COLLAPSED,
        storageArea: window.localStorage,
      }),
    ).toBe(true);
    expect(
      isRelevantActivityBarStorageEvent({
        key: ACTIVITY_BAR_LABELS,
        storageArea: window.localStorage,
      }),
    ).toBe(true);
    expect(
      isRelevantActivityBarStorageEvent({
        key: ACTIVITY_BAR_TAB_ORDER,
        storageArea: window.localStorage,
      }),
    ).toBe(true);
    expect(
      isRelevantActivityBarStorageEvent({
        key: ACTIVITY_BAR_HIDDEN_TABS,
        storageArea: window.localStorage,
      }),
    ).toBe(true);
    expect(
      isRelevantActivityBarStorageEvent({
        key: "cocalc:unrelated",
        storageArea: window.localStorage,
      }),
    ).toBe(false);
    expect(
      isRelevantActivityBarStorageEvent({
        key: ACTIVITY_BAR_LABELS,
        storageArea: window.sessionStorage,
      }),
    ).toBe(false);
    expect(
      isRelevantActivityBarStorageEvent({
        key: null,
        storageArea: window.localStorage,
      }),
    ).toBe(true);
  });
});
