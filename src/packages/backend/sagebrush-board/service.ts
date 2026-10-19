/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The board decide service (conat/project/board-decide.ts), started wherever
// a project's files are served: on a project host (project-host/main.ts),
// and on the owning bay in the workspace runtime
// (server/conat/project/workspace-filesystem.ts). A board is read here, by
// the server that has it, through the project's own file service, so its
// bytes stay on the data plane; only the bounded request goes back to the
// hub that asked (AGENTS.md: control plane and data plane).
//
// Its own bounds, for the server it runs on: at most
// MAX_IN_FLIGHT_PER_PROJECT reads in flight for one project, and
// MAX_IN_FLIGHT_TOTAL for all of them (each holds at most one board of
// BOARD_FILE_LIMIT in memory). The per-account and per-board limits, and the
// money, are the hubs' and the account's home bay's (board-decide-bound.ts,
// board-decide-funding.ts).

import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import { fsClient, fsSubject } from "@cocalc/conat/files/fs";
import {
  BOARD_DECIDE_SERVICE,
  type BoardDecidePrepareOptions,
  type BoardDecidePrepared,
} from "@cocalc/conat/project/board-decide";
import { prepareBoardDecideFromFiles, type BoardFiles } from "./prepare";

const logger = getLogger("backend:sagebrush-board:service");

export const BOARD_DECIDE_SUBJECT = `project.*.${BOARD_DECIDE_SERVICE}.-`;
export const MAX_IN_FLIGHT_PER_PROJECT = 4;
export const MAX_IN_FLIGHT_TOTAL = 32;

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

const inFlight = new Map<string, number>();
let inFlightTotal = 0;

/** For tests. */
export function boardDecideServiceInFlightForTests(): number {
  return inFlightTotal;
}

/** The project's files through its own file service (local to this
 * server: it serves them). */
function projectFiles(client: Client, project_id: string): BoardFiles {
  const fs = fsClient({ client, subject: fsSubject({ project_id }) });
  return {
    realpath: async (path) => await fs.realpath(path),
    stat: async (path) => await fs.stat(path),
    readFile: async (path) => String(await fs.readFile(path, "utf8")),
  };
}

export async function handleBoardDecidePrepare(
  project_id: string,
  opts: BoardDecidePrepareOptions,
  files: BoardFiles,
): Promise<BoardDecidePrepared> {
  const mine = inFlight.get(project_id) ?? 0;
  if (
    mine >= MAX_IN_FLIGHT_PER_PROJECT ||
    inFlightTotal >= MAX_IN_FLIGHT_TOTAL
  ) {
    throw codedError("Too many answers are being checked. Try again.", 503);
  }
  inFlight.set(project_id, mine + 1);
  inFlightTotal += 1;
  try {
    return await prepareBoardDecideFromFiles(files, {
      path: opts?.path,
      revision: opts?.revision,
      sha256: opts?.sha256,
      message: opts?.message,
    });
  } finally {
    inFlightTotal -= 1;
    const left = (inFlight.get(project_id) ?? 1) - 1;
    if (left > 0) inFlight.set(project_id, left);
    else inFlight.delete(project_id);
  }
}

export async function initBoardDecideService(client: Client) {
  logger.debug("starting board decide service", {
    subject: BOARD_DECIDE_SUBJECT,
  });
  return await client.service(BOARD_DECIDE_SUBJECT, {
    async prepare(
      this: { subject?: string } | undefined,
      opts: BoardDecidePrepareOptions,
    ) {
      const project_id = extractProjectSubject(`${this?.subject ?? ""}`);
      if (!project_id) throw codedError("Invalid request.", 400);
      return await handleBoardDecidePrepare(
        project_id,
        opts,
        projectFiles(client, project_id),
      );
    },
  });
}
