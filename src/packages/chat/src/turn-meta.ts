/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What an agent says about one of its turns, for the people reading it: a
// subject (a line saying what the turn was) and a priority (whether it is
// for them). Stored as fields of the turn's own chat message, so they move
// with it (e.g. when old messages are archived); the reader shows them.

/** high: it needs you; normal; low: FYI, for the record. */
export const TURN_PRIORITIES = ["high", "normal", "low"] as const;
export type TurnPriority = (typeof TURN_PRIORITIES)[number];

export const TURN_SUBJECT_MAX = 120;

export const TURN_SUBJECT_FIELD = "acp_turn_subject";
export const TURN_PRIORITY_FIELD = "acp_turn_priority";

export interface TurnMeta {
  subject?: string;
  priority?: TurnPriority;
}

/** One line, at most TURN_SUBJECT_MAX characters; empty clears it. */
export function normalizeTurnSubject(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  // By code points, not UTF-16 units: never half an emoji.
  const chars = Array.from(line);
  return chars.length > TURN_SUBJECT_MAX
    ? `${chars
        .slice(0, TURN_SUBJECT_MAX - 1)
        .join("")
        .trimEnd()}…`
    : line;
}

export function isTurnPriority(value: unknown): value is TurnPriority {
  return TURN_PRIORITIES.includes(value as TurnPriority);
}

function plain(value: any): any {
  return value?.toJS instanceof Function ? value.toJS() : value;
}

/** A message's subject and priority, if valid (never throws). */
export function readTurnMeta(message: unknown): TurnMeta {
  const row = plain(message);
  const rawSubject = row?.[TURN_SUBJECT_FIELD];
  const subject =
    typeof rawSubject === "string" && rawSubject.trim()
      ? normalizeTurnSubject(rawSubject)
      : undefined;
  const priority = isTurnPriority(row?.[TURN_PRIORITY_FIELD])
    ? (row[TURN_PRIORITY_FIELD] as TurnPriority)
    : undefined;
  return {
    ...(subject ? { subject } : {}),
    ...(priority ? { priority } : {}),
  };
}

interface TurnMetaStore {
  set(record: Record<string, unknown>): void;
}

// What names a chat row (the chat document's primary keys).
const ROW_KEYS = ["event", "date", "sender_id", "message_id", "thread_id"];

/**
 * Sets the subject and/or priority of the turn whose message is `row` (a
 * stored chat row), keeping what isn't given. An empty subject clears it.
 */
export function setTurnMeta(
  store: TurnMetaStore,
  row: Record<string, unknown>,
  { subject, priority }: { subject?: string; priority?: TurnPriority },
): TurnMeta {
  if (subject === undefined && priority === undefined)
    throw Error("give a subject or a priority");
  if (priority !== undefined && !isTurnPriority(priority))
    throw Error(`priority must be one of ${TURN_PRIORITIES.join(", ")}`);
  if (row?.event !== "chat" || typeof row.message_id !== "string")
    throw Error("a turn's subject and priority go on its chat message");
  const key: Record<string, unknown> = {};
  for (const name of ROW_KEYS) if (row[name] != null) key[name] = row[name];
  const update: Record<string, unknown> = { ...key };
  if (subject !== undefined)
    // null removes the field.
    update[TURN_SUBJECT_FIELD] = normalizeTurnSubject(subject) || null;
  if (priority !== undefined) update[TURN_PRIORITY_FIELD] = priority;
  store.set(update);
  return readTurnMeta({ ...plain(row), ...update });
}
