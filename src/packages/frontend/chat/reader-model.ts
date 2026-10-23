/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The reader view's model (an email-like view of one thread): items, and
// which are read and archived. Pure, so the rules are tested apart from the
// view.
//
// An item is one agent turn: the incoming message that started it (from a
// person, another agent, a sensor or a scheduled prompt), what arrived while
// it ran (steering, other agents' messages, answers to its questions: as the
// log places them, with the turn they arrived during) and its replies. A
// message no turn answers or ran through is an item of its own. It is read when its
// last message is at or before the thread's watermark (what the person has
// read in order), or when it was opened since its last message arrived; and
// not when it was marked unread again. Archived works the same way: a new
// reply brings an item back.

import type { ChatReaderStateEntry } from "@cocalc/conat/project/read-state";
import { isLanguageModelService } from "@cocalc/util/db-schema/ai-models";
import {
  dateValue,
  field,
  historyArray,
  isAcpAssistantMessage,
  parentMessageId,
} from "./access";
import { canMovePostedMessageToAgent } from "./post-to-agent";
import { assistantFinishedAt } from "./turn-span";
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
  /** Indexes of all its messages: a late reply need not follow its prompt. */
  indexes: number[];
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
) => {
  state: ReaderState;
  watermarkCount?: number;
  /** The state to keep if the watermark cannot be moved after all. */
  unmoved?: ReaderState;
};

/** How many ids each list keeps; the oldest go first. */
export const READER_STATE_LIMITS = { read: 1000, unread: 1000, archived: 2000 };

export function readerMessageId(message: ChatMessageTyped): string {
  const id = `${field<string>(message, "message_id") ?? ""}`.trim();
  if (id) return id;
  const date = dateValue(message);
  return date ? `date-${date.valueOf()}` : "";
}

/**
 * A reply of the thread's agent: ACP metadata, or written by a language
 * model (e.g. a failure reply the frontend writes, or older model messages),
 * as the log tells them apart.
 */
export function isAgentReply(message: ChatMessageTyped): boolean {
  if (isAcpAssistantMessage(message)) return true;
  const sender = field<string>(message, "sender_id");
  if (typeof sender === "string" && isLanguageModelService(sender)) return true;
  // The entry the log calls the first: its author wrote the message.
  const author = historyArray(message)[0]?.author_id;
  return typeof author === "string" && isLanguageModelService(author);
}

type AcpStateMap = { get?: (key: string) => unknown };

function acpStateOf(
  message: ChatMessageTyped,
  acpState?: AcpStateMap,
): string {
  const id = readerMessageId(message);
  return `${(id ? acpState?.get?.(`message:${id}`) : undefined) ?? field<string>(message, "acp_state") ?? ""}`;
}

/**
 * The turn a message arrived during, as the log places it: the latest turn
 * that started before it and was still going (running now, or its reply was
 * last written after the message came). Not a message waiting to be sent
 * (queued, not sent, a note posted for people only): that isn't part of any
 * turn yet.
 */
function midTurnOwner(
  message: ChatMessageTyped,
  turns: readonly ChatMessageTyped[],
  acpState?: AcpStateMap,
): ChatMessageTyped | undefined {
  const date = dateValue(message)?.valueOf();
  if (date == null) return undefined;
  if (canMovePostedMessageToAgent(message)) return undefined;
  if (["queue", "queued", "not-sent"].includes(acpStateOf(message, acpState)))
    return undefined;
  let owner: ChatMessageTyped | undefined;
  for (const turn of turns) {
    const start = dateValue(turn)?.valueOf();
    if (start == null || start >= date) continue;
    const running =
      field<boolean>(turn, "generating") === true ||
      acpStateOf(turn, acpState) === "running";
    if (running || date <= assistantFinishedAt(turn)) owner = turn;
  }
  return owner;
}

export function readerItems(
  messages: ChatMessageTyped[],
  { acpState }: { acpState?: AcpStateMap } = {},
): ReaderItem[] {
  const items: ReaderItem[] = [];
  // Every message's item, by message id: a reply joins its parent's item.
  const byMessage = new Map<string, ReaderItem>();
  // The agent turns (their replies) and the messages they answer.
  const turns = messages.filter(isAgentReply);
  const prompts = new Set(
    turns.map((turn) => parentMessageId(turn)).filter(Boolean),
  );
  messages.forEach((message, index) => {
    const id = readerMessageId(message);
    if (!id) return;
    const reply = isAgentReply(message);
    // A reply goes with its prompt; what arrived during a turn, with it.
    const owner = reply
      ? undefined
      : prompts.has(id)
        ? undefined
        : midTurnOwner(message, turns, acpState);
    if (reply || owner) {
      // Its prompt's item (histories can interleave), else the one before.
      const parent = reply ? parentMessageId(message) : readerMessageId(owner!);
      const item =
        (parent ? byMessage.get(parent) : undefined) ??
        (reply ? items[items.length - 1] : undefined);
      if (item) {
        item.messages.push(message);
        item.lastId = id;
        item.lastIndex = index;
        item.indexes.push(index);
        byMessage.set(id, item);
        return;
      }
    }
    const item: ReaderItem = {
      id,
      messages: [message],
      lastId: id,
      firstIndex: index,
      lastIndex: index,
      indexes: [index],
    };
    items.push(item);
    byMessage.set(id, item);
  });
  // In the order of their latest message: a late reply moves its item on.
  return items.sort((a, b) => a.lastIndex - b.lastIndex);
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
): ReturnType<ReaderChange> {
  let next: ReaderState = {
    ...state,
    u: state.u?.filter((id) => id !== item.id),
  };
  if (item.lastIndex > watermark) {
    next.r = withEntry(next.r, item.id, item.lastId, READER_STATE_LIMITS.read);
  }
  // Move the watermark message by message while each one's item is read
  // (items can interleave, so not item by item).
  const itemAt: (ReaderItem | undefined)[] = [];
  for (const candidate of items)
    for (const index of candidate.indexes) itemAt[index] = candidate;
  const readNow = (candidate: ReaderItem) =>
    next.r?.[candidate.id] === candidate.lastId &&
    !next.u?.includes(candidate.id);
  let advanced = watermark;
  for (let index = watermark + 1; index < itemAt.length; index++) {
    const candidate = itemAt[index];
    if (!candidate || !readNow(candidate)) break;
    advanced = index;
  }
  // Wholly covered now: read in order, so no longer an exception.
  const covered = new Set(
    items
      .filter((candidate) => candidate.lastIndex <= advanced)
      .map((candidate) => candidate.id),
  );
  if (advanced > watermark) {
    return {
      state: compact({ ...next, r: without(next.r, covered) }),
      watermarkCount: advanced + 1,
      unmoved: compact(next),
    };
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
): { state: ReaderState; watermarkCount: number; unmoved: ReaderState } {
  const last = items[items.length - 1];
  return {
    state: compact({ a: state.a }),
    watermarkCount: last ? last.lastIndex + 1 : 0,
    unmoved: state,
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
