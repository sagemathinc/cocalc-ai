import {
  ACCOUNT_ID_COOKIE_NAME,
  HOME_BAY_ID_COOKIE_NAME,
  REMEMBER_ME_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import type {
  AuthPrimaryMethod,
  AuthSessionFactorLevel,
} from "@cocalc/server/auth/auth-sessions";
import { recordNewAuthSession } from "@cocalc/server/auth/auth-sessions";
import getPool from "@cocalc/database/pool";
import { getAccountIdFromRememberMe } from "@cocalc/server/auth/get-account";
import {
  createRememberMeCookie,
  getRememberMeCookieValues,
  getRememberMeHashFromCookieValue,
} from "@cocalc/server/auth/remember-me";
import { BROWSER_SESSION_COOKIE_MAX_AGE_MS } from "@cocalc/server/auth/session-expiry";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getBrowserCookieDomainForRequest,
  getBrowserCookieNameForRequest,
} from "@cocalc/server/bay-public-origin";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { clearLegacySharedAuthCookies } from "./clear-auth-cookies";
import Cookies from "cookies";

export default async function setSignInCookies({
  req,
  res,
  account_id,
  maxAge,
  session,
  home_bay_id,
}: {
  req;
  res;
  account_id: string;
  // A shorter session than the site's maximum lifetime (e.g., impersonation),
  // in ms; the cookie then also ends with it. Without it, the session follows
  // the site's idle timeout and maximum lifetime (see session-expiry.ts), and
  // the browser keeps the cookie until the server says it has ended.
  maxAge?: number;
  session?: {
    authenticated_at?: Date;
    password_verified_at?: Date | null;
    primary_verified_at?: Date | null;
    primary_auth_method?: AuthPrimaryMethod | null;
    factor_verified_at?: Date | null;
    factor_level?: AuthSessionFactorLevel;
    fresh_auth_until?: Date | null;
    metadata?: Record<string, unknown>;
  };
  home_bay_id?: string;
}) {
  await clearLegacySharedAuthCookies({ req, res });
  const opts = {
    req,
    res,
    account_id,
    lifetime_ms: maxAge,
    maxAge: maxAge ?? BROWSER_SESSION_COOKIE_MAX_AGE_MS,
    session,
    home_bay_id,
  };
  const [rememberMe] = await Promise.all([
    setRememberMeCookie(opts),
    setAccountIdCookie(opts),
    setHomeBayCookie(opts),
  ]);
  return rememberMe;
}

async function cookieTargets({
  req,
  name,
}: {
  req;
  name: string;
}): Promise<{ name: string; domain?: string }[]> {
  const domain = await getBrowserCookieDomainForRequest(req);
  if (!domain) {
    return [{ name }];
  }
  if (name !== REMEMBER_ME_COOKIE_NAME) {
    return [{ name }, { name, domain }];
  }
  const sharedName = await getBrowserCookieNameForRequest({ name, req });
  return sharedName === name
    ? [{ name }, { name, domain }]
    : [{ name }, { name: sharedName, domain }];
}

async function setRememberMeCookie({
  req,
  res,
  account_id,
  maxAge,
  lifetime_ms,
  session,
}) {
  const { value, hash, expire } = await createRememberMeCookie(
    account_id,
    lifetime_ms != null ? lifetime_ms / 1000 : undefined,
  );
  await recordNewAuthSession({
    account_id,
    session_hash: hash,
    expire,
    req,
    authenticated_at: session?.authenticated_at,
    password_verified_at: session?.password_verified_at,
    primary_verified_at: session?.primary_verified_at,
    primary_auth_method: session?.primary_auth_method,
    factor_verified_at: session?.factor_verified_at,
    factor_level: session?.factor_level,
    fresh_auth_until: session?.fresh_auth_until,
    metadata: session?.metadata,
  });
  await writeRememberMeCookie({ req, res, value, maxAge });
  return { value, hash, expire };
}

async function writeRememberMeCookie({ req, res, value, maxAge }) {
  const cookies = new Cookies(req, res);
  const { samesite_remember_me } = await getServerSettings();
  const sameSite = samesite_remember_me;
  for (const target of await cookieTargets({
    req,
    name: REMEMBER_ME_COOKIE_NAME,
  })) {
    cookies.set(target.name, value, {
      ...(target.domain ? { domain: target.domain } : {}),
      maxAge,
      sameSite,
      secure: req.protocol === "https",
    });
  }
}

// The server decides when a session ends (idle timeout, maximum lifetime,
// which re-entering the password or second factor extends), so the browser's
// cookie must never end first: for a working session, set the same sign-in
// cookies again for another BROWSER_SESSION_COOKIE_MAX_AGE_MS. An
// impersonation session keeps its own short cookie.
export async function refreshSignInCookies({
  req,
  res,
}: {
  req;
  res;
}): Promise<{ refreshed: boolean }> {
  for (const value of getRememberMeCookieValues(req)) {
    let hash: string | undefined;
    try {
      hash = getRememberMeHashFromCookieValue(value);
    } catch {
      continue;
    }
    if (!hash) continue;
    const account_id = await getAccountIdFromRememberMe(hash);
    if (!account_id) continue;
    const { rows } = await getPool().query(
      "SELECT 1 FROM account_impersonation_sessions WHERE session_hash = $1::CHAR(127) LIMIT 1",
      [hash],
    );
    if (rows.length > 0) return { refreshed: false };
    const opts = {
      req,
      res,
      account_id,
      value,
      maxAge: BROWSER_SESSION_COOKIE_MAX_AGE_MS,
    };
    await Promise.all([
      writeRememberMeCookie(opts),
      setAccountIdCookie(opts),
      setHomeBayCookie(opts),
    ]);
    return { refreshed: true };
  }
  return { refreshed: false };
}

async function setAccountIdCookie({ req, res, account_id, maxAge }) {
  // account_id cookie is NOT secure since user is supposed to read it
  // from browser.  It's not for telling the server the account_id, but
  // for telling the user their own account_id.
  const cookies = new Cookies(req, res, { secure: false, httpOnly: false });
  for (const target of await cookieTargets({
    req,
    name: ACCOUNT_ID_COOKIE_NAME,
  })) {
    cookies.set(target.name, account_id, {
      ...(target.domain ? { domain: target.domain } : {}),
      maxAge,
      httpOnly: false,
    });
  }
}

async function setHomeBayCookie({
  req,
  res,
  account_id,
  maxAge,
  home_bay_id,
}: {
  req;
  res;
  account_id: string;
  maxAge: number;
  home_bay_id?: string;
}) {
  const cookies = new Cookies(req, res);
  const account = await getClusterAccountById(account_id);
  const resolvedHomeBayId =
    `${home_bay_id ?? ""}`.trim() ||
    `${account?.home_bay_id ?? ""}`.trim() ||
    getConfiguredBayId();
  for (const target of await cookieTargets({
    req,
    name: HOME_BAY_ID_COOKIE_NAME,
  })) {
    cookies.set(target.name, resolvedHomeBayId, {
      ...(target.domain ? { domain: target.domain } : {}),
      maxAge,
      sameSite: "lax",
      secure: req.protocol === "https",
      httpOnly: true,
    });
  }
}
