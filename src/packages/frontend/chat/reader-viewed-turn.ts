/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Which turn the person has open in the reader, so a reply sent from there
// can tell the agent which turn it is about (the composer sends to the
// thread, whichever turn is open); and the message just sent from it, so the
// reader can offer to go to its turn. This browser tab only.

import { useSyncExternalStore } from "react";

export interface ViewedTurn {
  /** The reader item: its first message's id. */
  item_id: string;
  /** It is the thread's newest turn: replying to it needs no note. */
  latest: boolean;
  /** When the turn began (ISO time). */
  date?: string;
  /** The beginning of its first message, one line. */
  preview?: string;
}

const MAX_VIEWED = 200;
const viewed = new Map<string, ViewedTurn>();

export function readerTurnKey(
  projectId: string | undefined,
  path: string | undefined,
  threadId: string,
): string {
  return JSON.stringify([projectId ?? "", path ?? "", threadId]);
}

export function setViewedTurn(key: string, turn: ViewedTurn | undefined) {
  viewed.delete(key);
  if (!turn) return;
  viewed.set(key, turn);
  if (viewed.size > MAX_VIEWED) {
    const oldest = viewed.keys().next().value;
    if (oldest != null) viewed.delete(oldest);
  }
}

export function viewedTurn(key: string): ViewedTurn | undefined {
  return viewed.get(key);
}

/** Tests only. */
export function clearViewedTurnsForTests(): void {
  viewed.clear();
  sent.clear();
}

// The message last sent from the reader, by thread. Kept until the person
// goes to it (or sends another).
const sent = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function noteSentFromReader(key: string, message_id: string): void {
  sent.delete(key);
  sent.set(key, message_id);
  if (sent.size > MAX_VIEWED) {
    const oldest = sent.keys().next().value;
    if (oldest != null) sent.delete(oldest);
  }
  emit();
}

export function clearSentFromReader(key: string): void {
  if (sent.delete(key)) emit();
}

/** The id of the message last sent from the reader in this thread. */
export function useSentFromReader(key: string): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sent.get(key),
  );
}

/**
 * The context a reply sent from the composer adds for the agent: which
 * earlier turn the reader had open. Only for an agent turn in reader mode.
 */
export function readerReplyContext(opts: {
  readerMode: boolean;
  agentTurn: boolean;
  projectId?: string;
  path?: string;
  threadId?: string;
}): string | undefined {
  if (!opts.readerMode || !opts.agentTurn || !opts.threadId) return;
  return viewedTurnNote(
    viewedTurn(readerTurnKey(opts.projectId, opts.path, opts.threadId)),
  );
}

const PREVIEW_CHARS = 160;

export function turnPreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS
    ? `${line.slice(0, PREVIEW_CHARS - 1)}…`
    : line;
}

/**
 * For the agent only (not shown in the chat): the reply was written while an
 * earlier turn was open. Undefined when the newest turn was open.
 */
export function viewedTurnNote(
  turn: ViewedTurn | undefined,
): string | undefined {
  if (!turn || turn.latest) return;
  const when = turn.date ? ` (started ${turn.date})` : "";
  const began = turn.preview
    ? `, which began: ${JSON.stringify(turn.preview)}`
    : "";
  return `[Context from the CoCalc interface, not written by the person: they wrote this while viewing an earlier turn of this conversation${when}${began}. Their message may be about that turn rather than the latest one.]`;
}
