/** @jest-environment jsdom */

import {
  describeAutomationSchedule,
  normalizeAutomationConfigForSave,
} from "../automation-form";

describe("automation form helpers", () => {
  it("normalizes interval schedules for save", () => {
    expect(
      normalizeAutomationConfigForSave({
        draft: {
          enabled: true,
          prompt: "Check Hacker News",
          schedule_type: "interval",
          days_of_week: [1, 2, 3, 4, 5],
          interval_minutes: 120,
          window_start_local_time: "6:00",
          window_end_local_time: "20:00",
          timezone: "UTC",
          pause_after_unacknowledged_runs: 9,
        },
        automationId: "auto-1",
      }),
    ).toEqual({
      enabled: true,
      automation_id: "auto-1",
      title: undefined,
      prompt: "Check Hacker News",
      schedule_type: "interval",
      days_of_week: [1, 2, 3, 4, 5],
      interval_minutes: 120,
      window_start_local_time: "06:00",
      window_end_local_time: "20:00",
      timezone: "UTC",
      pause_after_unacknowledged_runs: 9,
    });
  });

  it("describes interval schedules with day filters", () => {
    expect(
      describeAutomationSchedule({
        schedule_type: "interval",
        days_of_week: [1, 2, 3, 4, 5],
        interval_minutes: 120,
        window_start_local_time: "06:00",
        window_end_local_time: "20:00",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Mon-Fri Every 2 hours from 06:00 to 20:00 America/Los_Angeles");
  });
});
