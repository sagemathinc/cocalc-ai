/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Sign in works as follows:

1. Query the database for the account_id and password_hash
   with the given username.

2. Use the password-hash library to determine whether or
   not the given password hashes properly.  If so, create and
   set a secure remember_me http cookie confirming that the
   client is that user and tell user they are now authenticated.
   If not, send an error back.
*/
import { Request, Response } from "express";

import getPool from "@cocalc/database/pool";
import { recordFail, signInCheck } from "@cocalc/server/auth/throttle";
import getRequiresToken from "@cocalc/server/auth/tokens/get-requires-token";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { verify } from "password-hash";
import { MAX_PASSWORD_LENGTH } from "@cocalc/util/auth";
import setSignInCookies from "@cocalc/server/auth/set-sign-in-cookies";
import clearAuthCookies from "@cocalc/server/auth/clear-auth-cookies";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import {
  issueHomeBayRetryToken,
  verifyHomeBayRetryToken,
} from "@cocalc/server/auth/home-bay-retry-token";
import { getClusterAccountByEmail } from "@cocalc/server/inter-bay/accounts";

export default async function signIn(req: Request, res: Response) {
  let { email, password, retry_token } = getParams(req);

  email = email.toLowerCase().trim();
  retry_token = `${retry_token ?? ""}`.trim();
  const requiresToken = await getRequiresToken();

  const check: string | undefined = await signInCheck(email, req.ip);
  if (check) {
    res.json({ error: check });
    return;
  }
  let account_id: string;

  try {
    // Don't bother checking reCaptcha for *sign in* for now, since it causes trouble
    // when large classes all sign in from one point.  Also, it's much less important
    // for sign in, than for sign up and payment.
    // await reCaptcha(req);
    account_id = await getAccount(email, password, retry_token);
  } catch (err) {
    if (isWrongBayError(err)) {
      await clearAuthCookies({ req, res });
      res.json({
        wrong_bay: true,
        home_bay_id: err.home_bay_id,
        home_bay_url:
          (await getBayPublicOriginForRequest(req, err.home_bay_id)) ??
          err.home_bay_url,
        retry_token: err.retry_token,
      });
      return;
    }
    res.json({ error: getSignInErrorMessage(err, { requiresToken }) });
    recordFail(email, req.ip);
    return;
  }

  await signUserIn(req, res, account_id);
}

function getSignInErrorMessage(
  err: unknown,
  opts: { requiresToken: boolean },
): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (opts.requiresToken) {
    // In registration-token deployments, avoid leaking account existence/state.
    return "Invalid email address or password.";
  }
  if (message.includes("is banned")) {
    return "This account is not allowed to sign in.";
  }
  if (
    message.startsWith("no account with email address") ||
    message.startsWith("password for ")
  ) {
    return `Problem signing into account -- ${message}.`;
  }
  if (message.startsWith("account home bay mismatch:")) {
    return `Problem signing into account -- ${message.replace("account home bay mismatch:", "").trim()}.`;
  }
  if (message.startsWith("The password must be shorter than")) {
    return message;
  }
  return "Problem signing into account.";
}

export async function getAccount(
  email_address: string,
  password: string,
  retry_token?: string,
): Promise<string> {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be shorter than ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  const global = await getClusterAccountByEmail(email);
  if (retry_token) {
    verifyHomeBayRetryToken({
      token: retry_token,
      home_bay_id: getConfiguredBayId(),
      email,
      purpose: "sign-in",
    });
  } else if (
    global?.home_bay_id &&
    global.home_bay_id !== getConfiguredBayId()
  ) {
    const home_bay_id = global.home_bay_id;
    const retry = issueHomeBayRetryToken({
      email,
      home_bay_id,
      purpose: "sign-in",
    });
    const err = new Error(
      `account home bay mismatch: '${email}' is homed on bay '${home_bay_id}'`,
    ) as Error & {
      home_bay_id?: string;
      home_bay_url?: string;
      retry_token?: string;
    };
    err.home_bay_id = home_bay_id;
    err.retry_token = retry.token;
    throw err;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id, password_hash, banned FROM accounts WHERE email_address=$1",
    [email],
  );
  if (rows.length == 0) {
    throw Error(`no account with email address '${email}'`);
  }
  const { account_id, password_hash, banned } = rows[0];
  if (banned) {
    throw Error(
      `'${email}' is banned -- if you think this is a mistake, please email help@cocalc.com and explain.`,
    );
  }
  if (!verify(password, password_hash)) {
    throw Error(`password for '${email}' is incorrect`);
  }
  return account_id;
}

export async function signUserIn(
  req,
  res,
  account_id: string,
  opts?: { maxAge?: number },
): Promise<void> {
  try {
    await setSignInCookies({
      req,
      res,
      account_id,
      maxAge: opts?.maxAge,
    });
  } catch (err) {
    // Avoid leaking cookie implementation/internal errors to clients.
    res.json({ error: "Problem setting auth cookies." });
    return;
  }
  res.json({
    account_id,
    home_bay_id: getConfiguredBayId(),
    home_bay_url: await getBayPublicOriginForRequest(req, getConfiguredBayId()),
  });
}

export function isWrongBayError(err: unknown): err is Error & {
  home_bay_id: string;
  home_bay_url?: string;
  retry_token: string;
} {
  return (
    err instanceof Error &&
    typeof (err as any).home_bay_id === "string" &&
    typeof (err as any).retry_token === "string"
  );
}
