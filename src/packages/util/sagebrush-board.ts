/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What CoCalc's board card posts to a Sagebrush frame, computed the same
// way by the card and by the server that checks a board's decide request
// against it (web/board-host-protocol.md).

/** The board's name in the card's `board` message: the file's basename. */
export function boardPostedName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The SHA-256 (lowercase hex) of the UTF-8 text the card posted, so the
 * server can tell whether the file is still exactly that board. */
export async function boardTextDigest(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
