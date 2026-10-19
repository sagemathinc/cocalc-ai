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
  boardPostedName,
  boardTextDigest,
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
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string): Promise<string>;
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
  const resolved_path = await files.realpath(path);
  const { size } = await files.stat(resolved_path);
  if (!(size >= 0) || size > BOARD_FILE_LIMIT) {
    throw codedError("This board is too large to check answers on.", 413);
  }
  const text = await files.readFile(resolved_path);
  // The file can grow between stat and read: check what was read.
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
