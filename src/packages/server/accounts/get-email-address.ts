// Get email address of an account. If no such account or email not set, returns undefined.
// Not cached: sign-in, password reset and SSO checks use it, so a changed
// address must take effect at once.

import getPool from "@cocalc/database/pool";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

export default async function getEmailAddress(
  account_id: string,
): Promise<string | undefined> {
  const cluster = await getClusterAccountById(account_id);
  if (cluster?.email_address) {
    return cluster.email_address;
  }
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT email_address FROM accounts WHERE account_id=$1",
    [account_id],
  );
  return rows[0]?.email_address;
}
