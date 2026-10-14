/* Returns the configured help email address (also the fallback From address
   of outgoing mail). Not cached: an admin who changes it and sends a test
   message should see the new address.
*/

import getPool from "@cocalc/database/pool";

export default async function getHelpEmail(): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT value FROM server_settings WHERE name='help_email'",
  );
  if (rows.length == 0 || !rows[0].value) {
    throw Error("no help email address set");
  }
  return rows[0].value;
}
