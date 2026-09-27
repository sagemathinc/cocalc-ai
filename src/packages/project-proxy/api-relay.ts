/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import { Duplex, type Transform } from "node:stream";
import type { Socket } from "node:net";
import httpProxy from "http-proxy-3";
import { isValidUUID } from "@cocalc/util/misc";
import { meteredStream, type ApiRelayMeter } from "./api-relay-meter";
import { PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH } from "@cocalc/conat/auth/project-host-browser-session";
import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
  API_RELAY_HUB_HEADER,
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
  preAuthAttemptsPerMinute: number;
  peerAttemptsPerMinute: number;
  connectionLifetimeMs: number;
  connectTimeoutMs: number;
  checkIntervalMs: number;
}

const DEFAULT_LIMITS: ApiRelayLimits = {
  connections: 1024,
  connectionsPerProject: 64,
  attemptsPerMinute: 240,
  httpBodyBytes: 8 * 1024 * 1024,
  preAuthAttemptsPerMinute: 12_000,
  peerAttemptsPerMinute: 2_400,
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
      name === API_RELAY_HUB_HEADER ||
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
  createMeter,
}: {
  authenticate: (
    req: IncomingMessage,
  ) => ApiRelayAdmission | Promise<ApiRelayAdmission>;
  hubUrl: (requestedUrl?: string) => string | Promise<string>;
  hostUrl: (hostId: string, projectId: string) => Promise<string>;
  limits?: Partial<ApiRelayLimits>;
  onError?: (error: Error) => void;
  createMeter: (opts: {
    projectId: string;
    target: string;
    websocket: boolean;
    onError: (error: Error) => void;
  }) => Promise<ApiRelayMeter>;
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
  const responses = new WeakMap<
    IncomingMessage,
    (response: IncomingMessage) => void
  >();
  let closed = false;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const admitAttempt = (key: string, limit: number) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 256) fail(429, "API relay admission is busy");
      bucket = { tokens: limit, at: now };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(
      limit,
      bucket.tokens + (Math.max(0, now - bucket.at) * limit) / 60_000,
    );
    bucket.at = now;
    if (bucket.tokens < 1) fail(429, "API relay admission rate exceeded");
    bucket.tokens--;
  };
  const cleanup = setInterval(() => {
    for (const [key, bucket] of buckets) {
      if (Date.now() - bucket.at > 60_000) buckets.delete(key);
    }
    for (const [id, state] of projects) {
      if (!state.active && Date.now() - state.since > 60_000)
        projects.delete(id);
    }
  }, 60_000);
  cleanup.unref();
  proxy.on("proxyReq", (request, req) => upstream.get(req)?.(request));
  proxy.on("proxyReqWs", (request, req) => upstream.get(req)?.(request));
  proxy.on("proxyRes", (response, req) => {
    const handle = responses.get(req);
    responses.delete(req);
    if (handle) handle(response);
    else response.destroy();
  });

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
    let upstreamSocket: Duplex | undefined;
    let meter: ApiRelayMeter | undefined;
    const streams: Transform[] = [];
    let wsAdapter: Duplex | undefined;
    let finished = false;
    let connected = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let monitor: ReturnType<typeof setInterval> | undefined;
    let bodyBytes = 0;
    const finish = (reason = "completed") => {
      if (finished) return;
      finished = true;
      sessions.delete(session);
      upstream.delete(req);
      responses.delete(req);
      if (project) project.active--;
      clearTimeout(deadline);
      clearInterval(monitor);
      req.off("data", countBody);
      for (const stream of streams) stream.destroy();
      void meter?.close(reason).catch((err) => onError?.(err));
    };
    const cancel = (reason = "cancelled") => {
      finish(reason);
      request?.destroy();
      upstreamSocket?.destroy();
      wsAdapter?.destroy();
      destination.destroy();
    };
    const session = { cancel };
    const reject = (status: number, message: string) => {
      if (finished) return;
      finish(message);
      request?.destroy();
      upstreamSocket?.destroy();
      wsAdapter?.destroy();
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
      // Claimed project IDs are untrusted here; rotating one must not reset
      // admission. The local peer is coarse (containers can share loopback).
      admitAttempt("global", limits.preAuthAttemptsPerMinute);
      admitAttempt(
        `peer:${req.socket.remoteAddress ?? "unknown"}`,
        limits.peerAttemptsPerMinute,
      );
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
        cancel("downstream closed");
      });
      if (!websocket)
        (destination as ServerResponse).once("finish", () => finish());
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
      const requestedHub = req.headers[API_RELAY_HUB_HEADER];
      if (requestedHub != null && typeof requestedHub !== "string")
        fail(400, "invalid API relay hub header");
      const target = new URL(
        route.hostId
          ? await hostUrl(route.hostId, route.projectId!)
          : await hubUrl(requestedHub),
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
      meter = await createMeter({
        projectId: admission.projectId,
        target: route.hostId
          ? `host:${route.hostId}/project:${route.projectId}`
          : target.origin,
        websocket,
        onError: (err) => {
          onError?.(err);
          cancel("usage renewal failed");
        },
      });
      if (finished) {
        await meter.close("admission ended");
        return;
      }
      if (!admission.stillAuthorized())
        fail(403, "project API relay access ended");
      const stream = (direction: "sent" | "received") => {
        const value = meteredStream(meter!, direction);
        value.on("error", (err) => {
          onError?.(err);
          cancel(
            (err as any).statusCode === 429
              ? "account traffic quota exhausted"
              : "stream failed",
          );
        });
        streams.push(value);
        return value;
      };
      stripRelayHeaders(req);
      upstream.set(req, (value) => {
        request = value;
        value.once(websocket ? "upgrade" : "response", (_res, upgraded) => {
          if (websocket) upstreamSocket = upgraded;
          if (finished) {
            upgraded?.destroy();
            value.destroy();
            return;
          }
          connected = true;
          clearTimeout(deadline);
          deadline = setTimeout(
            () => cancel("connection lifetime ended"),
            limits.connectionLifetimeMs,
          );
          deadline.unref();
        });
      });
      monitor = setInterval(() => {
        try {
          if (!admission!.stillAuthorized())
            cancel("source authorization ended");
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
      if (websocket) {
        // Wrap both directions, including the upgrade head, so http-proxy's
        // socket piping retains backpressure while waiting for quota renewal.
        if (head!.length) socket.unshift(head!);
        const input = stream("sent");
        const output = stream("received");
        socket.pipe(input);
        output.pipe(socket);
        wsAdapter = new Duplex({
          read() {
            input.resume();
          },
          write(chunk, encoding, done) {
            output.write(chunk, encoding, (err) => {
              // The meter owns cancellation of both peers. Do not propagate
              // the same error through a second writable after destroying it.
              if (err)
                cancel(
                  (err as any).statusCode === 429
                    ? "account traffic quota exhausted"
                    : "stream failed",
                );
              done();
            });
          },
          final(done) {
            output.end(done);
          },
          destroy(err, done) {
            input.destroy();
            output.destroy();
            done(err);
          },
        });
        const adapter = wsAdapter;
        input.on("data", (chunk) => {
          if (!adapter.push(chunk)) input.pause();
        });
        input.on("end", () => adapter.push(null));
        wsAdapter.on("error", error);
        for (const method of [
          "setTimeout",
          "setNoDelay",
          "setKeepAlive",
          "destroySoon",
        ]) {
          (wsAdapter as any)[method] = (...args) =>
            (socket as any)[method](...args);
        }
        proxy.ws(
          req,
          wsAdapter as Socket,
          Buffer.alloc(0),
          { target: target.origin },
          error,
        );
      } else {
        req.on("data", countBody);
        const input = req.pipe(stream("sent"));
        responses.set(req, (upstreamRes) => {
          const res = destination as ServerResponse;
          if (finished) {
            upstreamRes.destroy();
            return;
          }
          const headers = { ...upstreamRes.headers };
          delete headers.connection;
          delete headers["transfer-encoding"];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.on("error", error);
          upstreamRes.pipe(stream("received")).pipe(res);
        });
        proxy.web(
          req,
          destination as ServerResponse,
          { target: target.origin, selfHandleResponse: true, buffer: input },
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
