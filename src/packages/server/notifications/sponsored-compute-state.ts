import getPool from "@cocalc/database/pool";

const initialized = new WeakMap<object, Promise<void>>();

// Account-home crossing state; included in financial rehome with notifications.
export async function ensureSponsoredComputeNoticeSchema(): Promise<void> {
  const pool = getPool();
  let ready = initialized.get(pool);
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS notification_sponsored_compute_states (
      id UUID PRIMARY KEY, account_id UUID NOT NULL, pool_id UUID NOT NULL,
      threshold_usd NUMERIC NOT NULL, below_threshold BOOLEAN NOT NULL,
      generation INTEGER NOT NULL, as_of TIMESTAMPTZ NOT NULL,
      UNIQUE(account_id, pool_id))`,
      )
      .then(() => {});
    initialized.set(pool, ready);
    ready.catch(() => initialized.delete(pool));
  }
  await ready;
}
