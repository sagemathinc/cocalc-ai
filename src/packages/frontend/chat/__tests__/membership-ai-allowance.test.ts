/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { allowanceWindows } from "../membership-ai-allowance";

describe("the membership's AI allowance windows", () => {
  it("shows each window with a limit as a percentage used and its reset", () => {
    const reset = new Date("2026-10-25T10:00:00Z");
    expect(
      allowanceWindows({
        units_per_dollar: 100,
        windows: [
          { window: "5h", used: 14, limit: 100, reset_at: reset },
          { window: "7d", used: 7, limit: 1000 },
        ],
      }),
    ).toEqual([
      {
        key: "5h",
        name: "5-hour limit",
        short: "5-hour",
        usedPercent: 14,
        resetsAt: reset,
      },
      {
        key: "7d",
        name: "7-day limit",
        short: "Week",
        usedPercent: 1,
        resetsAt: undefined,
      },
    ]);
  });

  it("skips windows without a limit and clamps to 0..100", () => {
    expect(
      allowanceWindows({
        units_per_dollar: 100,
        windows: [
          { window: "5h", used: 500, limit: 100 },
          { window: "7d", used: 1 },
        ],
      }).map(({ key, usedPercent }) => [key, usedPercent]),
    ).toEqual([["5h", 100]]);
    expect(allowanceWindows(null)).toEqual([]);
  });
});
