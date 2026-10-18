/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Board decide bound to a posted board (daybreak2's HARD-E33-1): the caller
// names a board file, says which board its card posted on the channel (the
// card's revision and the SHA-256 of the text it posted), and passes the
// frame's `decide` message. The server reads the board itself and refuses
// unless it is exactly the posted text: a stale message is never checked
// against a newer board. Sagebrush's decideRequest then takes the question
// and its options from that text, and compares the message's name and
// revision with the card's. Only the reader's words come from the message.
// The prompt sent is that question, those options and those words; no other
// text (@sagebrush, Oct 16).
//
// The card's revision only labels the posted board: what is classified is
// the file the server read, matching the digest (daybreak2, cad7a07be2).
//
// Per (account, board), keyed by the board's resolved path: one call in
// flight, taken before the file is read (HARD-CAD-2), and at most
// CALLS_PER_BOARD_PER_HOUR an hour; and in total, for every account and
// board, MAX_IN_FLIGHT_TOTAL in flight and MAX_CALLS_PER_MINUTE_TOTAL a
// minute, both before the file is read (the spec's "per user and board, and
// bounds the total rate it serves"). These are per hub process; the hard
// bounds are the per-account rate limit in board-decide.ts and the
// account's AI allowance and the site pool.

import { decideRequest } from "./board-decide-request";
import type { DecideResult } from "./board-decide";
import {
  boardPostedName,
  boardTextDigest,
  isBoardPath,
} from "@cocalc/util/sagebrush-board";

/** The most a board file may be to be read (as the card's preview). */
export const BOARD_FILE_LIMIT = 16 * 1024 * 1024;
export const CALLS_PER_BOARD_PER_HOUR = 60;
/** The total this hub process serves, for every account and board: at most
 * this many in flight (each holds at most one board read in memory) and
 * this many started a minute. */
export const MAX_IN_FLIGHT_TOTAL = 16;
export const MAX_CALLS_PER_MINUTE_TOTAL = 600;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const PATH_LIMIT = 4096;
const REVISION_LIMIT = 200;
const SHA256 = /^[0-9a-f]{64}$/;

/** When the model's best option counts as the reader's meaning; below
 * either, the answer is "none fits" (null), and the board falls back. */
export const DECIDED_MIN_PROBABILITY = 0.5;
export const DECIDED_MIN_CONFIDENCE = 0.5;

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

/** A board path spelled one way only: no empty, "." or ".." components and
 * no trailing slash (HARD-CAD-1). The limiter then uses the path as the
 * filesystem resolves it, so links to one file share a bucket too. */
export function isPlainBoardPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > PATH_LIMIT) return false;
  // The card's rule, any case: a board it shows live can be decided on.
  if (!isBoardPath(path) || path.includes("\0")) return false;
  const parts = (path.startsWith("/") ? path.slice(1) : path).split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
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
  realpath(project_id: string, path: string): Promise<string>;
  stat(project_id: string, path: string): Promise<{ size: number }>;
  readFile(project_id: string, path: string): Promise<string>;
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
    !(
      revision === null ||
      (typeof revision === "string" && revision.length <= REVISION_LIMIT)
    ) ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256)
  ) {
    throw codedError("Invalid request.", 400);
  }
  await deps.assertCollab({ account_id, project_id });
  const resolved = await deps.realpath(project_id, path);
  const key = `${account_id}\n${project_id}\n${resolved}`;
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
    const { size } = await deps.stat(project_id, resolved);
    if (!(size >= 0) || size > BOARD_FILE_LIMIT) {
      throw codedError("This board is too large to check answers on.", 413);
    }
    const text = await deps.readFile(project_id, resolved);
    if (new TextEncoder().encode(text).byteLength > BOARD_FILE_LIMIT) {
      throw codedError("This board is too large to check answers on.", 413);
    }
    if ((await boardTextDigest(text)) !== sha256) {
      throw codedError("The board changed: reload it.", 409);
    }
    const deciding = await decideRequest(
      { text, name: boardPostedName(path), revision },
      message,
    );
    if (!deciding.ok) {
      throw codedError(deciding.message.slice(0, 500), 400);
    }
    const { request } = deciding;
    const now = deps.now?.() ?? Date.now();
    const calls = recentCalls(key, now);
    if (calls.length >= CALLS_PER_BOARD_PER_HOUR) {
      rememberCalls(key, calls);
      throw codedError(
        "Too many answers checked on this board. Try later.",
        429,
      );
    }
    calls.push(now);
    rememberCalls(key, calls);
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
