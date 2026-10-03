/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";
import type { ListedConversation } from "@cocalc/util/people";

// Message search in People conversations (for the search results page):
// the existing per-file search over the most recently active conversations.
export const SEARCH_MAX_CONVERSATIONS = 50;
const HITS_PER_CONVERSATION = 5;

// Escape glob metacharacters so a file name matches only itself.
export function globLiteral(name: string): string {
  return name.replace(/[\\*?[\]{}!]/g, (c) => `\\${c}`);
}

// Turn ripgrep --json output for a .chat file into hits: each matching line is
// one chat record.
export function hitsFromRipgrepJson(
  stdout: string,
  query: string,
): ChatStoreSearchHit[] {
  const hits: ChatStoreSearchHit[] = [];
  const needle = query.toLowerCase();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match") continue;
    let record: any;
    try {
      record = JSON.parse(event.data?.lines?.text ?? "");
    } catch {
      continue;
    }
    if (record?.event !== "chat") continue;
    const text = `${record.history?.[0]?.content ?? record.content ?? ""}`;
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 60);
    const date = Date.parse(record.date);
    hits.push({
      row_id: event.data?.line_number ?? hits.length,
      segment_id: "head",
      thread_id: record.thread_id,
      date_ms: Number.isFinite(date) ? date : undefined,
      snippet:
        (start > 0 ? "..." : "") +
        text.slice(start, at + needle.length + 100).replace(/\s+/g, " "),
    });
  }
  return hits;
}

// Current messages: ripgrep the .chat file through the project-host
// filesystem (no compute start). Archived messages: the chat store.
export async function searchConversationFile(
  c: ListedConversation,
  query: string,
): Promise<ChatStoreSearchHit[]> {
  await ensureProjectReduxRuntime();
  const fs = redux.getProjectActions(c.project_id)?.fs();
  if (fs == null) throw Error("project is not available");
  const slash = c.path.lastIndexOf("/");
  const output = await fs.ripgrep(c.path.slice(0, slash) || "/", query, {
    options: [
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--hidden",
      "--no-ignore",
      "--max-depth",
      "1",
      "--glob",
      globLiteral(c.path.slice(slash + 1)),
      "--max-count",
      `${HITS_PER_CONVERSATION * 4}`,
    ],
    timeout: 15_000,
    maxSize: 2_000_000,
  });
  const hits = hitsFromRipgrepJson(
    Buffer.from(output.stdout).toString(),
    query,
  ).slice(0, HITS_PER_CONVERSATION);
  try {
    const archived =
      await webapp_client.conat_client.hub.projects.chatStoreSearch({
        project_id: c.project_id,
        chat_path: c.path,
        query,
        limit: HITS_PER_CONVERSATION,
      });
    hits.push(...archived.hits);
  } catch {
    // no archive for this chat
  }
  return hits;
}

export interface ConversationHit {
  conversation: ListedConversation;
  hit: ChatStoreSearchHit;
}
type Hit = ConversationHit;

export async function searchConversations({
  conversations,
  query,
  search = searchConversationFile,
  onProgress,
  canceled,
  concurrency = 1,
}: {
  conversations: ListedConversation[];
  query: string;
  search?: (
    c: ListedConversation,
    query: string,
  ) => Promise<ChatStoreSearchHit[]>;
  onProgress: (hits: Hit[], searched: number, failed: number) => void;
  canceled: () => boolean;
  // How many conversations to search at once.
  concurrency?: number;
}): Promise<void> {
  const targets = [...conversations]
    .sort((a, b) => b.last_activity - a.last_activity)
    .slice(0, SEARCH_MAX_CONVERSATIONS);
  const hits: Hit[] = [];
  let searched = 0;
  let failed = 0;
  async function worker() {
    while (targets.length > 0) {
      if (canceled()) return;
      const conversation = targets.shift()!;
      try {
        for (const hit of await search(conversation, query)) {
          hits.push({ conversation, hit });
        }
      } catch {
        failed += 1;
      }
      if (canceled()) return;
      searched += 1;
      hits.sort((a, b) => (b.hit.date_ms ?? 0) - (a.hit.date_ms ?? 0));
      onProgress([...hits], searched, failed);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}
