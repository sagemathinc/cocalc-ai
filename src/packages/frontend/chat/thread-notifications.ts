/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import Fragment from "@cocalc/frontend/misc/fragment-id";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { isValidUUID, original_path } from "@cocalc/util/misc";
import { notificationPreview } from "@cocalc/frontend/notifications/markdown-preview";
import type { CreateNotificationResult } from "@cocalc/conat/hub/api/notifications";
import type { ChatMessageTyped } from "./types";
import { field } from "./access";
import {
  ALL_PROJECT_COLLABORATORS_MENTION_ID,
  getMentionAllAccountIds,
} from "@cocalc/frontend/editors/markdown-input/mention-all";

const MAX_NOTIFICATION_TARGETS = 25;

export interface ThreadNotificationState {
  notification_followers?: string[];
  notification_muted?: string[];
}

export interface ThreadNotificationPlan {
  explicitMentionTargets: string[];
  followerTargets: string[];
  nextFollowers: string[];
  nextMuted: string[];
}

function normalizedAccountIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => `${value ?? ""}`.trim())
        .filter((value) => isValidUUID(value)),
    ),
  );
}

export function extractMentionAccountIds({
  input,
  project_id,
}: {
  input?: string;
  project_id: string;
}): string[] {
  const value = `${input ?? ""}`;
  if (!value.includes("user-mention")) {
    return [];
  }
  const ids = new Set<string>();
  const re =
    /<span\b(?=[^>]*\bclass\s*=\s*(?:"[^"]*\buser-mention\b[^"]*"|'[^']*\buser-mention\b[^']*'|[^\s>]*\buser-mention\b[^\s>]*))(?=[^>]*\baccount-id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) != null) {
    const account_id = `${match[1] ?? match[2] ?? match[3] ?? ""}`.trim();
    if (account_id === ALL_PROJECT_COLLABORATORS_MENTION_ID) {
      for (const id of getMentionAllAccountIds(project_id)) {
        if (isValidUUID(id)) ids.add(id);
      }
    } else if (isValidUUID(account_id)) {
      ids.add(account_id);
    }
  }
  return Array.from(ids);
}

function threadParticipantIds(messages: ChatMessageTyped[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const sender_id = `${field<string>(message, "sender_id") ?? ""}`.trim();
    if (isValidUUID(sender_id)) {
      ids.add(sender_id);
    }
  }
  return Array.from(ids);
}

export function buildThreadNotificationPlan({
  project_id,
  sender_id,
  input,
  threadMessages,
  notificationState,
}: {
  project_id: string;
  sender_id: string;
  input?: string;
  threadMessages: ChatMessageTyped[];
  notificationState?: ThreadNotificationState;
}): ThreadNotificationPlan {
  const sender = `${sender_id ?? ""}`.trim();
  const explicitMentionTargets = extractMentionAccountIds({
    input,
    project_id,
  }).filter((account_id) => account_id !== sender);
  const explicitSet = new Set(explicitMentionTargets);
  const muted = new Set(
    normalizedAccountIds(notificationState?.notification_muted).filter(
      (account_id) => account_id !== sender,
    ),
  );
  const followers = new Set([
    ...normalizedAccountIds(notificationState?.notification_followers),
    ...threadParticipantIds(threadMessages),
    ...explicitMentionTargets,
  ]);
  if (isValidUUID(sender)) {
    followers.add(sender);
  }
  const followerTargets = Array.from(followers).filter(
    (account_id) =>
      account_id !== sender &&
      !explicitSet.has(account_id) &&
      !muted.has(account_id),
  );
  return {
    explicitMentionTargets,
    followerTargets,
    nextFollowers: Array.from(followers).sort(),
    nextMuted: Array.from(muted).sort(),
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

function notificationDescription(input?: string): string {
  const text = `${input ?? ""}`.trim();
  if (!text) {
    return "New reply in a chat thread you follow.";
  }
  return `New reply in a chat thread you follow:\n\n${notificationPreview(text)}`;
}

export async function sendThreadFollowerNotifications({
  project_id,
  path,
  thread_id,
  message_id,
  date,
  input,
  target_account_ids,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  message_id: string;
  date: Date | string;
  input?: string;
  target_account_ids: string[];
}): Promise<{ notified_account_ids: string[] }> {
  const targets = normalizedAccountIds(target_account_ids);
  if (targets.length === 0) {
    return { notified_account_ids: [] };
  }
  const fragment_id = Fragment.encode({
    chat: `${new Date(date).valueOf()}`,
    thread: thread_id,
  });
  const source_path = original_path(path);
  const batches = chunk(targets, MAX_NOTIFICATION_TARGETS);
  const notified = new Set<string>();
  const results = await Promise.allSettled(
    batches.map(async (target_account_ids) => {
      const result: CreateNotificationResult =
        await webapp_client.conat_client.hub.notifications.createMention({
          source_project_id: project_id,
          source_path,
          source_fragment_id: fragment_id,
          target_account_ids,
          description: notificationDescription(input),
          stable_source_id: `${message_id}:thread-follow`,
          notification_reason: "thread_follow",
        });
      for (const target of result.targets ?? []) {
        notified.add(target.target_account_id);
      }
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn(
        "Failed to submit chat follower notification",
        result.reason,
      );
    }
  }
  return { notified_account_ids: Array.from(notified) };
}
