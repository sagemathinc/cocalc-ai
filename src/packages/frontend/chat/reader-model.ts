/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The reader view's model (an email-like view of one thread): items, and
// which are read and archived. Pure, so the rules are tested apart from the
// view.
//
// An item is an incoming message (from a person, another agent, a sensor or a
// scheduled prompt) with the agent replies that follow it. It is read when its
// last message is at or before the thread's watermark (what the person has
// read in order), or when it was opened since its last message arrived; and
// not when it was marked unread again. Archived works the same way: a new
// reply brings an item back.

import type { ChatReaderStateEntry } from "@cocalc/conat/project/read-state";
import { dateValue, field, isAcpAssistantMessage } from "./access";
import type { ChatMessageTyped } from "./types";

export interface ReaderItem {
  /** The first message's id. */
  id: string;
  messages: ChatMessageTyped[];
  /** The last message's id: what read and archived are pinned to. */
  lastId: string;
  /** Index of its first and last message in the thread. */
  firstIndex: number;
  lastIndex: number;
}

export type ReaderState = Omit<ChatReaderStateEntry, "kind" | "t">;

/**
 * A change to a thread's reader state, applied to the stored state and the
 * watermark (the index of the last message read in order) as they are when
 * it is saved. watermarkCount: the new number of messages read in order.
 */
export type ReaderChange = (
  state: ReaderState,
  watermark: number,
) => { state: ReaderState; watermarkCount?: number };

/** How many ids each list keeps; the oldest go first. */
export const READER_STATE_LIMITS = { read: 1000, unread: 1000, archived: 2000 };

export function readerMessageId(message: ChatMessageTyped): string {
  const id = `${field<string>(message, "message_id") ?? ""}`.trim();
  if (id) return id;
  const date = dateValue(message);
  return date ? `date-${date.valueOf()}` : "";
}

export function readerItems(messages: ChatMessageTyped[]): ReaderItem[] {
  const items: ReaderItem[] = [];
  messages.forEach((message, index) => {
    const id = readerMessageId(message);
    if (!id) return;
    const last = items[items.length - 1];
    if (last && isAcpAssistantMessage(message)) {
      last.messages.push(message);
      last.lastId = id;
      last.lastIndex = index;
      return;
    }
    items.push({
      id,
      messages: [message],
      lastId: id,
      firstIndex: index,
      lastIndex: index,
    });
  });
  return items;
}

/** watermark: the index of the last message read in order (-1 for none). */
export function isItemRead(
  item: ReaderItem,
  watermark: number,
  state: ReaderState,
): boolean {
  if (state.u?.includes(item.id)) return false;
  return item.lastIndex <= watermark || state.r?.[item.id] === item.lastId;
}

export function isItemArchived(item: ReaderItem, state: ReaderState): boolean {
  return state.a?.[item.id] === item.lastId;
}

function capRecord(
  record: Record<string, string>,
  limit: number,
): Record<string, string> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  return Object.fromEntries(
    keys.slice(keys.length - limit).map((key) => [key, record[key]]),
  );
}

function withEntry(
  record: Record<string, string> | undefined,
  key: string,
  value: string,
  limit: number,
): Record<string, string> {
  // Re-inserted at the end, so the newest is kept longest.
  const { [key]: _old, ...rest } = record ?? {};
  return capRecord({ ...rest, [key]: value }, limit);
}

function without(
  record: Record<string, string> | undefined,
  keys: Set<string>,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const next = Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.has(key)),
  );
  return Object.keys(next).length ? next : undefined;
}

function compact(state: ReaderState): ReaderState {
  return {
    ...(state.r && Object.keys(state.r).length ? { r: state.r } : {}),
    ...(state.u?.length ? { u: state.u } : {}),
    ...(state.a && Object.keys(state.a).length ? { a: state.a } : {}),
  };
}

/**
 * Open an item: it is read. When that makes every item up to some point
 * read, `watermark` is the new number of messages read in order (for the
 * thread's own read state), and the items it covers leave `r`.
 */
export function markItemRead(
  items: ReaderItem[],
  item: ReaderItem,
  watermark: number,
  state: ReaderState,
): { state: ReaderState; watermarkCount?: number } {
  let next: ReaderState = {
    ...state,
    u: state.u?.filter((id) => id !== item.id),
  };
  if (item.lastIndex > watermark) {
    next.r = withEntry(next.r, item.id, item.lastId, READER_STATE_LIMITS.read);
  }
  // Move the watermark over the read items that now follow it.
  let advanced = watermark;
  const covered = new Set<string>();
  for (const candidate of items) {
    if (candidate.lastIndex <= watermark) continue;
    if (
      next.r?.[candidate.id] !== candidate.lastId ||
      next.u?.includes(candidate.id)
    )
      break;
    advanced = candidate.lastIndex;
    covered.add(candidate.id);
  }
  if (advanced > watermark) {
    next = { ...next, r: without(next.r, covered) };
    return { state: compact(next), watermarkCount: advanced + 1 };
  }
  return { state: compact(next) };
}

export function markItemUnread(
  item: ReaderItem,
  state: ReaderState,
): ReaderState {
  const u = [...(state.u ?? []).filter((id) => id !== item.id), item.id];
  return compact({
    ...state,
    r: without(state.r, new Set([item.id])),
    u: u.slice(Math.max(0, u.length - READER_STATE_LIMITS.unread)),
  });
}

export function setItemArchived(
  item: ReaderItem,
  archived: boolean,
  state: ReaderState,
): ReaderState {
  return compact({
    ...state,
    a: archived
      ? withEntry(state.a, item.id, item.lastId, READER_STATE_LIMITS.archived)
      : without(state.a, new Set([item.id])),
  });
}

/** Everything read: the watermark covers every message; archives stay. */
export function markAllRead(
  items: ReaderItem[],
  state: ReaderState,
): { state: ReaderState; watermarkCount: number } {
  const last = items[items.length - 1];
  return {
    state: compact({ a: state.a }),
    watermarkCount: last ? last.lastIndex + 1 : 0,
  };
}

/** The next item after `index` (or before, with step -1) that matches. */
export function findItem(
  items: ReaderItem[],
  index: number,
  step: 1 | -1,
  matches: (item: ReaderItem) => boolean = () => true,
): number | undefined {
  for (let i = index + step; i >= 0 && i < items.length; i += step) {
    if (matches(items[i])) return i;
  }
  return undefined;
}
