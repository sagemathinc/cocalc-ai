import {
  ACCOUNT_ID_COOKIE_NAME,
  HOME_BAY_ID_COOKIE_NAME,
  REMEMBER_ME_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import { getBrowserCookieDomainForRequest } from "@cocalc/server/bay-public-origin";

const AUTH_COOKIE_NAMES = [
  REMEMBER_ME_COOKIE_NAME,
  ACCOUNT_ID_COOKIE_NAME,
  HOME_BAY_ID_COOKIE_NAME,
] as const;

export default async function clearAuthCookies({
  req,
  res,
}: {
  req: any;
  res: any;
}): Promise<void> {
  const domain = await getBrowserCookieDomainForRequest(req);
  const variants = [undefined, ...(domain ? [{ domain }] : [])];
  for (const opts of variants) {
    for (const name of AUTH_COOKIE_NAMES) {
      res.clearCookie(name, opts);
    }
  }
}
