/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What the hub told this host about computers, in the host's database so
// every process sees it: the master writes (the hub's dropComputer call and
// the 15 s status sync), and each conat router process checks it on every
// computer socket. See ../computers.ts.

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";

function ensureTables() {
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS computer_drops (
      computer_id TEXT PRIMARY KEY,
      until_ms INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS computer_access_meta (
      k TEXT PRIMARY KEY,
      v TEXT
    )
  `);
}

/** Refuse this computer until until_ms (and forget older drops). */
export function recordComputerDrop(
  computer_id: string,
  until_ms: number,
  now = Date.now(),
): void {
  if (!isValidUUID(computer_id)) throw new Error("invalid computer_id");
  ensureTables();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO computer_drops(computer_id, until_ms) VALUES(?, ?)
     ON CONFLICT(computer_id) DO UPDATE SET
       until_ms=MAX(computer_drops.until_ms, excluded.until_ms)`,
  ).run(computer_id, Math.floor(until_ms));
  db.prepare(`DELETE FROM computer_drops WHERE until_ms <= ?`).run(now);
}

export function isComputerDroppedInDb(
  computer_id: string,
  now = Date.now(),
): boolean {
  if (!isValidUUID(computer_id)) return true;
  ensureTables();
  const row = getDatabase()
    .prepare(`SELECT until_ms FROM computer_drops WHERE computer_id=? LIMIT 1`)
    .get(computer_id) as { until_ms?: number } | undefined;
  return row?.until_ms != null && Number(row.until_ms) > now;
}

/** The site's computers switch, as last heard from the hub. */
export function setComputersEnabledOnHost(enabled: boolean): void {
  ensureTables();
  getDatabase()
    .prepare(
      `INSERT INTO computer_access_meta(k, v) VALUES('enabled', ?)
       ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
    )
    .run(enabled ? "1" : "0");
}

/** Off until the hub has said it is on (fail closed). */
export function computersEnabledOnHost(): boolean {
  ensureTables();
  const row = getDatabase()
    .prepare(`SELECT v FROM computer_access_meta WHERE k='enabled' LIMIT 1`)
    .get() as { v?: string } | undefined;
  return row?.v === "1";
}

export function resetComputerAccessForTesting(): void {
  ensureTables();
  const db = getDatabase();
  db.exec(`DELETE FROM computer_drops`);
  db.exec(`DELETE FROM computer_access_meta`);
}
