/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  sparklineHoverPlacement,
  sparklineTooltipBoxStyle,
} from "./sparkline-tooltip";

describe("sparkline tooltip placement", () => {
  test("anchors left-edge tooltips from the left", () => {
    expect(sparklineHoverPlacement(0.1)).toEqual({
      left: "10%",
      transform: "translate(0, calc(-100% - 14px))",
    });
  });

  test("anchors middle tooltips around the cursor", () => {
    expect(sparklineHoverPlacement(0.5)).toEqual({
      left: "50%",
      transform: "translate(-50%, calc(-100% - 14px))",
    });
  });

  test("anchors right-edge tooltips from the right", () => {
    expect(sparklineHoverPlacement(0.9)).toEqual({
      right: "10%",
      transform: "translate(0, calc(-100% - 14px))",
    });
  });

  test("keeps tooltip boxes intrinsically sized", () => {
    expect(
      sparklineTooltipBoxStyle({
        placement: sparklineHoverPlacement(0.9),
        maxWidth: 240,
      }),
    ).toMatchObject({
      boxSizing: "border-box",
      maxWidth: "240px",
      right: "10%",
      transform: "translate(0, calc(-100% - 14px))",
      width: "max-content",
    });
  });
});
