/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// How a chat message's text is shown: an agent message or a sensor wake as
// its compact card, anything else as it is. Shared by the chat log and the
// reader, so both show a message the same way.

import { sensorWakeFence } from "@cocalc/frontend/editors/slate/elements/sensor-wake";
import { field } from "./access";
import {
  agentMessageFence,
  agentMessageWaitingDelivery,
  sensorWakePresentation,
  stripAgentRpcPrompt,
} from "./agent-message-presentation";
import type { ChatMessageTyped } from "./types";

/**
 * The sensor a wake message says it came from. Chat rows are editable, so
 * this only labels the message; it never replaces the stored sender.
 */
export function sensorWakeLabel(
  message: ChatMessageTyped,
): { title: string; sensor_id: string } | undefined {
  const raw = field<any>(message, "sensor_wake");
  const sensor = typeof raw?.toJS === "function" ? raw.toJS() : raw;
  if (typeof sensor?.sensor_id !== "string" || !sensor.sensor_id) return;
  return {
    sensor_id: sensor.sensor_id,
    title:
      typeof sensor.title === "string" && sensor.title.trim()
        ? sensor.title.trim().slice(0, 100)
        : "sensor",
  };
}

export function rpcSourceAttribution(
  message: ChatMessageTyped,
  // This message has not been delivered to its recipient's turn yet.
  waiting = false,
):
  | {
      label: string;
      source_label: string;
      source_agent_id: string;
      source_project_id?: string;
      direction: "incoming" | "report";
      agent_network_id?: string;
      attempt_id?: string;
      delivery?: "queued" | "queued-fallback";
    }
  | undefined {
  const raw = field<any>(message, "agent_rpc");
  const rpc = typeof raw?.toJS === "function" ? raw.toJS() : raw;
  const source = rpc?.source;
  const agentId = `${source?.agent_id ?? ""}`.trim();
  if (!agentId) return;
  // A delivery report is CoCalc's, about the source agent.
  const report = !!rpc.delivery_report;
  const evidence = {
    direction: report ? ("report" as const) : ("incoming" as const),
    source_label:
      typeof rpc.source_label === "string" && rpc.source_label.trim()
        ? rpc.source_label.trim()
        : source.kind === "external"
          ? `External agent ${agentId.slice(0, 8)}`
          : `Agent ${agentId.slice(0, 8)}`,
    source_agent_id: agentId,
    source_project_id:
      typeof source.project_id === "string" ? source.project_id : undefined,
    agent_network_id:
      typeof rpc.agent_network_id === "string"
        ? rpc.agent_network_id
        : undefined,
    attempt_id: typeof rpc.attempt_id === "string" ? rpc.attempt_id : undefined,
    // Say why it has not started instead of looking delivered and ignored.
    ...(() => {
      const delivery = report
        ? undefined
        : agentMessageWaitingDelivery(rpc, waiting);
      return delivery ? { delivery } : {};
    })(),
  };
  if (source.kind === "external") {
    return {
      ...evidence,
      label: "External agent message",
    };
  }
  return {
    ...evidence,
    label: report ? "Delivery report" : "Agent message",
  };
}

/**
 * The Markdown a message is shown as: an agent message (or a delivery
 * report) as its "From @agent" card, a turn a sensor started as one line that
 * expands to the prompt, anything else as it is.
 */
export function presentedMessageMarkdown(
  message: ChatMessageTyped,
  value: string,
  attribution = rpcSourceAttribution(message),
): string {
  const rawRpc = field<any>(message, "agent_rpc");
  const rpc = typeof rawRpc?.toJS === "function" ? rawRpc.toJS() : rawRpc;
  if (attribution)
    return agentMessageFence(stripAgentRpcPrompt(value, rpc), attribution);
  const sensor = sensorWakeLabel(message);
  const sensorWake = sensor
    ? sensorWakePresentation(value, sensor.title)
    : undefined;
  return sensorWake
    ? sensorWakeFence({ ...sensorWake, sensor_id: sensor!.sensor_id, value })
    : value;
}
