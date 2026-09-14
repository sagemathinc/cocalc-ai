#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

process.env.COCALC_BAY_FRONTDOOR_UNHEALTHY_THRESHOLD = "3";
process.env.COCALC_BAY_FRONTDOOR_APPLICATION_TIMEOUT_THRESHOLD = "3";
process.env.COCALC_BAY_FRONTDOOR_APPLICATION_TIMEOUT_WINDOW_MS = "60000";
process.env.COCALC_BAY_FRONTDOOR_APPLICATION_TIMEOUT_QUARANTINE_MS = "90000";
process.env.COCALC_BAY_PUBLIC_INGRESS_MODE = "cloudflare-proxy";

const {
  formatHealthError,
  isContentAddressedStaticRequest,
  isImmutableStaticStatus,
  isPubliclyCacheable,
  isTopLevelDocumentNavigation,
  prepareResponseHeaders,
  proxyRequestHeaders,
  recordWorkerApplicationTimeout,
  recordWorkerHealth,
  selectWorkerCandidate,
  serializeProxyRequest,
  workerIsQuarantined,
} = require("./bay-frontdoor.js");

test("recognizes only top-level browser document navigations", () => {
  assert.equal(
    isTopLevelDocumentNavigation({
      method: "GET",
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    }),
    true,
  );
  assert.equal(
    isTopLevelDocumentNavigation({
      method: "GET",
      headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    }),
    false,
  );
  assert.equal(
    isTopLevelDocumentNavigation({
      method: "POST",
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    }),
    false,
  );
});

test("rotates document navigations away from their pinned worker", () => {
  const workers = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const sticky = workers[1];
  assert.deepEqual(
    selectWorkerCandidate({
      candidates: workers,
      sticky,
      rotate: false,
      offset: 0,
    }),
    { worker: sticky, changed: false, nextOffset: 0 },
  );
  assert.deepEqual(
    selectWorkerCandidate({
      candidates: workers,
      sticky,
      rotate: true,
      offset: 0,
    }),
    { worker: workers[0], changed: true, nextOffset: 1 },
  );
  assert.deepEqual(
    selectWorkerCandidate({
      candidates: [sticky],
      sticky,
      rotate: true,
      offset: 0,
    }),
    { worker: sticky, changed: false, nextOffset: 1 },
  );
});

test("recognizes content-addressed static assets only", () => {
  assert.equal(
    isContentAddressedStaticRequest({
      url: "/static/app-6e50741dfe558fe6.js",
    }),
    true,
  );
  assert.equal(
    isContentAddressedStaticRequest({
      url: "/base/static/7386645f80d6d0a6.wasm?cache=1",
    }),
    true,
  );
  assert.equal(
    isContentAddressedStaticRequest({ url: "/static/app.html" }),
    false,
  );
  assert.equal(
    isContentAddressedStaticRequest({ url: "/api/static/report-deadbeef" }),
    false,
  );
});

test("does not poison immutable static assets with the affinity cookie", () => {
  const headers = prepareResponseHeaders(
    { url: "/static/app-6e50741dfe558fe6.js" },
    {
      "cache-control": "public, max-age=864000, must-revalidate",
      etag: 'W/"asset"',
    },
    { id: 2 },
    true,
    200,
  );
  assert.equal(headers["set-cookie"], undefined);
  assert.equal(headers["cache-control"], "public, max-age=31536000, immutable");
  const expiresInMs = Date.parse(headers.expires) - Date.now();
  assert.ok(expiresInMs > 364 * 24 * 60 * 60 * 1000);
  assert.ok(expiresInMs <= 365 * 24 * 60 * 60 * 1000);
  assert.equal(headers.etag, 'W/"asset"');
});

test("keeps the immutable policy on hashed asset revalidations", () => {
  const headers = prepareResponseHeaders(
    { url: "/static/app-6e50741dfe558fe6.js" },
    { etag: 'W/"asset"' },
    { id: 2 },
    true,
    304,
  );
  assert.equal(headers["cache-control"], "public, max-age=31536000, immutable");
});

test("never pins a failed hashed asset response", () => {
  for (const statusCode of [404, 500, 502, 503]) {
    const headers = prepareResponseHeaders(
      { url: "/static/app-6e50741dfe558fe6.js" },
      { "content-type": "text/plain; charset=utf-8" },
      { id: 2 },
      true,
      statusCode,
    );
    assert.equal(headers["cache-control"], "no-store", `status ${statusCode}`);
    assert.equal(headers["set-cookie"], undefined, `status ${statusCode}`);
  }
});

test("classifies which statuses may be pinned immutably", () => {
  assert.equal(isImmutableStaticStatus(200), true);
  assert.equal(isImmutableStaticStatus(203), true);
  assert.equal(isImmutableStaticStatus(304), true);
  assert.equal(isImmutableStaticStatus(206), false);
  assert.equal(isImmutableStaticStatus(302), false);
  assert.equal(isImmutableStaticStatus(404), false);
  assert.equal(isImmutableStaticStatus(502), false);
  assert.equal(isImmutableStaticStatus(undefined), false);
});

test("never attaches the affinity cookie to a public response", () => {
  for (const url of ["/", "/webapp/serviceWorker.js", "/favicon.ico"]) {
    const headers = prepareResponseHeaders(
      { url },
      { "cache-control": "public, max-age=864000, must-revalidate" },
      { id: 2 },
      true,
      200,
    );
    assert.equal(headers["set-cookie"], undefined, url);
    assert.equal(
      headers["cache-control"],
      "public, max-age=864000, must-revalidate",
      url,
    );
  }
});

test("recognizes the public directive without matching max-age tokens", () => {
  assert.equal(isPubliclyCacheable({ "cache-control": "public" }), true);
  assert.equal(
    isPubliclyCacheable({ "cache-control": "public, max-age=10" }),
    true,
  );
  assert.equal(
    isPubliclyCacheable({ "cache-control": ["private", "public"] }),
    true,
  );
  assert.equal(
    isPubliclyCacheable({ "cache-control": "private, max-age=10" }),
    false,
  );
  assert.equal(isPubliclyCacheable({ "cache-control": "no-store" }), false);
  assert.equal(isPubliclyCacheable({}), false);
});

test("keeps affinity on mutable shells and dynamic responses", () => {
  const worker = { id: 2 };
  const cacheControl = {
    "/static/app.html": "private, max-age=10, must-revalidate",
    "/api/v2/projects": "no-store",
  };
  for (const [url, value] of Object.entries(cacheControl)) {
    const headers = prepareResponseHeaders(
      { url },
      { "cache-control": value },
      worker,
      true,
      200,
    );
    assert.match(
      headers["set-cookie"],
      /^cocalc_bay_frontdoor_worker=2(?:\.|;)/,
      url,
    );
  }
});

test("includes a normalized readiness body in health errors", () => {
  assert.equal(
    formatHealthError(503, " conat routing\n round trip failed: timeout "),
    "health status 503: conat routing round trip failed: timeout",
  );
  assert.equal(formatHealthError(503, ""), "health status 503");
});

test("replaces untrusted forwarding headers on a direct proxied route", () => {
  const req = {
    headers: {
      host: "staging.cocalc.ai",
      "cf-connecting-ip": "203.0.113.17",
      "x-forwarded-for": "192.0.2.1, 192.0.2.2",
      "x-forwarded-proto": "http",
      "x-real-ip": "192.0.2.3",
      forwarded: "for=192.0.2.4;proto=http",
    },
    socket: { remoteAddress: "130.211.0.10" },
  };
  const headers = proxyRequestHeaders(req, { id: 3 });
  assert.equal(headers["x-forwarded-for"], "203.0.113.17");
  assert.equal(headers["x-forwarded-proto"], "https");
  assert.equal(headers["x-forwarded-host"], "staging.cocalc.ai");
  assert.equal(headers["x-cocalc-bay-frontdoor-worker"], "3");
  assert.equal(headers["x-real-ip"], undefined);
  assert.equal(headers.forwarded, undefined);
});

test("falls back to the load balancer peer when Cloudflare sends no client IP", () => {
  const headers = proxyRequestHeaders(
    {
      headers: { host: "staging.cocalc.ai" },
      socket: { remoteAddress: "::ffff:35.191.4.9" },
    },
    { id: 1 },
  );
  assert.equal(headers["x-forwarded-for"], "35.191.4.9");
});

test("serializes normalized WebSocket upgrade headers", () => {
  const request = serializeProxyRequest(
    {
      method: "GET",
      url: "/socket.io/?transport=websocket",
      httpVersion: "1.1",
    },
    {
      host: "staging.cocalc.ai",
      upgrade: "websocket",
      "x-forwarded-for": "203.0.113.17",
      "set-cookie": ["a=1", "b=2"],
    },
  );
  assert.match(
    request,
    /^GET \/socket\.io\/\?transport=websocket HTTP\/1\.1\r\n/,
  );
  assert.match(request, /x-forwarded-for: 203\.0\.113\.17\r\n/);
  assert.match(request, /set-cookie: a=1\r\nset-cookie: b=2\r\n/);
  assert.match(request, /\r\n\r\n$/);
});

class MockSocket extends EventEmitter {
  destroyed = false;

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

test("evicts upgraded sockets only after repeated worker health failures", () => {
  const socket = new MockSocket();
  const upstream = new MockSocket();
  const connection = { socket, upstream };
  const worker = {
    id: 2,
    healthy: true,
    consecutiveFailures: 0,
    lastOk: Date.now(),
    lastError: "",
    upgrades: new Set([connection]),
  };
  socket.once("close", () => worker.upgrades.delete(connection));
  upstream.once("close", () => worker.upgrades.delete(connection));

  recordWorkerHealth(worker, false, "failure 1");
  recordWorkerHealth(worker, false, "failure 2");
  assert.equal(worker.healthy, true);
  assert.equal(socket.destroyed, false);
  assert.equal(upstream.destroyed, false);

  recordWorkerHealth(worker, false, "failure 3");
  assert.equal(worker.healthy, false);
  assert.equal(socket.destroyed, true);
  assert.equal(upstream.destroyed, true);
  assert.equal(worker.upgrades.size, 0);

  recordWorkerHealth(worker, true);
  assert.equal(worker.healthy, true);
  assert.equal(worker.consecutiveFailures, 0);
  assert.equal(worker.lastError, "");
});

test("quarantines repeated application timeouts without trusting shallow health", () => {
  const socket = new MockSocket();
  const upstream = new MockSocket();
  const connection = { socket, upstream };
  const worker = {
    id: 3,
    healthy: true,
    consecutiveFailures: 0,
    lastOk: 1_000,
    lastError: "",
    applicationTimeouts: [],
    quarantinedUntil: 0,
    upgrades: new Set([connection]),
  };

  assert.equal(recordWorkerApplicationTimeout(worker, "timeout 1", 10_000), false);
  assert.equal(recordWorkerApplicationTimeout(worker, "timeout 2", 20_000), false);
  assert.equal(worker.healthy, true);
  assert.equal(recordWorkerApplicationTimeout(worker, "timeout 3", 30_000), true);
  assert.equal(worker.healthy, false);
  assert.equal(workerIsQuarantined(worker, 30_001), true);
  assert.equal(socket.destroyed, true);
  assert.equal(upstream.destroyed, true);

  recordWorkerHealth(worker, true, "", 40_000);
  assert.equal(worker.healthy, false);
  assert.equal(worker.applicationTimeouts.length, 3);

  recordWorkerHealth(worker, true, "", 120_001);
  assert.equal(worker.healthy, true);
  assert.equal(worker.applicationTimeouts.length, 0);
  assert.equal(worker.quarantinedUntil, 0);
});

test("application timeout accounting uses a sliding window", () => {
  const worker = {
    id: 4,
    healthy: true,
    consecutiveFailures: 0,
    lastOk: 1_000,
    lastError: "",
    applicationTimeouts: [],
    quarantinedUntil: 0,
    upgrades: new Set(),
  };

  recordWorkerApplicationTimeout(worker, "old timeout", 1_000);
  recordWorkerApplicationTimeout(worker, "timeout 1", 62_000);
  recordWorkerApplicationTimeout(worker, "timeout 2", 63_000);
  assert.equal(worker.healthy, true);
  assert.deepEqual(worker.applicationTimeouts, [62_000, 63_000]);
});
