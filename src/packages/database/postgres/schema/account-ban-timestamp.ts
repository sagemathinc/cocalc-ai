/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

type DatabaseClient = Pick<Client, "query">;

export const ACCOUNT_BAN_TIMESTAMP_TRIGGER = "accounts_set_banned_at";

export async function accountBanTimestampSchemaReady(
  db: DatabaseClient,
): Promise<boolean> {
  const { rows } = await db.query<{
    column_exists: boolean;
    trigger_exists: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1
           FROM pg_attribute
          WHERE attrelid='accounts'::regclass
            AND attname='banned_at'
            AND NOT attisdropped
       ) AS column_exists,
       EXISTS (
         SELECT 1
           FROM pg_trigger
          WHERE tgrelid='accounts'::regclass
            AND tgname=$1
            AND NOT tgisinternal
       ) AS trigger_exists`,
    [ACCOUNT_BAN_TIMESTAMP_TRIGGER],
  );
  const row = rows[0];
  return row?.column_exists === true && row.trigger_exists === true;
}

/** Install the non-declarative parts of account ban timestamps during schema sync. */
export async function syncAccountBanTimestampSchema(
  db: DatabaseClient,
): Promise<void> {
  await db.query(
    `UPDATE accounts
        SET banned_at = NOW()
      WHERE banned IS TRUE
        AND banned_at IS NULL`,
  );
  await db.query(`
    CREATE OR REPLACE FUNCTION set_account_banned_at()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.banned IS TRUE THEN
        IF TG_OP = 'INSERT' OR OLD.banned IS NOT TRUE THEN
          NEW.banned_at := NOW();
        ELSE
          NEW.banned_at := COALESCE(NEW.banned_at, OLD.banned_at, NOW());
        END IF;
      ELSE
        NEW.banned_at := NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.query(`
    DROP TRIGGER IF EXISTS ${ACCOUNT_BAN_TIMESTAMP_TRIGGER} ON accounts
  `);
  await db.query(`
    CREATE TRIGGER ${ACCOUNT_BAN_TIMESTAMP_TRIGGER}
    BEFORE INSERT OR UPDATE OF banned ON accounts
    FOR EACH ROW EXECUTE FUNCTION set_account_banned_at()
  `);
  await db.query(
    `UPDATE accounts
        SET banned_at = NULL
      WHERE banned IS NOT TRUE
        AND banned_at IS NOT NULL`,
  );
}
