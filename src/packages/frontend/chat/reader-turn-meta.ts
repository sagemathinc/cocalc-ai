/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Each reader item's subject and priority: what the agent said with
// `cocalc agent turn` (a chat-turn-meta record), else a default. Pure.

import {
  normalizeTurnSubject,
  readTurnMeta,
  TURN_META_EVENT,
  type TurnMetaRecord,
  type TurnPriority,
} from "@cocalc/chat";
import { field, isAcpAssistantMessage } from "./access";
import type { ReaderItem } from "./reader-model";
import { readerMessageId } from "./reader-model";
import type { ChatMessageTyped } from "./types";
import { newest_content } from "./utils";

export type { TurnPriority };

/** The turn records of a thread, by the message they belong to. */
export function threadTurnMeta(
  syncdb: any,
  threadId: string,
): Map<string, TurnMetaRecord> {
  const byMessage = new Map<string, TurnMetaRecord>();
  if (!syncdb || (syncdb.get_state && syncdb.get_state() !== "ready"))
    return byMessage;
  const found = syncdb.get({ event: TURN_META_EVENT, thread_id: threadId });
  const rows = found?.toJS?.() ?? found ?? [];
  for (const row of rows) {
    const meta = readTurnMeta(row);
    if (meta) byMessage.set(meta.message_id, meta);
  }
  return byMessage;
}

/** The newest record of any of the item's messages. */
export function itemTurnMeta(
  item: ReaderItem,
  metas: ReadonlyMap<string, TurnMetaRecord>,
): TurnMetaRecord | undefined {
  let best: TurnMetaRecord | undefined;
  for (const message of item.messages) {
    const meta = metas.get(readerMessageId(message));
    if (meta && (!best || meta.updated_at > best.updated_at)) best = meta;
  }
  return best;
}

/** A message from an agent, a sensor or a schedule, not a person. */
export function isMachineMessage(message: ChatMessageTyped): boolean {
  const has = (name: string) => {
    const value = field<any>(message, name);
    return value != null && value !== false && value !== "";
  };
  return has("agent_rpc") || has("sensor_wake") || has("acp_automation_id");
}

const PLACEHOLDER = /^:robot: Thinking\.*$/;

/** The first line of a message worth reading, without Markdown. */
export function firstLine(message: ChatMessageTyped | undefined): string {
  if (!message) return "";
  let fenced = false;
  for (const raw of `${newest_content(message) ?? ""}`.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || PLACEHOLDER.test(line)) continue;
    const text = line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (text) return normalizeTurnSubject(text);
  }
  return "";
}

/**
 * The item's subject: the agent's own, else the first line of its reply,
 * else of the message that started it.
 */
export function itemSubject(
  item: ReaderItem,
  meta: TurnMetaRecord | undefined,
): string {
  if (meta?.subject) return meta.subject;
  const replies = item.messages.filter(isAcpAssistantMessage);
  for (const reply of replies.reverse()) {
    const line = firstLine(reply);
    if (line) return line;
  }
  return firstLine(item.messages[0]);
}

/**
 * How much the item is for the person: an open question is always high;
 * else what the agent said; else normal for a turn a person started, low for
 * one an agent message, a sensor or a schedule started.
 */
export function itemPriority(
  item: ReaderItem,
  meta: TurnMetaRecord | undefined,
  openQuestion = false,
): TurnPriority {
  if (openQuestion) return "high";
  if (meta?.priority) return meta.priority;
  return isMachineMessage(item.messages[0]) ? "low" : "normal";
}
