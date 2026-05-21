import {
  ACCOUNT_ID_COOKIE_NAME,
  HOME_BAY_ID_COOKIE_NAME,
  REMEMBER_ME_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import type { AuthSessionFactorLevel } from "@cocalc/server/auth/auth-sessions";
import { recordNewAuthSession } from "@cocalc/server/auth/auth-sessions";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getBrowserCookieDomainForRequest,
  getBrowserCookieNameForRequest,
} from "@cocalc/server/bay-public-origin";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { clearLegacySharedAuthCookies } from "./clear-auth-cookies";
import Cookies from "cookies";

// 6 months by default, but sometimes (e.g., impersonate) is MUCH shorter.
export const DEFAULT_MAX_AGE_MS = 24 * 3600 * 30 * 1000 * 6;

export default async function setSignInCookies({
  req,
  res,
  account_id,
  maxAge = DEFAULT_MAX_AGE_MS,
  session,
  home_bay_id,
}: {
  req;
  res;
  account_id: string;
  maxAge?: number;
  session?: {
    authenticated_at?: Date;
    password_verified_at?: Date | null;
    factor_verified_at?: Date | null;
    factor_level?: AuthSessionFactorLevel;
    fresh_auth_until?: Date | null;
    metadata?: Record<string, unknown>;
  };
  home_bay_id?: string;
}) {
  await clearLegacySharedAuthCookies({ req, res });
  const opts = { req, res, account_id, maxAge, session, home_bay_id };
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

async function setRememberMeCookie({ req, res, account_id, maxAge, session }) {
  const { value, hash, expire } = await createRememberMeCookie(
    account_id,
    maxAge / 1000,
  );
  await recordNewAuthSession({
    account_id,
    session_hash: hash,
    expire,
    req,
    authenticated_at: session?.authenticated_at,
    password_verified_at: session?.password_verified_at,
    factor_verified_at: session?.factor_verified_at,
    factor_level: session?.factor_level,
    fresh_auth_until: session?.fresh_auth_until,
    metadata: session?.metadata,
  });
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
  return { value, hash, expire };
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

async function setHomeBayCookie({ req, res, account_id, maxAge, home_bay_id }) {
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
