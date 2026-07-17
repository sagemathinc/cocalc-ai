/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH } from "@cocalc/conat/auth/project-host-browser-session";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WEBSOCKET_ATTEMPTS = 8;
const ENGINE_IO_WEBSOCKET_PATH = "/conat/?EIO=4&transport=websocket";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type FetchLike = typeof fetch;
type WebSocketUpgradeProbe = (opts: {
  url: URL;
  origin: string;
  timeout_ms: number;
}) => Promise<{ status: number; cf_ray?: string }>;

export type ProjectHostPublicRouteProbeResult = {
  public_url: string;
  origin: string;
  health_status: number;
  preflight_status: number;
  session_status: number;
  websocket_status: number;
  websocket_attempts: number;
  edge_server?: string;
  cf_ray?: string;
};

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("project-host public URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("project-host public URL must not contain credentials");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("site origin must use HTTP or HTTPS");
  }
  return url.origin;
}

async function fetchWithTimeout({
  fetchImpl,
  url,
  init,
  timeout_ms,
}: {
  fetchImpl: FetchLike;
  url: URL;
  init: RequestInit;
  timeout_ms: number;
}): Promise<Response> {
  return await fetchImpl(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout_ms),
  });
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status and headers are the probe result. A body cancellation failure
    // must not turn a successful edge check into a false outage.
  }
}

function normalizedHeaderTokens(value: string | null): Set<string> {
  return new Set(
    `${value ?? ""}`
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function requireCorsHeaders({
  response,
  origin,
  requirePreflightHeaders,
}: {
  response: Response;
  origin: string;
  requirePreflightHeaders: boolean;
}): void {
  const allowedOrigin = `${
    response.headers.get("access-control-allow-origin") ?? ""
  }`.trim();
  if (allowedOrigin !== origin) {
    throw new Error(
      `public route returned invalid Access-Control-Allow-Origin ${JSON.stringify(
        allowedOrigin,
      )}; expected ${JSON.stringify(origin)}`,
    );
  }
  if (
    `${response.headers.get("access-control-allow-credentials") ?? ""}`
      .trim()
      .toLowerCase() !== "true"
  ) {
    throw new Error("public route did not allow credentialed browser requests");
  }
  if (!requirePreflightHeaders) return;
  const methods = normalizedHeaderTokens(
    response.headers.get("access-control-allow-methods"),
  );
  if (!methods.has("post") || !methods.has("options")) {
    throw new Error(
      "public route CORS preflight did not allow POST and OPTIONS",
    );
  }
  const headers = normalizedHeaderTokens(
    response.headers.get("access-control-allow-headers"),
  );
  if (!headers.has("authorization") || !headers.has("content-type")) {
    throw new Error(
      "public route CORS preflight did not allow Authorization and Content-Type",
    );
  }
}

async function probeWebSocketUpgrade({
  url,
  origin,
  timeout_ms,
}: {
  url: URL;
  origin: string;
  timeout_ms: number;
}): Promise<{ status: number; cf_ray?: string }> {
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: origin,
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        "Cache-Control": "no-cache",
      },
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      req.destroy(new Error(`public project-host WebSocket upgrade timed out`));
    }, timeout_ms);
    req.once("upgrade", (response, socket) => {
      socket.destroy();
      finish(() => {
        const accept = `${response.headers["sec-websocket-accept"] ?? ""}`;
        if (response.statusCode !== 101) {
          reject(
            new Error(
              `public project-host WebSocket upgrade returned HTTP ${response.statusCode ?? "unknown"}`,
            ),
          );
          return;
        }
        if (accept !== expectedAccept) {
          reject(
            new Error(
              "public project-host WebSocket upgrade returned an invalid Sec-WebSocket-Accept header",
            ),
          );
          return;
        }
        resolve({
          status: response.statusCode,
          cf_ray: `${response.headers["cf-ray"] ?? ""}`.trim() || undefined,
        });
      });
    });
    req.once("response", (response) => {
      response.resume();
      finish(() =>
        reject(
          new Error(
            `public project-host WebSocket upgrade returned HTTP ${response.statusCode ?? "unknown"}`,
          ),
        ),
      );
    });
    req.once("error", (err) => finish(() => reject(err)));
    req.end();
  });
}

export async function probeProjectHostPublicRoute({
  public_url,
  origin,
  fetchImpl = fetch,
  websocketProbeImpl = probeWebSocketUpgrade,
  websocket_attempts = DEFAULT_WEBSOCKET_ATTEMPTS,
  timeout_ms = DEFAULT_REQUEST_TIMEOUT_MS,
}: {
  public_url: string;
  origin: string;
  fetchImpl?: FetchLike;
  websocketProbeImpl?: WebSocketUpgradeProbe;
  websocket_attempts?: number;
  timeout_ms?: number;
}): Promise<ProjectHostPublicRouteProbeResult> {
  const baseUrl = normalizedBaseUrl(public_url);
  const normalizedSiteOrigin = normalizedOrigin(origin);
  const headers = {
    Origin: normalizedSiteOrigin,
    "Cache-Control": "no-cache",
  };

  const healthUrl = new URL("/healthz", baseUrl);
  const health = await fetchWithTimeout({
    fetchImpl,
    url: healthUrl,
    init: { method: "GET", headers },
    timeout_ms,
  });
  await discardBody(health);
  if (health.status !== 200) {
    throw new Error(
      `public project-host health check returned HTTP ${health.status}`,
    );
  }

  const sessionUrl = new URL(
    PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH,
    baseUrl,
  );
  const preflight = await fetchWithTimeout({
    fetchImpl,
    url: sessionUrl,
    init: {
      method: "OPTIONS",
      headers: {
        ...headers,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    },
    timeout_ms,
  });
  await discardBody(preflight);
  if (preflight.status !== 204) {
    throw new Error(
      `public project-host CORS preflight returned HTTP ${preflight.status}`,
    );
  }
  requireCorsHeaders({
    response: preflight,
    origin: normalizedSiteOrigin,
    requirePreflightHeaders: true,
  });

  const session = await fetchWithTimeout({
    fetchImpl,
    url: sessionUrl,
    init: {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    timeout_ms,
  });
  await discardBody(session);
  if (session.status !== 401) {
    throw new Error(
      `unauthenticated public project-host session check returned HTTP ${session.status}; expected 401`,
    );
  }
  requireCorsHeaders({
    response: session,
    origin: normalizedSiteOrigin,
    requirePreflightHeaders: false,
  });

  const attemptCount = Math.max(1, Math.floor(websocket_attempts) || 1);
  const websocketUrl = new URL(ENGINE_IO_WEBSOCKET_PATH, baseUrl);
  const websocketResults = await Promise.allSettled(
    Array.from({ length: attemptCount }, () =>
      websocketProbeImpl({
        url: websocketUrl,
        origin: normalizedSiteOrigin,
        timeout_ms,
      }),
    ),
  );
  const websocketFailures = websocketResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (websocketFailures.length) {
    const firstError = websocketFailures[0].reason;
    throw new Error(
      `${websocketFailures.length}/${attemptCount} public project-host WebSocket upgrades failed: ${firstError}`,
    );
  }
  const websocketPasses = websocketResults as PromiseFulfilledResult<{
    status: number;
    cf_ray?: string;
  }>[];

  return {
    public_url: baseUrl.origin,
    origin: normalizedSiteOrigin,
    health_status: health.status,
    preflight_status: preflight.status,
    session_status: session.status,
    websocket_status: websocketPasses[0].value.status,
    websocket_attempts: attemptCount,
    edge_server: health.headers.get("server") ?? undefined,
    cf_ray: health.headers.get("cf-ray") ?? undefined,
  };
}

export const _test = { probeWebSocketUpgrade };
