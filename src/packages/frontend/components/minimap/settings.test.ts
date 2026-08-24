/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createMinimapSettings } from "./settings";

function makeApi() {
  return createMinimapSettings({
    enabledKey: "e",
    kindKey: "k",
    widthKeys: { text: "wt", stylized: "ws" },
    changedEvent: "changed",
    openSettingsEvent: "open",
    defaultEnabled: true,
    defaultKind: "text",
    widths: {
      text: { default: 120, min: 56, max: 240 },
      stylized: { default: 40, min: 16, max: 120 },
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("minimap settings", () => {
  it("falls back to the defaults", () => {
    expect(makeApi().read()).toEqual({
      enabled: true,
      kind: "text",
      width: 120,
      widths: { text: 120, stylized: 40 },
    });
  });

  it("reports the active kind's width as `width`", () => {
    const api = makeApi();
    api.setKind("stylized");
    expect(api.read().width).toBe(40);
    api.setKind("text");
    expect(api.read().width).toBe(120);
  });

  it("keeps a separate width per kind", () => {
    const api = makeApi();
    api.setWidth(200, "text");
    api.setWidth(24, "stylized");
    expect(api.read().widths).toEqual({ text: 200, stylized: 24 });
  });

  it("adjusts the active kind by default", () => {
    const api = makeApi();
    api.setKind("stylized");
    api.adjustWidth(10);
    expect(api.read().widths).toEqual({ text: 120, stylized: 50 });
  });

  it("clamps each kind to its own range", () => {
    const api = makeApi();
    api.setWidth(1000, "text");
    api.setWidth(1000, "stylized");
    expect(api.read().widths).toEqual({ text: 240, stylized: 120 });
    api.setWidth(0, "text");
    api.setWidth(0, "stylized");
    expect(api.read().widths).toEqual({ text: 56, stylized: 16 });
  });

  it("toggles enabled and kind", () => {
    const api = makeApi();
    expect(api.toggleEnabled().enabled).toBe(false);
    expect(api.toggleEnabled().enabled).toBe(true);
    expect(api.toggleKind().kind).toBe("stylized");
    expect(api.toggleKind().kind).toBe("text");
  });

  it("ignores unparseable stored values", () => {
    window.localStorage.setItem("k", "bogus");
    window.localStorage.setItem("wt", "not-a-number");
    expect(makeApi().read()).toMatchObject({ kind: "text", width: 120 });
  });

  it("notifies listeners on every change", () => {
    const api = makeApi();
    const seen: string[] = [];
    const onChange = () => seen.push("x");
    window.addEventListener("changed", onChange);
    api.setEnabled(false);
    api.setKind("stylized");
    api.adjustWidth(4);
    window.removeEventListener("changed", onChange);
    expect(seen).toHaveLength(3);
  });
});
