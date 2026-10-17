/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush's reading of a board's decide request (web/board-host-protocol.md,
// "Deciding"): the question's prompt and options come from the posted board,
// never from the message; only the reader's words do. It comes from
// @sagemathinc/sagebrush-board/submission, pinned exactly with the
// `sagebrush` command line of the same release.
//
// Until that package is published, this module refuses every request, so
// nothing is classified unchecked. The types are Sagebrush's (web/board/
// ask.ts, branch board-ask-decide 34a8658c).

export interface Posted {
  text: string;
  name?: string | null;
  revision?: string | null;
}

export interface DecideRequest {
  id: string;
  name: string | null;
  revision: string | null;
  page: { number: number; id?: string; title?: string };
  item: string;
  /** the question, from the posted board: its title and text */
  prompt: string;
  /** from the posted board */
  options: { name: string; about?: string }[];
  /** the reader's own words, the one thing from the frame */
  answer: string;
}

export type Deciding =
  | { ok: true; request: DecideRequest }
  | { ok: false; id?: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decideRequest(_posted: Posted, m: unknown): Deciding {
  const id = (m as { id?: unknown } | null)?.id;
  return {
    ok: false,
    ...(typeof id === "string" && UUID.test(id) ? { id } : {}),
    message: "Answers can't be checked on this CoCalc yet.",
  };
}
