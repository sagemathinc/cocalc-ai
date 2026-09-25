/*
 * This file is part of CoCalc: Copyright (c) 2026 SageMath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ProjectedChatMessage } from "@cocalc/chat-client";
import {
  dateValue,
  field,
  firstHistory,
  isAcpAssistantMessage,
} from "./access";
import type { ChatMessage } from "./types";

export function projectLiveVoiceMessages(
  messages: readonly ChatMessage[],
  threadId: string,
  acpState?: { get: (key: string) => string | undefined },
): ProjectedChatMessage[] {
  return messages.map((message) => {
    const latest = firstHistory(message);
    const messageId = field<string>(message, "message_id") ?? "";
    const date = dateValue(message);
    const rawState =
      acpState?.get(`message:${messageId}`) ??
      (date ? acpState?.get(`${date.valueOf()}`) : undefined) ??
      field<string>(message, "acp_state");
    let state: ProjectedChatMessage["state"];
    if (
      field<boolean>(message, "acp_interrupted") ||
      rawState === "interrupted"
    )
      state = "interrupted";
    else if (rawState === "error" || rawState === "not-sent") state = "error";
    else if (["queue", "queued", "sending", "sent"].includes(rawState ?? ""))
      state = "queued";
    else if (rawState === "done" || rawState === "complete") state = "complete";
    else if (rawState === "running" || field<boolean>(message, "generating"))
      state = "running";
    else state = "complete";
    const senderId = field<string>(message, "sender_id") ?? "";
    return {
      message_id: messageId,
      thread_id: threadId,
      parent_message_id: field<string>(message, "parent_message_id"),
      sender_id: senderId,
      role: isAcpAssistantMessage(message)
        ? "agent"
        : senderId.startsWith("__")
          ? "system"
          : "human",
      content: latest?.content ?? "",
      date: date?.toISOString() ?? latest?.date ?? "",
      generating: state === "running",
      state,
    };
  });
}
