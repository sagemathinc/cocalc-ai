/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ChatActions } from "./actions";
import type { ChatMessageTyped } from "./types";

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
  if (!content.trim()) return "failed";
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
