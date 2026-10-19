/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// `decide` for Sagebrush boards: a reader's English answer, classified into
// one of a board question's own options, with probabilities. The board
// format names the capability, never a vendor; this module is
// provider-neutral, and the provider and the funding are given to it.
//
// The design (notes/board-plan/decide-cocalc-design.md):
// - the question and its options come from the board the host posted,
//   never from the frame; only the answer is the reader's;
// - limits bound what one call can cost and send;
// - only option names from the question come back, with probabilities in
//   [0, 1], so a provider's output can't add anything else;
// - money goes through the injected funding: none configured means
//   `decide` is unavailable, and nothing is called.

import { BOARD_DECIDE_REQUEST_LIMITS } from "@cocalc/util/sagebrush-board";
import { RecentTimes } from "@cocalc/util/recent-times";

/** Limits on one call (the request's sizes are util's, shared with the
 * server that reads the board). */
export const DECIDE_LIMITS = {
  answerCharacters: BOARD_DECIDE_REQUEST_LIMITS.answer,
  promptCharacters: BOARD_DECIDE_REQUEST_LIMITS.prompt,
  options: BOARD_DECIDE_REQUEST_LIMITS.options,
  optionNameCharacters: BOARD_DECIDE_REQUEST_LIMITS.optionName,
  optionAboutCharacters: BOARD_DECIDE_REQUEST_LIMITS.optionAbout,
  callsPerAccountPerMinute: 20,
  // Per (account, board as the filesystem resolves it), across every hub
  // replica: counted in the funding's reservation (board-decide-funding.ts).
  callsPerBoardPerHour: 60,
} as const;

const RATE_WINDOW_MS = 60_000;

export interface DecideQuestion {
  /** The question's text, from the posted board. */
  prompt: string;
  /** Its self-describing options, from the posted board: the name carries
   * the meaning, `about` (Markdown) only clarifies it. */
  options: DecideOption[];
}

export interface DecideOption {
  name: string;
  about?: string;
}

export interface DecideProviderResult {
  options: { name: string; p: number }[];
  confidence: number;
  /** The call's cost as the provider reports it, in micro-dollars. */
  costMicrousd?: number;
}

export interface DecideProvider {
  /** An upper bound on a request's cost in micro-dollars, before sending it. */
  maxCostMicrousd(question: DecideQuestion, answer: string): number;
  decide(
    question: DecideQuestion,
    answer: string,
    signal?: AbortSignal,
  ): Promise<DecideProviderResult>;
}

export interface DecideReservation {
  commit(microusd: number): Promise<void>;
  release(): Promise<void>;
}

/** Reserves an upper bound of a call's cost for an account, or throws
 * (over its allowance, or the site's). */
export interface DecideFunding {
  reserve(opts: {
    accountId: string;
    requestId: string;
    microusd: number;
    board: DecideBoard;
  }): Promise<DecideReservation>;
}

/** The board a call is for, as the file's server resolved it: its project
 * and real path. The funding counts calls per account and board. */
export interface DecideBoard {
  projectId: string;
  path: string;
}

export const DECIDE_BOARD_PATH_CHARACTERS = 4096;

function validDecideBoard(board: unknown): board is DecideBoard {
  const b = board as DecideBoard;
  return (
    b != null &&
    typeof b.projectId === "string" &&
    UUID.test(b.projectId) &&
    typeof b.path === "string" &&
    b.path.length > 0 &&
    b.path.length <= DECIDE_BOARD_PATH_CHARACTERS
  );
}

export interface DecideResult {
  options: { name: string; p: number }[];
  confidence: number;
}

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

// This process's counts, kept only for their windows and for at most so
// many keys (RecentTimes), however many accounts ever call. Forgetting one
// can only loosen them, never the funding's limits.
export const MAX_RATE_KEYS = 10_000;
export const MAX_REQUEST_ID_KEYS = 100_000;
const recentCalls = new RecentTimes({
  windowMs: RATE_WINDOW_MS,
  maxKeys: MAX_RATE_KEYS,
});
const usedRequestIds = new RecentTimes({
  windowMs: 10 * RATE_WINDOW_MS,
  maxKeys: MAX_REQUEST_ID_KEYS,
});

/** For tests. */
export function resetBoardDecideStateForTests(): void {
  recentCalls.clear();
  usedRequestIds.clear();
}

/** For tests: how many keys this process keeps. */
export function boardDecideStateSizesForTests(): {
  recentCalls: number;
  usedRequestIds: number;
} {
  return { recentCalls: recentCalls.size, usedRequestIds: usedRequestIds.size };
}

// This process's count: a cheap guard before the funding's reservation,
// which enforces callsPerAccountPerMinute atomically for every replica
// (board-decide-funding.ts). It keeps a flood from one account off the
// database: the reservation takes the site pool's row lock and writes a
// hold before it counts the account's calls.
function checkRate(accountId: string, now: number): void {
  if (
    !recentCalls.take(accountId, now, DECIDE_LIMITS.callsPerAccountPerMinute)
  ) {
    throw codedError("Too many answers checked. Try again in a minute.", 429);
  }
}

function claimRequestId(
  accountId: string,
  requestId: string,
  now: number,
): void {
  if (!usedRequestIds.take(`${accountId}\n${requestId}`, now, 1)) {
    throw codedError("This request was already made.", 409);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The question and answer as they may be sent, or a 400. */
export function validateDecideRequest(
  question: DecideQuestion,
  answer: unknown,
): { question: DecideQuestion; answer: string } {
  const prompt =
    typeof question?.prompt === "string" ? question.prompt.trim() : "";
  if (!prompt || prompt.length > DECIDE_LIMITS.promptCharacters) {
    throw codedError("This question can't be checked.", 400);
  }
  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length < 2 || options.length > DECIDE_LIMITS.options) {
    throw codedError("This question can't be checked.", 400);
  }
  const names = new Set<string>();
  const clean: DecideOption[] = [];
  for (const option of options) {
    const name = (option as DecideOption)?.name;
    const about = (option as DecideOption)?.about;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > DECIDE_LIMITS.optionNameCharacters ||
      names.has(name) ||
      (about != null &&
        (typeof about !== "string" ||
          about.length > DECIDE_LIMITS.optionAboutCharacters))
    ) {
      throw codedError("This question can't be checked.", 400);
    }
    names.add(name);
    clean.push(about?.trim() ? { name, about: about.trim() } : { name });
  }
  const text = typeof answer === "string" ? answer.trim() : "";
  if (!text) throw codedError("There is no answer to check.", 400);
  if (text.length > DECIDE_LIMITS.answerCharacters) {
    throw codedError("The answer is too long to check.", 400);
  }
  return { question: { prompt, options: clean }, answer: text };
}

/** Only the question's own option names, with probabilities in [0, 1],
 * sorted by probability. */
export function sanitizeDecideResult(
  question: DecideQuestion,
  result: DecideProviderResult,
): DecideResult {
  const allowed = new Set(question.options.map((o) => o.name));
  const seen = new Set<string>();
  const clamp = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x)
      ? Math.min(1, Math.max(0, x))
      : 0;
  const options: { name: string; p: number }[] = [];
  for (const o of Array.isArray(result?.options) ? result.options : []) {
    const name = (o as any)?.name;
    if (typeof name !== "string" || !allowed.has(name) || seen.has(name))
      continue;
    seen.add(name);
    options.push({ name, p: clamp((o as any).p) });
  }
  options.sort((a, b) => b.p - a.p);
  return { options, confidence: clamp(result?.confidence) };
}

export async function boardDecide({
  accountId,
  requestId,
  question,
  answer,
  board,
  provider,
  funding,
  now = Date.now(),
  signal,
}: {
  accountId: string;
  requestId: string;
  question: DecideQuestion;
  answer: unknown;
  board: DecideBoard;
  provider?: DecideProvider;
  funding?: DecideFunding;
  now?: number;
  signal?: AbortSignal;
}): Promise<DecideResult> {
  if (!provider || !funding) {
    throw codedError("Checking answers isn't available on this site.", 503);
  }
  if (
    typeof requestId !== "string" ||
    !UUID.test(requestId) ||
    !validDecideBoard(board)
  ) {
    throw codedError("Invalid request.", 400);
  }
  const valid = validateDecideRequest(question, answer);
  checkRate(accountId, now);
  claimRequestId(accountId, requestId, now);
  const reserved = Math.max(
    1,
    Math.ceil(provider.maxCostMicrousd(valid.question, valid.answer)),
  );
  const reservation = await funding.reserve({
    accountId,
    requestId,
    microusd: reserved,
    board: { projectId: board.projectId, path: board.path },
  });
  let result: DecideProviderResult;
  try {
    result = await provider.decide(valid.question, valid.answer, signal);
  } catch (err) {
    await reservation.release();
    throw codedError("The answer couldn't be checked. Try again.", 502);
  }
  // Commit what the provider reports (the reservation when it reports
  // nothing). A cost above the reservation is never clamped: the funding
  // records all of it and alerts.
  const reported = result?.costMicrousd;
  const cost =
    typeof reported === "number" && Number.isFinite(reported) && reported >= 0
      ? Math.max(1, Math.ceil(reported))
      : reserved;
  await reservation.commit(cost);
  return sanitizeDecideResult(valid.question, result);
}
