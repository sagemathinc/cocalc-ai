/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Board decide bound to a posted board (daybreak2's HARD-E33-1): the caller
// names a board file and passes the frame's `decide` message. The server
// reads the board itself, and Sagebrush's decideRequest takes the question
// and its options from it. Only the reader's words come from the message.
// The prompt sent is that question, those options and those words; no other
// text (@sagebrush, Oct 16).
//
// Per (account, board): one call in flight, and at most
// CALLS_PER_BOARD_PER_HOUR an hour, beside the per-account rate limit in
// board-decide.ts and the account's AI allowance.

import { decideRequest } from "./board-decide-request";
import type { DecideResult } from "./board-decide";

/** The most a board file may be to be read (as the card's preview). */
export const BOARD_FILE_LIMIT = 16 * 1024 * 1024;
export const CALLS_PER_BOARD_PER_HOUR = 60;
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
const recent = new Map<string, number[]>();

/** For tests. */
export function resetBoardDecideBoundStateForTests(): void {
  inFlight.clear();
  recent.clear();
}

export interface BoardDecideDeps {
  assertCollab(opts: { account_id: string; project_id: string }): Promise<void>;
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
    message,
  }: {
    account_id?: string;
    project_id: string;
    path: string;
    message: unknown;
  },
  deps: BoardDecideDeps,
): Promise<{ id: string; option: string | null }> {
  if (!account_id) throw codedError("must be signed in", 401);
  if (
    typeof project_id !== "string" ||
    typeof path !== "string" ||
    !path.endsWith(".board.json")
  ) {
    throw codedError("Invalid request.", 400);
  }
  await deps.assertCollab({ account_id, project_id });
  const { size } = await deps.stat(project_id, path);
  if (!(size >= 0) || size > BOARD_FILE_LIMIT) {
    throw codedError("This board is too large to check answers on.", 413);
  }
  const text = await deps.readFile(project_id, path);
  if (new TextEncoder().encode(text).byteLength > BOARD_FILE_LIMIT) {
    throw codedError("This board is too large to check answers on.", 413);
  }
  const name = path.split("/").pop() ?? path;
  // The revision is the card's; the board itself is the file as it is now.
  const revision = (message as any)?.revision;
  const deciding = decideRequest(
    { text, name, revision: typeof revision === "string" ? revision : null },
    message,
  );
  if (!deciding.ok) {
    throw codedError(deciding.message.slice(0, 500), 400);
  }
  const { request } = deciding;
  const key = `${account_id}\n${project_id}\n${path}`;
  if (inFlight.has(key)) {
    throw codedError("An answer on this board is already being checked.", 429);
  }
  const now = deps.now?.() ?? Date.now();
  const calls = (recent.get(key) ?? []).filter((t) => now - t < HOUR_MS);
  if (calls.length >= CALLS_PER_BOARD_PER_HOUR) {
    throw codedError("Too many answers checked on this board. Try later.", 429);
  }
  calls.push(now);
  recent.set(key, calls);
  inFlight.add(key);
  try {
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
