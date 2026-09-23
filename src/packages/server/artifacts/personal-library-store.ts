/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  PersonalLibraryApi,
  PersonalLibrarySnapshot,
} from "@cocalc/conat/hub/api/personal-library";
import {
  PERSONAL_LIBRARY_MAX_PIN_BYTES,
  PERSONAL_LIBRARY_MAX_PINS,
  movePersonalLibraryPin,
  normalizePersonalLibraryName,
  validatePersonalLibraryPinKey,
  validatePersonalLibraryTarget,
} from "@cocalc/util/personal-library";
import { assertPersonalAccountAuthority } from "@cocalc/server/agents/personal-rehome";

type Query = {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};

async function snapshot(
  db: Query,
  account: string,
): Promise<PersonalLibrarySnapshot> {
  const aliases = (
    await db.query(
      "SELECT name,project_id,entry_id,active FROM personal_library_aliases WHERE account_id=$1 ORDER BY name",
      [account],
    )
  ).rows;
  const pins = (
    await db.query(
      "SELECT pin_key FROM personal_library_pins WHERE account_id=$1 ORDER BY rank,pin_key",
      [account],
    )
  ).rows.map((row) => row.pin_key as string);
  return { aliases, pins };
}

async function locked<T>(
  account: string,
  fn: (db: Query) => Promise<T>,
): Promise<T> {
  requireUuid(account, "account_id");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertPersonalAccountAuthority(client, account);
    const admission = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
      [`personal-library:${account}`],
    );
    if (!admission.rows[0].acquired)
      throw Error("Personal library is busy; retry the change");
    await client.query(
      "INSERT INTO personal_library_controls(account_id) VALUES($1) ON CONFLICT DO NOTHING",
      [account],
    );
    await client.query(
      "SELECT account_id FROM personal_library_controls WHERE account_id=$1 FOR UPDATE",
      [account],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function replacePins(
  db: Query,
  account: string,
  pins: string[],
): Promise<void> {
  await db.query(
    `UPDATE personal_library_pins AS pins SET rank=ordered.rank - 1
     FROM unnest($2::text[]) WITH ORDINALITY AS ordered(pin_key,rank)
     WHERE pins.account_id=$1 AND pins.pin_key=ordered.pin_key
       AND pins.rank IS DISTINCT FROM ordered.rank - 1`,
    [account, pins],
  );
}

export const personalLibraryStore: PersonalLibraryApi = {
  async list(opts) {
    const account = opts.account_id;
    requireUuid(account, "account_id");
    await assertPersonalAccountAuthority(getPool(), account);
    return snapshot(getPool(), account);
  },
  async resolve(opts) {
    const account = opts.account_id;
    requireUuid(account, "account_id");
    const name = normalizePersonalLibraryName(opts.name);
    await assertPersonalAccountAuthority(getPool(), account);
    return (
      (
        await getPool().query(
          "SELECT name,project_id,entry_id,active FROM personal_library_aliases WHERE account_id=$1 AND name=$2",
          [account, name],
        )
      ).rows[0] ?? null
    );
  },
  async name(opts) {
    const account = opts.account_id;
    requireUuid(account, "account_id");
    validatePersonalLibraryTarget(opts);
    const name = normalizePersonalLibraryName(opts.name);
    return locked(account, async (db) => {
      const existing = (
        await db.query(
          "SELECT project_id,entry_id FROM personal_library_aliases WHERE account_id=$1 AND name=$2",
          [account, name],
        )
      ).rows[0];
      if (
        existing &&
        (existing.project_id !== opts.project_id ||
          existing.entry_id !== opts.entry_id)
      )
        throw Error(`@${name} is already used by another artifact`);
      const count = (
        await db.query(
          "SELECT count(*)::integer AS n FROM personal_library_aliases WHERE account_id=$1",
          [account],
        )
      ).rows[0].n;
      if (!existing && count >= 1000)
        throw Error("Artifact name limit reached");
      await db.query(
        "UPDATE personal_library_aliases SET active=FALSE WHERE account_id=$1 AND project_id=$2 AND entry_id=$3 AND active",
        [account, opts.project_id, opts.entry_id],
      );
      await db.query(
        `INSERT INTO personal_library_aliases(account_id,name,project_id,entry_id,active)
         VALUES($1,$2,$3,$4,TRUE)
         ON CONFLICT(account_id,name) DO UPDATE SET active=TRUE`,
        [account, name, opts.project_id, opts.entry_id],
      );
      return snapshot(db, account);
    });
  },
  async setPinned(opts) {
    const account = opts.account_id;
    requireUuid(account, "account_id");
    const key = validatePersonalLibraryPinKey(opts.pin_key);
    if (typeof opts.pinned !== "boolean") throw Error("Invalid pin state");
    return locked(account, async (db) => {
      const pins = (await snapshot(db, account)).pins;
      if (opts.pinned && !pins.includes(key)) {
        if (
          pins.length >= PERSONAL_LIBRARY_MAX_PINS ||
          Buffer.byteLength(key) +
            pins.reduce((bytes, pin) => bytes + Buffer.byteLength(pin), 0) >
            PERSONAL_LIBRARY_MAX_PIN_BYTES
        )
          throw Error("Artifact pin limit reached");
        await db.query(
          `INSERT INTO personal_library_pins(account_id,pin_key,rank)
           SELECT $1,$2,COALESCE(MAX(rank),-1)+1 FROM personal_library_pins WHERE account_id=$1
           ON CONFLICT(account_id,pin_key) DO NOTHING`,
          [account, key],
        );
      } else if (!opts.pinned) {
        await db.query(
          "DELETE FROM personal_library_pins WHERE account_id=$1 AND pin_key=$2",
          [account, key],
        );
      }
      return snapshot(db, account);
    });
  },
  async movePinned(opts) {
    const account = opts.account_id;
    requireUuid(account, "account_id");
    const key = validatePersonalLibraryPinKey(opts.pin_key);
    if (
      !Array.isArray(opts.visible) ||
      opts.visible.length > PERSONAL_LIBRARY_MAX_PINS ||
      !Number.isInteger(opts.index)
    )
      throw Error("Invalid pin order");
    const visible = opts.visible.map(validatePersonalLibraryPinKey);
    if (
      visible.reduce((bytes, pin) => bytes + Buffer.byteLength(pin), 0) >
      PERSONAL_LIBRARY_MAX_PIN_BYTES
    )
      throw Error("Invalid pin order");
    return locked(account, async (db) => {
      const pins = (await snapshot(db, account)).pins;
      await replacePins(
        db,
        account,
        movePersonalLibraryPin(pins, visible, key, opts.index),
      );
      return snapshot(db, account);
    });
  },
};
