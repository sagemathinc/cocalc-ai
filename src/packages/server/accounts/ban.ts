import getPool from "@cocalc/database/pool";
import { recordAccountRevocation } from "@cocalc/server/accounts/revocation";

export async function banUser(account_id: string): Promise<void> {
  const pool = getPool();
  // Delete all of the their auth tokens
  await pool.query("DELETE FROM auth_tokens WHERE account_id = $1::UUID", [
    account_id,
  ]);
  // Ban them
  await pool.query(
    "UPDATE accounts SET banned=true WHERE account_id = $1::UUID",
    [account_id],
  );
  // Revoke host-level persistent sessions/tokens issued before this ban.
  await recordAccountRevocation(account_id, Date.now());
}

export async function removeUserBan(account_id: string): Promise<void> {
  const pool = getPool();
  // remove their ban
  await pool.query(
    "UPDATE accounts SET banned=false WHERE account_id = $1::UUID",
    [account_id],
  );
}
