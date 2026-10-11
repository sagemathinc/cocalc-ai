import getPool from "@cocalc/database/pool";

// get account_ids of all admins (uncached: admin rights must take effect at once)
// *Always sorted by account_id lexicographically.*

export default async function admins(): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts where 'admin' = ANY(groups) AND coalesce(deleted,false) = false",
  );
  return rows.map(({ account_id }) => account_id).sort();
}
