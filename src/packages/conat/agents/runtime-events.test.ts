import { randomUUID } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import {
  encodeAgentMessageRuntimeEvent,
  parseAgentMessageRuntimeEvents,
  type AgentMessageRuntimeEvent,
} from "./runtime-events";

describe("agent message runtime events", () => {
  it("round trips message bodies without treating ordinary output as events", () => {
    const event: AgentMessageRuntimeEvent = {
      version: 1,
      type: "agent-message",
      direction: "outgoing",
      target: { project_id: randomUUID(), agent_id: randomUUID() },
      target_name: "reviewer",
      body: 'Review 2 + 2; then say "done".',
      agent_session_id: randomUUID(),
      attempt_id: randomUUID(),
      outcome: "accepted",
      observed_at: Date.now(),
      chat_effect: "saved",
    };
    expect(
      parseAgentMessageRuntimeEvents(
        `ordinary output\n${encodeAgentMessageRuntimeEvent(event)}\nmore output`,
      ),
    ).toEqual([event]);
    expect(parseAgentMessageRuntimeEvents(JSON.stringify(event))).toEqual([]);
  });

  it("ignores malformed control records", () => {
    expect(
      parseAgentMessageRuntimeEvents(
        "\u001b]6973;cocalc-agent-message=%7Bbad\u0007",
      ),
    ).toEqual([]);
  });
});
