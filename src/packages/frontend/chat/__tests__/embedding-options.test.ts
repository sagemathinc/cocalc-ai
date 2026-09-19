/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  readEmbeddedSidebarHidden,
  writeEmbeddedSidebarHidden,
} from "../embedding-options";

describe("embedded chat options", () => {
  beforeEach(() => localStorage.clear());

  it("uses the embedding default without changing ordinary chat state", () => {
    expect(readEmbeddedSidebarHidden({ sidebarHiddenByDefault: true })).toBe(
      true,
    );
    expect(localStorage.length).toBe(0);
  });

  it("persists an embedding-specific sidebar preference", () => {
    const sidebarPreferenceKey = "agents:test-agent:sidebar";
    expect(
      readEmbeddedSidebarHidden({
        sidebarHiddenByDefault: true,
        sidebarPreferenceKey,
      }),
    ).toBe(true);

    writeEmbeddedSidebarHidden(sidebarPreferenceKey, false);

    expect(
      readEmbeddedSidebarHidden({
        sidebarHiddenByDefault: true,
        sidebarPreferenceKey,
      }),
    ).toBe(false);
  });
});
