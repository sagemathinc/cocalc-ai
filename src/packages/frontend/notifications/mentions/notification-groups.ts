/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MentionInfo, MentionsMap } from "./types";

export type NotificationRenderGroup = {
  key: string;
  ids: string[];
  mention: MentionInfo;
  firstTime: Date;
  latestTime: Date;
};

function mentionTime(mention: MentionInfo): Date {
  const time = mention.get("time");
  return time instanceof Date ? time : new Date(0);
}

function dedupeKey(mention: MentionInfo): string | undefined {
  if (mention.get("kind") !== "account_notice") {
    return undefined;
  }
  return JSON.stringify([
    mention.get("kind") ?? "",
    mention.get("notice_type") ?? "",
    mention.get("project_id") ?? null,
    mention.get("path") ?? "",
    mention.get("thread_id") ?? "",
    mention.get("title") ?? "",
    mention.get("body_markdown") ?? "",
    mention.get("origin_label") ?? "",
    mention.get("action_link") ?? "",
    mention.get("action_label") ?? "",
    mention.get("severity") ?? "",
  ]);
}

export function groupNotificationMentions(
  mentions: MentionsMap,
): NotificationRenderGroup[] {
  const groups: NotificationRenderGroup[] = [];
  const byKey = new Map<string, NotificationRenderGroup>();

  mentions.forEach((mention, id) => {
    const key = dedupeKey(mention) ?? `notification:${id}`;
    const time = mentionTime(mention);
    const existing = byKey.get(key);
    if (existing == null) {
      const group = {
        key,
        ids: [id],
        mention,
        firstTime: time,
        latestTime: time,
      };
      groups.push(group);
      byKey.set(key, group);
      return;
    }

    existing.ids.push(id);
    if (time.getTime() < existing.firstTime.getTime()) {
      existing.firstTime = time;
    }
    if (time.getTime() > existing.latestTime.getTime()) {
      existing.latestTime = time;
      existing.mention = mention;
    }
  });

  return groups.sort((a, b) => b.latestTime.getTime() - a.latestTime.getTime());
}
