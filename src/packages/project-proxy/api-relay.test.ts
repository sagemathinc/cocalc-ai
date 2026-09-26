import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createApiRelayMeter } from "./api-relay-meter";
import { init } from "@cocalc/conat/core/server";
import { connect } from "@cocalc/conat/core/client";
import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
  API_RELAY_HUB_HEADER,
} from "@cocalc/conat/project-host/api-relay";
import {
  createApiRelay,
  parseApiRelayRoute,
  type ApiRelayLimits,
} from "./api-relay";

const projectId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const hubPath = `${API_RELAY_PATH}/hub`;
const hostPath = `${API_RELAY_PATH}/host/${hostId}/${projectId}`;
const sourceHeaders = {
  [API_RELAY_PROJECT_HEADER]: projectId,
  [API_RELAY_SECRET_HEADER]: "source-project-secret",
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

async function fixture(
  limits?: Partial<ApiRelayLimits>,
  createMeter?: Parameters<typeof createApiRelay>[0]["createMeter"],
) {
  let authorized = true;
  const upstream = createServer((req, res) => {
    if (req.url === "/base/api/v2/redirect") {
      res
        .writeHead(302, { location: "https://not-a-cocalc-site.invalid/" })
        .end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () =>
      res.end(
        JSON.stringify({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      ),
    );
  });
  const upstreamUrl = await listen(upstream);
  const hostUrl = jest.fn(async () => `${upstreamUrl}/base`);
  const hubUrl = jest.fn(() => `${upstreamUrl}/base`);
  const relay = createApiRelay({
    createMeter:
      createMeter ??
      (async () => ({ take: async (bytes) => bytes, close: async () => {} })),
    authenticate: (req) => {
      if (
        req.headers[API_RELAY_SECRET_HEADER] !==
        sourceHeaders[API_RELAY_SECRET_HEADER]
      ) {
        throw Object.assign(Error("bad source credential"), {
          statusCode: 403,
        });
      }
      return { projectId, stillAuthorized: () => authorized };
    },
    hubUrl,
    hostUrl,
    limits,
  });
  const server = createServer((req, res) => {
    void relay.handleRequest(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    void relay.handleUpgrade(req, socket, head);
  });
  const url = await listen(server);
  return {
    url,
    server,
    upstream,
    upstreamUrl,
    relay,
    hubUrl,
    hostUrl,
    revoke: () => {
      authorized = false;
    },
    close: async () => {
      relay.close();
      await close(server);
      await close(upstream);
    },
  };
}

describe("project API relay", () => {
  it.each([
    `${hubPath}/../../anything`,
    `${hubPath}/api/v2/%2e%2e/secrets`,
    `${hubPath}/api/v2/../anything`,
    `${hubPath}//api/v2/auth`,
    `${hubPath}/api/v2/auth\\foo`,
    `${hubPath}/port/3000`,
    `${API_RELAY_PATH}/host/https://example.com/conat`,
    `${hostPath}/api/v2/auth`,
    `https://example.com${hubPath}/api/v2/auth`,
  ])("rejects non-API and caller-supplied routes: %s", (path) => {
    expect(() => parseApiRelayRoute(path, false)).toThrow();
  });

  it("restricts upgrades to exact Conat paths", () => {
    expect(
      parseApiRelayRoute(`${hostPath}/conat/?EIO=4&transport=websocket`, true),
    ).toEqual({ hostId, projectId, path: "/conat/?EIO=4&transport=websocket" });
    expect(() => parseApiRelayRoute(`${hubPath}/api/v2/auth`, true)).toThrow();
    expect(() => parseApiRelayRoute(`${hubPath}/conat/../app`, true)).toThrow();
  });

  it("streams HTTP with caller credentials, but strips admission and forwarding headers", async () => {
    const f = await fixture();
    try {
      const response = await fetch(`${f.url}${hubPath}/api/v2/auth?query=ok`, {
        method: "POST",
        body: "the original request",
        headers: {
          ...sourceHeaders,
          Authorization: "Bearer caller-token",
          Cookie: "caller=cookie",
          [API_RELAY_HUB_HEADER]: "https://home-bay.test/base",
          "x-forwarded-for": "1.2.3.4",
          "cf-connecting-ip": "1.2.3.4",
        },
      });
      expect(response.status).toBe(200);
      expect(f.hubUrl).toHaveBeenCalledWith("https://home-bay.test/base");
      const data: any = await response.json();
      expect(data).toMatchObject({
        url: "/base/api/v2/auth?query=ok",
        method: "POST",
        body: "the original request",
      });
      expect(data.headers).toMatchObject({
        authorization: "Bearer caller-token",
        cookie: "caller=cookie",
      });
      for (const name of [
        API_RELAY_SECRET_HEADER,
        API_RELAY_PROJECT_HEADER,
        API_RELAY_HUB_HEADER,
        "x-forwarded-for",
        "cf-connecting-ip",
      ]) {
        expect(data.headers[name]).toBeUndefined();
      }
    } finally {
      await f.close();
    }
  });

  it("rejects admission before looking up a destination", async () => {
    const f = await fixture();
    try {
      const response = await fetch(`${f.url}${hubPath}/api/v2/auth`);
      expect(response.status).toBe(403);
      await response.text();
      expect(f.hubUrl).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("does not follow upstream redirects", async () => {
    const f = await fixture();
    try {
      const response = await fetch(`${f.url}${hubPath}/api/v2/redirect`, {
        headers: sourceHeaders,
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      await response.text();
    } finally {
      await f.close();
    }
  });

  it("bounds request bodies and request rates", async () => {
    const f = await fixture({ httpBodyBytes: 8, attemptsPerMinute: 2 });
    try {
      const large = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        method: "POST",
        headers: sourceHeaders,
        body: "123456789",
      });
      expect(large.status).toBe(413);
      await large.text();
      const small = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      expect(small.status).toBe(200);
      await small.text();
      const excess = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      expect(excess.status).toBe(429);
      await excess.text();
    } finally {
      await f.close();
    }
  });

  it("bounds outstanding route lookups and releases capacity on timeout", async () => {
    const f = await fixture({ connections: 1, connectTimeoutMs: 100 });
    f.hubUrl.mockImplementation(() => new Promise(() => {}) as any);
    try {
      const first = fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      await delay(20);
      const second = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      expect(second.status).toBe(429);
      await second.text();
      const timedOut = await first;
      expect(timedOut.status).toBe(504);
      await timedOut.text();
      f.hubUrl.mockReturnValue(`${f.upstreamUrl}/base`);
      const recovered = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      expect(recovered.status).toBe(200);
      await recovered.text();
    } finally {
      await f.close();
    }
  });

  it("cancels a streaming connection when the source project loses admission", async () => {
    const f = await fixture({ checkIntervalMs: 10 });
    f.upstream.removeAllListeners("request");
    f.upstream.on("request", (_req, res) => {
      res.writeHead(200);
      res.write("started");
    });
    try {
      const req = request(`${f.url}${hubPath}/api/v2/stream`, {
        headers: sourceHeaders,
      });
      req.end();
      const [response] = await once(req, "response");
      response.resume();
      const ended = new Promise<void>((done) => response.once("aborted", done));
      f.revoke();
      await ended;
    } finally {
      await f.close();
    }
  });

  it("supports real Conat authentication through a delayed cross-host route alongside local Conat", async () => {
    const f = await fixture(
      { connectTimeoutMs: 3000 },
      quota(2 * 1024 * 1024).createMeter,
    );
    const originalAuth = { bearer: "original-account-token" };
    const target = init({
      httpServer: f.upstream,
      port: (f.upstream.address() as AddressInfo).port,
      path: "/base/conat",
      getUser: async (socket) => {
        expect(socket.handshake.auth).toEqual(originalAuth);
        expect(socket.handshake.headers.cookie).toBe("caller=cookie");
        expect(
          socket.handshake.headers[API_RELAY_SECRET_HEADER],
        ).toBeUndefined();
        return { account_id: accountId };
      },
    });
    // The Engine.IO listener must not kill a relay upgrade after its usual 1s.
    const local = init({
      httpServer: f.server,
      port: (f.server.address() as AddressInfo).port,
      allowOtherUpgradeHandlers: true,
    });
    f.hostUrl.mockImplementation(async () => {
      await delay(1200);
      return `${f.upstreamUrl}/base`;
    });
    const client = connect({
      address: `${f.url}${hostPath}`,
      auth: originalAuth,
      extraHeaders: { ...sourceHeaders, Cookie: "caller=cookie" },
      noCache: true,
      reconnection: false,
    });
    try {
      if (!client.info)
        await once(client, "info", { signal: AbortSignal.timeout(4000) });
      expect(client.info?.user?.account_id).toBe(accountId);
      expect(f.hostUrl).toHaveBeenCalledWith(hostId, projectId);
      expect(f.hubUrl).not.toHaveBeenCalled();
    } finally {
      client.close();
      f.relay.close();
      await local.close();
      await target.close();
      await f.close();
    }
  });
});

function quota(bytes: number) {
  const update = jest.fn(async (req) => ({
    account_id: accountId,
    allowance: req.close
      ? req.sent + req.received
      : Math.min(bytes, req.sent + req.received + 1024 * 1024),
    expires_at: Date.now() + 60_000,
  }));
  const createMeter = async ({ onError }) =>
    await createApiRelayMeter({
      request: {
        project_id: projectId,
        session_id: randomUUID(),
        transport: "http",
        target: "test",
      },
      update,
      onError,
    });
  return { update, createMeter };
}

describe("streaming quota enforcement", () => {
  it("fails closed before upstream access when quota lookup is unavailable", async () => {
    const f = await fixture(undefined, async () => {
      throw Error("quota unavailable");
    });
    const upstream = jest.fn();
    f.upstream.on("request", upstream);
    try {
      const response = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      expect(response.status).toBe(502);
      await response.text();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("rechecks source admission after asynchronous quota reservation", async () => {
    const close = jest.fn(async () => {});
    const f = await fixture(undefined, async () => {
      f.revoke();
      return { take: async (bytes) => bytes, close };
    });
    try {
      const response = await fetch(`${f.url}${hubPath}/api/v2/auth`, {
        headers: sourceHeaders,
      });
      expect(response.status).toBe(403);
      await response.text();
      expect(close).toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it("charges and bounds HTTP uploads in the streaming path", async () => {
    const q = quota(1024);
    const f = await fixture(undefined, q.createMeter);
    let received = 0;
    f.upstream.removeAllListeners("request");
    f.upstream.on("request", (req, res) => {
      req.on("data", (chunk) => {
        received += chunk.length;
      });
      req.on("error", () => {});
      req.on("end", () => res.end());
    });
    try {
      await new Promise<void>((done) => {
        const req = request(
          `${f.url}${hubPath}/api/v2/upload`,
          { method: "POST", headers: sourceHeaders },
          (res) => {
            res.resume();
            res.on("close", done);
            res.on("error", () => {});
          },
        );
        req.on("error", () => done());
        req.end(Buffer.alloc(128 * 1024));
      });
      expect(received).toBeLessThanOrEqual(1024);
      expect(
        q.update.mock.calls.some(([r]) => r.close && r.sent === 1024),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("limits fast responses before the revocation timer and closes the upstream", async () => {
    const q = quota(1024);
    const f = await fixture({ checkIntervalMs: 5_000 }, q.createMeter);
    let upstreamClosed!: Promise<unknown>;
    f.upstream.removeAllListeners("request");
    f.upstream.on("request", (req, res) => {
      upstreamClosed = new Promise<void>((done) =>
        req.socket.once("close", done),
      );
      req.socket.on("error", () => {});
      res.writeHead(200, { "content-length": 8 * 1024 * 1024 });
      res.write(Buffer.alloc(8 * 1024 * 1024));
    });
    try {
      let bytes = 0;
      await new Promise<void>((done, reject) => {
        const req = request(
          `${f.url}${hubPath}/api/v2/large`,
          { headers: sourceHeaders },
          (res) => {
            res.on("data", (chunk) => {
              bytes += chunk.length;
            });
            res.on("close", done);
            res.on("error", () => {});
          },
        );
        req.on("error", (err: NodeJS.ErrnoException) =>
          err.code === "ECONNRESET" ? done() : reject(err),
        );
        req.end();
      });
      await upstreamClosed;
      expect(bytes).toBeLessThanOrEqual(1024);
      expect(
        q.update.mock.calls.some(([r]) => r.close && r.received === 1024),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("streams 600 MiB with renewable credit and bounded buffers", async () => {
    const size = 600 * 1024 * 1024;
    const q = quota(size);
    const f = await fixture(undefined, q.createMeter);
    const chunk = Buffer.alloc(64 * 1024, 42);
    f.upstream.removeAllListeners("request");
    f.upstream.on("request", (_req, res) => {
      res.writeHead(200, { "content-length": size });
      let remaining = size;
      const write = () => {
        while (remaining > 0) {
          remaining -= chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", write);
            return;
          }
        }
        res.end();
      };
      write();
    });
    try {
      const response = await fetch(`${f.url}${hubPath}/api/v2/large`, {
        headers: sourceHeaders,
      });
      let bytes = 0;
      for await (const chunk of response.body!) bytes += chunk.length;
      expect(response.status).toBe(200);
      expect(bytes).toBe(size);
      expect(q.update.mock.calls.length).toBeGreaterThan(500);
    } finally {
      await f.close();
    }
  }, 30_000);

  it.each(["sent", "received"])(
    "meters fast upgraded socket bursts in the %s direction and closes both peers",
    async (direction) => {
      const limit = 32 * 1024;
      const q = quota(limit);
      const f = await fixture({ checkIntervalMs: 5_000 }, q.createMeter);
      let upstreamClosed!: Promise<unknown>;
      let sentToUpstream = 0;
      f.upstream.on("upgrade", (_req, socket) => {
        upstreamClosed = new Promise<void>((done) =>
          socket.once("close", done),
        );
        socket.on("error", () => {});
        socket.on("end", () => socket.end());
        socket.on("data", (chunk) => {
          sentToUpstream += chunk.length;
        });
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
        if (direction === "received")
          socket.write(Buffer.alloc(8 * 1024 * 1024));
      });
      try {
        const req = request(`${f.url}${hubPath}/conat/`, {
          headers: {
            ...sourceHeaders,
            Connection: "Upgrade",
            Upgrade: "websocket",
          },
        });
        req.end();
        const [, socket, head] = await once(req, "upgrade");
        let received = head.length;
        socket.on("data", (chunk) => {
          received += chunk.length;
        });
        const downstreamClosed = new Promise<void>((done) =>
          socket.once("close", done),
        );
        socket.on("error", () => {});
        if (direction === "sent") socket.write(Buffer.alloc(8 * 1024 * 1024));
        await downstreamClosed;
        await upstreamClosed;
        expect(sentToUpstream).toBeLessThanOrEqual(limit);
        expect(received).toBeLessThanOrEqual(limit);
        expect(
          q.update.mock.calls.some(
            ([r]) => r.close && r.sent + r.received === limit,
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("rate limits bad secrets and malformed routes before destination lookup", async () => {
    const f = await fixture({
      preAuthAttemptsPerMinute: 3,
      peerAttemptsPerMinute: 2,
    });
    try {
      for (const [path, expected] of [
        ["/api/v2/auth", 403],
        ["/bad", 403],
        ["/api/v2/auth", 429],
      ] as const) {
        const response = await fetch(`${f.url}${hubPath}${path}`);
        expect(response.status).toBe(expected);
        await response.text();
      }
      expect(f.hubUrl).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
