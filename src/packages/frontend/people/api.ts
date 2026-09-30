/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export function conversationsApi() {
  return webapp_client.conat_client.hub.conversations;
}

// Local signal that the conversation list is stale (e.g., this browser just
// sent a message or changed a conversation), so it refreshes without waiting
// for the next poll.
export const conversationEvents = new EventEmitter();

export function conversationsChanged(): void {
  conversationEvents.emit("changed");
}

// Called by the chat editor after every human message sent in CoCalc.
// The server ignores files that are not conversations.
export function touchConversation(project_id: string, path: string): void {
  if (lite) return;
  void (async () => {
    const { conversation_id } = await conversationsApi().touch({
      project_id,
      path,
    });
    if (conversation_id) conversationsChanged();
  })().catch((err) => {
    console.warn("Failed to record conversation activity", err);
  });
}
