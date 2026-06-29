import { fromJS } from "immutable";
import {
  getDefaultFixedTabOrder,
  getDefaultHiddenFixedTabs,
  moveFixedTab,
  normalizeFixedTabOrder,
  normalizeHiddenFixedTabs,
  splitRailTabs,
} from "./activity-bar-preferences";

describe("activity-bar preferences", () => {
  it("uses the curated default order in lite mode", () => {
    expect(getDefaultFixedTabOrder({ liteMode: true })).toEqual([
      "files",
      "agents",
      "new",
      "search",
      "docs",
      "workspaces",
      "active",
      "log",
      "servers",
      "info",
    ]);
  });

  it("normalizes stored order and appends missing tabs", () => {
    expect(
      normalizeFixedTabOrder(["files", "agents", "files", "bogus"], {
        liteMode: true,
      }),
    ).toEqual([
      "files",
      "agents",
      "new",
      "search",
      "docs",
      "workspaces",
      "active",
      "log",
      "servers",
      "info",
    ]);
  });

  it("hides specialist buttons in the default rail", () => {
    expect(getDefaultHiddenFixedTabs({ liteMode: true })).toEqual([
      "workspaces",
      "active",
      "log",
      "servers",
      "info",
    ]);
  });

  it("preserves explicit saved legacy order and hidden tabs", () => {
    expect(
      normalizeFixedTabOrder(
        [
          "workspaces",
          "agents",
          "files",
          "new",
          "search",
          "docs",
          "active",
          "log",
          "servers",
          "info",
        ],
        { liteMode: true },
      ),
    ).toEqual([
      "workspaces",
      "agents",
      "files",
      "new",
      "search",
      "docs",
      "active",
      "log",
      "servers",
      "info",
    ]);
    expect(
      normalizeHiddenFixedTabs(["active", "log", "servers", "info"], {
        liteMode: true,
      }),
    ).toEqual(["active", "log", "servers", "info"]);
  });

  it("splits visible and overflow tabs from hidden preferences", () => {
    const order = normalizeFixedTabOrder(undefined, { liteMode: true });
    const hidden = normalizeHiddenFixedTabs(undefined, {
      liteMode: true,
    });
    expect(splitRailTabs(order, hidden)).toEqual({
      visible: ["files", "agents", "new", "search", "docs"],
      overflow: ["workspaces", "active", "log", "servers", "info"],
    });
  });

  it("keeps an empty hidden preference as all buttons visible", () => {
    expect(normalizeHiddenFixedTabs([], { liteMode: true })).toEqual([]);
    expect(normalizeHiddenFixedTabs(undefined, { liteMode: true })).toEqual([
      "workspaces",
      "active",
      "log",
      "servers",
      "info",
    ]);
  });

  it("accepts immutable map payloads with numeric keys from account settings", () => {
    const order = normalizeFixedTabOrder(
      fromJS({
        0: "workspaces",
        1: "agents",
        2: "files",
        3: "new",
        4: "search",
        5: "settings",
        6: "active",
        7: "log",
        8: "servers",
        9: "info",
      }),
      { liteMode: true },
    );
    const hidden = normalizeHiddenFixedTabs(
      fromJS({
        0: "active",
        1: "log",
        2: "servers",
        3: "info",
        4: "search",
        5: "settings",
      }),
      { liteMode: true },
    );
    expect(splitRailTabs(order, hidden)).toEqual({
      visible: ["workspaces", "agents", "files", "new", "docs"],
      overflow: ["search", "active", "log", "servers", "info"],
    });
  });

  it("drops the retired users tab from stored activity bar preferences", () => {
    expect(
      normalizeFixedTabOrder(["files", "users", "settings"], {
        liteMode: false,
      }),
    ).toEqual([
      "files",
      "settings",
      "agents",
      "new",
      "search",
      "docs",
      "workspaces",
      "rootfs",
      "active",
      "log",
      "servers",
      "info",
    ]);
  });

  it("moves tabs while preserving the rest of the order", () => {
    expect(moveFixedTab(["workspaces", "agents", "files"], 2, 0)).toEqual([
      "files",
      "workspaces",
      "agents",
    ]);
  });
});
