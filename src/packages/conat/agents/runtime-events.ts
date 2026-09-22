import type { AgentRpcTarget } from "./rpc";

const AGENT_MESSAGE_EVENT_PREFIX = "\u001b]6973;cocalc-agent-message=";
const AGENT_MESSAGE_EVENT_SUFFIX = "\u0007";
const AGENT_MESSAGE_RECORD_PREFIX = "::cocalc-agent-message::";
const MAX_AGENT_MESSAGE_EVENT_BYTES = 256 * 1024;

export interface AgentMessageRuntimeEvent {
  version: 1;
  type: "agent-message";
  direction: "outgoing";
  target: AgentRpcTarget;
  target_name?: string;
  body: string;
  agent_network_id: string;
  agent_network_title?: string;
  attempt_id: string;
  outcome: "accepted" | "rejected" | "unknown";
  observed_at: number;
  reason?: string;
  chat_effect?: "none" | "saved" | "unknown";
}

export function encodeAgentMessageRuntimeEvent(
  event: AgentMessageRuntimeEvent,
): string {
  // Codex normalizes terminal output and can discard OSC control sequences.
  // A line record survives that normalization; the ACP adapter removes it
  // before terminal output is presented to the user.
  return `${AGENT_MESSAGE_RECORD_PREFIX}${encodeURIComponent(JSON.stringify(event))}\n`;
}

export function parseAgentMessageRuntimeEvents(
  output: string,
): AgentMessageRuntimeEvent[] {
  const events: AgentMessageRuntimeEvent[] = [];
  const parsePayload = (payload: string) => {
    if (payload.length > MAX_AGENT_MESSAGE_EVENT_BYTES) return;
    try {
      const value = JSON.parse(decodeURIComponent(payload));
      if (
        value?.version === 1 &&
        value?.type === "agent-message" &&
        value?.direction === "outgoing" &&
        typeof value?.body === "string" &&
        typeof value?.attempt_id === "string" &&
        typeof value?.agent_network_id === "string" &&
        ["accepted", "rejected", "unknown"].includes(value?.outcome)
      ) {
        events.push(value as AgentMessageRuntimeEvent);
      }
    } catch {
      // Malformed runtime records are ordinary untrusted output.
    }
  };

  for (const line of output.split(/\r?\n/)) {
    const start = line.indexOf(AGENT_MESSAGE_RECORD_PREFIX);
    if (start < 0) continue;
    parsePayload(line.slice(start + AGENT_MESSAGE_RECORD_PREFIX.length));
  }

  // Parse the original OSC representation for turns produced by older CLIs.
  let offset = 0;
  while (offset < output.length) {
    const start = output.indexOf(AGENT_MESSAGE_EVENT_PREFIX, offset);
    if (start < 0) break;
    const payloadStart = start + AGENT_MESSAGE_EVENT_PREFIX.length;
    const end = output.indexOf(AGENT_MESSAGE_EVENT_SUFFIX, payloadStart);
    if (end < 0) break;
    offset = end + AGENT_MESSAGE_EVENT_SUFFIX.length;
    parsePayload(output.slice(payloadStart, end));
  }
  return events;
}

export function stripAgentMessageRuntimeEvents(output: string): string {
  const recordPattern = new RegExp(
    `${AGENT_MESSAGE_RECORD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\r\\n]*(?:\\r?\\n|$)`,
    "g",
  );
  const oscPattern = new RegExp(
    `${AGENT_MESSAGE_EVENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^${AGENT_MESSAGE_EVENT_SUFFIX}]*${AGENT_MESSAGE_EVENT_SUFFIX}`,
    "g",
  );
  return output.replace(recordPattern, "").replace(oscPattern, "");
}
