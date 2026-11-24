/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The last pressure policy the bay gave this host, kept across restarts so a
// restart never loses it. One row; written only after a reply passed every
// check (see ../pressure-policy.ts).

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";

export type PressurePolicyReason = "private_host" | "shared_pool";

export interface StoredPressurePolicy {
  host_id: string;
  watch_only: boolean;
  reason: PressurePolicyReason;
  evaluated_at_ms: number;
  fetched_at_ms: number;
}

const KEY = "policy";

function ensureTable() {
  initDatabase().exec(`
    CREATE TABLE IF NOT EXISTS host_pressure_policy (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    )
  `);
}

// A stored value is used only when it has exactly the shape a checked reply
// produces; anything else counts as no stored policy.
export function isStoredPressurePolicy(
  value: unknown,
): value is StoredPressurePolicy {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.host_id === "string" &&
    v.host_id.length > 0 &&
    typeof v.watch_only === "boolean" &&
    ((v.watch_only === true && v.reason === "private_host") ||
      (v.watch_only === false && v.reason === "shared_pool")) &&
    typeof v.evaluated_at_ms === "number" &&
    Number.isFinite(v.evaluated_at_ms) &&
    typeof v.fetched_at_ms === "number" &&
    Number.isFinite(v.fetched_at_ms)
  );
}

export function loadStoredPressurePolicy(): StoredPressurePolicy | undefined {
  ensureTable();
  const row = getDatabase()
    .prepare("SELECT v FROM host_pressure_policy WHERE k=?")
    .get(KEY) as { v?: string } | undefined;
  if (typeof row?.v !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.v);
  } catch {
    return undefined;
  }
  return isStoredPressurePolicy(parsed) ? parsed : undefined;
}

export function saveStoredPressurePolicy(policy: StoredPressurePolicy): void {
  if (!isStoredPressurePolicy(policy)) {
    throw new Error("refusing to store a malformed pressure policy");
  }
  ensureTable();
  getDatabase()
    .prepare(
      `INSERT INTO host_pressure_policy (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
    )
    .run(KEY, JSON.stringify(policy));
}
