/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { file_tab_labels } from "./file-tab-labels";

describe("file_tab_labels", () => {
  it("uses preferred labels when provided", () => {
    expect(
      file_tab_labels(
        ["/tmp/a.chat", "/tmp/b.chat"],
        ["Workspace Chat", undefined],
      ),
    ).toEqual(["Workspace Chat", "b.chat"]);
  });

  it("falls back to full paths when preferred labels collide", () => {
    expect(
      file_tab_labels(
        ["/tmp/a.chat", "/var/a.chat"],
        ["Workspace Chat", "Workspace Chat"],
      ),
    ).toEqual(["/tmp/a.chat", "/var/a.chat"]);
  });
});
