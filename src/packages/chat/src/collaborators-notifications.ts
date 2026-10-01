/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  COLLABORATION_MENTION_LIMIT,
  validateCollaborationMessageEvent,
} from "@cocalc/util/collaboration-attention";
import type { CollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import { createMarkdownParser } from "@cocalc/util/markdown/parser";

export type CollaborationMessageFacts = Omit<
  CollaborationMessageEvent,
  "activity" | "mode"
>;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ALL = "__cocalc_all_project_collaborators__";
// Keep raw HTML inline atoms instead of the renderer-oriented mention plugin.
const parser = createMarkdownParser();
parser.core.ruler.disable("mention");

function spanAttributes(tag: string): Map<string, string> | undefined {
  const match = /^<span\b([\s\S]*)>$/i.exec(tag);
  if (!match) return;
  const input = match[1];
  const attributes = new Map<string, string>();
  const pattern =
    /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let offset = 0;
  while (offset < input.length) {
    if (!input.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const attribute = pattern.exec(input);
    if (!attribute) return;
    const name = attribute[1].toLowerCase();
    if (attributes.has(name)) return;
    attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    offset = pattern.lastIndex;
  }
  return attributes;
}

/** Only authored person atoms count. Code, blockquotes, links, and plain @words do not. */
export function collaborationMessageMentions(text: string): {
  mentioned_account_ids: string[];
  mention_all: boolean;
} {
  if (text.length > 128 * 1024)
    throw Error("human message exceeds notification parsing capacity");
  const ids = new Set<string>();
  let mention_all = false,
    quoted = 0;
  for (const token of parser.parse(text, {})) {
    if (token.type === "blockquote_open") {
      quoted++;
      continue;
    }
    if (token.type === "blockquote_close") {
      quoted--;
      continue;
    }
    if (quoted || token.type !== "inline") continue;
    const children = token.children ?? [];
    let linked = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === "html_inline" && /^<a(?:\s|>)/i.test(child.content)) {
        linked++;
        continue;
      }
      if (child.type === "html_inline" && /^<\/a\s*>$/i.test(child.content)) {
        linked = Math.max(0, linked - 1);
        continue;
      }
      if (child.type === "link_open") {
        linked++;
        continue;
      }
      if (child.type === "link_close") {
        linked--;
        continue;
      }
      if (
        linked ||
        child.type !== "html_inline" ||
        !/^<span\s/i.test(child.content) ||
        children[i + 1]?.type !== "text" ||
        children[i + 2]?.content !== "</span>"
      )
        continue;
      const attributes = spanAttributes(child.content);
      if (!attributes?.get("class")?.split(/\s+/).includes("user-mention"))
        continue;
      const id = attributes.get("account-id");
      if (id === ALL) mention_all = true;
      else if (id && UUID.test(id)) ids.add(id.toLowerCase());
      if (ids.size > COLLABORATION_MENTION_LIMIT)
        throw Error("human message mention capacity exceeded");
    }
  }
  return { mentioned_account_ids: [...ids].sort(), mention_all };
}

/** Source facts only. The host journal decides cutover, activity and live/backfill. */
export function extractCollaborationMessageFacts(
  rows: readonly Record<string, any>[],
  source: { project_id: string; room_id: string },
): CollaborationMessageFacts[] {
  const human = new Set(
    rows
      .filter(
        (row) =>
          row.event === "chat-thread-config" &&
          row.agent_kind === "none" &&
          !row.acp_config &&
          !row.agent_model,
      )
      .map((row) => row.thread_id),
  );
  const facts: CollaborationMessageFacts[] = [];
  for (const row of rows) {
    if (
      row.event !== "chat" ||
      !human.has(row.thread_id) ||
      !UUID.test(row.sender_id ?? "") ||
      row.acp_thread_id ||
      row.acp_account_id ||
      row.generating
    )
      continue;
    const history = row.history;
    if (
      !Array.isArray(history) ||
      !history.length ||
      typeof history[history.length - 1]?.content !== "string"
    )
      throw Error("human message lacks original authored content");
    // Subsequent edits can change display text but must not add notification targets.
    const original = history[history.length - 1].content;
    const event = validateCollaborationMessageEvent({
      version: 1,
      ...source,
      thread_id: row.thread_id,
      message_id: row.message_id,
      actor_account_id: row.sender_id,
      activity: 1,
      mode: "backfill",
      ...collaborationMessageMentions(original),
    });
    const { activity: _activity, mode: _mode, ...fact } = event;
    facts.push(fact);
  }
  return facts.sort((a, b) =>
    JSON.stringify([a.thread_id, a.message_id]).localeCompare(
      JSON.stringify([b.thread_id, b.message_id]),
    ),
  );
}
