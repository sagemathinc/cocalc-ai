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
