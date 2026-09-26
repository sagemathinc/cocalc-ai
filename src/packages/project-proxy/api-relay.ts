/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy-3";
import { isValidUUID } from "@cocalc/util/misc";
import { PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH } from "@cocalc/conat/auth/project-host-browser-session";
import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
} from "@cocalc/conat/project-host/api-relay";

export interface ApiRelayAdmission {
  projectId: string;
  stillAuthorized: () => boolean;
}

export interface ApiRelayLimits {
  connections: number;
  connectionsPerProject: number;
  attemptsPerMinute: number;
  httpBodyBytes: number;
  connectionBytes: number;
  connectionLifetimeMs: number;
  connectTimeoutMs: number;
  checkIntervalMs: number;
}

const DEFAULT_LIMITS: ApiRelayLimits = {
  connections: 1024,
  connectionsPerProject: 64,
  attemptsPerMinute: 240,
  httpBodyBytes: 8 * 1024 * 1024,
  connectionBytes: 512 * 1024 * 1024,
  connectionLifetimeMs: 2 * 60 * 60_000,
  connectTimeoutMs: 15_000,
  checkIntervalMs: 5_000,
};

type Route = {
  path: string;
  hostId?: string;
  projectId?: string;
};

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function parseApiRelayRoute(rawUrl: string, websocket: boolean): Route {
  // Do not let URL normalization turn a rejected path into an allowed one.
  if (rawUrl.length > 16_384 || /[\\\r\n#]/.test(rawUrl)) {
    fail(400, "invalid API relay path");
  }
  const [pathname] = rawUrl.split("?");
  const prefix = `${API_RELAY_PATH}/`;
  if (!pathname.startsWith(prefix)) fail(404, "unknown API relay route");
  const rest = pathname.slice(prefix.length);
  let path: string;
  let hostId: string | undefined;
  let projectId: string | undefined;
  if (rest.startsWith("hub/")) {
    path = rest.slice(3);
  } else {
    const parts = rest.split("/");
    if (
      parts[0] !== "host" ||
      !isValidUUID(parts[1]) ||
      !isValidUUID(parts[2])
    ) {
      fail(404, "unknown API relay target");
    }
    [hostId, projectId] = [parts[1], parts[2]];
    path = `/${parts.slice(3).join("/")}`;
  }
  if (websocket) {
    if (!/^\/conat\/?$/.test(path))
      fail(403, "only Conat upgrades are allowed");
  } else if (hostId) {
    if (path !== PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH) {
      fail(
        403,
        "only project-host session bootstrap HTTP requests are allowed",
      );
    }
  } else if (
    !/^\/api\/v2\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(path)
  ) {
    fail(403, "only hub API HTTP requests are allowed");
  }
  const queryOffset = rawUrl.indexOf("?");
  return {
    path: path + (queryOffset < 0 ? "" : rawUrl.slice(queryOffset)),
    hostId,
    projectId,
  };
}

function stripRelayHeaders(req: IncomingMessage): void {
  for (const name of Object.keys(req.headers)) {
    if (
      name === API_RELAY_PROJECT_HEADER ||
      name === API_RELAY_SECRET_HEADER ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("cf-") ||
      name === "x-real-ip" ||
      name === "proxy-authorization" ||
      name === "proxy-connection"
    ) {
      delete req.headers[name];
    }
  }
}

export function createApiRelay({
  authenticate,
  hubUrl,
  hostUrl,
  limits: overrides,
  onError,
}: {
  authenticate: (
    req: IncomingMessage,
  ) => ApiRelayAdmission | Promise<ApiRelayAdmission>;
  hubUrl: () => string | Promise<string>;
  hostUrl: (hostId: string, projectId: string) => Promise<string>;
  limits?: Partial<ApiRelayLimits>;
  onError?: (error: Error) => void;
}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: false,
    changeOrigin: true,
    secure: true,
    followRedirects: false,
    prependPath: false,
    proxyTimeout: limits.connectTimeoutMs,
  });
  const projects = new Map<
    string,
    { active: number; attempts: number; since: number }
  >();
  const sessions = new Set<{ cancel: () => void }>();
  const upstream = new WeakMap<
    IncomingMessage,
    (request: ClientRequest) => void
  >();
  let closed = false;
  const cleanup = setInterval(() => {
    for (const [id, state] of projects) {
      if (!state.active && Date.now() - state.since > 60_000)
        projects.delete(id);
    }
  }, 60_000);
  cleanup.unref();
  proxy.on("proxyReq", (request, req) => upstream.get(req)?.(request));
  proxy.on("proxyReqWs", (request, req) => upstream.get(req)?.(request));

  const handle = async (
    req: IncomingMessage,
    destination: ServerResponse | Duplex,
    head?: Buffer,
  ) => {
    const websocket = head != null;
    const socket = websocket ? (destination as Duplex) : req.socket;
    let admission: ApiRelayAdmission | undefined;
    let project:
      | { active: number; attempts: number; since: number }
      | undefined;
    let request: ClientRequest | undefined;
    let finished = false;
    let connected = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let monitor: ReturnType<typeof setInterval> | undefined;
    let bodyBytes = 0;
    const initialBytes = req.socket.bytesRead + req.socket.bytesWritten;
    const finish = () => {
      if (finished) return;
      finished = true;
      sessions.delete(session);
      upstream.delete(req);
      if (project) project.active--;
      clearTimeout(deadline);
      clearInterval(monitor);
      req.off("data", countBody);
    };
    const cancel = () => {
      finish();
      request?.destroy();
      destination.destroy();
    };
    const session = { cancel };
    const reject = (status: number, message: string) => {
      if (finished) return;
      finish();
      request?.destroy();
      if (websocket) {
        if (connected) socket.destroy();
        else
          socket.end(
            `HTTP/1.1 ${status} API Relay Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
      } else {
        const res = destination as ServerResponse;
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(status, {
            "content-type": "application/json",
            connection: "close",
          });
          res.end(JSON.stringify({ error: message }));
        }
      }
    };
    const countBody = (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > limits.httpBodyBytes)
        reject(413, "API relay request is too large");
    };
    try {
      if (closed) fail(503, "API relay is stopping");
      if (sessions.size >= limits.connections) fail(429, "API relay is busy");
      sessions.add(session);
      const route = parseApiRelayRoute(req.url ?? "", websocket);
      if (websocket && req.method !== "GET")
        fail(405, "invalid upgrade method");
      if (
        !websocket &&
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
          req.method ?? "",
        )
      ) {
        fail(405, "unsupported API relay method");
      }
      destination.once("close", () => {
        finish();
        request?.destroy();
      });
      if (!websocket) (destination as ServerResponse).once("finish", finish);
      deadline = setTimeout(
        () => reject(504, "API relay connection timed out"),
        limits.connectTimeoutMs,
      );
      deadline.unref();
      admission = await authenticate(req);
      if (finished) return;
      if (!projects.has(admission.projectId)) {
        if (projects.size >= limits.connections * 4)
          fail(429, "API relay is busy");
        projects.set(admission.projectId, {
          active: 0,
          attempts: 0,
          since: Date.now(),
        });
      }
      const state = projects.get(admission.projectId)!;
      if (Date.now() - state.since >= 60_000) {
        state.since = Date.now();
        state.attempts = 0;
      }
      if (
        state.active >= limits.connectionsPerProject ||
        ++state.attempts > limits.attemptsPerMinute
      ) {
        fail(429, "project API relay limit reached");
      }
      project = state;
      project.active++;
      const target = new URL(
        route.hostId
          ? await hostUrl(route.hostId, route.projectId!)
          : await hubUrl(),
      );
      if (finished) return;
      if (!admission.stillAuthorized())
        fail(403, "project API relay access ended");
      if (
        !/^https?:$/.test(target.protocol) ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
      ) {
        fail(502, "invalid configured API relay upstream");
      }
      const suffix = route.path;
      req.url = `${target.pathname.replace(/\/$/, "")}${suffix}`;
      if (Number(req.headers["content-length"] ?? 0) > limits.httpBodyBytes) {
        fail(413, "API relay request is too large");
      }
      stripRelayHeaders(req);
      upstream.set(req, (value) => {
        request = value;
        value.once(websocket ? "upgrade" : "response", () => {
          connected = true;
          clearTimeout(deadline);
          deadline = setTimeout(cancel, limits.connectionLifetimeMs);
          deadline.unref();
        });
      });
      monitor = setInterval(() => {
        try {
          const bytes =
            req.socket.bytesRead + req.socket.bytesWritten - initialBytes;
          if (!admission!.stillAuthorized() || bytes > limits.connectionBytes)
            cancel();
        } catch {
          cancel();
        }
      }, limits.checkIntervalMs);
      monitor.unref();
      const error = (err: Error) => {
        onError?.(err);
        reject(502, "API relay upstream connection failed");
      };
      // Streaming proxying retains backpressure; no response or WebSocket
      // payload is buffered or interpreted by the relay.
      if (websocket)
        proxy.ws(req, socket, head!, { target: target.origin }, error);
      else {
        req.on("data", countBody);
        proxy.web(
          req,
          destination as ServerResponse,
          { target: target.origin },
          error,
        );
      }
    } catch (error) {
      const status = (error as any)?.statusCode ?? 502;
      reject(
        status,
        status < 500
          ? `${(error as Error).message}`
          : "API relay route is unavailable",
      );
      if (status >= 500) onError?.(error as Error);
    }
  };
  return {
    handleRequest: (req: IncomingMessage, res: ServerResponse) =>
      handle(req, res),
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      handle(req, socket, head),
    close: () => {
      closed = true;
      clearInterval(cleanup);
      for (const session of sessions) session.cancel();
      projects.clear();
      proxy.close();
    },
  };
}
