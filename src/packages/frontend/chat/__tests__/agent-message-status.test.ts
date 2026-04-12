/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AgentActivityChip,
  AgentMessageStatus,
  describeLastActivity,
  resolveLiveRunStartMs,
  STALE_ACTIVITY_MS,
} from "../agent-message-status";

describe("describeLastActivity", () => {
  it("prefers the ACP start time over the row date for live timing", () => {
    expect(resolveLiveRunStartMs({ startedAtMs: 5000, date: 1000 })).toBe(5000);
    expect(resolveLiveRunStartMs({ startedAtMs: undefined, date: 1000 })).toBe(
      1000,
    );
  });

  it("returns no label when not generating", () => {
    expect(
      describeLastActivity({
        generating: false,
        lastActivityAtMs: 1000,
        now: 5000,
      }),
    ).toEqual({
      label: undefined,
      ageMs: undefined,
      stale: false,
    });
  });

  it("shows awaiting activity before the first backend event", () => {
    expect(
      describeLastActivity({
        generating: true,
        lastActivityAtMs: undefined,
        now: 5000,
      }),
    ).toEqual({
      label: "Starting...",
      ageMs: undefined,
      stale: false,
    });
  });

  it("formats recent activity age and marks stale after the threshold", () => {
    expect(
      describeLastActivity({
        generating: true,
        lastActivityAtMs: 4000,
        now: 9000,
      }),
    ).toEqual({
      label: "Last activity 0:05 ago",
      ageMs: 5000,
      stale: false,
    });

    const stale = describeLastActivity({
      generating: true,
      lastActivityAtMs: 1000,
      now: 1000 + STALE_ACTIVITY_MS,
    });
    expect(stale.label).toBe("Last activity 2:00 ago");
    expect(stale.ageMs).toBe(STALE_ACTIVITY_MS);
    expect(stale.stale).toBe(true);
  });
});

describe("AgentMessageStatus", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders the shared activity chip and opens it on click", () => {
    const onOpen = jest.fn();
    render(
      React.createElement(AgentActivityChip, {
        generating: true,
        durationLabel: "0:10",
        lastActivityAtMs: 4000,
        startedAtMs: 1000,
        date: 1000,
        onOpen,
      }),
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText(/Running 0:10/)).toBeTruthy();
    expect(screen.getByText(/Last activity/)).toBeTruthy();
    expect(screen.getByText("Activity")).toBeTruthy();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("refreshes the last activity age when the running duration rerenders", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(5_000));
    const onOpen = jest.fn();
    const { rerender } = render(
      React.createElement(AgentActivityChip, {
        generating: true,
        durationLabel: "0:05",
        lastActivityAtMs: 4_000,
        startedAtMs: 1_000,
        date: 1_000,
        onOpen,
      }),
    );

    expect(screen.getByText("Last activity 0:01 ago")).toBeTruthy();

    jest.setSystemTime(new Date(8_000));
    rerender(
      React.createElement(AgentActivityChip, {
        generating: true,
        durationLabel: "0:08",
        lastActivityAtMs: 4_000,
        startedAtMs: 1_000,
        date: 1_000,
        onOpen,
      }),
    );

    expect(screen.getByText("Last activity 0:04 ago")).toBeTruthy();
  });

  it("shows the notify toggle next to a running Codex status row", () => {
    const onNotifyOnTurnFinishChange = jest.fn();
    render(
      React.createElement(AgentMessageStatus, {
        show: true,
        generating: true,
        durationLabel: "0:10",
        date: 1000,
        logRefs: {},
        activityContext: {} as any,
        notifyOnTurnFinish: false,
        onNotifyOnTurnFinishChange,
      }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Notify" }));

    expect(screen.getByText(/Running/)).toBeTruthy();
    expect(onNotifyOnTurnFinishChange).toHaveBeenCalledWith(true);
  });

  it("hides the notify toggle once the turn is no longer running", () => {
    render(
      React.createElement(AgentMessageStatus, {
        show: true,
        generating: false,
        durationLabel: "0:10",
        date: 1000,
        logRefs: {},
        activityContext: {} as any,
        notifyOnTurnFinish: false,
        onNotifyOnTurnFinishChange: jest.fn(),
      }),
    );

    expect(screen.queryByRole("checkbox", { name: "Notify" })).toBeNull();
  });

  it("renders an interrupt button when a handler is provided", () => {
    const onInterrupt = jest.fn();
    render(
      React.createElement(AgentMessageStatus, {
        show: true,
        generating: true,
        durationLabel: "0:10",
        date: 1000,
        logRefs: {},
        activityContext: {} as any,
        onInterrupt,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
