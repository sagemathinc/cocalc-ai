/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FRAME_BASE_CSS, resolveShellTheme } from "./frame-theme";

describe("FRAME_BASE_CSS", () => {
  it("only sets defaults: every rule is :where(), so output styles win", () => {
    const selectors = FRAME_BASE_CSS.split("}")
      .filter((rule) => rule.trim())
      .map((rule) => rule.slice(0, rule.indexOf("{")));
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
      expect(selector).toMatch(/^:where\(.*\)$/);
    }
  });

  it("styles links with the app's link color", () => {
    expect(FRAME_BASE_CSS).toContain(":where(a){color:var(--shell-link");
  });
});

describe("resolveShellTheme", () => {
  it("includes the app's link color", () => {
    const el = document.createElement("div");
    el.style.setProperty("--cocalc-ui-link", "#123456");
    document.body.append(el);
    expect(resolveShellTheme(el).link).toBe("#123456");
    el.remove();
  });
});
