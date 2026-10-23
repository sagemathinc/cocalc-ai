/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What an agent says about one of its turns, for the people reading it: a
// subject (a line saying what the turn was) and a priority (whether it is
// for them). Stored in the chat document as one record per turn, keyed by
// the turn's message; the reader shows them.

export const TURN_META_EVENT = "chat-turn-meta";

/** high: it needs you; normal; low: FYI, for the record. */
export const TURN_PRIORITIES = ["high", "normal", "low"] as const;
export type TurnPriority = (typeof TURN_PRIORITIES)[number];

export const TURN_SUBJECT_MAX = 120;

// Records that aren't messages share one date, as artifacts do.
const DATE = "1970-01-01T00:00:00.000Z";

export interface TurnMetaRecord {
  event: typeof TURN_META_EVENT;
  date: string;
  sender_id: string;
  thread_id: string;
  message_id: string;
  schema_version: 1;
  subject?: string;
  priority?: TurnPriority;
  updated_at: string;
}

export interface TurnMetaTarget {
  thread_id: string;
  message_id: string;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw Error(`turn ${name} is required`);
  return value;
}

export function turnMetaKey(target: TurnMetaTarget) {
  return {
    event: TURN_META_EVENT as typeof TURN_META_EVENT,
    date: DATE,
    sender_id: `__turn__:${id(target.message_id, "message id")}`,
    thread_id: id(target.thread_id, "thread id"),
  };
}

/** One line, at most TURN_SUBJECT_MAX characters; empty clears it. */
export function normalizeTurnSubject(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > TURN_SUBJECT_MAX
    ? `${line.slice(0, TURN_SUBJECT_MAX - 1).trimEnd()}…`
    : line;
}

export function isTurnPriority(value: unknown): value is TurnPriority {
  return TURN_PRIORITIES.includes(value as TurnPriority);
}

function plain(value: any): any {
  return value?.toJS instanceof Function ? value.toJS() : value;
}

/** A stored record, or undefined if it isn't one (never throws). */
export function readTurnMeta(value: unknown): TurnMetaRecord | undefined {
  const row = plain(value);
  if (
    row?.event !== TURN_META_EVENT ||
    row.schema_version !== 1 ||
    typeof row.thread_id !== "string" ||
    typeof row.message_id !== "string" ||
    row.sender_id !== `__turn__:${row.message_id}`
  )
    return undefined;
  const subject =
    typeof row.subject === "string" && row.subject.trim()
      ? normalizeTurnSubject(row.subject)
      : undefined;
  const priority = isTurnPriority(row.priority) ? row.priority : undefined;
  return {
    event: TURN_META_EVENT as typeof TURN_META_EVENT,
    date: DATE,
    sender_id: row.sender_id,
    thread_id: row.thread_id,
    message_id: row.message_id,
    schema_version: 1,
    ...(subject ? { subject } : {}),
    ...(priority ? { priority } : {}),
    updated_at: `${row.updated_at ?? ""}`,
  };
}

interface TurnMetaStore {
  get_one(where: Record<string, unknown>): unknown;
  set(record: Record<string, unknown>): void;
}

/**
 * Sets a turn's subject and/or priority, keeping what isn't given. An empty
 * subject clears it.
 */
export function setTurnMeta(
  store: TurnMetaStore,
  {
    thread_id,
    message_id,
    subject,
    priority,
    now = new Date(),
  }: TurnMetaTarget & {
    subject?: string;
    priority?: TurnPriority;
    now?: Date;
  },
): TurnMetaRecord {
  if (subject === undefined && priority === undefined)
    throw Error("give a subject or a priority");
  if (priority !== undefined && !isTurnPriority(priority))
    throw Error(`priority must be one of ${TURN_PRIORITIES.join(", ")}`);
  const key = turnMetaKey({ thread_id, message_id });
  const previous = readTurnMeta(store.get_one(key));
  const nextSubject =
    subject === undefined ? previous?.subject : normalizeTurnSubject(subject);
  const record: TurnMetaRecord = {
    ...key,
    message_id,
    schema_version: 1,
    ...(nextSubject ? { subject: nextSubject } : {}),
    ...((priority ?? previous?.priority)
      ? { priority: priority ?? previous?.priority }
      : {}),
    updated_at: now.toISOString(),
  };
  // A cleared subject must not survive the merge of the stored record.
  store.set({ ...record, subject: record.subject ?? null });
  return record;
}
