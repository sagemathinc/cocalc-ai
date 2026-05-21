/*
1. check that the password reset id is valid still; throw error if not
2. check that the password is valid; throw error if not
3. invalidate password reset id by writing that it is used to the database
4. write hash of new password to the database
5. Return account_id of user who just reset their password.
*/

import passwordStrength from "@cocalc/server/auth/password-strength";
import { redeemReset } from "@cocalc/server/auth/password-reset";
import { setClusterAccountPasswordFromReset } from "@cocalc/server/inter-bay/accounts";
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

  const { account_id } = await redeemReset(passwordResetId);
  await setClusterAccountPasswordFromReset({
    account_id,
    password,
  });
  return account_id;
}
