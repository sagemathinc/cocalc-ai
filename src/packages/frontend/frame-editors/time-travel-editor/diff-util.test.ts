/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { set_cm_line_diff } from "./diff-util";

describe("set_cm_line_diff", () => {
  function editor() {
    return {
      addLineClass: jest.fn(),
      removeLineClass: jest.fn(),
      setGutterMarker: jest.fn(),
      setOption: jest.fn(),
      setValue: jest.fn(),
    };
  }

  it("shows an explicit no-change message instead of a blank editor", () => {
    const cm = editor();

    set_cm_line_diff(cm as any, "same\ntext", "same\ntext");

    expect(cm.setValue).toHaveBeenCalledWith("No changes.");
    expect(cm.setOption).toHaveBeenCalledWith("gutters", []);
  });

  it("renders a non-empty line diff when text changes", () => {
    const cm = editor();

    set_cm_line_diff(cm as any, "a\nb", "a\nc");

    expect(cm.setValue).toHaveBeenCalledWith(expect.stringContaining("b"));
    expect(cm.setValue).toHaveBeenCalledWith(expect.stringContaining("c"));
    expect(cm.setOption).toHaveBeenCalledWith("gutters", [
      "cocalc-history-diff-gutter",
    ]);
  });
});
