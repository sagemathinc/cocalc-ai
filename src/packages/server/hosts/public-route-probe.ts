/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH } from "@cocalc/conat/auth/project-host-browser-session";
import {
  createProjectHostAgent,
  projectHostLoopbackUrlsAllowed,
  safeProjectHostUrl,
} from "@cocalc/backend/project-host-target";
import type { lookup as dnsLookup } from "node:dns";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WEBSOCKET_ATTEMPTS = 8;
const TRANSIENT_REQUEST_RETRY_DELAY_MS = 250;
const ENGINE_IO_WEBSOCKET_PATH = "/conat/?EIO=4&transport=websocket";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type FetchLike = typeof fetch;
type WebSocketUpgradeProbe = (opts: {
  url: URL;
  origin: string;
  timeout_ms: number;
  lookup?: typeof dnsLookup;
}) => Promise<{ status: number; cf_ray?: string }>;

// A fresh guarded agent per request: no socket outlives its request, and the
// address actually connected to is checked (a host-written public_url can name
// anything; see @cocalc/backend/project-host-target).
function probeAgent(url: URL, lookup?: typeof dnsLookup) {
  return createProjectHostAgent({
    secure: url.protocol === "https:",
    allowLoopback: projectHostLoopbackUrlsAllowed(),
    lookup,
  });
}

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
  expected_host_id: string;
  health_status?: number;
  health_ok?: boolean;
  health_ready?: boolean;
  health_host_id?: string;
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
  expected_host_id: string;
  health_host_id: string;
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

function errorText(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return `${error}`;
  const detail = error as Error & { cause?: unknown; code?: unknown };
  const code =
    typeof detail.code === "string" && detail.code
      ? ` code=${detail.code}`
      : "";
  const cause =
    depth < 2 && detail.cause != null && detail.cause !== error
      ? `; cause=${errorText(detail.cause, depth + 1)}`
      : "";
  return `${error.name}: ${error.message}${code}${cause}`;
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("project-host public URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("project-host public URL must not contain credentials");
  }
  // public_url may have been written by a host report: never probe a
  // loopback, link-local or metadata address (the agent checks the resolved
  // address as well).
  if (safeProjectHostUrl(value) == null) {
    throw new Error("project-host public URL is not an allowed target");
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
  lookup,
}: {
  fetchImpl?: FetchLike;
  url: URL;
  init: RequestInit;
  timeout_ms: number;
  lookup?: typeof dnsLookup;
}): Promise<Response> {
  if (fetchImpl == null) {
    try {
      return await requestWithIsolatedSocket({ url, init, timeout_ms, lookup });
    } catch (err) {
      if (!isTransientRequestError(err)) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, TRANSIENT_REQUEST_RETRY_DELAY_MS),
      );
      return await requestWithIsolatedSocket({ url, init, timeout_ms, lookup });
    }
  }
  return await fetchImpl(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout_ms),
  });
}

function isTransientRequestError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const detail = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const code = `${detail.code ?? ""}`.toUpperCase();
  const message = `${detail.message ?? ""}`;
  return (
    [
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETDOWN",
      "ENETUNREACH",
      "ENOTFOUND",
      "EPIPE",
      "ETIMEDOUT",
    ].includes(code) ||
    detail.name === "TimeoutError" ||
    /socket hang up|client network socket disconnected/i.test(message)
  );
}

async function requestWithIsolatedSocket({
  url,
  init,
  timeout_ms,
  lookup,
}: {
  url: URL;
  init: RequestInit;
  timeout_ms: number;
  lookup?: typeof dnsLookup;
}): Promise<Response> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers);
  const body =
    typeof init.body === "string" || Buffer.isBuffer(init.body)
      ? init.body
      : undefined;
  if (init.body != null && body == null) {
    throw new Error("public route probe request body must be a string");
  }
  if (body != null && !headers.has("content-length")) {
    headers.set("content-length", `${Buffer.byteLength(body)}`);
  }
  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: init.method,
      headers: Object.fromEntries(headers.entries()),
      // Do not share the application process's long-lived HTTP agent state:
      // a fresh agent that checks the address connected to.
      agent: probeAgent(url, lookup),
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      req.destroy(err);
    }, timeout_ms);
    req.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      response.once("end", () =>
        finish(() => {
          const responseHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            responseHeaders.append(
              response.rawHeaders[i],
              response.rawHeaders[i + 1],
            );
          }
          resolve(
            new Response(chunks.length ? Buffer.concat(chunks) : null, {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage,
              headers: responseHeaders,
            }),
          );
        }),
      );
      response.once("error", (err) => finish(() => reject(err)));
    });
    req.once("error", (err) => finish(() => reject(err)));
    if (body != null) req.write(body);
    req.end();
  });
}

/** One HTTP(S) request to a project host, as a fetch-style Response, through a
 * fresh guarded agent (the address connected to is checked) and never
 * following a redirect. For bay-side requests to host-written URLs. */
export async function projectHostRequest(
  url: string | URL,
  init: RequestInit = {},
  {
    timeout_ms = DEFAULT_REQUEST_TIMEOUT_MS,
    lookup,
  }: {
    timeout_ms?: number;
    lookup?: typeof dnsLookup;
  } = {},
): Promise<Response> {
  const target = typeof url === "string" ? new URL(url) : url;
  if (safeProjectHostUrl(target.toString()) == null) {
    throw new Error("project-host URL is not an allowed target");
  }
  return await requestWithIsolatedSocket({
    url: target,
    init,
    timeout_ms,
    lookup,
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
): Promise<{ ok?: boolean; ready?: boolean; host_id?: string }> {
  try {
    const value = await response.json();
    if (value == null || typeof value !== "object") return {};
    const body = value as Record<string, unknown>;
    return {
      ...(typeof body.ok === "boolean" ? { ok: body.ok } : {}),
      ...(typeof body.ready === "boolean" ? { ready: body.ready } : {}),
      ...(typeof body.host_id === "string" ? { host_id: body.host_id } : {}),
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
  lookup,
}: {
  url: URL;
  origin: string;
  timeout_ms: number;
  lookup?: typeof dnsLookup;
}): Promise<{ status: number; cf_ray?: string }> {
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      agent: probeAgent(url, lookup),
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
  expected_host_id,
  fetchImpl,
  websocketProbeImpl = probeWebSocketUpgrade,
  websocket_attempts = DEFAULT_WEBSOCKET_ATTEMPTS,
  timeout_ms = DEFAULT_REQUEST_TIMEOUT_MS,
  lookup,
}: {
  public_url: string;
  origin: string;
  expected_host_id: string;
  fetchImpl?: FetchLike;
  websocketProbeImpl?: WebSocketUpgradeProbe;
  websocket_attempts?: number;
  timeout_ms?: number;
  // For tests: the resolver behind the guarded agent.
  lookup?: typeof dnsLookup;
}): Promise<ProjectHostPublicRouteProbeResult> {
  const baseUrl = normalizedBaseUrl(public_url);
  const normalizedSiteOrigin = normalizedOrigin(origin);
  const normalizedExpectedHostId = expected_host_id.trim();
  if (!normalizedExpectedHostId) {
    throw new Error("expected project-host ID must not be empty");
  }
  const diagnostic: ProjectHostPublicRouteProbeDiagnostic = {
    stage: "health",
    public_url: baseUrl.origin,
    origin: normalizedSiteOrigin,
    expected_host_id: normalizedExpectedHostId,
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
      lookup,
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
  diagnostic.health_host_id = healthState.host_id;
  if (healthState.ok === false) {
    fail("public project-host health check reported ok=false");
  }
  if (healthState.ready === false) {
    fail("public project-host health check reported ready=false");
  }
  const healthHostId =
    healthState.host_id ??
    fail("public project-host health check did not report host_id");
  if (!healthHostId) {
    fail("public project-host health check did not report host_id");
  }
  if (healthHostId !== normalizedExpectedHostId) {
    fail(
      `public project-host health check reached host ${JSON.stringify(
        healthHostId,
      )}; expected ${JSON.stringify(normalizedExpectedHostId)}`,
    );
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
      lookup,
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
      lookup,
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
          lookup,
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
    expected_host_id: normalizedExpectedHostId,
    health_host_id: healthHostId,
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
