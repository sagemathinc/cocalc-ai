/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computeNextAutomationRunAt,
  normalizeAcpAutomationConfig,
} from "../automation-schedule";

describe("ACP automation schedule helpers", () => {
  it("keeps daily schedules on the selected weekdays only", () => {
    const nextRunAt = computeNextAutomationRunAt(
      {
        prompt: "Status update",
        schedule_type: "daily",
        days_of_week: [3],
        local_time: "09:00",
        timezone: "UTC",
      },
      {
        nowMs: Date.parse("2026-04-06T10:00:00.000Z"),
        defaultPauseAfterRuns: 7,
      },
    );

    expect(new Date(nextRunAt ?? 0).toISOString()).toBe(
      "2026-04-08T09:00:00.000Z",
    );
  });

  it("finds the next interval slot inside the configured window", () => {
    const nextRunAt = computeNextAutomationRunAt(
      {
        prompt: "Check Hacker News",
        schedule_type: "interval",
        days_of_week: [2],
        interval_minutes: 120,
        window_start_local_time: "06:00",
        window_end_local_time: "20:00",
        timezone: "UTC",
      },
      {
        nowMs: Date.parse("2026-04-07T07:30:00.000Z"),
        defaultPauseAfterRuns: 7,
      },
    );

    expect(new Date(nextRunAt ?? 0).toISOString()).toBe(
      "2026-04-07T08:00:00.000Z",
    );
  });

  it("rejects interval schedules whose window ends before it starts", () => {
    expect(
      normalizeAcpAutomationConfig(
        {
          prompt: "Broken interval",
          schedule_type: "interval",
          interval_minutes: 30,
          window_start_local_time: "20:00",
          window_end_local_time: "06:00",
          timezone: "UTC",
        },
        {
          defaultPauseAfterRuns: 7,
        },
      ),
    ).toBeUndefined();
  });
});
