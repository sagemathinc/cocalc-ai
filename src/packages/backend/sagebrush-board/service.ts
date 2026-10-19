/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The board decide service (conat/project/board-decide.ts), started wherever
// a project's files are served: on a project host (project-host/main.ts),
// and on the owning bay in the workspace runtime
// (server/conat/project/run.ts). A board is read here, by the server that
// has it, through the same sandboxed view of the project its file service
// uses, so its bytes stay on the data plane; only the bounded request goes
// back to the hub that asked (AGENTS.md: control plane and data plane).
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

/** What the service needs of a project's sandboxed filesystem
 * (backend/sandbox: SandboxedFilesystem). */
export interface BoardSandbox {
  realpath(path: string): Promise<string>;
  readRegularFileAuthorized(opts: {
    path: string;
    authorizeCanonicalIdentity: (identity: string) => void;
    maxBytes?: number;
    encoding?: string;
  }): Promise<string | Buffer>;
  close?(): void;
}

/** A project's board files through its sandbox: one opened handle, a
 * regular file only, at most maxBytes + 1 bytes read (EFBIG past that). The
 * caller was authorized as a collaborator by the hub; the sandbox keeps the
 * path inside the project. */
export function sandboxBoardFiles(sandbox: BoardSandbox): BoardFiles {
  return {
    realpath: async (path) => await sandbox.realpath(path),
    readBoard: async (path, maxBytes) => {
      try {
        return String(
          await sandbox.readRegularFileAuthorized({
            path,
            authorizeCanonicalIdentity: () => {},
            maxBytes,
            encoding: "utf8",
          }),
        );
      } catch (err) {
        if ((err as { code?: unknown })?.code === "EFBIG") {
          throw codedError("This board is too large to check answers on.", 413);
        }
        throw err;
      }
    },
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

export async function initBoardDecideService(
  client: Client,
  {
    projectFilesystem,
  }: {
    /** The sandboxed filesystem of a project this server serves, as its
     * file service has it (without provisioning anything). */
    projectFilesystem: (project_id: string) => Promise<BoardSandbox>;
  },
) {
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
      const sandbox = await projectFilesystem(project_id);
      try {
        return await handleBoardDecidePrepare(
          project_id,
          opts,
          sandboxBoardFiles(sandbox),
        );
      } finally {
        sandbox.close?.();
      }
    },
  });
}
