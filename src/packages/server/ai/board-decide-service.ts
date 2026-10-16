/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Board decide on the account's home bay, where its AI allowance lives
// (board-decide.ts: the call; board-decide-openrouter.ts: the provider;
// board-decide-funding.ts: the money).
//
// The caller is CoCalc's own board card, signed in as the account. It takes
// the question and options from the board it posted (never from the
// frame), so a direct caller can only classify things at the cost of their
// own allowance, within the limits.

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  boardDecide,
  type DecideQuestion,
  type DecideResult,
} from "./board-decide";
import { siteFundedDecideFunding } from "./board-decide-funding";
import { openRouterDecideProvider } from "./board-decide-openrouter";

export const BOARD_DECIDE_MODEL = "typesafe/jev-1.14";

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

/** This call's configuration, read once: the key when checking is on and
 * a key is set, else undefined. Never logged. */
async function decideConfig(): Promise<{ apiKey: string } | undefined> {
  const settings: any = await getServerSettings();
  const key =
    typeof settings.openrouter_api_key === "string"
      ? settings.openrouter_api_key.trim()
      : "";
  return settings.board_decide_enabled === true && key
    ? { apiKey: key }
    : undefined;
}

/** Whether this site checks board answers (the switch and a key). */
export async function boardDecideEnabled(): Promise<boolean> {
  return (await decideConfig()) != null;
}

export async function boardDecideLocal({
  account_id,
  request_id,
  question,
  answer,
}: {
  account_id?: string;
  request_id: string;
  question: DecideQuestion;
  answer: string;
}): Promise<DecideResult> {
  if (!account_id) throw codedError("must be signed in", 401);
  // One snapshot for the whole call: the key that admitted it is the key
  // it uses, and removing the key refuses new calls before any reservation.
  const config = await decideConfig();
  if (!config) {
    throw codedError("Checking answers isn't available on this site.", 503);
  }
  return await boardDecide({
    accountId: account_id,
    requestId: request_id,
    question,
    answer,
    provider: openRouterDecideProvider({
      model: BOARD_DECIDE_MODEL,
      apiKey: async () => config.apiKey,
    }),
    funding: siteFundedDecideFunding({ model: BOARD_DECIDE_MODEL }),
  });
}
