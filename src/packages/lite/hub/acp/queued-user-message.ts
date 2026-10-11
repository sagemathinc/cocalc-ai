/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: reconcile queued ACP requests with the latest saved user-message edits before execution.

import type { MessageHistory } from "@cocalc/chat";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";

function historyToArray(value: unknown): MessageHistory[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as MessageHistory[];
  if (typeof (value as any).toJS === "function") {
    return (value as any).toJS() as MessageHistory[];
  }
  return [];
}

export function getLatestQueuedUserMessageContent(
  historyValue: unknown,
): string | undefined {
  const history = historyToArray(historyValue);
  if (history.length === 0) return undefined;
  const first = history[0] as MessageHistory | undefined;
  const content =
    typeof first?.content === "string"
      ? first.content
      : `${(first as any)?.content ?? ""}`;
  return content.trim().length > 0 ? content : undefined;
}

export function applyQueuedUserMessageEditToRequest<
  T extends {
    prompt: string;
    chat?: AcpChatContext;
  },
>({ request, latestContent }: { request: T; latestContent?: string }): T {
  if (typeof latestContent !== "string" || latestContent.trim().length === 0) {
    return request;
  }
  // CoCalc wrote a sensor wake for an approved sensor, and its permit binds
  // that exact prompt. Collaborators can edit chat rows; never run their edit.
  if (request.chat?.sensor_wake) return request;
  // The visible chat message can intentionally differ from the prompt sent to
  // ACP (for example, agent modals store detailed instructions in acp_prompt).
  // Only replace that hidden prompt when the persisted visible message changed.
  const submittedVisibleContent =
    typeof request.chat?.user_message_content === "string"
      ? request.chat.user_message_content
      : request.prompt;
  if (latestContent.trim() === submittedVisibleContent.trim()) return request;

  return {
    ...request,
    prompt: latestContent,
    chat: request.chat
      ? {
          ...request.chat,
          user_message_content: latestContent,
        }
      : request.chat,
  };
}
