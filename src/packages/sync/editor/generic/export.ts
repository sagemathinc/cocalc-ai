/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { decodePatchId, type PatchEnvelope } from "patchflow";

export interface HistoryEntry {
  time_utc: Date;
  account_id: string;
  patch?: any[];
  patch_length?: number;
}

export interface HistoryExportOptions {
  patches?: boolean;
  patch_lengths?: boolean; // length of each patch (some measure of amount changed)
}

function patchTimeMs(x: PatchEnvelope): number {
  if (typeof x.wall === "number" && Number.isFinite(x.wall)) {
    return x.wall;
  }

  const t = x.time;
  if (typeof t === "number" && Number.isFinite(t)) {
    return t;
  }
  if (typeof t === "string" && t.length > 0) {
    try {
      const { timeMs } = decodePatchId(t);
      if (Number.isFinite(timeMs)) {
        return timeMs;
      }
    } catch {
      // ignore decode error; legacy/invalid ids are handled below
    }
    const numeric = Number(t);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  // Keep export deterministic and JSON-safe even for malformed legacy data.
  return 0;
}

export function export_history(
  account_ids: string[],
  patches: PatchEnvelope[],
  options: HistoryExportOptions,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const x of patches) {
    const time_utc = new Date(patchTimeMs(x));
    let account_id = account_ids[x.userId ?? 0];
    if (account_id == null) {
      account_id = "unknown"; // should never happen...
    }
    const entry: HistoryEntry = { time_utc, account_id };
    if (options.patches) {
      entry.patch = x.patch as any[];
    }
    if (options.patch_lengths) {
      entry.patch_length = JSON.stringify(x.patch ?? []).length;
    }
    entries.push(entry);
  }
  return entries;
}
