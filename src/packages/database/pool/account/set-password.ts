import getPool from "@cocalc/database/pool";
import { newPasswordHash } from "@cocalc/database/settings/password-kdf";
export default async function setPassword(
  account_id: string,
  password: string,
): Promise<void> {
  const password_hash = await newPasswordHash(password);
  const pool = getPool();
  await pool.query("UPDATE accounts SET password_hash=$1 WHERE account_id=$2", [
    password_hash,
    account_id,
  ]);
}
