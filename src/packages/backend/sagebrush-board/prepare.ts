/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A board decide request's board side (conat/project/board-decide.ts), run
// where the project's files are served: the board is read there, checked to
// be exactly the text the card posted (its SHA-256), and Sagebrush's
// decideRequest takes the question, its options and the reader's words from
// it. Only that bounded request leaves; the board's text never does. The
// question and options always come from the file, never from the caller.

import {
  BOARD_DECIDE_REQUEST_LIMITS,
  boardPostedName,
  boardTextDigest,
  canonicalBoardKey,
  isBoardDecideBinding,
  isPlainBoardPath,
} from "@cocalc/util/sagebrush-board";
import type {
  BoardDecidePrepareOptions,
  BoardDecidePrepared,
} from "@cocalc/conat/project/board-decide";
import { decideRequest } from "./decide-request";

/** The most a board file may be to be read (as the card's preview). */
export const BOARD_FILE_LIMIT = 16 * 1024 * 1024;

/** The project's files, as the file server sees them. */
export interface BoardFiles {
  realpath(path: string): Promise<string>;
  /** The regular file at `path` as UTF-8, reading at most maxBytes + 1
   * bytes of it from one opened handle: one larger is refused (413), never
   * read whole (daybreak2, LIMITS-R6-1). */
  readBoard(path: string, maxBytes: number): Promise<string>;
}

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

export async function prepareBoardDecideFromFiles(
  files: BoardFiles,
  { path, revision, sha256, message }: BoardDecidePrepareOptions,
): Promise<BoardDecidePrepared> {
  // The hub checked these; whoever serves the file checks them again.
  if (!isPlainBoardPath(path) || !isBoardDecideBinding(revision, sha256)) {
    throw codedError("Invalid request.", 400);
  }
  const real = await files.realpath(path);
  // One key per file, however it was named: the realpath's HOME alias
  // (`/home/user/x`) and its project-relative form (`x`) are the same
  // board for every per-board limit (Codex on #1134).
  const resolved_path = canonicalBoardKey(real);
  if (resolved_path == null) throw codedError("Invalid request.", 400);
  const text = await files.readBoard(real, BOARD_FILE_LIMIT);
  // What was read can't be more than the limit (the read stops there);
  // checked again here all the same.
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
  const { id, prompt, options, answer } = deciding.request;
  // Bounded before anything leaves (astra, CORR-E3B-1): a board may ask a
  // question longer than the model is sent; that one isn't checked here.
  const L = BOARD_DECIDE_REQUEST_LIMITS;
  if (
    typeof prompt !== "string" ||
    prompt.length > L.prompt ||
    typeof answer !== "string" ||
    answer.length > L.answer ||
    !Array.isArray(options) ||
    options.length > L.options ||
    !options.every(
      (o) =>
        typeof o?.name === "string" &&
        o.name.length <= L.optionName &&
        (o.about === undefined ||
          (typeof o.about === "string" && o.about.length <= L.optionAbout)),
    )
  ) {
    throw codedError("This question can't be checked.", 400);
  }
  // Only these fields: nothing else of the board goes back.
  return {
    resolved_path,
    request: {
      id,
      prompt,
      options: options.map(({ name, about }) =>
        about === undefined ? { name } : { name, about },
      ),
      answer,
    },
  };
}
