/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Board decide bound to a posted board (daybreak2's HARD-E33-1): the caller
// names a board file, says which board its card posted on the channel (the
// card's revision and the SHA-256 of the text it posted), and passes the
// frame's `decide` message. The server that has the project's files reads
// the board (backend/sagebrush-board: a project host, or the owning bay in
// the workspace runtime; this call runs on the project's owning bay,
// conat/hub/api/routes.ts) and refuses unless it is exactly the posted text:
// a stale message is never checked against a newer board. The board never
// comes here (AGENTS.md: control plane and data plane; Codex on #1134).
// Sagebrush's decideRequest, there, takes the question
// and its options from that text, and compares the message's name and
// revision with the card's. Only the reader's words come from the message.
// The prompt sent is that question, those options and those words; no other
// text (@sagebrush, Oct 16).
//
// The card's revision only labels the posted board: what is classified is
// the file the server read, matching the digest (daybreak2, cad7a07be2).
//
// Per (account, board): one call in flight per path as asked, taken before
// the file is read (HARD-CAD-2), and at most CALLS_PER_BOARD_PER_HOUR an
// hour per path as the filesystem resolves it; and in total, for every
// account and board, MAX_IN_FLIGHT_TOTAL in flight and
// MAX_CALLS_PER_MINUTE_TOTAL a minute, both before the file is read (the
// spec's "per user and board, and bounds the total rate it serves"). The
// file's server bounds its reads per project and in total. These are per
// process; the hard
// bounds, shared by every replica and atomic, are in the funding's
// reservation (board-decide-funding.ts): the account's per-minute limit,
// its AI allowance, and the site pool.

import type { DecideResult } from "./board-decide";
import {
  isBoardDecideBinding,
  isPlainBoardPath,
} from "@cocalc/util/sagebrush-board";
import type {
  BoardDecidePrepareOptions,
  BoardDecidePrepared,
} from "@cocalc/conat/project/board-decide";

export { isPlainBoardPath };
export const CALLS_PER_BOARD_PER_HOUR = 60;
/** The total this hub process serves, for every account and board: at most
 * this many in flight and this many started a minute. (A board is never
 * read here: the file's server reads it, backend/sagebrush-board.) */
export const MAX_IN_FLIGHT_TOTAL = 16;
export const MAX_CALLS_PER_MINUTE_TOTAL = 600;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * 60_000;

/** When the model's best option counts as the reader's meaning; below
 * either, the answer is "none fits" (null), and the board falls back. */
export const DECIDED_MIN_PROBABILITY = 0.5;
export const DECIDED_MIN_CONFIDENCE = 0.5;

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

export function chooseDecidedOption(
  result: DecideResult,
  allowed: string[],
): string | null {
  const best = result.options[0];
  if (!best || !allowed.includes(best.name)) return null;
  if (best.p < DECIDED_MIN_PROBABILITY) return null;
  if (result.confidence < DECIDED_MIN_CONFIDENCE) return null;
  return best.name;
}

const inFlight = new Set<string>();
// Start times of the last MAX_CALLS_PER_MINUTE_TOTAL calls, oldest first.
const started: number[] = [];
// Hourly call times per key, least recently used first: every call moves
// its key to the end, so keys with no call in the last hour come first.
// When the map passes MAX_RECENT_KEYS, the least recently used go, down to
// 90%: at most MAX_RECENT_KEYS keys, and one cut (at most MAX_RECENT_KEYS / 10
// deletions) per MAX_RECENT_KEYS / 10 new keys, so amortized one deletion a
// call. Eviction can only loosen this soft limit, never the account's hard
// ones.
const recent = new Map<string, number[]>();
export const MAX_RECENT_KEYS = 10_000;

function recentCalls(key: string, now: number): number[] {
  const calls = (recent.get(key) ?? []).filter((t) => now - t < HOUR_MS);
  recent.delete(key);
  return calls;
}

function rememberCalls(key: string, calls: number[]): void {
  recent.set(key, calls); // most recently used last
  if (recent.size <= MAX_RECENT_KEYS) return;
  for (const k of recent.keys()) {
    if (recent.size <= MAX_RECENT_KEYS * 0.9) break;
    recent.delete(k);
  }
}

/** For tests. */
export function boardDecideRecentKeysForTests(): string[] {
  return [...recent.keys()];
}

/** For tests. */
export function resetBoardDecideBoundStateForTests(): void {
  inFlight.clear();
  recent.clear();
  started.length = 0;
}

export interface BoardDecideDeps {
  assertCollab(opts: { account_id: string; project_id: string }): Promise<void>;
  /** The board side, on the server that has the project's files
   * (conat/project/board-decide.ts): it reads and checks the board, and
   * only the bounded request comes back. Nothing here reads a file. */
  prepare(
    project_id: string,
    opts: BoardDecidePrepareOptions,
  ): Promise<BoardDecidePrepared>;
  /** The home-bay call (board-decide-service.ts). */
  decide(opts: {
    account_id: string;
    request_id: string;
    question: { prompt: string; options: { name: string; about?: string }[] };
    answer: string;
  }): Promise<DecideResult>;
  now?: () => number;
}

export async function boardDecideForBoard(
  {
    account_id,
    project_id,
    path,
    revision,
    sha256,
    message,
  }: {
    account_id?: string;
    project_id: string;
    path: string;
    /** The card's revision for the board it posted on this channel. */
    revision: string | null;
    /** The SHA-256 of the text the card posted on this channel. */
    sha256: string;
    message: unknown;
  },
  deps: BoardDecideDeps,
): Promise<{ id: string; option: string | null }> {
  if (!account_id) throw codedError("must be signed in", 401);
  if (
    typeof project_id !== "string" ||
    !isPlainBoardPath(path) ||
    !isBoardDecideBinding(revision, sha256)
  ) {
    throw codedError("Invalid request.", 400);
  }
  await deps.assertCollab({ account_id, project_id });
  // One in flight per board path as asked, taken before the file's server
  // is asked to read it (HARD-CAD-2); that server bounds its own reads per
  // project and in total (backend/sagebrush-board/service.ts).
  const key = `${account_id}\n${project_id}\n${path}`;
  if (inFlight.has(key)) {
    throw codedError("An answer on this board is already being checked.", 429);
  }
  if (inFlight.size >= MAX_IN_FLIGHT_TOTAL) {
    throw codedError("Too many answers are being checked. Try again.", 503);
  }
  const startedAt = deps.now?.() ?? Date.now();
  if (
    started.length >= MAX_CALLS_PER_MINUTE_TOTAL &&
    startedAt - started[0] < MINUTE_MS
  ) {
    throw codedError("Too many answers are being checked. Try again.", 503);
  }
  started.push(startedAt);
  if (started.length > MAX_CALLS_PER_MINUTE_TOTAL) started.shift();
  inFlight.add(key);
  try {
    // The file's server reads the board, refuses one too large (413) or
    // not exactly the text the card posted (409), and takes the question
    // and its options from it: never from the message, never from here.
    const { resolved_path, request } = await deps.prepare(project_id, {
      path,
      revision,
      sha256,
      message,
    });
    // Per board as the filesystem resolves it: links to one file share it.
    const boardKey = `${account_id}\n${project_id}\n${resolved_path}`;
    const now = deps.now?.() ?? Date.now();
    const calls = recentCalls(boardKey, now);
    if (calls.length >= CALLS_PER_BOARD_PER_HOUR) {
      rememberCalls(boardKey, calls);
      throw codedError(
        "Too many answers checked on this board. Try later.",
        429,
      );
    }
    calls.push(now);
    rememberCalls(boardKey, calls);
    const result = await deps.decide({
      account_id,
      request_id: request.id,
      question: { prompt: request.prompt, options: request.options },
      answer: request.answer,
    });
    return {
      id: request.id,
      option: chooseDecidedOption(
        result,
        request.options.map((o) => o.name),
      ),
    };
  } finally {
    inFlight.delete(key);
  }
}
