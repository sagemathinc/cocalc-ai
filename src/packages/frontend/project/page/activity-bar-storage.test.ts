/** @jest-environment jsdom */

import { redux } from "@cocalc/frontend/app-framework";
import { PageStore } from "@cocalc/frontend/app/store";
import {
  getActivityBarCollapsed,
  readActivityBarPreferences,
  setActivityBarCollapsed,
  setActivityBarHiddenTabs,
  setActivityBarLabels,
  setActivityBarTabOrder,
} from "./activity-bar-storage";

function initPageStore() {
  if ((redux as any).hasStore?.("page")) {
    redux.removeStore("page");
  }
  redux.createStore("page", PageStore, {
    active_top_tab: "settings",
    show_connection: false,
    connection_status: "connecting",
    connection_quality: "good",
    cookie_warning: false,
    local_storage_warning: false,
    num_ghost_tabs: 0,
  } as any);
}

describe("activity-bar storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    initPageStore();
  });

  afterEach(() => {
    redux.removeStore("page");
  });

  it("persists rail preferences in localStorage and mirrors them into the page store", () => {
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
    expect(redux.getStore("page")?.get("activity_bar_collapsed")).toBe(true);
    expect(redux.getStore("page")?.get("activity_bar_labels")).toBe(false);
    expect(redux.getStore("page")?.get("activity_bar_order")?.toJS?.()).toEqual(
      [
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
    );
    expect(
      redux.getStore("page")?.get("activity_bar_hidden")?.toJS?.(),
    ).toEqual(["settings", "log"]);
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

  it("prefers page-scoped runtime state over persisted storage", () => {
    setActivityBarCollapsed(false);
    redux.getStore("page")?.setState({
      activity_bar_collapsed: true,
    });
    expect(getActivityBarCollapsed()).toBe(true);
  });
});
