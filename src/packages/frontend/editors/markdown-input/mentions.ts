/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { isValidUUID, original_path } from "@cocalc/util/misc";
import {
  ALL_PROJECT_COLLABORATORS_MENTION_ID,
  getMentionAllAccountIds,
} from "./mention-all";

interface Mention {
  account_id: string;
  description: string;
  fragment_id?: string;
}

const seenMentionKeys = new Set<string>();
const MAX_MENTION_TARGETS_PER_NOTIFICATION = 25;

function expandMentions(project_id: string, mentions: Mention[]): Mention[] {
  const expanded: Mention[] = [];
  for (const mention of mentions) {
    if (mention.account_id !== ALL_PROJECT_COLLABORATORS_MENTION_ID) {
      expanded.push(mention);
      continue;
    }
    for (const account_id of getMentionAllAccountIds(project_id)) {
      expanded.push({ ...mention, account_id });
    }
  }
  return expanded;
}

function mentionSeenKey({
  account_id,
  fragment_id,
}: Pick<Mention, "account_id" | "fragment_id">): string {
  return `${fragment_id ?? ""}:${account_id}`;
}

function groupedMentions(mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  const grouped: Mention[] = [];
  for (const mention of mentions) {
    const key = mentionSeenKey(mention);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    grouped.push(mention);
  }
  return grouped;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

export async function submit_mentions(
  project_id: string,
  path: string,
  mentions: Mention[],
): Promise<void> {
  const source = redux.getStore("account")?.get("account_id");
  if (source == null) {
    return;
  }
  const source_path = original_path(path);
  const validMentions: Mention[] = [];
  const expandedMentions = groupedMentions(
    expandMentions(project_id, mentions),
  );
  for (const { account_id, description, fragment_id } of expandedMentions) {
    if (!isValidUUID(account_id)) {
      // Ignore all language model mentions, they are processed by the chat actions in the frontend
      continue;
    }
    if (fragment_id) {
      const key = mentionSeenKey({ account_id, fragment_id });
      if (seenMentionKeys.has(key)) {
        continue;
      }
      seenMentionKeys.add(key);
    }
    validMentions.push({ account_id, description, fragment_id });
  }
  if (validMentions.length === 0) {
    return;
  }

  const work: Promise<unknown>[] = [];
  for (const { account_id, description, fragment_id } of validMentions) {
    work.push(
      Promise.resolve().then(() =>
        webapp_client.query_client.query({
          query: {
            mentions: {
              project_id,
              path: source_path,
              fragment_id,
              target: account_id,
              priority: 2,
              description,
              source,
            },
          },
        }),
      ),
    );
  }

  const notificationGroups = new Map<string, Mention[]>();
  for (const mention of validMentions) {
    const key = `${mention.fragment_id ?? ""}\0${mention.description}`;
    const group = notificationGroups.get(key);
    if (group == null) {
      notificationGroups.set(key, [mention]);
    } else {
      group.push(mention);
    }
  }

  for (const group of notificationGroups.values()) {
    const first = group[0];
    if (first == null) {
      continue;
    }
    const { description, fragment_id } = first;
    for (const target_account_ids of chunk(
      group.map(({ account_id }) => account_id),
      MAX_MENTION_TARGETS_PER_NOTIFICATION,
    )) {
      work.push(
        Promise.resolve().then(() =>
          webapp_client.conat_client.hub.notifications.createMention({
            source_project_id: project_id,
            source_path,
            source_fragment_id: fragment_id,
            target_account_ids,
            description,
            stable_source_id: fragment_id,
          }),
        ),
      );
    }
  }

  try {
    const results = await Promise.allSettled(work);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("Failed to submit mention ", result.reason);
      }
    }
  } catch (err) {
    // TODO: this is just naively assuming that no errors happen.
    // What if there is a network blip?
    // Then we would just loose the mention, which is no good. Do better.
    console.warn("Failed to submit mention ", err);
  }
}
