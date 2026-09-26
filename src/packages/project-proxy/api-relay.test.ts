import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
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

async function fixture(limits?: Partial<ApiRelayLimits>) {
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
    const f = await fixture({ connectTimeoutMs: 3000 });
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
