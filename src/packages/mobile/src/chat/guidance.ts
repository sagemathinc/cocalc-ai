/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectedChatMessage } from "@cocalc/chat-client";

export interface ConversationMessage {
  item: ProjectedChatMessage;
  guidance: ProjectedChatMessage[];
}

// Guidance is stored as a durable chat row after the active assistant row.
// Render it with that assistant turn so long responses keep the guidance in
// view. A missing parent (for example, before older rows load) stays visible.
export function inlineGuidance(
  messages: readonly ProjectedChatMessage[],
): ConversationMessage[] {
  const byId = new Map(messages.map((item) => [item.message_id, item]));
  const attached = new Map<string, ProjectedChatMessage[]>();
  const represented = new Set<string>();

  for (const item of messages) {
    if (!item.guidance || !item.content.trim()) continue;
    let parentId = item.parent_message_id;
    const visited = new Set([item.message_id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.guidance) {
        parentId = parent.parent_message_id;
        continue;
      }
      if (parent.role === "agent" && parent.thread_id === item.thread_id) {
        const group = attached.get(parent.message_id) ?? [];
        group.push(item);
        attached.set(parent.message_id, group);
        represented.add(item.message_id);
      }
      break;
    }
  }

  return messages
    .filter((item) => !represented.has(item.message_id))
    .map((item) => ({
      item,
      guidance: (attached.get(item.message_id) ?? []).sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.message_id.localeCompare(b.message_id),
      ),
    }));
}
