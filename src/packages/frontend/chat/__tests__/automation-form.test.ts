/** @jest-environment jsdom */

import {
  describeAutomationSchedule,
  normalizeAutomationConfigForSave,
  shouldShowAutomationNextRun,
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
      run_kind: "codex",
      prompt: "Check Hacker News",
      command: undefined,
      command_cwd: undefined,
      command_timeout_ms: undefined,
      command_max_output_bytes: undefined,
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
        window_start_local_time: "00:00",
        window_end_local_time: "23:59",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Mon-Fri Every 2 hours all day");
  });

  it("hides next run when the automation is paused", () => {
    expect(
      shouldShowAutomationNextRun({
        enabled: true,
        status: "paused",
        next_run_at_ms: Date.now() - 60_000,
      }),
    ).toBe(false);
  });

  it("shows next run when the automation is active", () => {
    expect(
      shouldShowAutomationNextRun({
        enabled: true,
        status: "active",
        next_run_at_ms: Date.now() + 60_000,
      }),
    ).toBe(true);
  });

  it("normalizes command automations for save", () => {
    expect(
      normalizeAutomationConfigForSave({
        draft: {
          enabled: true,
          run_kind: "command",
          title: "Repo status",
          command: "git status --short",
          command_cwd: "/work/repo",
          command_timeout_ms: 90_000,
          command_max_output_bytes: 250_000,
          schedule_type: "daily",
          days_of_week: [1, 2, 3, 4, 5],
          local_time: "6:00",
          timezone: "UTC",
          pause_after_unacknowledged_runs: 9,
        },
        automationId: "auto-command-1",
        allowCodexRunKind: false,
      }),
    ).toEqual({
      enabled: true,
      automation_id: "auto-command-1",
      title: "Repo status",
      run_kind: "command",
      prompt: undefined,
      command: "git status --short",
      command_cwd: "/work/repo",
      command_timeout_ms: 90_000,
      command_max_output_bytes: 250_000,
      schedule_type: "daily",
      days_of_week: [1, 2, 3, 4, 5],
      local_time: "06:00",
      timezone: "UTC",
      pause_after_unacknowledged_runs: 9,
    });
  });
});
