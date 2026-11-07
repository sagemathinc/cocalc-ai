/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The plan's browser-idle limit still applies to a project with a running
// agent turn (William, 2026-11-05: "No, the plan's browser-idle limit still
// applies to projects with a running turn"). The turn's last_edited touches
// (agent-turn-activity.ts) must not move that clock: the deadline depends on
// the runtime state change, the last start and browser presence only.

import {
  browserIdleStopDeadline,
  startBrowserIdleStopMaintenance,
} from "./browser-runtime";
import { listProjectsByStates } from "./sqlite/projects";
import { getProjectStopState } from "./sqlite/stop-policy";

jest.mock("./sqlite/projects", () => ({ listProjectsByStates: jest.fn() }));
jest.mock("./sqlite/stop-policy", () => ({
  getProjectStopState: jest.fn(),
  noteProjectBrowserActivity: jest.fn(),
}));

const now = Date.parse("2026-11-05T12:00:00Z");
const minute = 60_000;

// 30 min plan limit; the runtime state last changed 2 h ago, but the row was
// refreshed just now (as a bay sync after an activity touch would).
const project = (project_id: string) =>
  ({
    project_id,
    state: "running",
    run_quota: { browser_idle_timeout: 1800 },
    state_updated_at: now - 120 * minute,
    updated_at: now,
    last_seen: now,
  }) as any;

describe("browser-idle limit with running agent turns", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.clearAllMocks();
    // A fresh authoritative last_edited, as the activity touch produces.
    jest.mocked(getProjectStopState).mockReturnValue({
      project_id: "turn",
      authoritative_last_edited_ms: now,
    } as any);
  });

  afterEach(() => jest.useRealTimers());

  it("a fresh last_edited or row refresh does not move the deadline", () => {
    expect(
      browserIdleStopDeadline({
        project: project("turn"),
        stopState: getProjectStopState("turn"),
      }),
    ).toBe(now - 120 * minute + 30 * minute);
  });

  it("the sweep stops a project at its plan limit even while an agent turn runs", async () => {
    jest.mocked(listProjectsByStates).mockReturnValue([project("turn")]);
    const stopProject = jest.fn(async (_project_id: string) => {});
    const stop = startBrowserIdleStopMaintenance({
      stopProject,
      interval_ms: 60 * minute,
      now: () => now,
    });
    await jest.advanceTimersByTimeAsync(0);
    stop();
    expect(stopProject).toHaveBeenCalledWith("turn");
  });
});
