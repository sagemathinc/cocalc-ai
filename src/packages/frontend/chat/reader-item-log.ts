/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The reader shows its open item with the chat log itself, limited to the
// item's messages: what the log shows (activity, live output, questions,
// Reply and Quote) the reader shows too. These pick what the log shows.

import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { dateValue, field } from "./access";
import type { ThreadIndexEntry } from "./message-cache";
import type { ReaderItem } from "./reader-model";

/** The log's keys of an item's messages (their dates in ms). */
export function readerItemKeys(item: ReaderItem): Set<string> {
  const keys = new Set<string>();
  for (const message of item.messages) {
    const date = dateValue(message);
    if (date) keys.add(`${date.valueOf()}`);
  }
  return keys;
}

/** A thread index under which the log shows only the item's messages. */
export function readerItemThreadIndex(
  threadKey: string,
  item: ReaderItem,
): Map<string, ThreadIndexEntry> {
  const messageKeys = readerItemKeys(item);
  let newestTime = 0;
  for (const key of messageKeys) newestTime = Math.max(newestTime, Number(key));
  return new Map([
    [
      threadKey,
      {
        key: threadKey,
        newestTime,
        messageCount: messageKeys.size,
        messageKeys,
      },
    ],
  ]);
}

/**
 * Each attention record (a question, an approval) goes with the item whose
 * message it belongs to; one whose message isn't known goes with the newest
 * item, where the turn asking it is.
 */
export function readerItemAttention(
  records: readonly AcpAttentionRecord[],
  items: readonly ReaderItem[],
): Map<string, AcpAttentionRecord[]> {
  const itemByKey = new Map<string, ReaderItem>();
  for (const item of items)
    for (const key of readerItemKeys(item)) itemByKey.set(key, item);
  const newest = items.reduce<ReaderItem | undefined>(
    (best, item) => (best && best.lastIndex >= item.lastIndex ? best : item),
    undefined,
  );
  const byItem = new Map<string, AcpAttentionRecord[]>();
  for (const record of records) {
    const date = Date.parse(record.message_date ?? "");
    const item =
      (Number.isFinite(date) ? itemByKey.get(`${date}`) : undefined) ?? newest;
    if (!item) continue;
    const list = byItem.get(item.id) ?? [];
    list.push(record);
    byItem.set(item.id, list);
  }
  return byItem;
}

/** A question or approval still waiting for an answer. */
export function isOpenAttention(record: AcpAttentionRecord): boolean {
  return record.state === "pending" && record.response_submitted_at == null;
}

/** The item's agent turn is running (or queued). */
export function readerItemWorking(
  item: ReaderItem,
  acpState?: { get?: (key: string) => unknown },
): boolean {
  return item.messages.some((message) => {
    if (field<boolean>(message, "generating") === true) return true;
    const id = `${field<string>(message, "message_id") ?? ""}`.trim();
    const state =
      (id ? acpState?.get?.(`message:${id}`) : undefined) ??
      field<string>(message, "acp_state");
    return state === "running" || state === "queue" || state === "queued";
  });
}
