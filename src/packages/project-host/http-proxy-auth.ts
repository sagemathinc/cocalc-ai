import { URL } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import TTL from "@isaacs/ttlcache";
import { isValidUUID } from "@cocalc/util/misc";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import {
  PROJECT_HOST_HTTP_AUTH_COOKIE_NAME,
  PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
} from "@cocalc/conat/auth/project-host-http";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthPublicKey } from "./auth-public-key";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { conatPassword } from "@cocalc/backend/data";

const collaboratorCache = new TTL<string, boolean>({
  max: 50_000,
  ttl: 30_000,
});
const PROJECT_HOST_HTTP_SESSION_COOKIE_NAME = "cocalc_project_host_http_session";
const HTTP_SESSION_TTL_SECONDS = Math.max(
  300,
  Number(process.env.COCALC_PROJECT_HOST_HTTP_SESSION_TTL_SECONDS ?? 7 * 24 * 60 * 60),
);

class HttpAuthError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

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

function appendSetCookie(res: ServerResponse, cookie: string): void {
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
  return createHmac("sha256", conatPassword).update(payload).digest("base64url");
}

function createSessionToken({
  account_id,
  now_ms = Date.now(),
}: {
  account_id: string;
  now_ms?: number;
}): string {
  const payload = JSON.stringify({
    account_id,
    exp: Math.floor(now_ms / 1000) + HTTP_SESSION_TTL_SECONDS,
    nonce: randomBytes(12).toString("hex"),
  });
  const encoded = base64UrlEncode(payload);
  const sig = sessionSignature(encoded);
  return `${encoded}.${sig}`;
}

function verifySessionToken(token: string, now_ms = Date.now()): string | undefined {
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
  const exp = Number(payload?.exp ?? 0);
  if (!isValidUUID(account_id)) return;
  if (!Number.isFinite(exp)) return;
  if (exp < Math.floor(now_ms / 1000)) return;
  return account_id;
}

function isSecureRequest(req: IncomingMessage): boolean {
  const xfProto = `${req.headers["x-forwarded-proto"] ?? ""}`.toLowerCase();
  if (xfProto.includes("https")) return true;
  // @ts-ignore node IncomingMessage.socket may have encrypted in tls mode.
  return !!req.socket?.encrypted;
}

function readBearerToken(
  req: IncomingMessage,
): { token?: string; fromQuery: boolean } {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) {
      return { token: m[1].trim(), fromQuery: false };
    }
  }
  const cookies = parseCookies(req.headers.cookie as string | undefined);
  const cookieToken = `${cookies[PROJECT_HOST_HTTP_AUTH_COOKIE_NAME] ?? ""}`.trim();
  if (cookieToken) {
    return { token: cookieToken, fromQuery: false };
  }
  try {
    const u = new URL(req.url ?? "/", "http://project-host.local");
    const queryToken = `${u.searchParams.get(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM) ?? ""}`.trim();
    if (queryToken) {
      return { token: queryToken, fromQuery: true };
    }
  } catch {
    // ignore malformed URL and fall through.
  }
  return { token: undefined, fromQuery: false };
}

function stripQueryToken(req: IncomingMessage): void {
  try {
    const u = new URL(req.url ?? "/", "http://project-host.local");
    if (!u.searchParams.has(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM)) return;
    u.searchParams.delete(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM);
    const path = `${u.pathname}${u.search}${u.hash}`;
    req.url = path || "/";
  } catch {
    // ignore
  }
}

function isProjectCollaboratorLocal({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  if (account_id === project_id) {
    return true;
  }
  const key = `${account_id}:${project_id}`;
  if (collaboratorCache.has(key)) {
    return collaboratorCache.get(key)!;
  }
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group =
    typeof userEntry === "string" ? userEntry : userEntry?.group;
  const allowed = isProjectCollaboratorGroup(group);
  collaboratorCache.set(key, allowed);
  return allowed;
}

export function clearProjectHostHttpProxyAuthCaches() {
  collaboratorCache.clear();
}

export function createProjectHostHttpProxyAuth({
  host_id,
}: {
  host_id: string;
}): {
  authorizeHttpRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    project_id: string,
  ) => Promise<void>;
  authorizeUpgradeRequest: (
    req: IncomingMessage,
    project_id: string,
  ) => Promise<void>;
  clearCaches: () => void;
} {
  const verifyTokenAndGetAccountId = (token: string): string => {
    const claims = verifyProjectHostAuthToken({
      token,
      host_id,
      public_key: getProjectHostAuthPublicKey(),
    });
    if ((claims.act ?? "account") !== "account") {
      throw new HttpAuthError(403, "invalid actor for project-host HTTP auth");
    }
    if (!isValidUUID(claims.sub)) {
      throw new HttpAuthError(401, "invalid account id in auth token");
    }
    return claims.sub;
  };

  const sessionAccountId = (req: IncomingMessage): string | undefined => {
    const cookies = parseCookies(req.headers.cookie as string | undefined);
    const token = `${cookies[PROJECT_HOST_HTTP_SESSION_COOKIE_NAME] ?? ""}`.trim();
    if (!token) return;
    return verifySessionToken(token);
  };

  const setSessionCookie = (req: IncomingMessage, res: ServerResponse, account_id: string) => {
    const sessionToken = createSessionToken({ account_id });
    const attrs = [
      `${PROJECT_HOST_HTTP_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${HTTP_SESSION_TTL_SECONDS}`,
    ];
    if (isSecureRequest(req)) {
      attrs.push("Secure");
    }
    appendSetCookie(res, attrs.join("; "));
  };

  const authorizeAccountForProject = ({
    account_id,
    project_id,
  }: {
    account_id: string;
    project_id: string;
  }) => {
    if (!isProjectCollaboratorLocal({ account_id, project_id })) {
      throw new HttpAuthError(
        403,
        "permission denied: account is not a collaborator on this project",
      );
    }
  };

  const authorizeHttpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    project_id: string,
  ) => {
    const accountFromSession = sessionAccountId(req);
    if (accountFromSession) {
      authorizeAccountForProject({ account_id: accountFromSession, project_id });
      return;
    }
    const { token, fromQuery } = readBearerToken(req);
    if (!token) {
      throw new HttpAuthError(401, "missing project-host HTTP auth token");
    }
    const account_id = verifyTokenAndGetAccountId(token);
    authorizeAccountForProject({ account_id, project_id });
    setSessionCookie(req, res, account_id);
    if (fromQuery) {
      // Avoid forwarding a bearer query parameter to project apps.
      stripQueryToken(req);
    }
  };

  const authorizeUpgradeRequest = async (
    req: IncomingMessage,
    project_id: string,
  ) => {
    const accountFromSession = sessionAccountId(req);
    if (accountFromSession) {
      authorizeAccountForProject({ account_id: accountFromSession, project_id });
      return;
    }
    const { token } = readBearerToken(req);
    if (!token) {
      throw new HttpAuthError(401, "missing project-host HTTP auth token");
    }
    const account_id = verifyTokenAndGetAccountId(token);
    authorizeAccountForProject({ account_id, project_id });
  };

  return {
    authorizeHttpRequest,
    authorizeUpgradeRequest,
    clearCaches: clearProjectHostHttpProxyAuthCaches,
  };
}
