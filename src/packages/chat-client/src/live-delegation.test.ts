/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { LiveDelegation } from "./live-delegation";
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
