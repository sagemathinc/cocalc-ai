/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { unavailableSinceForHostStatusTransition } from "./host-info";

describe("project host connection timing", () => {
  it("starts a new timer when a stopped host begins starting again", () => {
    expect(
      unavailableSinceForHostStatusTransition({
        previousStatus: "off",
        status: "starting",
        unavailableSince: "2026-09-16T10:00:00.000Z",
        now: "2026-09-16T10:10:00.000Z",
      }),
    ).toBe("2026-09-16T10:10:00.000Z");
  });

  it("keeps the first observation throughout one startup attempt", () => {
    expect(
      unavailableSinceForHostStatusTransition({
        previousStatus: "starting",
        status: "starting",
        unavailableSince: "2026-09-16T10:10:00.000Z",
        now: "2026-09-16T10:11:00.000Z",
      }),
    ).toBe("2026-09-16T10:10:00.000Z");
  });

  it("keeps the timer when starting transitions to restarting", () => {
    expect(
      unavailableSinceForHostStatusTransition({
        previousStatus: "starting",
        status: "restarting",
        unavailableSince: "2026-09-16T10:10:00.000Z",
        now: "2026-09-16T10:11:00.000Z",
      }),
    ).toBe("2026-09-16T10:10:00.000Z");
  });

  it("does not rewrite ordinary disconnect timing", () => {
    expect(
      unavailableSinceForHostStatusTransition({
        previousStatus: "running",
        status: "off",
        unavailableSince: "2026-09-16T10:00:00.000Z",
        now: "2026-09-16T10:10:00.000Z",
      }),
    ).toBe("2026-09-16T10:00:00.000Z");
  });
});
