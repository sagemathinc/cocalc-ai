/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush's check of a board submission (web/board-host-protocol.md,
// "Checking a submission"), so that every host checks the same way. It comes
// from @sagemathinc/sagebrush-board/submission, pinned exactly with the
// `sagebrush` command line of the same release.
//
// Until that package is published, this module refuses every submission:
// boards are shown, but nothing a user submits reaches an agent unchecked.
// The types are Sagebrush's (web/board/ask.ts at board-ask-items 175a74bf).

/** The board posted on one channel. Keep one object per channel: the
 * parsed board is cached per object. */
export interface Posted {
  text: string;
  name?: string | null;
  revision?: string | null;
}

export type AskAnswer = string | number | boolean | Array<string | number>;

/** A submission as the check returns it: only these fields. */
export interface Submission {
  id: string;
  name: string | null;
  revision: string | null;
  page: { number: number; id?: string; title?: string };
  answers: Record<string, AskAnswer>;
  notes: Record<string, string>;
  comment: string;
}

export type Checked =
  | { ok: true; submission: Submission }
  | { ok: false; id?: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkSubmission(_posted: Posted, m: unknown): Checked {
  const id =
    m != null &&
    typeof m === "object" &&
    typeof (m as { id?: unknown }).id === "string" &&
    UUID.test((m as { id: string }).id)
      ? (m as { id: string }).id
      : undefined;
  return {
    ok: false,
    ...(id ? { id } : {}),
    message: "Board answers can't be sent from this CoCalc yet.",
  };
}
