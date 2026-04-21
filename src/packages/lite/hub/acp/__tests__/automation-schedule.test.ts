/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computeNextAutomationRunAt,
  computeSkippedAutomationRunAt,
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

  it("defaults interval schedules to all day", () => {
    const normalized = normalizeAcpAutomationConfig(
      {
        prompt: "Keep making progress",
        schedule_type: "interval",
        interval_minutes: 15,
        timezone: "UTC",
      },
      {
        defaultPauseAfterRuns: 7,
      },
    );

    expect(normalized?.window_start_local_time).toBe("00:00");
    expect(normalized?.window_end_local_time).toBe("23:59");
    expect(
      new Date(
        computeNextAutomationRunAt(normalized, {
          nowMs: Date.parse("2026-04-07T23:46:00.000Z"),
          defaultPauseAfterRuns: 7,
        }) ?? 0,
      ).toISOString(),
    ).toBe("2026-04-08T00:00:00.000Z");
  });

  it("skips the current next run and moves to the following slot", () => {
    const config = {
      prompt: "Keep making progress",
      schedule_type: "interval" as const,
      days_of_week: [2],
      interval_minutes: 120,
      window_start_local_time: "06:00",
      window_end_local_time: "20:00",
      timezone: "UTC",
    };
    const nextRunAtMs = Date.parse("2026-04-07T08:00:00.000Z");

    expect(
      new Date(
        computeSkippedAutomationRunAt(config, {
          nextRunAtMs,
          defaultPauseAfterRuns: 7,
        }) ?? 0,
      ).toISOString(),
    ).toBe("2026-04-07T10:00:00.000Z");
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

  it("normalizes command automations with defaults and output cap", () => {
    expect(
      normalizeAcpAutomationConfig(
        {
          run_kind: "command",
          command: "git status --short",
          command_cwd: "/work/repo",
          schedule_type: "daily",
          local_time: "6:00",
          timezone: "UTC",
        },
        {
          defaultPauseAfterRuns: 7,
        },
      ),
    ).toEqual({
      enabled: true,
      automation_id: undefined,
      title: undefined,
      run_kind: "command",
      prompt: undefined,
      command: "git status --short",
      command_cwd: "/work/repo",
      command_timeout_ms: 600000,
      command_max_output_bytes: 250000,
      schedule_type: "daily",
      days_of_week: [0, 1, 2, 3, 4, 5, 6],
      local_time: "06:00",
      timezone: "UTC",
      pause_after_unacknowledged_runs: 7,
    });
  });
});
