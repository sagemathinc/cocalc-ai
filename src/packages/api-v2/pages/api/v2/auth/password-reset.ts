/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Password reset works as follows:

1. Query the database to make sure there is a user with the given email address.
2. If a password reset was already sent within the last XX minutes,
   return an error -- we don't want people to spam other people with
   password resets.
3. Generate password reset token and write to database.
4. Send email.
5. Send response to user that email has been sent (or there was an error).
*/

import isAccountAvailable from "@cocalc/server/auth/is-account-available";
import {
  recentAttempts,
  createReset,
} from "@cocalc/server/auth/password-reset";
import sendPasswordResetEmail from "@cocalc/server/email/password-reset";
import getRequiresToken from "@cocalc/server/auth/tokens/get-requires-token";
import { getLogger } from "@cocalc/backend/logger";
import getParams from "lib/api/get-params";

const logger = getLogger("auth:password-reset");
const GENERIC_RESET_MESSAGE =
  "If an account with that email exists, a password reset email has been sent.";

export default async function passwordReset(req, res) {
  const { email } = getParams(req);
  const requiresToken = await getRequiresToken();
  let result;
  try {
    result = await handle(email?.toLowerCase(), req.ip, {
      hideAccountDetails: requiresToken,
    });
  } catch (err) {
    result = requiresToken
      ? { success: GENERIC_RESET_MESSAGE }
      : { error: err.message };
  }
  res.json(result);
}

async function handle(
  email: string,
  ip: string,
  opts: { hideAccountDetails: boolean },
): Promise<object> {
  if (await isAccountAvailable(email)) {
    // Bad -- email is *available*, which means no way to reset
    // the password for it, since it doesn't exist.
    if (opts.hideAccountDetails) {
      return { success: GENERIC_RESET_MESSAGE };
    }
    return { error: `There is no account with email "${email}".` };
  }
  // Check that user isn't spamming email.

  const n = await recentAttempts(email, ip);
  if (n > 3) {
    if (opts.hideAccountDetails) {
      return { success: GENERIC_RESET_MESSAGE };
    }
    return {
      error: `We recently sent multiple password resets for "${email}".  Check your email or wait a while and try later.`,
    };
  }

  const id = await createReset(email, ip, 60 * 60 * 4); // 4 hour ttl seems reasonable for this.
  // TODO:
  // - Send email with the id and link
  // - Link should be back to next.js server (i.e., a new password reset target)
  // - Implement that target and backend handling of it.
  try {
    await sendPasswordResetEmail(email, id);
  } catch (err) {
    logger.warn("password reset email send failed", {
      email,
      err: err instanceof Error ? err.message : String(err),
    });
    if (opts.hideAccountDetails) {
      return { success: GENERIC_RESET_MESSAGE };
    }
    return {
      error: `Sending password reset email failed -- ${err.message}`,
    };
  }

  if (opts.hideAccountDetails) {
    return { success: GENERIC_RESET_MESSAGE };
  }
  return {
    success: `Password reset email successfully sent to ${email}.`,
  };
}
