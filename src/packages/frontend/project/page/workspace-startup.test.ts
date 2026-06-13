/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { shouldBypassWorkspaceStartupGuardForTab } from "./workspace-startup";

describe("workspace startup fixed tab bypass", () => {
  it("lets the project file explorer render immediately", () => {
    expect(shouldBypassWorkspaceStartupGuardForTab("files")).toBe(true);
    expect(shouldBypassWorkspaceStartupGuardForTab("home")).toBe(true);
  });

  it("keeps workspace startup protection for other tabs", () => {
    expect(shouldBypassWorkspaceStartupGuardForTab("new")).toBe(false);
    expect(
      shouldBypassWorkspaceStartupGuardForTab("editor-/home/user/a.md"),
    ).toBe(false);
    expect(shouldBypassWorkspaceStartupGuardForTab(undefined)).toBe(false);
  });
});
