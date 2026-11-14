#!/usr/bin/env node
"use strict";

// The bay's internal TLS listener for the federated connector broker.
//
// The broker (a separate VM) reaches its fabric bay only over TLS, accepting
// the bay only by a pinned SPKI sha256. Every other bay listener is plain
// HTTP on loopback, and public TLS ends off the bay, so this process is the
// broker's only way in:
// - it listens on the bay's internal address only, and only the broker's
//   address (and the bay itself, for the pin check) may connect; any other
//   source is dropped on the raw socket, before any TLS work;
// - TLS 1.3 only, with a key generated on the bay (bay-broker-tls-init);
// - it forwards only a websocket upgrade on the conat path, to the loopback
//   frontdoor, the way every other conat client arrives, so the hub's own
//   authentication applies unchanged. Forwarding and Cloudflare headers from
//   the broker are dropped (the hub trusts those from loopback peers), and
//   Host is set to the configured site host;
// - it is dormant unless COCALC_BAY_BROKER_TLS_ENABLE=1.
// Logs carry counts only: never addresses, headers, paths or handshake data.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");

const DEFAULTS = {
  port: 9443,
  maxConnections: 4,
  handshakeTimeoutMs: 10_000,
  headersTimeoutMs: 10_000,
  maxHeaderSize: 8192,
  upstreamConnectTimeoutMs: 5_000,
  idleTimeoutMs: 120_000,
};

// Headers the broker may not set: the frontdoor and hub trust forwarding
// headers from loopback peers, and this process is one. Host is replaced.
const STRIP_EXACT = new Set([
  "host",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
]);
const STRIP_PREFIXES = ["x-forwarded-", "cf-"];

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/;
const CONAT_PATH_RE = /^\/([A-Za-z0-9._~-]+\/)*conat\/$/;

function log(message, extra) {
  const line = { ts: new Date().toISOString(), msg: message };
  if (extra) Object.assign(line, extra);
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function boundedInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw Error(`invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw Error(`invalid ${name}`);
  }
  return value;
}

/** An IPv4 address, optionally written as a /32. */
function parseSingleIpv4(value, name) {
  const raw = `${value ?? ""}`.trim().replace(/\/32$/, "");
  if (!net.isIPv4(raw)) throw Error(`invalid ${name}`);
  return raw;
}

function isLoopbackIpv4(ip) {
  return ip.startsWith("127.");
}

/** The IPv4 addresses of this machine's interfaces. */
function localIpv4Addresses(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" || item.family === 4) out.add(item.address);
    }
  }
  return out;
}

/**
 * The listener's configuration from the environment, or { enabled: false }.
 * Anything invalid throws: the unit then fails closed.
 */
function loadConfig(env = process.env, interfaces = os.networkInterfaces()) {
  if (env.COCALC_BAY_BROKER_TLS_ENABLE !== "1") return { enabled: false };
  const bindHost = parseSingleIpv4(
    env.COCALC_BAY_BROKER_TLS_BIND_HOST,
    "COCALC_BAY_BROKER_TLS_BIND_HOST",
  );
  if (bindHost === "0.0.0.0" || isLoopbackIpv4(bindHost)) {
    throw Error("COCALC_BAY_BROKER_TLS_BIND_HOST must be the internal address");
  }
  if (!localIpv4Addresses(interfaces).has(bindHost)) {
    throw Error("COCALC_BAY_BROKER_TLS_BIND_HOST is not a local address");
  }
  const allowFrom = parseSingleIpv4(
    env.COCALC_BAY_BROKER_TLS_ALLOW_FROM,
    "COCALC_BAY_BROKER_TLS_ALLOW_FROM",
  );
  if (allowFrom === "0.0.0.0" || isLoopbackIpv4(allowFrom)) {
    throw Error("invalid COCALC_BAY_BROKER_TLS_ALLOW_FROM");
  }
  const conatPath = `${env.COCALC_BAY_BROKER_TLS_CONAT_PATH ?? ""}`;
  if (!CONAT_PATH_RE.test(conatPath)) {
    throw Error("invalid COCALC_BAY_BROKER_TLS_CONAT_PATH");
  }
  const upstreamHostHeader = `${
    env.COCALC_BAY_BROKER_TLS_UPSTREAM_HOST_HEADER ?? ""
  }`.toLowerCase();
  if (!HOSTNAME_RE.test(upstreamHostHeader)) {
    throw Error("invalid COCALC_BAY_BROKER_TLS_UPSTREAM_HOST_HEADER");
  }
  const upstreamHost = parseSingleIpv4(
    env.COCALC_BAY_FRONTDOOR_HOST ?? "127.0.0.1",
    "COCALC_BAY_FRONTDOOR_HOST",
  );
  if (!isLoopbackIpv4(upstreamHost)) {
    throw Error("the frontdoor must be on loopback");
  }
  const credentials = env.CREDENTIALS_DIRECTORY;
  const keyFile =
    env.COCALC_BAY_BROKER_TLS_KEY_FILE ??
    (credentials ? path.join(credentials, "broker-fabric-tls.key") : "");
  const certFile =
    env.COCALC_BAY_BROKER_TLS_CERT_FILE ??
    (credentials ? path.join(credentials, "broker-fabric-tls.crt") : "");
  if (!keyFile || !certFile) throw Error("missing key or certificate");
  return {
    enabled: true,
    bindHost,
    port: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_PORT",
      DEFAULTS.port,
      1024,
      65535,
    ),
    allowedSources: new Set([allowFrom, bindHost]),
    allowFrom,
    conatPath,
    upstreamHost,
    upstreamPort: boundedInt(env, "COCALC_BAY_FRONTDOOR_PORT", 9400, 1, 65535),
    upstreamHostHeader,
    keyFile,
    certFile,
    maxConnections: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_MAX_CONNECTIONS",
      DEFAULTS.maxConnections,
      1,
      64,
    ),
    handshakeTimeoutMs: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_HANDSHAKE_TIMEOUT_MS",
      DEFAULTS.handshakeTimeoutMs,
      100,
      60_000,
    ),
    headersTimeoutMs: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_HEADERS_TIMEOUT_MS",
      DEFAULTS.headersTimeoutMs,
      100,
      60_000,
    ),
    maxHeaderSize: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_MAX_HEADER_SIZE",
      DEFAULTS.maxHeaderSize,
      1024,
      16_384,
    ),
    upstreamConnectTimeoutMs: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_UPSTREAM_CONNECT_TIMEOUT_MS",
      DEFAULTS.upstreamConnectTimeoutMs,
      100,
      60_000,
    ),
    idleTimeoutMs: boundedInt(
      env,
      "COCALC_BAY_BROKER_TLS_IDLE_TIMEOUT_MS",
      DEFAULTS.idleTimeoutMs,
      1_000,
      3_600_000,
    ),
  };
}

function normalizeRemoteAddress(address) {
  const v = `${address ?? ""}`;
  return v.startsWith("::ffff:") ? v.slice("::ffff:".length) : v;
}

/** The sha256 (hex) of a certificate's DER SubjectPublicKeyInfo. */
function spkiSha256OfCertificate(cert) {
  const der = cert.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function spkiSha256OfPem(pem) {
  return spkiSha256OfCertificate(new crypto.X509Certificate(pem));
}

function isStrippedHeader(lowerName) {
  if (STRIP_EXACT.has(lowerName)) return true;
  return STRIP_PREFIXES.some((prefix) => lowerName.startsWith(prefix));
}

/**
 * The request headers to send upstream, from the raw header pairs: every
 * forwarding/Cloudflare header and Host dropped, whatever their case or
 * count, everything else (Authorization, cookies, the websocket handshake)
 * kept as sent, then exactly Host, X-Forwarded-For and X-Forwarded-Proto.
 */
function upstreamHeaderLines(rawHeaders, { hostHeader, clientIp }) {
  const lines = [];
  let stripped = 0;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (isStrippedHeader(`${name}`.toLowerCase())) {
      stripped++;
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: ${hostHeader}`);
  lines.push(`X-Forwarded-For: ${clientIp}`);
  lines.push("X-Forwarded-Proto: https");
  return { lines, stripped };
}

/**
 * Whether the request is a websocket upgrade on the conat path. The target
 * must already be in normal origin form (no dot segments, no absolute form),
 * so the path checked here is exactly the path the frontdoor routes on.
 */
function isAllowedUpgrade(req, conatPath) {
  if (req.method !== "GET") return false;
  if (`${req.headers.upgrade ?? ""}`.toLowerCase() !== "websocket") {
    return false;
  }
  const target = `${req.url ?? ""}`;
  if (!target.startsWith("/") || target.startsWith("//")) return false;
  let url;
  try {
    url = new URL(target, "https://bay.invalid");
  } catch {
    return false;
  }
  if (`${url.pathname}${url.search}` !== target) return false;
  if (!url.pathname.startsWith(conatPath)) return false;
  return (
    url.searchParams.get("EIO") === "4" &&
    url.searchParams.get("transport") === "websocket"
  );
}

const NOT_FOUND =
  "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

function createCounters() {
  return {
    accepted: 0,
    refused_source: 0,
    refused_capacity: 0,
    handshake_failed: 0,
    handshake_timeout: 0,
    headers_timeout: 0,
    bad_request: 0,
    not_found: 0,
    forwarded: 0,
    headers_stripped: 0,
    upstream_failed: 0,
    upstream_timeout: 0,
    idle_timeout: 0,
  };
}

function noop() {}

/**
 * The listener. Returns { server, counters, active, close }. The caller
 * calls server.listen(config.port, config.bindHost). deps.connect opens the
 * upstream connection (tests replace it).
 */
function createBrokerTlsServer(
  config,
  { key, cert },
  { connect = net.connect } = {},
) {
  const counters = createCounters();
  // The accepted connections, so that close() can end them.
  const connections = new Set();
  const secureContext = tls.createSecureContext({
    key,
    cert,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    secureOptions: crypto.constants.SSL_OP_NO_TICKET,
  });

  // HTTP parsing of the decrypted stream. Only the upgrade is accepted.
  const httpServer = http.createServer({
    maxHeaderSize: config.maxHeaderSize,
  });
  httpServer.on("request", (req, res) => {
    clearTimeout(req.socket.brokerHeadersTimer);
    counters.not_found++;
    res.writeHead(404, { Connection: "close", "Content-Length": "0" });
    res.end(() => req.socket.destroy());
  });
  httpServer.on("clientError", (_err, socket) => {
    clearTimeout(socket.brokerHeadersTimer);
    counters.bad_request++;
    socket.destroy();
  });
  httpServer.on("upgrade", (req, socket, head) => {
    clearTimeout(socket.brokerHeadersTimer);
    if (!isAllowedUpgrade(req, config.conatPath)) {
      counters.not_found++;
      socket.end(NOT_FOUND, () => socket.destroy());
      return;
    }
    const { lines, stripped } = upstreamHeaderLines(req.rawHeaders, {
      hostHeader: config.upstreamHostHeader,
      clientIp: socket.brokerClientIp,
    });
    counters.headers_stripped += stripped;
    const upstream = connect({
      host: config.upstreamHost,
      port: config.upstreamPort,
    });
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      upstream.destroy();
      socket.destroy();
    };
    const connectTimer = setTimeout(() => {
      counters.upstream_timeout++;
      closeBoth();
    }, config.upstreamConnectTimeoutMs);
    upstream.on("error", () => {
      if (!upstream.brokerConnected) counters.upstream_failed++;
      closeBoth();
    });
    socket.on("error", closeBoth);
    socket.once("close", closeBoth);
    upstream.once("close", closeBoth);
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      upstream.brokerConnected = true;
      counters.forwarded++;
      upstream.write(
        `GET ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
      );
      if (head?.length) upstream.write(head);
      const onIdle = () => {
        if (!closed) counters.idle_timeout++;
        closeBoth();
      };
      socket.setTimeout(config.idleTimeoutMs, onIdle);
      upstream.setTimeout(config.idleTimeoutMs, onIdle);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });

  // The raw listener: the source and capacity checks happen here, on the
  // accepted TCP socket, before any TLS object exists or any byte is read.
  const server = net.createServer({ pauseOnConnect: true }, (raw) => {
    raw.on("error", noop);
    const source = normalizeRemoteAddress(raw.remoteAddress);
    if (!config.allowedSources.has(source)) {
      counters.refused_source++;
      raw.destroy();
      return;
    }
    if (connections.size >= config.maxConnections) {
      counters.refused_capacity++;
      raw.destroy();
      return;
    }
    connections.add(raw);
    counters.accepted++;
    raw.once("close", () => {
      connections.delete(raw);
    });
    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      secureContext,
      ALPNProtocols: ["http/1.1"],
      requestCert: false,
    });
    secure.brokerClientIp = source;
    let secured = false;
    const handshakeTimer = setTimeout(() => {
      counters.handshake_timeout++;
      secure.destroy();
      raw.destroy();
    }, config.handshakeTimeoutMs);
    secure.on("error", () => {
      if (!secured) counters.handshake_failed++;
      clearTimeout(handshakeTimer);
      clearTimeout(secure.brokerHeadersTimer);
      secure.destroy();
      raw.destroy();
    });
    secure.once("secure", () => {
      secured = true;
      clearTimeout(handshakeTimer);
      // The request head must arrive within the bound.
      secure.brokerHeadersTimer = setTimeout(() => {
        counters.headers_timeout++;
        secure.destroy();
      }, config.headersTimeoutMs);
      httpServer.emit("connection", secure);
    });
    secure.once("close", () => {
      clearTimeout(handshakeTimer);
      clearTimeout(secure.brokerHeadersTimer);
      raw.destroy();
    });
    raw.resume();
  });

  return {
    server,
    counters,
    active: () => connections.size,
    // Stops listening and ends every open connection (and its upstream).
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const raw of connections) raw.destroy();
      }),
  };
}

function main() {
  let config, key, cert, pin, instance;
  try {
    config = loadConfig();
    if (!config.enabled) {
      log("broker tls listener is not enabled; exiting");
      return;
    }
    key = fs.readFileSync(config.keyFile);
    cert = fs.readFileSync(config.certFile);
    pin = spkiSha256OfPem(cert);
    instance = createBrokerTlsServer(config, { key, cert });
  } catch (err) {
    // Messages name settings, never values or key material.
    log("not starting", { error: `${err?.code ?? err?.message ?? err}` });
    process.exit(1);
  }
  instance.server.on("error", (err) => {
    log("listener error", { code: err?.code ?? "unknown" });
    process.exit(1);
  });
  instance.server.listen(config.port, config.bindHost, () => {
    // The pin is public (it identifies the key); the key is never logged.
    log("broker tls listener ready", { port: config.port, pin });
  });
  let last = "";
  setInterval(() => {
    const now = JSON.stringify(instance.counters);
    if (now !== last) {
      last = now;
      log("counts", { ...instance.counters, active: instance.active() });
    }
  }, 60_000).unref();
  const stop = () => {
    instance.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULTS,
  createBrokerTlsServer,
  isAllowedUpgrade,
  loadConfig,
  localIpv4Addresses,
  normalizeRemoteAddress,
  spkiSha256OfCertificate,
  spkiSha256OfPem,
  upstreamHeaderLines,
};
