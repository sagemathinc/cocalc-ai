/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  frameTitleBarMenuVisible,
  frameTitleBarTerminalButtonVisible,
} from "../read-only-title-bar";

describe("read-only preview frame title bar", () => {
  it("shows only the View menu in read-only preview mode", () => {
    expect(
      frameTitleBarMenuVisible({ name: "view", readOnlyPreview: true }),
    ).toBe(true);
    expect(
      frameTitleBarMenuVisible({ name: "file", readOnlyPreview: true }),
    ).toBe(false);
    expect(
      frameTitleBarMenuVisible({ name: "help", readOnlyPreview: true }),
    ).toBe(false);
  });

  it("keeps normal title-bar menus outside read-only preview mode", () => {
    expect(
      frameTitleBarMenuVisible({ name: "file", readOnlyPreview: false }),
    ).toBe(true);
    expect(
      frameTitleBarMenuVisible({ name: "help", readOnlyPreview: false }),
    ).toBe(true);
  });

  it("hides terminal launch affordances in read-only preview mode", () => {
    expect(
      frameTitleBarTerminalButtonVisible({
        readOnlyPreview: true,
        terminalsDisabled: false,
        type: "cm",
      }),
    ).toBe(false);
  });

  it("keeps existing terminal visibility rules outside read-only preview mode", () => {
    expect(
      frameTitleBarTerminalButtonVisible({
        readOnlyPreview: false,
        terminalsDisabled: false,
        type: "cm",
      }),
    ).toBe(true);
    expect(
      frameTitleBarTerminalButtonVisible({
        readOnlyPreview: false,
        terminalsDisabled: true,
        type: "cm",
      }),
    ).toBe(false);
    expect(
      frameTitleBarTerminalButtonVisible({
        readOnlyPreview: false,
        terminalsDisabled: false,
        type: "terminal",
      }),
    ).toBe(false);
  });
});
