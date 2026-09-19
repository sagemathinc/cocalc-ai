import type { AgentRpcTarget } from "./rpc";

const AGENT_MESSAGE_EVENT_PREFIX = "\u001b]6973;cocalc-agent-message=";
const AGENT_MESSAGE_EVENT_SUFFIX = "\u0007";
const MAX_AGENT_MESSAGE_EVENT_BYTES = 256 * 1024;

export interface AgentMessageRuntimeEvent {
  version: 1;
  type: "agent-message";
  direction: "outgoing";
  target: AgentRpcTarget;
  target_name?: string;
  body: string;
  agent_session_id: string;
  attempt_id: string;
  outcome: "accepted" | "rejected" | "unknown";
  observed_at: number;
  reason?: string;
  chat_effect?: "none" | "saved" | "unknown";
}

export function encodeAgentMessageRuntimeEvent(
  event: AgentMessageRuntimeEvent,
): string {
  return `${AGENT_MESSAGE_EVENT_PREFIX}${encodeURIComponent(JSON.stringify(event))}${AGENT_MESSAGE_EVENT_SUFFIX}`;
}

export function parseAgentMessageRuntimeEvents(
  output: string,
): AgentMessageRuntimeEvent[] {
  const events: AgentMessageRuntimeEvent[] = [];
  let offset = 0;
  while (offset < output.length) {
    const start = output.indexOf(AGENT_MESSAGE_EVENT_PREFIX, offset);
    if (start < 0) break;
    const payloadStart = start + AGENT_MESSAGE_EVENT_PREFIX.length;
    const end = output.indexOf(AGENT_MESSAGE_EVENT_SUFFIX, payloadStart);
    if (end < 0) break;
    offset = end + AGENT_MESSAGE_EVENT_SUFFIX.length;
    if (end - payloadStart > MAX_AGENT_MESSAGE_EVENT_BYTES) continue;
    try {
      const value = JSON.parse(
        decodeURIComponent(output.slice(payloadStart, end)),
      );
      if (
        value?.version === 1 &&
        value?.type === "agent-message" &&
        value?.direction === "outgoing" &&
        typeof value?.body === "string" &&
        typeof value?.attempt_id === "string" &&
        typeof value?.agent_session_id === "string" &&
        ["accepted", "rejected", "unknown"].includes(value?.outcome)
      ) {
        events.push(value as AgentMessageRuntimeEvent);
      }
    } catch {
      // Malformed terminal control records are ordinary untrusted output.
    }
  }
  return events;
}
