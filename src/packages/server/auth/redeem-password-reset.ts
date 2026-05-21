/*
1. check that the password reset id is valid still; throw error if not
2. check that the password is valid; throw error if not
3. invalidate password reset id by writing that it is used to the database
4. write hash of new password to the database
5. Return account_id of user who just reset their password.
*/

import getPool from "@cocalc/database/pool";
import passwordHash from "@cocalc/backend/auth/password-hash";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { getClusterAccountByEmail } from "@cocalc/server/inter-bay/accounts";
import passwordStrength from "@cocalc/server/auth/password-strength";
import { MIN_PASSWORD_LENGTH, MIN_PASSWORD_STRENGTH } from "@cocalc/util/auth";

export default async function redeemPasswordReset(
  password: string,
  passwordResetId: string,
): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    // won't happen in practice because frontend UI prevents this...
    throw Error("password is too short");
  }
  const { score, help } = passwordStrength(password);
  if (score <= MIN_PASSWORD_STRENGTH) {
    throw Error(help ? help : "password is too weak");
  }

  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT email_address FROM password_reset WHERE expire > NOW() AND id=$1::UUID",
    [passwordResetId],
  );
  if (rows.length == 0) {
    throw Error("Password reset no longer valid.");
  }
  const { email_address } = rows[0];

  await pool.query("UPDATE password_reset SET expire=NOW() WHERE id=$1::UUID", [
    passwordResetId,
  ]);

  const account = await getClusterAccountByEmail(email_address);
  const account_id = account?.account_id;
  if (!account_id) {
    throw Error("Password reset no longer valid.");
  }
  await withAccountRehomeWriteFence({
    account_id,
    action: "redeem password reset",
    fn: async (db) => {
      await db.query(
        "UPDATE accounts SET password_hash=$1 WHERE account_id=$2",
        [passwordHash(password), account_id],
      );
    },
  });
  return account_id;
}
