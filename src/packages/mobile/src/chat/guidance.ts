/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectedChatMessage } from "@cocalc/chat-client";
import { projectAcpActivityGuidanceBlocks } from "@cocalc/chat-client/activity";

export interface ConversationMessage {
  item: ProjectedChatMessage;
  guidance: ProjectedChatMessage[];
}

export type ActivityGuidanceSection =
  | { kind: "activity"; key: string; markdown: string }
  | { kind: "guidance"; key: string; item: ProjectedChatMessage };

/** Keep guidance at its delivery point as new Codex activity arrives. */
export function activityGuidanceSections(
  item: ProjectedChatMessage,
  guidance: readonly ProjectedChatMessage[],
): ActivityGuidanceSection[] {
  const events = item.activity?.events ?? [];
  if (!events.length) {
    return [
      ...(item.activity?.markdown
        ? [
            {
              kind: "activity" as const,
              key: "activity",
              markdown: item.activity.markdown,
            },
          ]
        : []),
      ...guidance.map((entry) => ({
        kind: "guidance" as const,
        key: entry.message_id,
        item: entry,
      })),
    ];
  }
  const sorted = [...guidance].sort(
    (a, b) =>
      (a.guidance_delivered_at_ms ?? Date.parse(a.date)) -
        (b.guidance_delivered_at_ms ?? Date.parse(b.date)) ||
      a.message_id.localeCompare(b.message_id),
  );
  let guidanceIndex = 0;
  const blocks = projectAcpActivityGuidanceBlocks(
    events,
    sorted.map((entry) => ({
      date: entry.guidance_delivered_at_ms ?? Date.parse(entry.date),
      text: entry.content,
      state: entry.state === "sending" ? "sending" : "sent",
    })),
  );
  const lastAgent = blocks.findLastIndex((block) => block.kind === "agent");
  if (
    !item.generating &&
    lastAgent >= 0 &&
    blocks[lastAgent].text.trim() === item.content.trim()
  ) {
    blocks.splice(lastAgent, 1);
  }
  return blocks.flatMap((block, index): ActivityGuidanceSection[] => {
    if (block.kind === "guidance") {
      const entry = sorted[guidanceIndex++];
      return entry
        ? [{ kind: "guidance", key: entry.message_id, item: entry }]
        : [];
    }
    return block.text.trim()
      ? [{ kind: "activity", key: `activity-${index}`, markdown: block.text }]
      : [];
  });
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
