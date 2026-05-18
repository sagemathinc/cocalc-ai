import {
  ACCOUNT_ID_COOKIE_NAME,
  HOME_BAY_ID_COOKIE_NAME,
  REMEMBER_ME_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import {
  getBrowserCookieDomainForRequest,
  getBrowserCookieNameForRequest,
} from "@cocalc/server/bay-public-origin";
import Cookies from "cookies";

const AUTH_COOKIE_NAMES = [
  REMEMBER_ME_COOKIE_NAME,
  ACCOUNT_ID_COOKIE_NAME,
  HOME_BAY_ID_COOKIE_NAME,
] as const;

function clearCookie({
  req,
  res,
  name,
  opts,
}: {
  req: any;
  res: any;
  name: string;
  opts?: { domain?: string };
}): void {
  if (typeof res?.clearCookie === "function") {
    res.clearCookie(name, opts);
    return;
  }
  new Cookies(req, res).set(name, "", opts);
}

export default async function clearAuthCookies({
  req,
  res,
}: {
  req: any;
  res: any;
}): Promise<void> {
  const domain = await getBrowserCookieDomainForRequest(req);
  for (const name of AUTH_COOKIE_NAMES) {
    clearCookie({ req, res, name });
  }
  if (!domain) {
    return;
  }
  for (const name of AUTH_COOKIE_NAMES) {
    clearCookie({ req, res, name, opts: { domain } });
    const namespacedName = await getBrowserCookieNameForRequest({ name, req });
    if (namespacedName !== name) {
      clearCookie({ req, res, name: namespacedName, opts: { domain } });
    }
  }
}

export async function clearLegacySharedAuthCookies({
  req,
  res,
}: {
  req: any;
  res: any;
}): Promise<void> {
  const domain = await getBrowserCookieDomainForRequest(req);
  if (!domain) return;
  for (const name of AUTH_COOKIE_NAMES) {
    clearCookie({ req, res, name, opts: { domain } });
  }
}
