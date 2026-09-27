/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ChatActions } from "./actions";
import type { ChatMessageTyped } from "./types";
import { field } from "./access";
import { hasAcpGuidanceReceipt } from "./message-state";

export function canMovePostedMessageToAgent(
  message: ChatMessageTyped,
): boolean {
  return (
    field(message, "post_only") === true &&
    !field(message, "acp_attention_response") &&
    !hasAcpGuidanceReceipt(field(message, "acp_guidance_delivered_at_ms"))
  );
}

export async function movePostedMessageToAgent({
  actions,
  message,
  threadId,
  content,
}: {
  actions: ChatActions;
  message: ChatMessageTyped;
  threadId: string;
  content: string;
}): Promise<"sent" | "moved" | "failed"> {
  // Question transcripts have their own continuation path; never duplicate
  // their response or delete the canonical answer as though it were a note.
  if (!canMovePostedMessageToAgent(message) || !content.trim()) return "failed";
  const sent = actions.sendChat({
    input: content,
    reply_thread_id: threadId,
    preserveSelectedThread: true,
  });
  if (!sent) return "failed";
  await actions.syncdb?.save();
  await actions.save_to_disk();
  return actions.deleteMessage(message) ? "moved" : "sent";
}
