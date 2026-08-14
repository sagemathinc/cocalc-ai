/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AgentActivityChip,
  AgentMessageStatus,
  AttachedSteerStatusList,
  describeLastActivity,
  reconcileAvailableSubagentEvents,
  resolveLiveRunStartMs,
  STALE_ACTIVITY_MS,
} from "../agent-message-status";

describe("reconcileAvailableSubagentEvents", () => {
  it("preserves missing events so the activity panel can load its persisted log", () => {
    expect(reconcileAvailableSubagentEvents(undefined, [])).toBeUndefined();
    expect(reconcileAvailableSubagentEvents(null, [])).toBeNull();
  });

  it("reconciles events that have already been loaded", () => {
    const events = [
      {
        type: "event",
        seq: 1,
        event: {
          type: "subagent",
          operationId: "spawn-1",
          threadId: "child-1",
          state: "running",
        },
      },
    ] as any;

    const reconciled = reconcileAvailableSubagentEvents(events, []);

    expect(reconciled).toHaveLength(2);
    expect((reconciled as any[])[1].event.state).toBe("unknown");
  });
});

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
      label: "0:05 ago",
      ageMs: 5000,
      stale: false,
    });

    const stale = describeLastActivity({
      generating: true,
      lastActivityAtMs: 1000,
      now: 1000 + STALE_ACTIVITY_MS,
    });
    expect(stale.label).toBe("2:00 ago");
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
    const { container } = render(
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
    expect(screen.getByText(/ago$/)).toBeTruthy();
    expect(screen.queryByText(/Last activity/)).toBeNull();
    expect(screen.queryByText("Activity")).toBeNull();
    expect(container.querySelector(".anticon-spin")).toBeNull();
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

    expect(screen.getByText("0:01 ago")).toBeTruthy();

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

    expect(screen.getByText("0:04 ago")).toBeTruthy();
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

  it("keeps post-turn retained work visible and stoppable", () => {
    const onInterrupt = jest.fn();
    render(
      React.createElement(AgentMessageStatus, {
        show: true,
        generating: false,
        durationLabel: "0:10",
        date: 1000,
        logRefs: {},
        activityContext: {} as any,
        activeDescendantThreadIds: ["child-1"],
        backgroundTerminalProcesses: 1,
        logEvents: [
          {
            type: "event",
            seq: 1,
            event: {
              type: "subagent",
              operationId: "spawn-1",
              threadId: "child-1",
              state: "running",
            },
          },
        ] as any,
        onInterrupt,
      }),
    );

    expect(screen.getByText(/Manager finished/)).toBeTruthy();
    expect(screen.getByText(/background command/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("does not leave old pending subagents spinning after a turn completes", () => {
    render(
      React.createElement(AgentMessageStatus, {
        show: true,
        generating: false,
        durationLabel: "0:10",
        date: 8_675_309,
        logRefs: {},
        activityContext: {} as any,
        logEvents: [
          {
            type: "event",
            seq: 1,
            event: {
              type: "subagent",
              operationId: "spawn-1",
              threadId: "child-1",
              state: "pending",
            },
          },
        ] as any,
      }),
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText(/None working/)).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.queryByLabelText("working")).toBeNull();
  });

  it("includes steer guidance in the Codex activity drawer", () => {
    render(
      React.createElement(AgentMessageStatus, {
        show: true,
        generating: false,
        durationLabel: "0:10",
        date: 1000,
        logRefs: {},
        activityContext: {} as any,
        activitySteers: [
          {
            messageId: "steer-1",
            date: 1000,
            state: "sent",
            text: "use the smaller API",
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Codex activity")).toBeTruthy();
    expect(screen.getByText("use the smaller API")).toBeTruthy();
  });
});

describe("AttachedSteerStatusList", () => {
  it("keeps quoted guidance distinct from the user's follow-up", () => {
    render(
      React.createElement(AttachedSteerStatusList, {
        attachedSteers: [
          {
            messageId: "m1",
            date: 1000,
            state: "sent",
            text: "> quoted request\n\n**follow-up guidance** with `code`",
          },
        ],
      }),
    );

    const card = screen.getByRole("region", { name: "Guidance sent" });
    expect(
      screen.getByText("quoted request").closest("blockquote"),
    ).toBeTruthy();
    expect(screen.getByText("follow-up guidance")).toBeTruthy();
    expect(screen.getByText("code")).toBeTruthy();
    expect(card).toContainElement(screen.getByText("Guidance sent"));
  });
});
