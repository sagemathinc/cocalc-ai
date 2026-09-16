#!/usr/bin/env node
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");

function env(name, fallback) {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function intEnv(name, fallback) {
  const value = Number.parseInt(env(name, `${fallback}`), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const bindHost = env("COCALC_BAY_FRONTDOOR_HOST", "127.0.0.1");
const bindPort = intEnv("COCALC_BAY_FRONTDOOR_PORT", 9400);
const publicIngressMode = env(
  "COCALC_BAY_PUBLIC_INGRESS_MODE",
  "cloudflare-tunnel",
);
if (!["cloudflare-tunnel", "cloudflare-proxy"].includes(publicIngressMode)) {
  throw new Error(
    `invalid COCALC_BAY_PUBLIC_INGRESS_MODE: ${publicIngressMode}`,
  );
}
const healthPath = env(
  "COCALC_BAY_FRONTDOOR_HEALTH_PATH",
  "/_cocalc/frontdoor/healthz",
);
const defaultDrainFile = process.env.COCALC_BAY_STATE_DIR
  ? `${process.env.COCALC_BAY_STATE_DIR}/frontdoor-drain-workers`
  : "";
const drainFile = env("COCALC_BAY_FRONTDOOR_DRAIN_FILE", defaultDrainFile);
const workerHost = env("COCALC_BAY_HUB_BIND_HOST", "127.0.0.1");
const workerBasePort = intEnv("COCALC_BAY_HUB_BASE_PORT", 9300);
const workerCount = intEnv("COCALC_BAY_WORKER_COUNT", 1);
const workerHealthPath = env("COCALC_BAY_HUB_HEALTH_PATH", "/alive");
const affinityCookieName = env(
  "COCALC_BAY_FRONTDOOR_AFFINITY_COOKIE",
  "cocalc_bay_frontdoor_worker",
);
const affinityMaxAgeSeconds = intEnv(
  "COCALC_BAY_FRONTDOOR_AFFINITY_MAX_AGE_SECONDS",
  3600,
);
const immutableStaticMaxAgeSeconds = 365 * 24 * 60 * 60;
const minHealthyWorkers = Math.min(
  intEnv("COCALC_BAY_MIN_HEALTHY_WORKERS", 1),
  workerCount,
);
const healthIntervalMs = intEnv(
  "COCALC_BAY_FRONTDOOR_HEALTH_INTERVAL_MS",
  1000,
);
const unhealthyThreshold = intEnv(
  "COCALC_BAY_FRONTDOOR_UNHEALTHY_THRESHOLD",
  3,
);
const applicationTimeoutWindowMs = intEnv(
  "COCALC_BAY_FRONTDOOR_APPLICATION_TIMEOUT_WINDOW_MS",
  60_000,
);
const maxApplicationTimeoutObservations = 1024;
const healthErrorMaxBytes = intEnv(
  "COCALC_BAY_FRONTDOOR_HEALTH_ERROR_MAX_BYTES",
  2048,
);
const upstreamTimeoutMs = intEnv(
  "COCALC_BAY_FRONTDOOR_UPSTREAM_TIMEOUT_MS",
  15000,
);

let nextWorkerOffset = 0;
const workers = Array.from({ length: workerCount }, (_, index) => ({
  id: index + 1,
  host: workerHost,
  port: workerBasePort + index,
  healthy: false,
  consecutiveFailures: 0,
  lastOk: 0,
  lastError: "not checked yet",
  applicationTimeouts: [],
  lastApplicationTimeout: 0,
  lastApplicationTimeoutError: "",
  upgrades: new Set(),
}));

const signingKey = readSigningKey();

function log(message, extra) {
  const suffix = extra == null ? "" : ` ${JSON.stringify(extra)}`;
  console.log(`[bay-frontdoor] ${message}${suffix}`);
}

function readSigningKey() {
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  const candidates = [
    credentialDir ? `${credentialDir}/site-master-key` : "",
    "/etc/cocalc/site-master-key",
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const key = fs.readFileSync(path);
      if (key.length > 0) {
        return key;
      }
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "EACCES") {
        log("failed to read affinity signing key", {
          path,
          error: err.message,
        });
      }
    }
  }
  return undefined;
}

function evictWorkerUpgrades(worker) {
  if (worker.upgrades.size === 0) {
    return;
  }
  log("evicting upgraded connections from unhealthy worker", {
    worker_id: worker.id,
    connections: worker.upgrades.size,
  });
  for (const connection of [...worker.upgrades]) {
    connection.socket.destroy();
    connection.upstream.destroy();
  }
}

function recordWorkerHealth(worker, ok, error = "", now = Date.now()) {
  const wasHealthy = worker.healthy;
  if (ok) {
    worker.healthy = true;
    worker.consecutiveFailures = 0;
    worker.lastOk = now;
    worker.lastError = "";
  } else {
    worker.consecutiveFailures += 1;
    worker.lastError = error;
    if (worker.consecutiveFailures >= unhealthyThreshold) {
      worker.healthy = false;
    }
  }
  if (wasHealthy && !worker.healthy) {
    log("worker became unhealthy", {
      worker_id: worker.id,
      consecutive_failures: worker.consecutiveFailures,
      error: worker.lastError,
    });
    evictWorkerUpgrades(worker);
  } else if (!wasHealthy && worker.healthy) {
    log("worker recovered", { worker_id: worker.id });
  }
}

// Application requests are client-controlled and may intentionally run longer
// than the proxy timeout. Keep bounded evidence, but only the independent
// worker readiness probe may change global routing health.
function recordWorkerApplicationTimeout(worker, error, now = Date.now()) {
  const cutoff = now - applicationTimeoutWindowMs;
  worker.applicationTimeouts = (worker.applicationTimeouts ?? []).filter(
    (observedAt) => observedAt >= cutoff,
  );
  if (worker.applicationTimeouts.length >= maxApplicationTimeoutObservations) {
    worker.applicationTimeouts.splice(
      0,
      worker.applicationTimeouts.length - maxApplicationTimeoutObservations + 1,
    );
  }
  worker.applicationTimeouts.push(now);
  worker.lastApplicationTimeout = now;
  worker.lastApplicationTimeoutError = error;
  const timeoutCount = worker.applicationTimeouts.length;
  if ([1, 10, 100, 1000].includes(timeoutCount)) {
    log("upstream application request timed out", {
      worker_id: worker.id,
      timeout_count: timeoutCount,
      timeout_window_ms: applicationTimeoutWindowMs,
      error,
    });
  }
  return timeoutCount;
}

function recentApplicationTimeouts(worker, now = Date.now()) {
  const cutoff = now - applicationTimeoutWindowMs;
  worker.applicationTimeouts = (worker.applicationTimeouts ?? []).filter(
    (observedAt) => observedAt >= cutoff,
  );
  return worker.applicationTimeouts;
}

function formatHealthError(statusCode, body) {
  const detail = `${body ?? ""}`.replace(/\s+/g, " ").trim();
  return detail
    ? `health status ${statusCode}: ${detail}`
    : `health status ${statusCode}`;
}

function checkWorker(worker) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, error = "") => {
      if (settled) {
        return;
      }
      settled = true;
      recordWorkerHealth(worker, ok, error);
      resolve();
    };
    const req = http.request(
      {
        hostname: worker.host,
        port: worker.port,
        path: workerHealthPath,
        method: "GET",
        timeout: Math.min(5000, upstreamTimeoutMs),
      },
      (res) => {
        const ok =
          res.statusCode != null &&
          res.statusCode >= 200 &&
          res.statusCode < 400;
        if (ok) {
          res.resume();
          finish(true);
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          if (bytes >= healthErrorMaxBytes) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const selected = buffer.subarray(0, healthErrorMaxBytes - bytes);
          chunks.push(selected);
          bytes += selected.length;
        });
        res.once("end", () => {
          finish(
            false,
            formatHealthError(
              res.statusCode,
              Buffer.concat(chunks).toString("utf8"),
            ),
          );
        });
        res.once("error", (err) => finish(false, err.message));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("health timeout"));
    });
    req.on("error", (err) => {
      finish(false, err.message);
    });
    req.end();
  });
}

async function refreshHealth() {
  await Promise.all(workers.map(checkWorker));
}

let healthRefreshInFlight;
function scheduleHealthRefresh() {
  if (healthRefreshInFlight != null) {
    return healthRefreshInFlight;
  }
  healthRefreshInFlight = refreshHealth()
    .catch((err) => log("health refresh failed", { error: err.message }))
    .finally(() => {
      healthRefreshInFlight = undefined;
    });
  return healthRefreshInFlight;
}

function healthyWorkers() {
  const drained = drainedWorkerIds();
  return workers.filter((worker) => worker.healthy && !drained.has(worker.id));
}

function workerById(id) {
  return workers.find((worker) => worker.id === id);
}

function isAvailable(worker) {
  return worker != null && worker.healthy && !drainedWorkerIds().has(worker.id);
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of `${header ?? ""}`.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function signWorkerId(id) {
  if (signingKey == null) {
    return `${id}`;
  }
  const mac = crypto
    .createHmac("sha256", signingKey)
    .update(`${id}`)
    .digest("base64url")
    .slice(0, 32);
  return `${id}.${mac}`;
}

function verifyWorkerCookie(value) {
  const [idText, mac] = `${value ?? ""}`.split(".");
  const id = Number.parseInt(idText, 10);
  if (!Number.isInteger(id) || id < 1 || id > workerCount) {
    return undefined;
  }
  if (signingKey == null) {
    return id;
  }
  const expected = signWorkerId(id).split(".")[1];
  const macBuffer = Buffer.from(`${mac ?? ""}`);
  const expectedBuffer = Buffer.from(expected);
  if (macBuffer.length !== expectedBuffer.length) {
    return undefined;
  }
  if (crypto.timingSafeEqual(macBuffer, expectedBuffer)) {
    return id;
  }
  return undefined;
}

function affinityWorker(req) {
  const cookie = parseCookies(req.headers.cookie).get(affinityCookieName);
  const id = verifyWorkerCookie(cookie);
  if (id == null) {
    return undefined;
  }
  const worker = workerById(id);
  return isAvailable(worker) ? worker : undefined;
}

// A hard navigation tears down the current page's API and WebSocket traffic,
// so it is a safe recovery boundary for worker affinity. Rotating here means a
// browser refresh escapes a worker whose readiness probe still succeeds
// while normal application requests are stuck. Requests made by the loaded
// application remain pinned to the newly selected worker.
function isTopLevelDocumentNavigation(req) {
  if (`${req?.method ?? ""}`.toUpperCase() !== "GET") {
    return false;
  }
  const mode = `${req?.headers?.["sec-fetch-mode"] ?? ""}`.toLowerCase();
  const destination = `${req?.headers?.["sec-fetch-dest"] ?? ""}`.toLowerCase();
  return mode === "navigate" && destination === "document";
}

function selectWorkerCandidate({ candidates, sticky, rotate, offset }) {
  if (sticky != null && !rotate) {
    return { worker: sticky, changed: false, nextOffset: offset };
  }
  if (candidates.length === 0) {
    return undefined;
  }
  const pool =
    rotate && sticky != null && candidates.length > 1
      ? candidates.filter((worker) => worker.id !== sticky.id)
      : candidates;
  const worker = pool[offset % pool.length];
  return {
    worker,
    changed: sticky == null || worker.id !== sticky.id,
    nextOffset: offset + 1,
  };
}

function drainedWorkerIds() {
  const drained = new Set();
  if (!drainFile) {
    return drained;
  }
  try {
    for (const id of fs.readFileSync(drainFile, "utf8").split(/[\s,]+/)) {
      const value = Number.parseInt(id, 10);
      if (Number.isInteger(value) && value > 0) {
        drained.add(value);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      log("failed to read drain file", { drainFile, error: err.message });
    }
  }
  return drained;
}

function chooseWorker(req) {
  const sticky = req == null ? undefined : affinityWorker(req);
  const candidates = healthyWorkers();
  const selected = selectWorkerCandidate({
    candidates,
    sticky,
    rotate: isTopLevelDocumentNavigation(req),
    offset: nextWorkerOffset,
  });
  if (selected == null) {
    return undefined;
  }
  nextWorkerOffset = selected.nextOffset;
  return { worker: selected.worker, changed: selected.changed };
}

function affinitySetCookie(worker) {
  return [
    `${affinityCookieName}=${signWorkerId(worker.id)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${affinityMaxAgeSeconds}`,
  ].join("; ");
}

function addAffinityCookie(headers, worker, changed) {
  if (!changed) {
    return headers;
  }
  const nextHeaders = { ...headers };
  const cookie = affinitySetCookie(worker);
  const existing = nextHeaders["set-cookie"];
  if (existing == null) {
    nextHeaders["set-cookie"] = cookie;
  } else if (Array.isArray(existing)) {
    nextHeaders["set-cookie"] = [...existing, cookie];
  } else {
    nextHeaders["set-cookie"] = [existing, cookie];
  }
  return nextHeaders;
}

function isContentAddressedStaticRequest(req) {
  const pathname = `${req?.url ?? ""}`.split(/[?#]/, 1)[0];
  const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  return (
    /(?:^|\/)static\//.test(pathname) &&
    /(?:^|[-.])[0-9a-f]{16,}(?=[-.]|$)/i.test(basename)
  );
}

// Only a successfully served asset is safe to pin. A hashed URL that 404s or
// errors during a release must never be stored: `immutable` would keep that
// failure at the edge, and in every browser that saw it, for a full year.
function isImmutableStaticStatus(statusCode) {
  return statusCode === 200 || statusCode === 203 || statusCode === 304;
}

// A response marked `public` may be stored by Cloudflare and by any proxy
// between us and the browser. Attaching the per-client worker-affinity cookie
// to one hands whichever worker the first visitor drew to everyone who is
// later served that stored copy, and makes Cloudflare bypass the asset. A
// response that must carry affinity has to say `private` (or no-store).
function isPubliclyCacheable(headers) {
  const value = headers?.["cache-control"];
  const text = Array.isArray(value) ? value.join(",") : `${value ?? ""}`;
  return text
    .split(",")
    .some((directive) => directive.trim().toLowerCase() === "public");
}

function prepareResponseHeaders(req, headers, worker, changed, statusCode) {
  if (isContentAddressedStaticRequest(req)) {
    if (!isImmutableStaticStatus(statusCode)) {
      return { ...headers, "cache-control": "no-store" };
    }
    return {
      ...headers,
      "cache-control": `public, max-age=${immutableStaticMaxAgeSeconds}, immutable`,
      expires: new Date(
        Date.now() + immutableStaticMaxAgeSeconds * 1000,
      ).toUTCString(),
    };
  }
  if (isPubliclyCacheable(headers)) {
    return headers;
  }
  return addAffinityCookie(headers, worker, changed);
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRemoteAddress(req) {
  const address = `${req.socket?.remoteAddress ?? ""}`.trim();
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function proxyRequestHeaders(req, worker) {
  const headers = { ...req.headers };
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-cocalc-bay-frontdoor-worker"] = `${worker.id}`;

  if (publicIngressMode === "cloudflare-proxy") {
    // Cloud Armor limits the external load balancer to Cloudflare source
    // ranges. Replace, rather than append to, user-controlled forwarding
    // headers before the loopback frontdoor passes them to Express.
    const connectingIp = `${
      firstHeaderValue(req.headers["cf-connecting-ip"]) ?? ""
    }`.trim();
    headers["x-forwarded-for"] = net.isIP(connectingIp)
      ? connectingIp
      : normalizeRemoteAddress(req);
    headers["x-forwarded-proto"] = "https";
    delete headers.forwarded;
    delete headers["x-real-ip"];
  } else {
    headers["x-forwarded-proto"] = req.headers["cf-visitor"] ? "https" : "http";
  }

  return headers;
}

function serializeProxyRequest(req, headers) {
  const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
  const lines = [requestLine];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${item}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function writeHealth(res) {
  const now = Date.now();
  const healthy = healthyWorkers();
  const drained = drainedWorkerIds();
  const ok = healthy.length >= minHealthyWorkers;
  const body = JSON.stringify(
    {
      ok,
      healthy_workers: healthy.length,
      min_healthy_workers: minHealthyWorkers,
      workers: workers.map((worker) => ({
        id: worker.id,
        port: worker.port,
        healthy: worker.healthy,
        drained: drained.has(worker.id),
        consecutive_failures: worker.consecutiveFailures,
        active_upgrades: worker.upgrades.size,
        application_timeouts: recentApplicationTimeouts(worker, now).length,
        // Retained for consumers of the original circuit-breaker health shape.
        quarantined_until: null,
        last_application_timeout: worker.lastApplicationTimeout
          ? new Date(worker.lastApplicationTimeout).toISOString()
          : null,
        last_application_timeout_error:
          worker.lastApplicationTimeoutError || null,
        last_ok: worker.lastOk ? new Date(worker.lastOk).toISOString() : null,
        last_error: worker.lastError || null,
      })),
      affinity: {
        cookie: affinityCookieName,
        max_age_seconds: affinityMaxAgeSeconds,
        signed: signingKey != null,
      },
    },
    null,
    2,
  );
  res.writeHead(ok ? 200 : 503, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${body}\n`);
}

function proxyHttp(req, res) {
  if (req.url === healthPath) {
    writeHealth(res);
    return;
  }
  const selected = chooseWorker(req);
  if (selected == null) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("no healthy hub workers\n");
    return;
  }
  const { worker, changed } = selected;

  const headers = proxyRequestHeaders(req, worker);
  let receivedUpstreamResponse = false;
  let recordedApplicationTimeout = false;

  const upstream = http.request(
    {
      hostname: worker.host,
      port: worker.port,
      method: req.method,
      path: req.url,
      headers,
      timeout: upstreamTimeoutMs,
    },
    (upstreamRes) => {
      receivedUpstreamResponse = true;
      const statusCode = upstreamRes.statusCode ?? 502;
      res.writeHead(
        statusCode,
        prepareResponseHeaders(
          req,
          upstreamRes.headers,
          worker,
          changed,
          statusCode,
        ),
      );
      upstreamRes.pipe(res);
    },
  );
  upstream.on("timeout", () => {
    if (!receivedUpstreamResponse) {
      recordedApplicationTimeout = true;
      const pathname = `${req.url ?? ""}`.split("?", 1)[0].slice(0, 512);
      recordWorkerApplicationTimeout(
        worker,
        `upstream timeout before response: ${req.method} ${pathname}`,
      );
    }
    upstream.destroy(new Error("upstream timeout"));
  });
  upstream.on("error", (err) => {
    // Isolated client/proxy failures do not change health. Repeated failures
    // before response headers are handled by the timeout circuit breaker.
    if (!recordedApplicationTimeout) {
      worker.lastError = err.message;
    }
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("upstream hub worker failed\n");
  });
  req.pipe(upstream);
}

function rejectUpgrade(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message) + 1}\r\n` +
      "\r\n" +
      `${message}\n`,
  );
  socket.destroy();
}

function proxyUpgrade(req, socket, head) {
  const selected = chooseWorker(req);
  if (selected == null) {
    rejectUpgrade(socket, 503, "no healthy hub workers");
    return;
  }
  const { worker } = selected;

  const upstream = net.connect(worker.port, worker.host);
  const connection = { socket, upstream };
  worker.upgrades.add(connection);
  const forgetConnection = () => worker.upgrades.delete(connection);
  socket.once("close", forgetConnection);
  upstream.once("close", forgetConnection);
  upstream.setTimeout(upstreamTimeoutMs);
  upstream.once("connect", () => {
    // The timeout above is only a connect timeout. After the upgrade succeeds,
    // this is a long-lived websocket and normal Engine.IO ping intervals can be
    // longer than the HTTP upstream timeout.
    upstream.setTimeout(0);
    socket.setTimeout(0);
    upstream.write(
      serializeProxyRequest(req, proxyRequestHeaders(req, worker)),
    );
    if (head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("timeout", () => {
    upstream.destroy(new Error("upstream timeout"));
  });
  upstream.on("error", (err) => {
    // Client/proxy upgrade failures are not health checks. The poller owns
    // worker health so one reset/timeout cannot briefly remove the whole bay.
    worker.lastError = err.message;
    if (!socket.destroyed) {
      rejectUpgrade(socket, 502, "upstream hub worker failed");
    }
  });
  socket.on("error", () => upstream.destroy());
}

const server = http.createServer(proxyHttp);
server.on("upgrade", proxyUpgrade);
function start() {
  server.listen(bindPort, bindHost, async () => {
    log("listening", {
      bind: `${bindHost}:${bindPort}`,
      workers: workers.map((worker) => `${worker.host}:${worker.port}`),
      healthPath,
      workerHealthPath,
      unhealthyThreshold,
      applicationTimeoutWindowMs,
      publicIngressMode,
    });
    await scheduleHealthRefresh();
  });

  setInterval(scheduleHealthRefresh, healthIntervalMs).unref();
}

if (require.main === module) {
  start();
}

module.exports = {
  evictWorkerUpgrades,
  formatHealthError,
  isContentAddressedStaticRequest,
  isImmutableStaticStatus,
  isPubliclyCacheable,
  isTopLevelDocumentNavigation,
  prepareResponseHeaders,
  proxyRequestHeaders,
  recordWorkerApplicationTimeout,
  recordWorkerHealth,
  recentApplicationTimeouts,
  selectWorkerCandidate,
  serializeProxyRequest,
};
