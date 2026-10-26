/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// When an agent turn ended: the log and the reader both place messages that
// arrived during a turn with that turn.

import { isLanguageModelService } from "@cocalc/util/db-schema/ai-models";
import {
  field,
  historyArray,
  isAcpAssistantMessage,
  parentMessageId,
} from "./access";
import type { ChatMessageTyped } from "./types";

/** The time of the assistant's last edit of its reply (0 if none). */
export function assistantFinishedAt(assistant: ChatMessageTyped): number {
  return Math.max(
    0,
    ...historyArray(assistant).map((entry) => {
      const author =
        (entry as any)?.author_id ?? (entry as any)?.get?.("author_id");
      if (
        typeof author !== "string" ||
        (author !== field(assistant, "sender_id") &&
          !isLanguageModelService(author))
      )
        return 0;
      const raw = (entry as any)?.date ?? (entry as any)?.get?.("date");
      const time = new Date(raw).valueOf();
      return Number.isFinite(time) ? time : 0;
    }),
  );
}

export function isImmediateAcpSteerMessage(message: ChatMessageTyped): boolean {
  return field<string>(message, "acp_send_mode") === "immediate";
}

/**
 * The assistant turn a message's parent chain leads to (through steering,
 * and with includeMidturnMessages through any non-assistant messages).
 */
export function resolveSteerAssistantMessageId({
  message,
  byMessageId,
  includeMidturnMessages = false,
}: {
  message: ChatMessageTyped;
  byMessageId: Map<string, ChatMessageTyped>;
  includeMidturnMessages?: boolean;
}): string | undefined {
  let current: ChatMessageTyped | undefined = message;
  let guard = 0;
  while (current != null && guard < 1000) {
    const directParentId = `${parentMessageId(current) ?? ""}`.trim();
    if (!directParentId) return undefined;
    const directParent = byMessageId.get(directParentId);
    if (directParent == null) return undefined;
    if (field(message, "thread_id") !== field(directParent, "thread_id"))
      return;
    if (
      isImmediateAcpSteerMessage(directParent) ||
      (includeMidturnMessages && !isAcpAssistantMessage(directParent))
    ) {
      current = directParent;
      guard += 1;
      continue;
    }
    if (!isAcpAssistantMessage(directParent)) {
      return undefined;
    }
    const assistantMessageId =
      `${field<string>(directParent, "message_id") ?? ""}`.trim();
    return assistantMessageId || undefined;
  }
  return undefined;
}
