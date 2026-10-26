/*
What an open copy of a document does when its history is reset under it
(bounded history plan H1b-2, r3): the decisions, kept apart from SyncDoc so
they can be tested on their own.  SyncDoc never reconstructs anything from
the old history here; it either reloads (everything it had is provably in
the new history) or first saves its current value to a recovery copy.
*/

import {
  jsonLinesLengthCapped,
  utf8LengthCapped,
} from "@cocalc/util/json-size";
import type { InclusionStatus } from "@cocalc/conat/persist/storage";

// The transition's admission bounds (LIMIT-H1B-2): pending patches, their
// bytes, and the document value.
export const TRANSITION_MAX_PENDING = 1000;
export const TRANSITION_MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const TRANSITION_MAX_VALUE_BYTES = 32 * 1024 * 1024;

// The UTF-8 size of what doc.to_str() writes, measured without building it,
// or undefined if it is over max (or cannot be measured exactly).
export function valueBytesCapped(doc: any, max: number): number | undefined {
  if (doc == null) return 0;
  if (
    doc.records != null &&
    typeof doc.records[Symbol.iterator] === "function"
  ) {
    // a db document: JSON lines, one per record
    return jsonLinesLengthCapped(doc.records, { max });
  }
  if (typeof doc.to_str === "function") {
    // a string document stores its value: to_str() copies nothing
    const value = doc.to_str();
    if (typeof value === "string") return utf8LengthCapped(value, max);
  }
  return undefined;
}

// A name for a recovery copy beside path, unique across tabs and processes:
// the time, this client's id and 8 random characters.
export function recoveryCopyName(
  path: string,
  {
    clientId,
    now = new Date(),
    random = randomChars(8),
  }: {
    clientId: string;
    now?: Date;
    random?: string;
  },
): string {
  const pad = (n: number) => `${n}`.padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const id =
    `${clientId}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "client";
  return `${path}.unsaved-${stamp}-${id}${random}`;
}

function randomChars(n: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

// After the inclusion query: drop everything and reload only if every
// pending patch is proven included and nothing else is unsaved (no draft,
// no edits made since the transition began).  Anything else -- an id that
// is absent, excluded or unknown, a missing answer -- means saving the
// current value to a copy first (astra's condition 1).
export function canDropAll({
  ids,
  statuses,
  hasDraft,
  hasLaterEdits,
}: {
  ids: string[];
  statuses?: { [id: string]: { status: InclusionStatus } };
  hasDraft: boolean;
  hasLaterEdits: boolean;
}): boolean {
  if (hasDraft || hasLaterEdits) return false;
  if (ids.length == 0) return true;
  if (statuses == null) return false;
  return ids.every((id) => statuses[id]?.status === "included");
}
