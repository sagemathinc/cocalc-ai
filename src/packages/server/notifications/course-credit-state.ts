import getPool from "@cocalc/database/pool";

const initialized = new WeakMap<object, Promise<void>>();

// Account-home state; included in financial rehome alongside delivery records.
export async function ensureCourseCreditNoticeSchema(): Promise<void> {
  const pool = getPool();
  let ready = initialized.get(pool);
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS notification_course_credit_states (
      id UUID PRIMARY KEY, account_id UUID NOT NULL, grant_id UUID NOT NULL,
      threshold_usd NUMERIC NOT NULL, below_threshold BOOLEAN NOT NULL,
      generation INTEGER NOT NULL, as_of TIMESTAMPTZ NOT NULL,
      UNIQUE(account_id, grant_id))`,
      )
      .then(() => {});
    initialized.set(pool, ready);
    ready.catch(() => initialized.delete(pool));
  }
  await ready;
}
