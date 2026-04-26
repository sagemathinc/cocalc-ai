/*
In the interest of security and "XSS", we strip the "remember_me" cookie
from the header before passing anything along via the proxy.
The reason this is important is that it's critical that the project (and
nothing running in the project) can get access to a user's auth cookie.
I.e., malicious code running in a project shouldn't be able to steal
auth credentials for all users of a project!
*/

import {
  REMEMBER_ME_COOKIE_NAME,
  API_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import { SSO_API_KEY_COOKIE_NAME } from "@cocalc/server/auth/sso/consts";
import Cookies from "cookies";

export default function stripRememberMeCookie(
  cookie: string | string[] | undefined,
  req?,
): {
  cookie: string | undefined;
  remember_me: string | undefined; // the value of the cookie we just stripped out.
  api_key: string | undefined;
} {
  const raw = Array.isArray(cookie) ? cookie.join("; ") : cookie;
  if (raw == null) {
    return {
      cookie: raw,
      remember_me: undefined,
      api_key: undefined,
    };
  } else {
    const cookies = req ? new Cookies(req) : undefined;
    const v: string[] = [];
    let remember_me: string | undefined = cookies?.get(REMEMBER_ME_COOKIE_NAME);
    let api_key: string | undefined =
      cookies?.get(API_COOKIE_NAME) ?? cookies?.get(SSO_API_KEY_COOKIE_NAME);
    for (const c of raw.split(";")) {
      const i = c.indexOf("=");
      const name = (i === -1 ? c : c.slice(0, i)).trim();
      const value = i === -1 ? "" : c.slice(i + 1).trim();
      if (name == REMEMBER_ME_COOKIE_NAME) {
        // save it but do not include it in v, which will
        // be the new cookies values after going through
        // the proxy.
        remember_me ??= value;
      } else if (name == API_COOKIE_NAME || name == SSO_API_KEY_COOKIE_NAME) {
        api_key ??= value;
      } else {
        v.push(c.trim());
      }
    }
    return {
      cookie: v.length > 0 ? v.join("; ") : undefined,
      remember_me,
      api_key,
    };
  }
}
