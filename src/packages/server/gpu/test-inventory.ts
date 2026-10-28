/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Tests only. Launches need a recent complete inventory of the key (the
// reconciler, reconcile.ts); suites that aren't about it start every key
// with one, as they start with a reaper that has just completed a sweep.
// The reconciler's own tests don't call this.

export async function freshInventoryForTests(): Promise<void> {
  // loaded here: the real-PostgreSQL suites configure the pool first
  const getPool = (await import("@cocalc/database/pool")).default;
  await getPool().query(`
    CREATE OR REPLACE FUNCTION gpu_test_fresh_inventory() RETURNS trigger AS $$
    BEGIN
      NEW.last_inventory_at := COALESCE(NEW.last_inventory_at, now() + interval '10 years');
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await getPool().query(
    `DROP TRIGGER IF EXISTS gpu_test_fresh_inventory ON gpu_key_fences`,
  );
  await getPool().query(
    `CREATE TRIGGER gpu_test_fresh_inventory BEFORE INSERT ON gpu_key_fences
       FOR EACH ROW EXECUTE FUNCTION gpu_test_fresh_inventory()`,
  );
}
