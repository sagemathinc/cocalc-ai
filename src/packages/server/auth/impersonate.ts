/* Sign in using an impersonation auth_token. */

import getPool from "@cocalc/database/pool";
import basePath from "@cocalc/backend/base-path";
import clientSideRedirect from "@cocalc/server/auth/client-side-redirect";
import { isLocale } from "@cocalc/util/i18n/const";
import setSignInCookies from "@cocalc/server/auth/set-sign-in-cookies";

export async function signInUsingImpersonateToken({ req, res }) {
  try {
    await doIt({ req, res });
  } catch (err) {
    res.send(`ERROR: impersonate error -- ${err}`);
  }
}

async function doIt({ req, res }) {
  const { auth_token, lang_temp } = req.query;
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
  const { account_id } = rows[0];
  // maxAge = 12 hours
  await setSignInCookies({ req, res, account_id, maxAge: 12 * 3600 * 1000 });

  // Redirect on the same origin that handled /auth/impersonate so the
  // newly-set auth cookies are visible after navigation.  Using a canonical
  // site URL here can cross origins (e.g. localhost -> public URL) and make
  // the sign-in appear to fail.
  let target = basePath === "/" ? "/app" : `${basePath}/app`;

  // if lang_temp is a locale, then append it as a query parameter.
  // This is usally "en" to help admins understanding the UI without changing the user's language preferences.
  if (isLocale(lang_temp)) {
    target += `?lang_temp=${encodeURIComponent(lang_temp)}`;
  }

  clientSideRedirect({ res, target });
}
