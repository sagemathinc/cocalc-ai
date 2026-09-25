/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { isExplicitInterruptRequest, LiveDelegation } from "./live-delegation";
import type { ProjectedChatMessage } from "./types";

it.each([
  ["human", "error"],
  ["human", "interrupted"],
  ["agent", "error"],
  ["agent", "interrupted"],
] as const)(
  "reports %s %s once without claiming a completed result",
  async (role, state) => {
    const append = jest.fn(),
      report = jest.fn(),
      send = jest.fn(async () => ({ message_id: "human" }));
    const bridge = new LiveDelegation(send, append, report);
    await bridge.event({
      type: "session.input_transcript.delta",
      delta: "Run tests",
      end_ms: 1,
    });
    await bridge.event({
      type: "session.delegation.created",
      offset_ms: 2,
      delegation: { id: "delegation", target: "client" },
    });
    append.mockClear();
    report.mockClear();
    const failed = {
      message_id: role === "human" ? "human" : "reply",
      parent_message_id: role === "agent" ? "human" : undefined,
      role,
      state,
      generating: false,
      content: "Private backend error metadata",
    } as ProjectedChatMessage;
    bridge.observe([failed]);
    bridge.observe([
      failed,
      {
        ...failed,
        role: "agent",
        parent_message_id: "human",
        state: "complete",
        content: "Partial result",
      },
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1]).toMatch(
      state === "error" ? /request failed/ : /was interrupted/,
    );
    expect(append.mock.calls[0][1]).not.toMatch(
      /Private backend|Partial result/,
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).not.toMatch(/result is ready/);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it("answers a progress question without submitting work", async () => {
  const send = jest.fn(async () => ({ message_id: "work" }));
  const append = jest.fn();
  const bridge = new LiveDelegation(
    send,
    append,
    jest.fn(),
    () => "The agent is checking tests.",
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "What happened recently?",
    end_ms: 1,
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "status", target: "client" },
  });
  expect(send).not.toHaveBeenCalled();
  expect(append).toHaveBeenCalledWith(
    "session.commentary.append",
    "The agent is checking tests.",
    "status",
  );
});

it("acknowledges guidance without tracking it as a new task", async () => {
  const append = jest.fn();
  const bridge = new LiveDelegation(
    async () => ({ message_id: "guidance", kind: "guidance" }),
    append,
    jest.fn(),
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Please check the tests too.",
    end_ms: 1,
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "guidance", target: "client" },
  });
  bridge.observe([
    {
      message_id: "guidance",
      thread_id: "thread",
      sender_id: "human",
      role: "human",
      content: "Please check the tests too.",
      date: "2026-09-25T00:00:00.000Z",
      generating: false,
      state: "complete",
    },
  ]);
  expect(
    append.mock.calls.some(([, content]) =>
      String(content).includes("result is ready"),
    ),
  ).toBe(false);
  expect(
    append.mock.calls.some(([, content]) =>
      String(content).includes("Guidance was sent"),
    ),
  ).toBe(true);
});

it.each([
  "interrupt the turn",
  "Please stop the current agent turn now!",
  "I want to just end the turn",
  "could you cancel this task?",
])("recognizes an explicit spoken stop request: %s", (text) => {
  expect(isExplicitInterruptRequest(text)).toBe(true);
});

it.each([
  "stop talking",
  "end the call",
  "don't stop the turn",
  "interrupt the turn after the tests finish",
  "tell the agent to stop when done",
  "can you stop the music",
])("does not treat other speech as an interrupt: %s", (text) => {
  expect(isExplicitInterruptRequest(text)).toBe(false);
});

it("interrupts a running turn once without sending guidance or new work", async () => {
  const send = jest.fn(async () => ({ message_id: "unexpected" }));
  const interrupt = jest.fn(async () => true);
  const append = jest.fn();
  const report = jest.fn();
  const bridge = new LiveDelegation(send, append, report, undefined, interrupt);
  const input = {
    type: "session.input_transcript.delta",
    delta: "Please interrupt the turn.",
    end_ms: 1,
  };
  const delegated = {
    type: "session.delegation.created",
    event_id: "stop-1",
    offset_ms: 2,
    delegation: { id: "stop", target: "client" },
  };
  await bridge.event(input);
  await bridge.event(delegated);
  await bridge.event(delegated);
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(append).toHaveBeenCalledWith(
    "session.commentary.append",
    expect.stringContaining("Interrupt request accepted"),
    "stop",
  );
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining("Check chat to confirm"),
  );
});

it("says when no turn is running and does not claim an interrupt", async () => {
  const send = jest.fn();
  const append = jest.fn();
  const bridge = new LiveDelegation(
    send,
    append,
    jest.fn(),
    undefined,
    async () => false,
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "End the turn",
    end_ms: 1,
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "stop", target: "client" },
  });
  expect(send).not.toHaveBeenCalled();
  expect(append).toHaveBeenCalledWith(
    "session.commentary.append",
    "There is no running agent turn to interrupt.",
    "stop",
  );
});
