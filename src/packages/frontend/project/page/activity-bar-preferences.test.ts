import { fromJS } from "immutable";
import {
  getDefaultFixedTabOrder,
  moveFixedTab,
  normalizeFixedTabOrder,
  normalizeHiddenFixedTabs,
  splitRailTabs,
} from "./activity-bar-preferences";

describe("activity-bar preferences", () => {
  it("uses the curated default order in lite mode", () => {
    expect(getDefaultFixedTabOrder({ liteMode: true })).toEqual([
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
      "workspaces",
      "new",
      "search",
      "settings",
      "active",
      "log",
      "servers",
      "info",
    ]);
  });

  it("splits visible and overflow tabs from hidden preferences", () => {
    const order = normalizeFixedTabOrder(undefined, { liteMode: true });
    const hidden = normalizeHiddenFixedTabs(["log", "info"], {
      liteMode: true,
    });
    expect(splitRailTabs(order, hidden)).toEqual({
      visible: [
        "workspaces",
        "agents",
        "files",
        "new",
        "search",
        "settings",
        "active",
        "servers",
      ],
      overflow: ["log", "info"],
    });
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
      visible: ["workspaces", "agents", "files", "new"],
      overflow: ["search", "settings", "active", "log", "servers", "info"],
    });
  });

  it("moves tabs while preserving the rest of the order", () => {
    expect(moveFixedTab(["workspaces", "agents", "files"], 2, 0)).toEqual([
      "files",
      "workspaces",
      "agents",
    ]);
  });
});
