// The broker fabric TLS listener (bay-broker-tls.js), over real sockets.
// Run: node --test scripts/bay-systemd/bin/bay-broker-tls.test.js
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const nodeTest = require("node:test");
const tls = require("node:tls");

const {
  createBrokerTlsServer,
  isAllowedUpgrade,
  loadConfig,
  normalizeRemoteAddress,
  spkiSha256OfPem,
  upstreamHeaderLines,
} = require("./bay-broker-tls.js");

// Every test is bounded: a connection left open fails it, not the run.
const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
test.after = nodeTest.after;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bay-broker-tls-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makePair(name) {
  const key = path.join(TMP, `${name}.key`);
  const crt = path.join(TMP, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=cocalc-bay-broker-fabric",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      crt,
    ],
    { stdio: "ignore" },
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), crt };
}

const PAIR = makePair("current");
const OTHER = makePair("other");

// The broker's pin and pinned agent, as in
// packages/server/federated-connectors/broker-runtime.ts (G3b-1).
function brokerSpkiSha256(socket) {
  const cert = socket.getPeerX509Certificate?.();
  if (cert == null) return;
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spki).digest("hex");
}

function brokerPinnedAgent(pin) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 4 });
  agent.createConnection = (options, oncreate) => {
    let done = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      oncreate(err, socket);
    };
    const socket = tls.connect({
      host: options.host,
      port: options.port,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      if (brokerSpkiSha256(socket) !== pin) {
        socket.destroy();
        finish(Error("fabric pin mismatch"));
        return;
      }
      finish(null, socket);
    });
    socket.once("error", (err) => {
      socket.destroy();
      finish(err);
    });
    return undefined;
  };
  return agent;
}

const UPGRADE_PATH = "/conat/?EIO=4&transport=websocket";

// A stand-in for the frontdoor: records what arrives, answers an upgrade
// with 101 and then echoes.
async function startUpstream() {
  const received = [];
  const server = net.createServer((socket) => {
    const record = { data: Buffer.alloc(0) };
    received.push(record);
    let answered = false;
    socket.on("data", (chunk) => {
      record.data = Buffer.concat([record.data, chunk]);
      if (!answered && record.data.includes("\r\n\r\n")) {
        answered = true;
        const rest = record.data.subarray(record.data.indexOf("\r\n\r\n") + 4);
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
        if (rest.length) socket.write(rest);
      } else if (answered) {
        socket.write(chunk);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startListener(upstream, overrides = {}, deps) {
  const config = {
    bindHost: "127.0.0.1",
    allowedSources: new Set(["127.0.0.1"]),
    conatPath: "/conat/",
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream?.port ?? 9,
    upstreamHostHeader: "cocalc.example",
    maxConnections: 4,
    handshakeTimeoutMs: 2_000,
    headersTimeoutMs: 2_000,
    maxHeaderSize: 8192,
    upstreamConnectTimeoutMs: 2_000,
    idleTimeoutMs: 5_000,
    ...overrides,
  };
  const instance = createBrokerTlsServer(
    config,
    { key: PAIR.key, cert: PAIR.cert },
    deps,
  );
  await new Promise((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  instance.port = instance.server.address().port;
  return instance;
}

function tlsClient(port, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
      ...options,
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// Everything the peer sends until it closes (or the wait ends).
function collect(socket, ms = 3_000) {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    let closed = false;
    const timer = setTimeout(() => resolve({ data, closed }), ms);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      closed = true;
      clearTimeout(timer);
      resolve({ data, closed });
    });
  });
}

const until = async (fn, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function upgradeRequest(target = UPGRADE_PATH, extra = []) {
  return [
    `GET ${target} HTTP/1.1`,
    "Host: 10.0.0.2:9443",
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...extra,
    "",
    "",
  ].join("\r\n");
}

const ENV = {
  COCALC_BAY_BROKER_TLS_ENABLE: "1",
  COCALC_BAY_BROKER_TLS_BIND_HOST: "10.0.0.2",
  COCALC_BAY_BROKER_TLS_ALLOW_FROM: "10.0.0.3/32",
  COCALC_BAY_BROKER_TLS_CONAT_PATH: "/conat/",
  COCALC_BAY_BROKER_TLS_UPSTREAM_HOST_HEADER: "cocalc.example",
  CREDENTIALS_DIRECTORY: "/run/credentials/cocalc-bay-broker-tls.service",
};
const INTERFACES = {
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  ens4: [{ family: "IPv4", address: "10.0.0.2", internal: false }],
};

test("dormant unless enabled", () => {
  assert.deepEqual(loadConfig({}, INTERFACES), { enabled: false });
  assert.deepEqual(
    loadConfig({ ...ENV, COCALC_BAY_BROKER_TLS_ENABLE: "true" }, INTERFACES),
    { enabled: false },
  );
});

test("configuration: the internal address, one source, loopback upstream", () => {
  const config = loadConfig(ENV, INTERFACES);
  assert.equal(config.enabled, true);
  assert.equal(config.bindHost, "10.0.0.2");
  assert.equal(config.port, 9443);
  assert.deepEqual([...config.allowedSources].sort(), ["10.0.0.2", "10.0.0.3"]);
  assert.equal(config.upstreamHost, "127.0.0.1");
  assert.equal(config.upstreamPort, 9400);
  assert.equal(
    config.keyFile,
    "/run/credentials/cocalc-bay-broker-tls.service/broker-fabric-tls.key",
  );
  assert.equal(config.maxConnections, 4);
  assert.equal(config.maxHeaderSize, 8192);
});

test("configuration refusals", () => {
  const refused = {
    COCALC_BAY_BROKER_TLS_BIND_HOST: [
      "0.0.0.0",
      "127.0.0.1",
      "::",
      "::1",
      "10.0.0.9",
      "10.0.0.0/24",
      "",
      undefined,
    ],
    COCALC_BAY_BROKER_TLS_ALLOW_FROM: [
      "10.0.0.0/24",
      "0.0.0.0",
      "0.0.0.0/0",
      "127.0.0.1",
      "10.0.0.3,10.0.0.4",
      "::ffff:10.0.0.3",
      "",
      undefined,
    ],
    COCALC_BAY_BROKER_TLS_CONAT_PATH: ["/", "/hub/", "conat/", "/conat", ""],
    COCALC_BAY_BROKER_TLS_UPSTREAM_HOST_HEADER: [
      "",
      "a b",
      "host:9400",
      "x\r\nX-Forwarded-For: 1.2.3.4",
      undefined,
    ],
    COCALC_BAY_FRONTDOOR_HOST: ["10.0.0.2", "0.0.0.0", "localhost"],
    COCALC_BAY_BROKER_TLS_PORT: ["80", "70000", "9443x", "-1"],
    COCALC_BAY_BROKER_TLS_MAX_CONNECTIONS: ["0", "65"],
    COCALC_BAY_BROKER_TLS_MAX_HEADER_SIZE: ["100", "100000"],
    COCALC_BAY_BROKER_TLS_HANDSHAKE_TIMEOUT_MS: ["0", "600000"],
    COCALC_BAY_BROKER_TLS_IDLE_TIMEOUT_MS: ["5", "99999999"],
  };
  for (const [name, values] of Object.entries(refused)) {
    for (const value of values) {
      const env = { ...ENV, [name]: value };
      if (value === undefined) delete env[name];
      assert.throws(
        () => loadConfig(env, INTERFACES),
        undefined,
        `${name}=${value}`,
      );
    }
  }
  const noCredentials = { ...ENV };
  delete noCredentials.CREDENTIALS_DIRECTORY;
  assert.throws(() => loadConfig(noCredentials, INTERFACES), /missing key/);
});

test("raw source addresses", () => {
  assert.equal(normalizeRemoteAddress("::ffff:10.0.0.3"), "10.0.0.3");
  assert.equal(normalizeRemoteAddress("10.0.0.3"), "10.0.0.3");
  assert.equal(normalizeRemoteAddress("::1"), "::1");
  assert.equal(normalizeRemoteAddress(undefined), "");
});

test("another source is dropped on the raw socket, before any TLS", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream, {
    allowedSources: new Set(["10.0.0.3"]),
  });
  const constructed = [];
  const Original = tls.TLSSocket;
  tls.TLSSocket = function (...args) {
    constructed.push(1);
    return new Original(...args);
  };
  try {
    const raw = net.connect(listener.port, "127.0.0.1");
    raw.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]));
    const { data, closed } = await collect(raw);
    assert.equal(closed, true);
    assert.equal(data.length, 0, "nothing at all is sent back");
    await assert.rejects(tlsClient(listener.port));
    assert.equal(constructed.length, 0, "no TLS socket was made");
    assert.equal(listener.counters.refused_source, 2);
    assert.equal(listener.counters.accepted, 0);
    assert.equal(listener.counters.handshake_failed, 0);
    assert.equal(upstream.received.length, 0);
  } finally {
    tls.TLSSocket = Original;
    await listener.close();
    await upstream.close();
  }
});

test("at most maxConnections at once", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream, { maxConnections: 2 });
  try {
    const a = await tlsClient(listener.port);
    const b = await tlsClient(listener.port);
    await assert.rejects(tlsClient(listener.port));
    assert.equal(listener.counters.refused_capacity, 1);
    assert.equal(listener.active(), 2);
    a.destroy();
    await until(() => listener.active() === 1);
    const c = await tlsClient(listener.port);
    assert.equal(listener.counters.accepted, 3);
    b.destroy();
    c.destroy();
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("a handshake that does not finish is cut off", async () => {
  const listener = await startListener(null, { handshakeTimeoutMs: 200 });
  try {
    const raw = net.connect(listener.port, "127.0.0.1");
    const started = Date.now();
    const { closed } = await collect(raw);
    assert.equal(closed, true);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(listener.counters.handshake_timeout, 1);
    await until(() => listener.active() === 0);
  } finally {
    await listener.close();
  }
});

test("request headers that do not finish are cut off", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream, { headersTimeoutMs: 200 });
  try {
    const socket = await tlsClient(listener.port);
    socket.write(`GET ${UPGRADE_PATH} HTTP/1.1\r\nHost: x\r\n`);
    const { closed } = await collect(socket);
    assert.equal(closed, true);
    assert.equal(listener.counters.headers_timeout, 1);
    assert.equal(upstream.received.length, 0);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("request headers over maxHeaderSize are refused", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream, { maxHeaderSize: 2048 });
  try {
    const socket = await tlsClient(listener.port);
    socket.write(upgradeRequest(UPGRADE_PATH, [`X-Pad: ${"a".repeat(4096)}`]));
    const { data, closed } = await collect(socket);
    assert.equal(closed, true);
    assert.doesNotMatch(data.toString(), /101/);
    assert.equal(listener.counters.bad_request, 1);
    assert.equal(upstream.received.length, 0);
    // Just under the bound is fine.
    const ok = await tlsClient(listener.port);
    ok.write(upgradeRequest(UPGRADE_PATH, [`X-Pad: ${"a".repeat(1024)}`]));
    const { data: answer } = await collect(ok, 500);
    assert.match(answer.toString(), /^HTTP\/1\.1 101 /);
    ok.destroy();
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("an upstream that does not connect is cut off", async () => {
  const pending = [];
  const listener = await startListener(
    null,
    { upstreamConnectTimeoutMs: 200 },
    {
      connect: () => {
        const socket = new net.Socket();
        pending.push(socket);
        return socket;
      },
    },
  );
  try {
    const socket = await tlsClient(listener.port);
    socket.write(upgradeRequest());
    const { data, closed } = await collect(socket);
    assert.equal(closed, true);
    assert.equal(data.length, 0);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].destroyed, true);
    assert.equal(listener.counters.upstream_timeout, 1);
  } finally {
    await listener.close();
  }
});

test("an upstream that refuses closes the connection", async () => {
  const closedPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const listener = await startListener({ port: closedPort });
  try {
    const socket = await tlsClient(listener.port);
    socket.write(upgradeRequest());
    const { closed } = await collect(socket);
    assert.equal(closed, true);
    assert.equal(listener.counters.upstream_failed, 1);
  } finally {
    await listener.close();
  }
});

test("an idle upgraded connection is closed", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream, { idleTimeoutMs: 300 });
  try {
    const socket = await tlsClient(listener.port);
    socket.write(upgradeRequest());
    const { data, closed } = await collect(socket);
    assert.match(data.toString(), /^HTTP\/1\.1 101 /);
    assert.equal(closed, true);
    assert.equal(listener.counters.idle_timeout, 1);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("close() ends open connections and their upstream", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream);
  const socket = await tlsClient(listener.port);
  socket.write(upgradeRequest());
  const pending = collect(socket, 5_000);
  await until(() => upstream.received.length === 1);
  const started = Date.now();
  await listener.close();
  const { data, closed } = await pending;
  assert.match(data.toString(), /^HTTP\/1\.1 101 /);
  assert.equal(closed, true);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(listener.active(), 0);
  await upstream.close();
});

test("TLS 1.3 only, no plaintext, no resumption", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream);
  try {
    await assert.rejects(tlsClient(listener.port, { maxVersion: "TLSv1.2" }));
    const raw = net.connect(listener.port, "127.0.0.1");
    raw.write(upgradeRequest());
    const { data, closed } = await collect(raw);
    assert.equal(closed, true);
    assert.doesNotMatch(data.toString("latin1"), /HTTP\//);
    assert.equal(listener.counters.handshake_failed, 2);
    assert.equal(upstream.received.length, 0);

    const first = await tlsClient(listener.port);
    assert.equal(first.getProtocol(), "TLSv1.3");
    assert.equal(first.alpnProtocol, "http/1.1");
    const session = await new Promise((resolve) => {
      first.once("session", resolve);
      first.write(upgradeRequest());
      setTimeout(() => resolve(first.getSession()), 500);
    });
    first.destroy();
    // The client is offered a session; presenting it gets a full handshake.
    assert.ok(session);
    const second = await tlsClient(listener.port, { session });
    assert.equal(second.isSessionReused(), false);
    second.destroy();
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("the pin: the broker's computation, openssl's, and the served key", async () => {
  const pin = spkiSha256OfPem(PAIR.cert);
  assert.match(pin, /^[0-9a-f]{64}$/);
  const pubkey = execFileSync("openssl", [
    "x509",
    "-in",
    PAIR.crt,
    "-noout",
    "-pubkey",
  ]);
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], {
    input: pubkey,
  });
  assert.equal(crypto.createHash("sha256").update(der).digest("hex"), pin);
  assert.notEqual(spkiSha256OfPem(OTHER.cert), pin);
  const listener = await startListener(null);
  try {
    const socket = await tlsClient(listener.port);
    assert.equal(brokerSpkiSha256(socket), pin);
    socket.destroy();
  } finally {
    await listener.close();
  }
});

function brokerUpgrade(port, pin, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: UPGRADE_PATH,
      agent: brokerPinnedAgent(pin),
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.once("upgrade", (res, socket) => resolve({ res, socket }));
    req.once("response", (res) => resolve({ res }));
    req.once("error", reject);
    req.end();
  });
}

test("the broker's pinned client: the right pin reaches the frontdoor, a wrong one nothing", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream);
  try {
    await assert.rejects(
      brokerUpgrade(listener.port, spkiSha256OfPem(OTHER.cert)),
      /fabric pin mismatch/,
    );
    assert.equal(upstream.received.length, 0);
    const { res, socket } = await brokerUpgrade(
      listener.port,
      spkiSha256OfPem(PAIR.cert),
      { Authorization: "Bearer test-token" },
    );
    assert.equal(res.statusCode, 101);
    socket.write("ping");
    const echoed = await new Promise((resolve) => socket.once("data", resolve));
    assert.equal(echoed.toString(), "ping");
    socket.destroy();
    assert.equal(upstream.received.length, 1);
    assert.match(
      upstream.received[0].data.toString(),
      /\r\nAuthorization: Bearer test-token\r\n/,
    );
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("only a websocket upgrade on the conat path", () => {
  const req = (method, url, upgrade = "websocket") => ({
    method,
    url,
    headers: upgrade ? { upgrade } : {},
  });
  assert.equal(isAllowedUpgrade(req("GET", UPGRADE_PATH), "/conat/"), true);
  assert.equal(
    isAllowedUpgrade(
      req("GET", "/conat/?transport=websocket&EIO=4&x=1"),
      "/conat/",
    ),
    true,
  );
  assert.equal(
    isAllowedUpgrade(req("GET", UPGRADE_PATH, "WebSocket"), "/conat/"),
    true,
  );
  for (const [method, url, upgrade] of [
    ["POST", UPGRADE_PATH],
    ["GET", UPGRADE_PATH, "h2c"],
    ["GET", UPGRADE_PATH, ""],
    ["GET", "/hub/?EIO=4&transport=websocket"],
    ["GET", "/conat?EIO=4&transport=websocket"],
    ["GET", "/conat/../hub/?EIO=4&transport=websocket"],
    ["GET", "/conat/%2e%2e/hub?EIO=4&transport=websocket"],
    ["GET", "/conat/./?EIO=4&transport=websocket"],
    ["GET", "//conat/?EIO=4&transport=websocket"],
    ["GET", "http://evil.example/conat/?EIO=4&transport=websocket"],
    ["GET", "/conat/?EIO=3&transport=websocket"],
    ["GET", "/conat/?EIO=4&transport=polling"],
    ["GET", "/conat/"],
    ["GET", "/conat/\\..\\hub?EIO=4&transport=websocket"],
    ["GET", "*"],
  ]) {
    assert.equal(
      isAllowedUpgrade(req(method, url, upgrade), "/conat/"),
      false,
      `${method} ${url} ${upgrade}`,
    );
  }
});

test("other requests get a 404 and nothing reaches the frontdoor", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream);
  try {
    for (const request of [
      "GET /conat/?EIO=4&transport=polling HTTP/1.1\r\nHost: x\r\n\r\n",
      "POST /conat/?EIO=4&transport=websocket HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n",
      upgradeRequest("/hub/?EIO=4&transport=websocket"),
      upgradeRequest("/conat/../hub/?EIO=4&transport=websocket"),
      upgradeRequest(UPGRADE_PATH).replace(
        "Upgrade: websocket",
        "Upgrade: h2c",
      ),
    ]) {
      const socket = await tlsClient(listener.port);
      socket.write(request);
      const { data, closed } = await collect(socket);
      assert.match(data.toString(), /^HTTP\/1\.1 404 /, request);
      assert.equal(closed, true);
    }
    assert.equal(listener.counters.not_found, 5);
    assert.equal(upstream.received.length, 0);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("header hygiene: any case, any count", async () => {
  const upstream = await startUpstream();
  const listener = await startListener(upstream);
  try {
    const planted = [
      "authorization: Bearer abc.def",
      "Cookie: a=1",
      "cookie: b=2",
      "X-Forwarded-For: 198.51.100.1",
      "x-FORWARDED-for: 198.51.100.2",
      "X-Forwarded-Proto: http",
      "x-forwarded-host: evil.example",
      "X-Forwarded-Port: 80",
      "FORWARDED: for=198.51.100.3",
      "X-Real-IP: 198.51.100.4",
      "x-real-ip: 198.51.100.5",
      "CF-Connecting-IP: 198.51.100.6",
      "cf-connecting-ip: 198.51.100.7",
      'Cf-Visitor: {"scheme":"http"}',
      "CF-IPCountry: XX",
      "True-Client-IP: 198.51.100.8",
      "X-Custom: kept",
    ];
    const socket = await tlsClient(listener.port);
    // The first bytes after the head travel with it and must arrive as sent.
    socket.write(
      upgradeRequest(UPGRADE_PATH, planted).replace(
        "Host: 10.0.0.2:9443",
        "hOsT: 10.0.0.2:9443",
      ) + "early-bytes",
    );
    const { data } = await collect(socket, 500);
    assert.match(data.toString(), /^HTTP\/1\.1 101 /);
    assert.match(data.toString(), /early-bytes$/);
    socket.destroy();

    const sent = upstream.received[0].data.toString();
    const [head, body] = sent.split("\r\n\r\n");
    assert.equal(body, "early-bytes");
    const lines = head.split("\r\n");
    assert.equal(lines[0], `GET ${UPGRADE_PATH} HTTP/1.1`);
    const named = (name) =>
      lines.slice(1).filter((l) => l.toLowerCase().startsWith(`${name}:`));
    assert.deepEqual(named("authorization"), ["authorization: Bearer abc.def"]);
    assert.deepEqual(named("cookie"), ["Cookie: a=1", "cookie: b=2"]);
    assert.deepEqual(named("x-custom"), ["X-Custom: kept"]);
    assert.deepEqual(named("upgrade"), ["Upgrade: websocket"]);
    assert.deepEqual(named("sec-websocket-key"), [
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ]);
    assert.deepEqual(named("host"), ["Host: cocalc.example"]);
    assert.deepEqual(named("x-forwarded-for"), ["X-Forwarded-For: 127.0.0.1"]);
    assert.deepEqual(named("x-forwarded-proto"), ["X-Forwarded-Proto: https"]);
    for (const name of [
      "x-forwarded-host",
      "x-forwarded-port",
      "forwarded",
      "x-real-ip",
      "cf-connecting-ip",
      "cf-visitor",
      "cf-ipcountry",
      "true-client-ip",
    ]) {
      assert.deepEqual(named(name), [], name);
    }
    assert.doesNotMatch(sent, /198\.51\.100\.|evil\.example|10\.0\.0\.2/);
    // The 13 planted forwarding/Cloudflare headers and Host.
    assert.equal(listener.counters.headers_stripped, 14);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("upstreamHeaderLines keeps order and duplicates of kept headers", () => {
  const { lines, stripped } = upstreamHeaderLines(
    [
      "Cookie",
      "a=1",
      "X-FORWARDED-FOR",
      "1.2.3.4",
      "cookie",
      "b=2",
      "cf-ray",
      "r",
      "Host",
      "h",
    ],
    { hostHeader: "cocalc.example", clientIp: "10.0.0.3" },
  );
  assert.equal(stripped, 3);
  assert.deepEqual(lines, [
    "Cookie: a=1",
    "cookie: b=2",
    "Host: cocalc.example",
    "X-Forwarded-For: 10.0.0.3",
    "X-Forwarded-Proto: https",
  ]);
});

test("the process: dormant by default; a bad setting logs no values", () => {
  const script = path.join(__dirname, "bay-broker-tls.js");
  const env = { PATH: process.env.PATH };
  const dormant = spawnSync(process.execPath, [script], {
    env,
    encoding: "utf8",
  });
  assert.equal(dormant.status, 0);
  assert.match(dormant.stdout, /not enabled/);

  const bad = spawnSync(process.execPath, [script], {
    env: {
      ...env,
      ...ENV,
      COCALC_BAY_BROKER_TLS_BIND_HOST: "203.0.113.77",
      COCALC_BAY_BROKER_TLS_UPSTREAM_HOST_HEADER: "secret-host.example",
    },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /not starting/);
  assert.doesNotMatch(
    bad.stdout + bad.stderr,
    /203\.0\.113\.77|10\.0\.0\.3|secret-host/,
  );
});
