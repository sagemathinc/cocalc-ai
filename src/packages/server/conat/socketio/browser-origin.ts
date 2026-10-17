/*
Which web pages may open a hub Conat websocket authenticated by a cookie.

Browsers attach cookies to websockets opened by any page, and CORS does not
apply to websockets. So when a connection is authenticated only by a cookie a
browser holds (remember_me, or the API-key and project-secret cookies), the
Origin of the page that opened it must be an approved CoCalc origin: the site
or a bay public origin (isAllowedBrowserOrigin).

- remember_me: Origin is required (only browsers use it).
- API-key and project-secret cookies: non-browser clients send no Origin and
  are unaffected; when an Origin is present it must be approved.
- Explicit credentials (bearer, computer login, project secret in the auth
  payload) and internal cookies (bay credential, system accounts, hub
  password) are not checked here.

COCALC_CONAT_ORIGIN_POLICY: "report" (default for the first rollout) logs
connections that enforcement would refuse; "enforce" refuses them; "off"
disables the check.
*/

import { getLogger } from "@cocalc/backend/logger";
import { isAllowedBrowserOrigin } from "@cocalc/server/bay-public-origin";

const logger = getLogger("conat-auth:browser-origin");

export type CookieCredential =
  | "remember-me"
  | "api-key-cookie"
  | "project-secret-cookie";
export type OriginPolicyMode = "enforce" | "report" | "off";

export function originPolicyMode(): OriginPolicyMode {
  const value = `${process.env.COCALC_CONAT_ORIGIN_POLICY ?? ""}`
    .trim()
    .toLowerCase();
  return value === "enforce" || value === "off" ? value : "report";
}

// A serialized http(s) origin exactly as browsers send it.
export function parseOrigin(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw || raw === "null") return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (url.origin.toLowerCase() !== raw.toLowerCase()) return;
    return url.origin.toLowerCase();
  } catch {
    return;
  }
}

function header(headers: any, name: string): string {
  const value = headers?.[name];
  return `${Array.isArray(value) ? value[0] : (value ?? "")}`.trim();
}

// Why the connection must be refused, or undefined if it is acceptable.
export async function cookieOriginRejection(
  headers: Record<string, unknown>,
  credential: CookieCredential,
  isAllowed: typeof isAllowedBrowserOrigin = isAllowedBrowserOrigin,
): Promise<string | undefined> {
  const originHeader = header(headers, "origin");
  if (!originHeader) {
    return credential === "remember-me" ? "no origin" : undefined;
  }
  const origin = parseOrigin(originHeader);
  if (!origin) return "invalid or opaque origin";
  if (await cachedIsAllowed(origin, headers, isAllowed)) return;
  return "origin not allowed";
}

// The approved-origin lookup reads site and bay configuration; cache answers
// briefly since it runs for every connection and revalidation.
const ALLOWED_CACHE_MS = 60_000;
const allowedCache = new Map<string, { allowed: boolean; at: number }>();

async function cachedIsAllowed(
  origin: string,
  headers: Record<string, unknown>,
  isAllowed: typeof isAllowedBrowserOrigin,
): Promise<boolean> {
  // The answer can depend on the request host (local and request-origin
  // deployments), so key on both.
  const key = `${origin}|${header(headers, "x-forwarded-host") || header(headers, "host")}`;
  const now = Date.now();
  const hit = allowedCache.get(key);
  if (hit != null && now - hit.at < ALLOWED_CACHE_MS) return hit.allowed;
  const allowed = await isAllowed(origin, { headers } as any);
  if (allowedCache.size > 1000) allowedCache.clear();
  allowedCache.set(key, { allowed, at: now });
  return allowed;
}

export function clearAllowedOriginCacheForTests(): void {
  allowedCache.clear();
}

const lastLogged = new Map<string, number>();

// Throws when the connection must be refused (enforce mode only).
export async function assertCookieOrigin(
  headers: Record<string, unknown>,
  credential: CookieCredential,
): Promise<void> {
  const mode = originPolicyMode();
  if (mode === "off") return;
  let reason: string | undefined;
  try {
    reason = await cookieOriginRejection(headers, credential);
  } catch (err) {
    // The approved-origin lookup failed: refuse when enforcing, but never
    // turn a lookup outage into a report-mode rejection.
    logger.warn("browser origin check failed", { err: `${err}` });
    if (mode === "enforce") throw Error("unable to verify connection origin");
    return;
  }
  if (!reason) return;
  const origin = header(headers, "origin") || "(none)";
  const key = `${credential}|${reason}|${origin}`;
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) > 60_000) {
    lastLogged.set(key, now);
    if (lastLogged.size > 1000) lastLogged.clear();
    logger.warn(
      "cookie-authenticated conat connection from an unapproved page",
      {
        credential,
        reason,
        origin: origin.slice(0, 200),
        mode,
      },
    );
  }
  if (mode === "enforce") {
    throw Error("cross-site connection refused");
  }
}
