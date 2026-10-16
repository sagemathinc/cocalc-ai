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

/** Whether this site checks board answers (the switch and a key). */
export async function boardDecideEnabled(): Promise<boolean> {
  const settings: any = await getServerSettings();
  return (
    settings.board_decide_enabled === true &&
    typeof settings.openrouter_api_key === "string" &&
    settings.openrouter_api_key.trim() !== ""
  );
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
  if (!(await boardDecideEnabled())) {
    throw codedError("Checking answers isn't available on this site.", 503);
  }
  return await boardDecide({
    accountId: account_id,
    requestId: request_id,
    question,
    answer,
    provider: openRouterDecideProvider({
      model: BOARD_DECIDE_MODEL,
      // Read at the call, so a changed key applies at once; never logged.
      apiKey: async () => {
        const key = ((await getServerSettings()) as any).openrouter_api_key;
        return typeof key === "string" && key.trim() ? key.trim() : undefined;
      },
    }),
    funding: siteFundedDecideFunding({ model: BOARD_DECIDE_MODEL }),
  });
}
