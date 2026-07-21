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

export type ProjectHostPublicRouteProbeStage =
  | "health"
  | "preflight"
  | "session"
  | "websocket";

export type ProjectHostWebSocketProbeSample = {
  ok: boolean;
  duration_ms: number;
  status?: number;
  cf_ray?: string;
  error?: string;
};

export type ProjectHostPublicRouteProbeDiagnostic = {
  stage: ProjectHostPublicRouteProbeStage;
  public_url: string;
  origin: string;
  health_status?: number;
  health_ok?: boolean;
  health_ready?: boolean;
  preflight_status?: number;
  session_status?: number;
  edge_server?: string;
  cf_ray?: string;
  websocket_attempts?: number;
  websocket_successes?: number;
  websocket_failures?: number;
  websocket_samples?: ProjectHostWebSocketProbeSample[];
};

export type ProjectHostPublicRouteProbeResult = {
  public_url: string;
  origin: string;
  health_status: number;
  preflight_status: number;
  session_status: number;
  websocket_status: number;
  websocket_attempts: number;
  websocket_successes: number;
  websocket_failures: number;
  websocket_samples: ProjectHostWebSocketProbeSample[];
  edge_server?: string;
  cf_ray?: string;
};

export class ProjectHostPublicRouteProbeError extends Error {
  readonly diagnostic: ProjectHostPublicRouteProbeDiagnostic;

  constructor(
    message: string,
    diagnostic: ProjectHostPublicRouteProbeDiagnostic,
  ) {
    super(message);
    this.name = "ProjectHostPublicRouteProbeError";
    this.diagnostic = diagnostic;
  }
}

class WebSocketUpgradeError extends Error {
  readonly status?: number;
  readonly cf_ray?: string;

  constructor(message: string, opts?: { status?: number; cf_ray?: string }) {
    super(message);
    this.name = "WebSocketUpgradeError";
    this.status = opts?.status;
    this.cf_ray = opts?.cf_ray;
  }
}

export function projectHostPublicRouteProbeDiagnostic(
  error: unknown,
): ProjectHostPublicRouteProbeDiagnostic | undefined {
  return error instanceof ProjectHostPublicRouteProbeError
    ? error.diagnostic
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : `${error}`;
}

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

async function readHealthState(
  response: Response,
): Promise<{ ok?: boolean; ready?: boolean }> {
  try {
    const value = await response.json();
    if (value == null || typeof value !== "object") return {};
    const body = value as Record<string, unknown>;
    return {
      ...(typeof body.ok === "boolean" ? { ok: body.ok } : {}),
      ...(typeof body.ready === "boolean" ? { ready: body.ready } : {}),
    };
  } catch {
    return {};
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
        const cfRay = `${response.headers["cf-ray"] ?? ""}`.trim() || undefined;
        if (response.statusCode !== 101) {
          reject(
            new WebSocketUpgradeError(
              `public project-host WebSocket upgrade returned HTTP ${response.statusCode ?? "unknown"}`,
              { status: response.statusCode, cf_ray: cfRay },
            ),
          );
          return;
        }
        if (accept !== expectedAccept) {
          reject(
            new WebSocketUpgradeError(
              "public project-host WebSocket upgrade returned an invalid Sec-WebSocket-Accept header",
              { status: response.statusCode, cf_ray: cfRay },
            ),
          );
          return;
        }
        resolve({
          status: response.statusCode,
          cf_ray: cfRay,
        });
      });
    });
    req.once("response", (response) => {
      const status = response.statusCode;
      const cfRay = `${response.headers["cf-ray"] ?? ""}`.trim() || undefined;
      response.resume();
      finish(() =>
        reject(
          new WebSocketUpgradeError(
            `public project-host WebSocket upgrade returned HTTP ${status ?? "unknown"}`,
            { status, cf_ray: cfRay },
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
  const diagnostic: ProjectHostPublicRouteProbeDiagnostic = {
    stage: "health",
    public_url: baseUrl.origin,
    origin: normalizedSiteOrigin,
  };
  const fail = (message: string): never => {
    throw new ProjectHostPublicRouteProbeError(message, {
      ...diagnostic,
      websocket_samples: diagnostic.websocket_samples?.map((sample) => ({
        ...sample,
      })),
    });
  };
  const headers = {
    Origin: normalizedSiteOrigin,
    "Cache-Control": "no-cache",
  };

  const healthUrl = new URL("/healthz", baseUrl);
  let health!: Response;
  try {
    health = await fetchWithTimeout({
      fetchImpl,
      url: healthUrl,
      init: { method: "GET", headers },
      timeout_ms,
    });
  } catch (err) {
    fail(`public project-host health check failed: ${errorText(err)}`);
  }
  diagnostic.health_status = health.status;
  diagnostic.edge_server = health.headers.get("server") ?? undefined;
  diagnostic.cf_ray = health.headers.get("cf-ray") ?? undefined;
  if (health.status !== 200) {
    await discardBody(health);
    fail(`public project-host health check returned HTTP ${health.status}`);
  }
  const healthState = await readHealthState(health);
  diagnostic.health_ok = healthState.ok;
  diagnostic.health_ready = healthState.ready;
  if (healthState.ok === false) {
    fail("public project-host health check reported ok=false");
  }
  if (healthState.ready === false) {
    fail("public project-host health check reported ready=false");
  }

  const sessionUrl = new URL(
    PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH,
    baseUrl,
  );
  diagnostic.stage = "preflight";
  let preflight!: Response;
  try {
    preflight = await fetchWithTimeout({
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
  } catch (err) {
    fail(`public project-host CORS preflight failed: ${errorText(err)}`);
  }
  await discardBody(preflight);
  diagnostic.preflight_status = preflight.status;
  if (preflight.status !== 204) {
    fail(
      `public project-host CORS preflight returned HTTP ${preflight.status}`,
    );
  }
  try {
    requireCorsHeaders({
      response: preflight,
      origin: normalizedSiteOrigin,
      requirePreflightHeaders: true,
    });
  } catch (err) {
    fail(errorText(err));
  }

  diagnostic.stage = "session";
  let session!: Response;
  try {
    session = await fetchWithTimeout({
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
  } catch (err) {
    fail(`public project-host session check failed: ${errorText(err)}`);
  }
  await discardBody(session);
  diagnostic.session_status = session.status;
  if (session.status !== 401) {
    fail(
      `unauthenticated public project-host session check returned HTTP ${session.status}; expected 401`,
    );
  }
  try {
    requireCorsHeaders({
      response: session,
      origin: normalizedSiteOrigin,
      requirePreflightHeaders: false,
    });
  } catch (err) {
    fail(errorText(err));
  }

  diagnostic.stage = "websocket";
  const attemptCount = Math.max(1, Math.floor(websocket_attempts) || 1);
  const websocketUrl = new URL(ENGINE_IO_WEBSOCKET_PATH, baseUrl);
  const websocketSamples = await Promise.all(
    Array.from({ length: attemptCount }, async () => {
      const startedAt = Date.now();
      try {
        const result = await websocketProbeImpl({
          url: websocketUrl,
          origin: normalizedSiteOrigin,
          timeout_ms,
        });
        return {
          ok: true,
          duration_ms: Date.now() - startedAt,
          status: result.status,
          cf_ray: result.cf_ray,
        } satisfies ProjectHostWebSocketProbeSample;
      } catch (err) {
        return {
          ok: false,
          duration_ms: Date.now() - startedAt,
          status: err instanceof WebSocketUpgradeError ? err.status : undefined,
          cf_ray: err instanceof WebSocketUpgradeError ? err.cf_ray : undefined,
          error: errorText(err),
        } satisfies ProjectHostWebSocketProbeSample;
      }
    }),
  );
  const websocketPasses = websocketSamples.filter((sample) => sample.ok);
  const websocketFailures = websocketSamples.filter((sample) => !sample.ok);
  const websocketSuccesses = websocketPasses.length;
  diagnostic.websocket_attempts = attemptCount;
  diagnostic.websocket_successes = websocketSuccesses;
  diagnostic.websocket_failures = websocketFailures.length;
  diagnostic.websocket_samples = websocketSamples;
  const minimumWebsocketSuccesses = Math.max(1, Math.ceil(attemptCount * 0.75));
  if (websocketSuccesses < minimumWebsocketSuccesses) {
    fail(
      `${websocketFailures.length}/${attemptCount} public project-host WebSocket upgrades failed: ${websocketFailures[0]?.error ?? "unknown error"}`,
    );
  }
  const firstPass = websocketPasses[0];
  if (!firstPass?.status) {
    fail("public project-host WebSocket probe had no successful status");
  }

  return {
    public_url: baseUrl.origin,
    origin: normalizedSiteOrigin,
    health_status: health.status,
    preflight_status: preflight.status,
    session_status: session.status,
    websocket_status: firstPass.status,
    websocket_attempts: attemptCount,
    websocket_successes: websocketSuccesses,
    websocket_failures: websocketFailures.length,
    websocket_samples: websocketSamples,
    edge_server: diagnostic.edge_server,
    cf_ray: diagnostic.cf_ray,
  };
}

export const _test = { probeWebSocketUpgrade };
