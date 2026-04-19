import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { conatPassword } from "@cocalc/backend/data";
import { isValidUUID } from "@cocalc/util/misc";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthPublicKey } from "./auth-public-key";
import { getAccountRevokedBeforeMs } from "./sqlite/account-revocations";
import { isSecureRequest } from "./http-proxy-cookies";
import { PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME } from "@cocalc/conat/auth/project-host-browser-session";

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const BROWSER_SESSION_TTL_SECONDS = Math.max(
  300,
  envNumber(
    "COCALC_PROJECT_HOST_BROWSER_SESSION_TTL_SECONDS",
    30 * 24 * 60 * 60,
  ),
);

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function readCookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (key !== name) continue;
    const value = part.slice(i + 1).trim();
    if (!value) continue;
    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push(value);
    }
  }
  return values;
}

export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookie]);
    return;
  }
  res.setHeader("Set-Cookie", [String(prev), cookie]);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = normalized.length % 4;
  const padded =
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
  return Buffer.from(padded, "base64").toString("utf8");
}

function sessionSignature(payload: string): string {
  return createHmac("sha256", conatPassword)
    .update(payload)
    .digest("base64url");
}

function normalizeOriginHostname(
  origin: string | undefined,
): string | undefined {
  if (!origin) return;
  try {
    const { hostname } = new URL(origin);
    const normalized = hostname.trim().toLowerCase();
    return normalized || undefined;
  } catch {
    return;
  }
}

function browserSessionSameSite(req: IncomingMessage): "Lax" | "None" {
  // Project-host browser sessions are bootstrapped by an XHR/fetch from the
  // main app origin to the host-specific project-host origin. Use None+Secure
  // whenever that bootstrap is cross-origin so browsers will actually store
  // the Set-Cookie response on the project-host origin.
  if (!isSecureRequest(req)) {
    return "Lax";
  }
  const originHost = normalizeOriginHostname(
    `${req.headers.origin ?? ""}`.trim() || undefined,
  );
  const requestHost = `${req.headers.host ?? ""}`
    .trim()
    .toLowerCase()
    .split(":")[0];
  if (originHost && requestHost && originHost !== requestHost) {
    return "None";
  }
  return "Lax";
}

export function createProjectHostBrowserSessionToken({
  account_id,
  now_ms = Date.now(),
}: {
  account_id: string;
  now_ms?: number;
}): string {
  const payload = JSON.stringify({
    account_id,
    iat: Math.floor(now_ms / 1000),
    exp: Math.floor(now_ms / 1000) + BROWSER_SESSION_TTL_SECONDS,
    nonce: randomBytes(12).toString("hex"),
  });
  const encoded = base64UrlEncode(payload);
  const sig = sessionSignature(encoded);
  return `${encoded}.${sig}`;
}

export function verifyProjectHostBrowserSessionToken(
  token: string,
  now_ms = Date.now(),
):
  | {
      account_id: string;
      iat_s: number;
      exp_s: number;
    }
  | undefined {
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return;
  const expected = sessionSignature(encoded);
  const gotBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (gotBuf.length !== expBuf.length) {
    return;
  }
  if (!timingSafeEqual(gotBuf, expBuf)) {
    return;
  }
  let payload: any;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return;
  }
  const account_id = `${payload?.account_id ?? ""}`;
  const iat = Number(payload?.iat ?? 0);
  const exp = Number(payload?.exp ?? 0);
  if (!isValidUUID(account_id)) return;
  if (!Number.isFinite(iat)) return;
  if (!Number.isFinite(exp)) return;
  if (exp < Math.floor(now_ms / 1000)) return;
  return { account_id, iat_s: iat, exp_s: exp };
}

export function resolveProjectHostBrowserSessionFromCookieHeader(
  header: string | undefined,
): { account_id: string; iat_s: number; exp_s: number } | undefined {
  const tokens = readCookieValues(
    header,
    PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME,
  )
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const session = verifyProjectHostBrowserSessionToken(token);
    if (session) {
      return session;
    }
  }
  return;
}

export function buildProjectHostBrowserSessionCookie({
  req,
  sessionToken,
}: {
  req: IncomingMessage;
  sessionToken: string;
}): string {
  const attrs = [
    `${PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${browserSessionSameSite(req)}`,
    `Max-Age=${BROWSER_SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(req)) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

export function buildProjectHostBrowserSessionCookieDeletion({
  req,
}: {
  req: IncomingMessage;
}): string {
  const attrs = [
    `${PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${browserSessionSameSite(req)}`,
    "Max-Age=0",
  ];
  if (isSecureRequest(req)) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

export function issueProjectHostBrowserSessionFromBearer({
  req,
  res,
  host_id,
  token,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  host_id: string;
  token: string;
}): { account_id: string; issued_at_s: number } {
  const claims = verifyProjectHostAuthToken({
    token,
    host_id,
    public_key: getProjectHostAuthPublicKey(),
  });
  if ((claims.act ?? "account") !== "account") {
    throw new Error("invalid actor for project-host browser session");
  }
  if (!isValidUUID(claims.sub)) {
    throw new Error("invalid account id in auth token");
  }
  const revokedBeforeMs = getAccountRevokedBeforeMs(claims.sub);
  if (revokedBeforeMs != null && claims.iat * 1000 <= revokedBeforeMs) {
    throw new Error("session revoked");
  }
  appendSetCookie(
    res,
    buildProjectHostBrowserSessionCookie({
      req,
      sessionToken: createProjectHostBrowserSessionToken({
        account_id: claims.sub,
      }),
    }),
  );
  return { account_id: claims.sub, issued_at_s: claims.iat };
}

export function clearProjectHostBrowserSessionCookie({
  req,
  res,
}: {
  req: IncomingMessage;
  res: ServerResponse;
}): void {
  appendSetCookie(res, buildProjectHostBrowserSessionCookieDeletion({ req }));
}

export function parseProjectHostBrowserSessionCookies(
  header: string | undefined,
): Record<string, string> {
  return parseCookies(header);
}
