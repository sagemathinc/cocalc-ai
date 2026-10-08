/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";

// Upper bound for one pasted batch; each address is one seat assignment call.
export const MAX_SEAT_EMAIL_BATCH = 500;

export interface SeatEmailListPlan {
  /** Normalized, deduplicated addresses that will be assigned, in order. */
  toAssign: string[];
  /** Tokens that are not valid email addresses (as typed). */
  invalid: string[];
  /** Addresses that appeared more than once in the pasted text. */
  duplicates: string[];
  /** Addresses that already have an active seat in this package. */
  alreadyAssigned: string[];
  /** Valid new addresses that do not fit in the remaining seats. */
  overCapacity: string[];
}

/**
 * Parse a pasted list of email addresses (from a spreadsheet column, a
 * comma-separated list or "Name <address>" entries) into a seat assignment
 * plan for a package with `availableSeats` free seats.
 */
export function planSeatEmailList({
  text,
  alreadyAssigned,
  availableSeats,
}: {
  text: string;
  alreadyAssigned: ReadonlySet<string>;
  availableSeats: number;
}): SeatEmailListPlan {
  const plan: SeatEmailListPlan = {
    toAssign: [],
    invalid: [],
    duplicates: [],
    alreadyAssigned: [],
    overCapacity: [],
  };
  const seen = new Set<string>();
  const capacity = Math.max(
    0,
    Math.min(Math.floor(availableSeats), MAX_SEAT_EMAIL_BATCH),
  );
  const consider = (email: string) => {
    if (seen.has(email)) {
      if (!plan.duplicates.includes(email)) plan.duplicates.push(email);
      return;
    }
    seen.add(email);
    if (alreadyAssigned.has(email)) {
      plan.alreadyAssigned.push(email);
    } else if (plan.toAssign.length < capacity) {
      plan.toAssign.push(email);
    } else {
      plan.overCapacity.push(email);
    }
  };
  // One entry per line, comma or semicolon. Within an entry, words without
  // "@" are treated as a name (e.g. `Ada Lovelace <ada@x.edu>` or a name
  // column copied from a spreadsheet); an entry with no "@" is invalid.
  for (const rawEntry of text.split(/[\n\r,;]+/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const tokens = entry
      .split(/\s+/)
      .map((t) =>
        t
          .replace(/^["'(<]+|["')>]+$/g, "")
          .replace(/^mailto:/i, "")
          .trim(),
      )
      .filter((t) => t.includes("@"));
    if (tokens.length === 0) {
      plan.invalid.push(entry);
      continue;
    }
    for (const token of tokens) {
      const email = token.toLowerCase();
      if (isValidEmailAddress(email)) {
        consider(email);
      } else {
        plan.invalid.push(token);
      }
    }
  }
  return plan;
}
