/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A board decide request's board side, where the project's files are
// served (a project host, or the owning bay in the workspace runtime): read
// the board, check it is exactly the text the card posted, and take the
// question, its options and the reader's words from it. Only that bounded
// request comes back; the board itself never leaves the file's server
// (AGENTS.md: control plane and data plane; Codex on #1134).

import { projectSubject } from "@cocalc/conat/names";
import type { Client as ConatClient } from "@cocalc/conat/core/client";

export const BOARD_DECIDE_SERVICE = "board-decide";
/** The file server's own deadline for one board (its read and check). */
export const BOARD_DECIDE_PREPARE_TIMEOUT_MS = 30_000;

/** What a decide call sends the home bay: from the board, except the
 * reader's words (answer), which are the frame message's. */
export interface BoardDecidePrepared {
  /** Where the filesystem resolves the board's path (the limiter's key). */
  resolved_path: string;
  request: {
    id: string;
    prompt: string;
    options: { name: string; about?: string }[];
    answer: string;
  };
}

export interface BoardDecidePrepareOptions {
  path: string;
  /** The card's revision for the board it posted on this channel. */
  revision: string | null;
  /** The SHA-256 of the text the card posted on this channel. */
  sha256: string;
  /** The frame's `decide` message. */
  message: unknown;
}

interface Api {
  prepare(opts: BoardDecidePrepareOptions): Promise<BoardDecidePrepared>;
}

export function boardDecideSubject({
  project_id,
}: {
  project_id: string;
}): string {
  return projectSubject({ project_id, service: BOARD_DECIDE_SERVICE });
}

export async function prepareBoardDecide({
  client,
  project_id,
  ...opts
}: BoardDecidePrepareOptions & {
  client: ConatClient;
  project_id: string;
}): Promise<BoardDecidePrepared> {
  return await client
    .call<Api>(boardDecideSubject({ project_id }), {
      timeout: BOARD_DECIDE_PREPARE_TIMEOUT_MS,
    })
    .prepare(opts);
}
