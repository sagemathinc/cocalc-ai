import { URL } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import {
  PROJECT_HOST_HTTP_AUTH_COOKIE_NAME,
  PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
  PROJECT_HOST_HTTP_SESSION_COOKIE_NAME,
} from "@cocalc/conat/auth/project-host-http";
import {
  buildProjectHostSessionCookie,
  buildProjectHostSessionCookieDeletion,
  legacyProjectHostCookiePath,
  projectCookiePath,
} from "./http-proxy-cookies";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthPublicKey } from "./auth-public-key";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { conatPassword } from "@cocalc/backend/data";
import { getAccountRevokedBeforeMs } from "./sqlite/account-revocations";
import { authorizePublicAppPath } from "./app-public-access";

const collaboratorCache = new TTL<string, boolean>({
  max: 50_000,
  ttl: 30_000,
});
const logger = getLogger("project-host:http-proxy-auth");
const PROJECT_HOST_HTTP_AUTH_CONTEXT = Symbol(
  "cocalc-project-host-http-auth-context",
);
const PUBLIC_APP_HOST_HEADER = "x-cocalc-public-app-host";
function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}
const HTTP_SESSION_TTL_SECONDS = Math.max(
  300,
  envNumber(
    "COCALC_PROJECT_HOST_HTTP_SESSION_TTL_SECONDS",
    30 * 24 * 60 * 60,
  ),
);
const HTTP_UPGRADE_REVOKE_SWEEP_MS = Math.max(
  5_000,
  envNumber("COCALC_PROJECT_HOST_HTTP_REVOKE_SWEEP_MS", 30_000),
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

type AuthorizedAccountContext = {
  account_id: string;
  issued_at_s: number;
};

function setAuthContext(
  req: IncomingMessage,
  context: AuthorizedAccountContext,
): void {
  (req as any)[PROJECT_HOST_HTTP_AUTH_CONTEXT] = context;
}

function getAuthContext(
  req: IncomingMessage,
): AuthorizedAccountContext | undefined {
  return (req as any)[PROJECT_HOST_HTTP_AUTH_CONTEXT];
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

export function createProjectHostHttpSessionToken({
  account_id,
  now_ms = Date.now(),
}: {
  account_id: string;
  now_ms?: number;
}): string {
  const payload = JSON.stringify({
    account_id,
    iat: Math.floor(now_ms / 1000),
    exp: Math.floor(now_ms / 1000) + HTTP_SESSION_TTL_SECONDS,
    nonce: randomBytes(12).toString("hex"),
  });
  const encoded = base64UrlEncode(payload);
  const sig = sessionSignature(encoded);
  return `${encoded}.${sig}`;
}

export function verifyProjectHostHttpSessionToken(
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

export function resolveProjectHostHttpSessionFromCookieHeader(
  header: string | undefined,
): { account_id: string; iat_s: number; exp_s: number } | undefined {
  const tokens = readCookieValues(header, PROJECT_HOST_HTTP_SESSION_COOKIE_NAME)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const session = verifyProjectHostHttpSessionToken(token);
    if (session) {
      return session;
    }
  }
  return;
}

function readBearerToken(
  req: IncomingMessage,
): { token?: string; source?: "header" | "cookie" | "query" } {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) {
      return { token: m[1].trim(), source: "header" };
    }
  }
  const cookies = parseCookies(req.headers.cookie as string | undefined);
  const cookieToken = `${cookies[PROJECT_HOST_HTTP_AUTH_COOKIE_NAME] ?? ""}`.trim();
  if (cookieToken) {
    return { token: cookieToken, source: "cookie" };
  }
  try {
    const u = new URL(req.url ?? "/", "http://project-host.local");
    const queryToken = `${u.searchParams.get(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM) ?? ""}`.trim();
    if (queryToken) {
      return { token: queryToken, source: "query" };
    }
  } catch {
    // ignore malformed URL and fall through.
  }
  return { token: undefined, source: undefined };
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

function urlWithoutQueryToken(req: IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? "/", "http://project-host.local");
    if (!u.searchParams.has(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM)) {
      return;
    }
    u.searchParams.delete(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return;
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
  ) => Promise<AuthorizedAccountContext>;
  trackUpgradedSocket: (req: IncomingMessage, socket: Socket | Duplex) => void;
  startUpgradeRevocationKickLoop: () => () => void;
  clearCaches: () => void;
} {
  const trackedUpgradeSockets = new Set<{
    socket: Socket | Duplex;
    account_id: string;
    issued_at_s: number;
  }>();

  const verifyClaimsAndGetAccountId = (
    claims: {
      sub: string;
      act?: string;
    },
    req?: IncomingMessage,
    project_id?: string,
  ): string => {
    const actor = claims.act ?? "account";
    if (actor === "hub") {
      const publicAppHost = `${req?.headers?.[PUBLIC_APP_HOST_HEADER] ?? ""}`.trim();
      if (!publicAppHost || !project_id) {
        throw new HttpAuthError(403, "invalid actor for project-host HTTP auth");
      }
      return project_id;
    }
    if (actor !== "account") {
      throw new HttpAuthError(403, "invalid actor for project-host HTTP auth");
    }
    if (!isValidUUID(claims.sub)) {
      throw new HttpAuthError(401, "invalid account id in auth token");
    }
    return claims.sub;
  };

  const verifyBearerClaims = (token: string) => {
    try {
      return verifyProjectHostAuthToken({
        token,
        host_id,
        public_key: getProjectHostAuthPublicKey(),
      });
    } catch (err: any) {
      throw new HttpAuthError(401, err?.message ?? "invalid auth token");
    }
  };

  const sessionAccountId = (
    req: IncomingMessage,
  ):
    | {
        account_id: string;
        iat_s: number;
      }
  | undefined => {
    const tokenCount = readCookieValues(
      req.headers.cookie as string | undefined,
      PROJECT_HOST_HTTP_SESSION_COOKIE_NAME,
    ).length;
    if (!tokenCount) return;
    const session = resolveProjectHostHttpSessionFromCookieHeader(
      req.headers.cookie as string | undefined,
    );
    if (!session) {
      logger.debug("invalid project-host http session cookie", {
        host: req.headers.host,
        url: req.url,
        cookie_count: tokenCount,
      });
    }
    return session;
  };

  const clearSessionCookie = (
    req: IncomingMessage,
    res: ServerResponse,
    project_id: string,
  ) => {
    appendSetCookie(
      res,
      buildProjectHostSessionCookieDeletion({
        req,
        path: projectCookiePath(project_id),
      }),
    );
    appendSetCookie(
      res,
      buildProjectHostSessionCookieDeletion({
        req,
        path: legacyProjectHostCookiePath(),
      }),
    );
  };

  const setSessionCookie = (
    req: IncomingMessage,
    res: ServerResponse,
    account_id: string,
    project_id: string,
  ) => {
    const sessionToken = createProjectHostHttpSessionToken({ account_id });
    appendSetCookie(
      res,
      buildProjectHostSessionCookieDeletion({
        req,
        path: legacyProjectHostCookiePath(),
      }),
    );
    appendSetCookie(
      res,
      buildProjectHostSessionCookie({ req, sessionToken, project_id }),
    );
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

  const assertNotRevoked = ({
    account_id,
    issued_at_s,
  }: {
    account_id: string;
    issued_at_s: number;
  }) => {
    const revokedBeforeMs = getAccountRevokedBeforeMs(account_id);
    if (revokedBeforeMs == null) return;
    if (issued_at_s * 1000 <= revokedBeforeMs) {
      throw new HttpAuthError(401, "session revoked");
    }
  };

  const authorizeHttpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    project_id: string,
  ) => {
    const accountFromSession = sessionAccountId(req);
    if (accountFromSession) {
      try {
        assertNotRevoked({
          account_id: accountFromSession.account_id,
          issued_at_s: accountFromSession.iat_s,
        });
      } catch (err) {
        clearSessionCookie(req, res, project_id);
        throw err;
      }
      authorizeAccountForProject({
        account_id: accountFromSession.account_id,
        project_id,
      });
      setAuthContext(req, {
        account_id: accountFromSession.account_id,
        issued_at_s: accountFromSession.iat_s,
      });
      return;
    }
    const { token, source } = readBearerToken(req);
    if (!token) {
      const allowedPublic = await authorizePublicAppPath({
        project_id,
        url: req.url,
      });
      if (allowedPublic) {
        setAuthContext(req, {
          account_id: project_id,
          issued_at_s: Math.floor(Date.now() / 1000),
        });
        return;
      }
      throw new HttpAuthError(401, "missing project-host HTTP auth token");
    }
    const claims = verifyBearerClaims(token);
    const account_id = verifyClaimsAndGetAccountId(claims, req, project_id);
    assertNotRevoked({ account_id, issued_at_s: claims.iat });
    if ((claims.act ?? "account") === "account") {
      authorizeAccountForProject({ account_id, project_id });
    }
    setAuthContext(req, {
      account_id,
      issued_at_s: claims.iat,
    });
    if (source === "header") {
      delete req.headers.authorization;
    }
    setSessionCookie(req, res, account_id, project_id);
    if (source === "query") {
      // Clean the browser URL and avoid forwarding a bearer query parameter.
      const cleaned = urlWithoutQueryToken(req);
      if (cleaned && /^(GET|HEAD)$/i.test(req.method ?? "GET")) {
        res.statusCode = 302;
        res.setHeader("Location", cleaned);
        res.end("");
        return;
      }
      stripQueryToken(req);
    }
  };

  const authorizeUpgradeRequest = async (
    req: IncomingMessage,
    project_id: string,
  ): Promise<AuthorizedAccountContext> => {
    const accountFromSession = sessionAccountId(req);
    if (accountFromSession) {
      assertNotRevoked({
        account_id: accountFromSession.account_id,
        issued_at_s: accountFromSession.iat_s,
      });
      authorizeAccountForProject({
        account_id: accountFromSession.account_id,
        project_id,
      });
      const context = {
        account_id: accountFromSession.account_id,
        issued_at_s: accountFromSession.iat_s,
      };
      setAuthContext(req, context);
      return context;
    }
    const { token, source } = readBearerToken(req);
    if (!token) {
      const allowedPublic = await authorizePublicAppPath({
        project_id,
        url: req.url,
      });
      if (allowedPublic) {
        const context = {
          account_id: project_id,
          issued_at_s: Math.floor(Date.now() / 1000),
        };
        setAuthContext(req, context);
        return context;
      }
      throw new HttpAuthError(401, "missing project-host HTTP auth token");
    }
    const claims = verifyBearerClaims(token);
    const account_id = verifyClaimsAndGetAccountId(claims, req, project_id);
    assertNotRevoked({ account_id, issued_at_s: claims.iat });
    if ((claims.act ?? "account") === "account") {
      authorizeAccountForProject({ account_id, project_id });
    }
    const context = {
      account_id,
      issued_at_s: claims.iat,
    };
    setAuthContext(req, context);
    if (source === "header") {
      delete req.headers.authorization;
    }
    return context;
  };

  const trackUpgradedSocket = (
    req: IncomingMessage,
    socket: Socket | Duplex,
  ) => {
    const context = getAuthContext(req);
    if (!context) {
      return;
    }
    const entry = {
      socket,
      account_id: context.account_id,
      issued_at_s: context.issued_at_s,
    };
    trackedUpgradeSockets.add(entry);
    const remove = () => trackedUpgradeSockets.delete(entry);
    socket.once("close", remove);
    socket.once("error", remove);
    socket.once("end", remove);
  };

  const sweepRevokedUpgradeSockets = () => {
    let kicked = 0;
    for (const entry of trackedUpgradeSockets) {
      if (entry.socket.destroyed) {
        trackedUpgradeSockets.delete(entry);
        continue;
      }
      try {
        assertNotRevoked({
          account_id: entry.account_id,
          issued_at_s: entry.issued_at_s,
        });
      } catch {
        kicked += 1;
        trackedUpgradeSockets.delete(entry);
        entry.socket.destroy();
      }
    }
    return kicked;
  };

  const startUpgradeRevocationKickLoop = () => {
    const run = () => {
      const kicked = sweepRevokedUpgradeSockets();
      if (kicked > 0) {
        logger.info("revoked websocket sessions disconnected", { kicked });
      }
    };
    const timer = setInterval(run, HTTP_UPGRADE_REVOKE_SWEEP_MS);
    timer.unref();
    run();
    return () => clearInterval(timer);
  };

  return {
    authorizeHttpRequest,
    authorizeUpgradeRequest,
    trackUpgradedSocket,
    startUpgradeRevocationKickLoop,
    clearCaches: () => {
      clearProjectHostHttpProxyAuthCaches();
    },
  };
}
