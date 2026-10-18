/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The card's side of a board's decide request: the hub's system.boardDecide
// with the board this card posted on the channel (its file, its revision
// and the SHA-256 of the text it posted) and the frame's message. The hub
// reads the board itself and refuses unless it is exactly that text.
// Errors are shown in CoCalc's own words, by code, never as they came.

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { boardTextDigest } from "@cocalc/util/sagebrush-board";
import {
  BoardAnswersRefusal,
  type DecideOnBoard,
} from "./board-answers-channel";

// Every deliberate refusal of system.boardDecide has its own words; only an
// unexpected failure (502 from the model, or none) invites a retry.
const REFUSALS: Record<number, string> = {
  400: "This answer can't be checked.",
  401: "Sign in to check answers.",
  // The reader's AI allowance, or the site's, is used up for now: trying
  // again won't help until it renews.
  403: "The AI allowance for checking answers is used up for now, so this answer can't be checked.",
  404: "Your account can't check answers right now.",
  409: "The board changed: reload it.",
  413: "This board is too large to check answers on.",
  // One already being checked on this board, or too many in the last
  // minute or hour.
  429: "Too many answers are being checked. Try later.",
  503: "Checking answers isn't available right now. Try later.",
};

export type BoardDecideCall = (opts: {
  project_id: string;
  path: string;
  revision: string | null;
  sha256: string;
  message: unknown;
  timeout: number;
}) => Promise<{ id: string; option: string | null }>;

const hubBoardDecide: BoardDecideCall = async (opts) =>
  await webapp_client.conat_client.hub.system.boardDecide(opts as any);

export function boardDecider({
  project_id,
  path,
  revision,
  text,
  call = hubBoardDecide,
}: {
  project_id: string;
  path: string;
  /** The revision this card posted on the channel. */
  revision: string | null;
  /** The text this card posted on the channel. */
  text: string;
  call?: BoardDecideCall;
}): DecideOnBoard {
  // Its SHA-256, once, when first asked (crypto.subtle needs a secure
  // context; without one, deciding is refused and the board still shows).
  let digest: Promise<string> | undefined;
  return async (message) => {
    const id = (message as { id?: unknown })?.id;
    let sha256: string;
    try {
      sha256 = await (digest ??= boardTextDigest(text));
    } catch {
      digest = undefined;
      throw new BoardAnswersRefusal(
        "This browser can't check answers here. Try again over https.",
      );
    }
    let result: { id: string; option: string | null };
    try {
      result = await call({
        project_id,
        path,
        revision,
        sha256,
        message,
        timeout: 45_000,
      });
    } catch (err) {
      const code = Number((err as { code?: unknown })?.code);
      throw new BoardAnswersRefusal(
        REFUSALS[code] ?? "CoCalc could not check your answer. Try again.",
      );
    }
    if (result?.id !== id) throw new Error("answer for another request");
    return result.option ?? null;
  };
}
