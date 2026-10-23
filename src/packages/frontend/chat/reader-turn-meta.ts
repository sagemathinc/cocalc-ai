/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Each reader item's subject and priority: what the agent said with
// `cocalc agent turn` (fields of the turn's message), else a default. Pure.

import {
  normalizeTurnSubject,
  readTurnMeta,
  type TurnMeta,
  type TurnPriority,
} from "@cocalc/chat";
import { field } from "./access";
import { isAgentReply, type ReaderItem } from "./reader-model";
import type { ChatMessageTyped } from "./types";
import { newest_content } from "./utils";

export type { TurnMeta, TurnPriority };

/** What the agent said about the item's turn, from any of its messages. */
export function itemTurnMeta(item: ReaderItem): TurnMeta {
  const meta: TurnMeta = {};
  for (const message of item.messages)
    Object.assign(meta, readTurnMeta(message));
  return meta;
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
      // Markdown's markup only: _ and ~ in cache_key or ~/.config stay.
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
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
  meta: TurnMeta | undefined,
): string {
  if (meta?.subject) return meta.subject;
  // As the reader groups them: older model replies too.
  const replies = item.messages.filter(isAgentReply);
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
  meta: TurnMeta | undefined,
  openQuestion = false,
): TurnPriority {
  if (openQuestion) return "high";
  if (meta?.priority) return meta.priority;
  return isMachineMessage(item.messages[0]) ? "low" : "normal";
}
