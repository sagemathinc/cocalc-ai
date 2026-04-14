/* Sign in using an impersonation auth_token. */

import getPool from "@cocalc/database/pool";
import basePath from "@cocalc/backend/base-path";
import clientSideRedirect from "@cocalc/server/auth/client-side-redirect";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getBayPublicOriginForRequest,
  getSitePublicOriginForRequest,
} from "@cocalc/server/bay-public-origin";
import { isLocale } from "@cocalc/util/i18n/const";
import {
  issueHomeBayRetryToken,
  verifyHomeBayRetryToken,
} from "@cocalc/server/auth/home-bay-retry-token";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import setSignInCookies from "@cocalc/server/auth/set-sign-in-cookies";
import clearAuthCookies from "@cocalc/server/auth/clear-auth-cookies";

export async function signInUsingImpersonateToken({ req, res }) {
  try {
    await doIt({ req, res });
  } catch (err) {
    res.send(`ERROR: impersonate error -- ${err}`);
  }
}

async function doIt({ req, res }) {
  const { auth_token, retry_token, lang_temp } = req.query;
  const local_bay_id = getConfiguredBayId();
  let account_id: string;

  if (`${retry_token ?? ""}`.trim()) {
    const claims = verifyHomeBayRetryToken({
      token: `${retry_token}`,
      home_bay_id: local_bay_id,
      purpose: "impersonate",
    });
    account_id = `${claims.account_id ?? ""}`.trim();
    if (!account_id) {
      throw Error("invalid impersonation retry token");
    }
  } else {
    if (!auth_token) {
      throw Error("invalid empty token");
    }
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT account_id FROM auth_tokens WHERE auth_token=$1 AND expire > NOW()",
      [auth_token],
    );
    if (rows.length == 0) {
      throw Error(`unknown or expired token: '${auth_token}'`);
    }
    account_id = rows[0].account_id;
  }

  const account = await getClusterAccountById(account_id);
  const home_bay_id = `${account?.home_bay_id ?? ""}`.trim() || local_bay_id;

  if (!`${retry_token ?? ""}`.trim() && home_bay_id !== local_bay_id) {
    await clearAuthCookies({ req, res });
    const retry = issueHomeBayRetryToken({
      account_id,
      home_bay_id,
      purpose: "impersonate",
    });
    const target = new URL(
      basePath === "/" ? "/auth/impersonate" : `${basePath}/auth/impersonate`,
      (await getBayPublicOriginForRequest(req, home_bay_id)) ??
        `${req.protocol === "https" ? "https" : "http"}://${req.headers.host}`,
    );
    target.searchParams.set("retry_token", retry.token);
    if (isLocale(lang_temp)) {
      target.searchParams.set("lang_temp", lang_temp);
    }
    clientSideRedirect({ res, target: target.toString() });
    return;
  }

  // maxAge = 12 hours
  await setSignInCookies({ req, res, account_id, maxAge: 12 * 3600 * 1000 });

  const target = new URL(
    basePath === "/" ? "/app" : `${basePath}/app`,
    (await getSitePublicOriginForRequest(req)) ??
      (await getBayPublicOriginForRequest(req, home_bay_id)) ??
      `${req.protocol === "https" ? "https" : "http"}://${req.headers.host}`,
  );

  // if lang_temp is a locale, then append it as a query parameter.
  // This is usally "en" to help admins understanding the UI without changing the user's language preferences.
  if (isLocale(lang_temp)) {
    target.searchParams.set("lang_temp", lang_temp);
  }

  clientSideRedirect({ res, target: target.toString() });
}
