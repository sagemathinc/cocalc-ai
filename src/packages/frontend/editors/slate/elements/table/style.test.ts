/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getStyles from "./style";

describe("Markdown table styles", () => {
  it("collapse borders, so row shading spans the row instead of separate cell boxes", () => {
    const { tableStyle } = getStyles();
    expect(tableStyle.borderCollapse).toBe("collapse");
    expect((tableStyle as any).borderSpacing).toBeUndefined();
  });

  it("draw a grid in the theme's border color, with room in empty cells", () => {
    const { cellStyle } = getStyles();
    expect(cellStyle.border).toContain("var(--cocalc-ui-border");
    expect(cellStyle.minWidth).toBeTruthy();
    expect(cellStyle.height).toBeTruthy();
  });
});
