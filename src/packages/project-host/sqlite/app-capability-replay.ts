/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Single use of app capabilities (content-app-origin.ts): each capability id
// is recorded until it expires, in host sqlite, so every process of the host
// sees it and a restart doesn't forget it.

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";

let ready = false;
let lastPurgeMs = 0;
const PURGE_INTERVAL_MS = 60_000;

function ensureTable() {
  if (ready) return;
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_capability_used (
      jti TEXT PRIMARY KEY,
      exp_ms INTEGER NOT NULL
    )
  `);
  ready = true;
}

// True the first time jti is seen (until exp_ms), false after.
export function consumeAppCapability({
  jti,
  exp_ms,
  now_ms = Date.now(),
}: {
  jti: string;
  exp_ms: number;
  now_ms?: number;
}): boolean {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(jti)) return false;
  ensureTable();
  const db = getDatabase();
  if (now_ms - lastPurgeMs >= PURGE_INTERVAL_MS) {
    lastPurgeMs = now_ms;
    db.prepare(`DELETE FROM app_capability_used WHERE exp_ms < ?`).run(now_ms);
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO app_capability_used (jti, exp_ms) VALUES (?, ?)`,
    )
    .run(jti, Math.floor(exp_ms));
  return result.changes === 1;
}
