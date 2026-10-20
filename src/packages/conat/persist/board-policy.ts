/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Who may change a Sagebrush board's live document.

A board's syncdb (.foo.board.json.sage-board) is written only by its project
host's board manager, which admits and bounds every edit. Browsers, agents and
every other client of the ordinary persist service may only read board streams.
The manager writes through a separate persist service, BOARD_WRITE_SERVICE,
whose only subject is `${BOARD_WRITE_SERVICE}.hub`: only hub and system
principals are admitted to it, so its authority comes from the broker's
authentication of the connection, never from anything a client sends.

Board streams are recognized by their storage path,

    projects/<project_id>/patchflow/<absolute path>.sage-board

which must be canonical (exactly what storagePath() builds from a normalized
absolute path), so a stream has one name. Names are kept byte for byte: no
Unicode normalization, since distinct Linux names are distinct boards.
*/

import { posix } from "node:path";
import { isValidUUID } from "@cocalc/util/misc";

// The service names and limits live in board-constants.ts, which has no Node
// imports, so browser code (e.g. the load balancer) can use them.
export {
  BOARD_WRITE_CONTROL_RECEIVE_LIMITS,
  BOARD_WRITE_RECEIVE_LIMITS,
  BOARD_WRITE_SERVICE,
  BOARD_WRITE_USER,
} from "./board-constants";
import { BOARD_WRITE_SERVICE, BOARD_WRITE_USER } from "./board-constants";

const BOARD_STREAM_SUFFIX = ".sage-board";
const PATCHFLOW_SEGMENT = "patchflow";

// Commands a client of the ordinary persist service may send for a board
// stream. Everything else (set, setMany, delete, config changes, metadata
// writes, resetHistory, checkpoint writes, sqlite, and any command added
// later) is refused.
const BOARD_READ_COMMANDS = new Set([
  "get",
  "getAll",
  "changefeed",
  "keys",
  "serverId",
  "inventory",
  "checkpoints",
  "metadata",
]);

export type BoardStreamClass =
  | { board: false }
  | { board: true; canonical: boolean };

// Is this storage path a board's stream, and is it written canonically?
export function classifyStreamPath(path: unknown): BoardStreamClass {
  if (typeof path != "string") return { board: false };
  const parts = path.split("/");
  if (
    parts[0] !== "projects" ||
    parts[2] !== PATCHFLOW_SEGMENT ||
    !path.endsWith(BOARD_STREAM_SUFFIX)
  ) {
    return { board: false };
  }
  return { board: true, canonical: isCanonicalBoardPath(path, parts) };
}

function isCanonicalBoardPath(path: string, parts: string[]): boolean {
  if (!isValidUUID(parts[1])) return false;
  const prefix = `projects/${parts[1]}/${PATCHFLOW_SEGMENT}/`;
  const rest = path.slice(prefix.length);
  // The document path, made absolute as storagePath's posix.join leaves it.
  const abs = `/${rest}`;
  if (rest.length === 0 || posix.normalize(abs) !== abs) return false;
  if (abs.endsWith("/") || /\/\.\.?(\/|$)/.test(abs)) return false;
  // Control characters and invalid UTF-16 (lone surrogates) are refused.
  if (/[\u0000-\u001f\u007f]/.test(rest)) return false;
  if (!isWellFormed(rest)) return false;
  return true;
}

function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export class BoardStreamPolicyError extends Error {
  code: number;
  constructor(message: string, code = 403) {
    super(message);
    this.code = code;
  }
}

export interface BoardStreamAccess {
  board: boolean;
  // Only reads are allowed on this socket.
  readOnly: boolean;
  // For a board stream: the storage options it is opened with, built here
  // from its path alone (durable, server defaults for everything else). The
  // client's options are never used for a board stream, so no client (the
  // first opener in particular) chooses how the host's writes are stored.
  storage?: { path: string };
}

// Decide, when a persist socket names its stream, what it may do, and for a
// board stream with what storage options. Throws for a socket that must not
// open the stream at all.
export function boardStreamAccess({
  service,
  subject,
  storage,
}: {
  service: string;
  subject: string;
  storage: { path?: unknown; ephemeral?: unknown } | undefined;
}): BoardStreamAccess {
  const cls = classifyStreamPath(storage?.path);
  const writeService = service === BOARD_WRITE_SERVICE;
  if (writeService) {
    if (subject.split(".")[1] !== BOARD_WRITE_USER) {
      throw new BoardStreamPolicyError(
        "the board write service serves only the host",
      );
    }
    if (!cls.board) {
      throw new BoardStreamPolicyError(
        "the board write service serves only board streams",
      );
    }
  }
  if (!cls.board) return { board: false, readOnly: false };
  if (!cls.canonical) {
    throw new BoardStreamPolicyError("not a canonical board stream path", 400);
  }
  return {
    board: true,
    readOnly: !writeService,
    storage: { path: storage!.path as string },
  };
}

// Refuse a command a read-only board socket may not send.
export function assertBoardCommandAllowed(
  access: BoardStreamAccess,
  request: { cmd?: unknown; config?: unknown },
): void {
  if (!access.readOnly) return;
  const cmd = `${request?.cmd ?? ""}`;
  if (BOARD_READ_COMMANDS.has(cmd)) return;
  // Reading the configuration is a read; changing it is not.
  if (cmd === "config" && request?.config == null) return;
  throw new BoardStreamPolicyError(
    `board streams are read-only here (${cmd || "unknown command"})`,
  );
}
