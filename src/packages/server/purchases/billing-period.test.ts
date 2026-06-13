/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  calendarMonthStart,
  nextCalendarMonthStartAfter,
} from "./billing-period";

describe("calendar billing periods", () => {
  it("returns the UTC start of the current calendar month", () => {
    expect(
      calendarMonthStart(new Date("2026-06-12T18:30:00.000Z")).toISOString(),
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("returns the next UTC calendar-month boundary after a date", () => {
    expect(
      nextCalendarMonthStartAfter(
        new Date("2026-05-31T23:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-06-01T00:00:00.000Z");
    expect(
      nextCalendarMonthStartAfter(
        new Date("2026-06-01T00:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-07-01T00:00:00.000Z");
  });
});
