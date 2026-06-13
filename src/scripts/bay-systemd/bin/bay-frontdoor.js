#!/usr/bin/env node
"use strict";

const http = require("node:http");
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
const minHealthyWorkers = Math.min(
  intEnv("COCALC_BAY_MIN_HEALTHY_WORKERS", 1),
  workerCount,
);
const healthIntervalMs = intEnv(
  "COCALC_BAY_FRONTDOOR_HEALTH_INTERVAL_MS",
  1000,
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
  lastOk: 0,
  lastError: "not checked yet",
}));

function log(message, extra) {
  const suffix = extra == null ? "" : ` ${JSON.stringify(extra)}`;
  console.log(`[bay-frontdoor] ${message}${suffix}`);
}

function checkWorker(worker) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: worker.host,
        port: worker.port,
        path: workerHealthPath,
        method: "GET",
        timeout: Math.min(5000, upstreamTimeoutMs),
      },
      (res) => {
        res.resume();
        const ok =
          res.statusCode != null &&
          res.statusCode >= 200 &&
          res.statusCode < 400;
        worker.healthy = ok;
        if (ok) {
          worker.lastOk = Date.now();
          worker.lastError = "";
        } else {
          worker.lastError = `health status ${res.statusCode}`;
        }
        resolve();
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("health timeout"));
    });
    req.on("error", (err) => {
      worker.healthy = false;
      worker.lastError = err.message;
      resolve();
    });
    req.end();
  });
}

async function refreshHealth() {
  await Promise.all(workers.map(checkWorker));
}

function healthyWorkers() {
  const drained = drainedWorkerIds();
  return workers.filter((worker) => worker.healthy && !drained.has(worker.id));
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

function chooseWorker() {
  const candidates = healthyWorkers();
  if (candidates.length === 0) {
    return undefined;
  }
  const worker = candidates[nextWorkerOffset % candidates.length];
  nextWorkerOffset += 1;
  return worker;
}

function writeHealth(res) {
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
        last_ok: worker.lastOk ? new Date(worker.lastOk).toISOString() : null,
        last_error: worker.lastError || null,
      })),
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
  const worker = chooseWorker();
  if (worker == null) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("no healthy hub workers\n");
    return;
  }

  const headers = { ...req.headers };
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = req.headers["cf-visitor"] ? "https" : "http";
  headers["x-cocalc-bay-frontdoor-worker"] = `${worker.id}`;

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
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("timeout", () => {
    upstream.destroy(new Error("upstream timeout"));
  });
  upstream.on("error", (err) => {
    worker.healthy = false;
    worker.lastError = err.message;
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
  const worker = chooseWorker();
  if (worker == null) {
    rejectUpgrade(socket, 503, "no healthy hub workers");
    return;
  }

  const upstream = net.connect(worker.port, worker.host);
  upstream.setTimeout(upstreamTimeoutMs);
  upstream.once("connect", () => {
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
    const rawHeaders = [...req.rawHeaders];
    rawHeaders.push("X-CoCalc-Bay-Frontdoor-Worker", `${worker.id}`);
    const lines = [requestLine];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
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
    worker.healthy = false;
    worker.lastError = err.message;
    if (!socket.destroyed) {
      rejectUpgrade(socket, 502, "upstream hub worker failed");
    }
  });
  socket.on("error", () => upstream.destroy());
}

const server = http.createServer(proxyHttp);
server.on("upgrade", proxyUpgrade);
server.listen(bindPort, bindHost, async () => {
  log("listening", {
    bind: `${bindHost}:${bindPort}`,
    workers: workers.map((worker) => `${worker.host}:${worker.port}`),
    healthPath,
  });
  await refreshHealth();
});

setInterval(() => {
  refreshHealth().catch((err) =>
    log("health refresh failed", { error: err.message }),
  );
}, healthIntervalMs).unref();
