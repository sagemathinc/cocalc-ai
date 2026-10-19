/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sha256 } from "@noble/hashes/sha2";
import { v5 } from "uuid";

// What CoCalc's board card posts to a Sagebrush frame, computed the same
// way by the card and by the server that checks a board's decide request
// against it (web/board-host-protocol.md).

/** Whether a file is a Sagebrush board: its name ends in ".board.json", in
 * any case. The one rule for the card (which shows it live, with answers
 * and deciding) and the server (which decides on it). */
export function isBoardPath(path: string): boolean {
  return path.toLowerCase().endsWith(".board.json");
}

const BOARD_PATH_LIMIT = 4096;
const BOARD_REVISION_LIMIT = 200;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A board path spelled one way only: a board's name, no NUL, no empty,
 * "." or ".." components and no trailing slash (HARD-CAD-1), so a limiter
 * keyed by it, or by where the filesystem resolves it, has one bucket per
 * spelling. Checked by the hub and again by whoever serves the file. */
export function isPlainBoardPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > BOARD_PATH_LIMIT) return false;
  // The card's rule, any case: a board it shows live can be decided on.
  if (!isBoardPath(path) || path.includes("\0")) return false;
  const parts = (path.startsWith("/") ? path.slice(1) : path).split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** A board decide call's revision (the card's label) and SHA-256 (of the
 * text it posted), as the hub and the file's server both require them. */
export function isBoardDecideBinding(
  revision: unknown,
  sha256: unknown,
): boolean {
  return (
    (revision === null ||
      (typeof revision === "string" &&
        revision.length <= BOARD_REVISION_LIMIT)) &&
    typeof sha256 === "string" &&
    SHA256_HEX.test(sha256)
  );
}

/** The board's name in the card's `board` message: the file's basename. */
export function boardPostedName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The SHA-256 (lowercase hex) of the UTF-8 text the card posted, so the
 * server can tell whether the file is still exactly that board. With
 * crypto.subtle where there is one; on a plain-http site (cocalc-star on a
 * LAN) there isn't, and @noble/hashes' audited SHA-256 gives the same
 * bytes. The digest binds the board text the server checks a decide
 * request against (integrity, not a secret). */
export async function boardTextDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle
    ? new Uint8Array(await subtle.digest("SHA-256", bytes))
    : sha256(bytes);
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** UUID version 5 (SHA-1, RFC 9562) of `name` in `namespace`: the uuid
 * package's, whose browser build hashes in plain JavaScript, so it works
 * without crypto.subtle (a plain-http site). */
export function uuidV5(name: string, namespace: string): string {
  return v5(name, namespace);
}
