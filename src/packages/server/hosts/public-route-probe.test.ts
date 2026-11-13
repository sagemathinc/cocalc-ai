/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

import {
  _test,
  probeProjectHostPublicRoute,
  projectHostPublicRouteProbeDiagnostic,
} from "./public-route-probe";

const PUBLIC_URL = "https://host-123-cocalc-prod.cocalc.ai";
const ORIGIN = "https://cocalc.ai";
const HOST_ID = "84f2a969-6d8e-4a47-93c5-7cc13cf13ac0";

function response(
  status: number,
  headers: Record<string, string> = {},
  body: BodyInit | null = null,
): Response {
  return new Response(body, { status, headers });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function healthResponse({
  body = {},
  headers = {},
}: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
} = {}): Response {
  return response(
    200,
    { "content-type": "application/json", ...headers },
    JSON.stringify({
      ok: true,
      ready: true,
      host_id: HOST_ID,
      ...body,
    }),
  );
}

describe("probeProjectHostPublicRoute", () => {
  // These tests run real servers on 127.0.0.1, which needs the bay's
  // development loopback opt-in (production never sets it).
  const savedLoopback = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  beforeEach(() => {
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "1";
  });
  afterEach(() => {
    if (savedLoopback == null) {
      delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    } else {
      process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = savedLoopback;
    }
  });

  it("checks public health, CORS preflight, and session rejection", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        healthResponse({
          headers: { server: "cloudflare", "cf-ray": "ray-1" },
        }),
      )
      .mockResolvedValueOnce(response(204, corsHeaders()))
      .mockResolvedValueOnce(response(401, corsHeaders()));
    const websocketProbeImpl = jest.fn().mockResolvedValue({ status: 101 });

    await expect(
      probeProjectHostPublicRoute({
        public_url: `${PUBLIC_URL}/ignored/path`,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
        websocketProbeImpl,
        timeout_ms: 1000,
      }),
    ).resolves.toEqual({
      public_url: PUBLIC_URL,
      origin: ORIGIN,
      expected_host_id: HOST_ID,
      health_host_id: HOST_ID,
      health_status: 200,
      preflight_status: 204,
      session_status: 401,
      websocket_status: 101,
      websocket_attempts: 8,
      websocket_successes: 8,
      websocket_failures: 0,
      websocket_samples: Array.from({ length: 8 }, () => ({
        ok: true,
        duration_ms: expect.any(Number),
        status: 101,
      })),
      edge_server: "cloudflare",
      cf_ray: "ray-1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(`${fetchImpl.mock.calls[0][0]}`).toBe(`${PUBLIC_URL}/healthz`);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(`${fetchImpl.mock.calls[1][0]}`).toBe(
      `${PUBLIC_URL}/.cocalc/project-host/session`,
    );
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: "OPTIONS",
      headers: expect.objectContaining({
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
      }),
    });
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: "{}",
    });
    expect(websocketProbeImpl).toHaveBeenCalledTimes(8);
    expect(websocketProbeImpl).toHaveBeenCalledWith({
      url: new URL(`${PUBLIC_URL}/conat/?EIO=4&transport=websocket`),
      origin: ORIGIN,
      timeout_ms: 1000,
    });
  });

  it("tolerates a minority of sampled WebSocket upgrade failures", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(response(204, corsHeaders()))
      .mockResolvedValueOnce(response(401, corsHeaders()));
    const websocketProbeImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("first websocket error"))
      .mockResolvedValue({ status: 101 });

    await expect(
      probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
        websocketProbeImpl,
        websocket_attempts: 4,
      }),
    ).resolves.toMatchObject({
      websocket_attempts: 4,
      websocket_successes: 3,
      websocket_failures: 1,
      websocket_status: 101,
      websocket_samples: [
        expect.objectContaining({
          ok: false,
          error: "Error: first websocket error",
        }),
        expect.objectContaining({ ok: true, status: 101 }),
        expect.objectContaining({ ok: true, status: 101 }),
        expect.objectContaining({ ok: true, status: 101 }),
      ],
    });
  });

  it("fails when fewer than 75 percent of WebSocket upgrades succeed", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(response(204, corsHeaders()))
      .mockResolvedValueOnce(response(401, corsHeaders()));
    const websocketProbeImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("first websocket error"))
      .mockRejectedValueOnce(new Error("second websocket error"))
      .mockResolvedValue({ status: 101 });

    await expect(
      probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
        websocketProbeImpl,
        websocket_attempts: 4,
      }),
    ).rejects.toThrow(
      "2/4 public project-host WebSocket upgrades failed: Error: first websocket error",
    );
  });

  it("uses isolated native HTTP requests for the default transport", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: true, ready: true, host_id: HOST_ID }),
        );
        return;
      }
      if (
        request.url === "/.cocalc/project-host/session" &&
        request.method === "OPTIONS"
      ) {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }
      if (
        request.url === "/.cocalc/project-host/session" &&
        request.method === "POST"
      ) {
        response.writeHead(401, corsHeaders());
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      await expect(
        probeProjectHostPublicRoute({
          public_url: `http://127.0.0.1:${address.port}`,
          origin: ORIGIN,
          expected_host_id: HOST_ID,
          websocketProbeImpl: jest.fn().mockResolvedValue({ status: 101 }),
          websocket_attempts: 4,
          timeout_ms: 1000,
        }),
      ).resolves.toMatchObject({
        health_status: 200,
        preflight_status: 204,
        session_status: 401,
        websocket_successes: 4,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("retries one transient native HTTP socket reset", async () => {
    let healthAttempts = 0;
    const server = createServer((request, response) => {
      if (request.url === "/healthz") {
        healthAttempts += 1;
        if (healthAttempts === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: true, ready: true, host_id: HOST_ID }),
        );
        return;
      }
      if (
        request.url === "/.cocalc/project-host/session" &&
        request.method === "OPTIONS"
      ) {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }
      if (
        request.url === "/.cocalc/project-host/session" &&
        request.method === "POST"
      ) {
        response.writeHead(401, corsHeaders());
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      await expect(
        probeProjectHostPublicRoute({
          public_url: `http://127.0.0.1:${address.port}`,
          origin: ORIGIN,
          expected_host_id: HOST_ID,
          websocketProbeImpl: jest.fn().mockResolvedValue({ status: 101 }),
          websocket_attempts: 4,
          timeout_ms: 1000,
        }),
      ).resolves.toMatchObject({
        health_status: 200,
        preflight_status: 204,
        session_status: 401,
        websocket_successes: 4,
      });
      expect(healthAttempts).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("performs and validates a raw WebSocket upgrade", async () => {
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      const key = `${request.headers["sec-websocket-key"] ?? ""}`;
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.end(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Accept: ${accept}`,
          "CF-Ray: local-ray",
          "",
          "",
        ].join("\r\n"),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      await expect(
        _test.probeWebSocketUpgrade({
          url: new URL(
            `http://127.0.0.1:${address.port}/conat/?EIO=4&transport=websocket`,
          ),
          origin: ORIGIN,
          timeout_ms: 1000,
        }),
      ).resolves.toEqual({ status: 101, cf_ray: "local-ray" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("retains HTTP status and CF-Ray for failed WebSocket samples", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(520, { "CF-Ray": "failed-ray-DFW" });
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      const localUrl = `http://127.0.0.1:${address.port}`;
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(healthResponse())
        .mockResolvedValueOnce(response(204, corsHeaders()))
        .mockResolvedValueOnce(response(401, corsHeaders()));
      let caught: unknown;
      try {
        await probeProjectHostPublicRoute({
          public_url: localUrl,
          origin: ORIGIN,
          expected_host_id: HOST_ID,
          fetchImpl,
          websocket_attempts: 4,
          timeout_ms: 1000,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(projectHostPublicRouteProbeDiagnostic(caught)).toMatchObject({
        stage: "websocket",
        websocket_attempts: 4,
        websocket_successes: 0,
        websocket_failures: 4,
        websocket_samples: Array.from({ length: 4 }, () =>
          expect.objectContaining({
            ok: false,
            status: 520,
            cf_ray: "failed-ray-DFW",
            duration_ms: expect.any(Number),
          }),
        ),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("rejects a public edge response without browser CORS headers", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(
        response(204, {
          ...corsHeaders(),
          "Access-Control-Allow-Origin": "",
        }),
      );

    await expect(
      probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
      }),
    ).rejects.toThrow("invalid Access-Control-Allow-Origin");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a Cloudflare or origin health error before session checks", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(502));

    await expect(
      probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
      }),
    ).rejects.toThrow("health check returned HTTP 502");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a project-host that returns HTTP 200 before it is ready", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response(
        200,
        { "content-type": "application/json" },
        JSON.stringify({
          ok: true,
          ready: false,
        }),
      ),
    );

    let caught: unknown;
    try {
      await probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("reported ready=false");
    expect(projectHostPublicRouteProbeDiagnostic(caught)).toMatchObject({
      stage: "health",
      expected_host_id: HOST_ID,
      health_status: 200,
      health_ok: true,
      health_ready: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires the exact unauthenticated session response", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(response(204, corsHeaders()))
      .mockResolvedValueOnce(response(403, corsHeaders()));

    await expect(
      probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
      }),
    ).rejects.toThrow("returned HTTP 403; expected 401");
  });

  it("rejects credentials embedded in the public URL", async () => {
    await expect(
      probeProjectHostPublicRoute({
        public_url: "https://user:secret@host.example.test",
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl: jest.fn(),
      }),
    ).rejects.toThrow("must not contain credentials");
  });

  it("rejects a health response without a project-host identity", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      healthResponse({
        body: { host_id: undefined },
      }),
    );

    await expect(
      probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
      }),
    ).rejects.toThrow("did not report host_id");
  });

  it("rejects a healthy response from the wrong project host", async () => {
    const wrongHostId = "777d774e-3f9c-43a0-9944-c2c25324741f";
    const fetchImpl = jest.fn().mockResolvedValue(
      healthResponse({
        body: { host_id: wrongHostId },
      }),
    );

    let caught: unknown;
    try {
      await probeProjectHostPublicRoute({
        public_url: PUBLIC_URL,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain(
      `reached host "${wrongHostId}"; expected "${HOST_ID}"`,
    );
    expect(projectHostPublicRouteProbeDiagnostic(caught)).toMatchObject({
      stage: "health",
      expected_host_id: HOST_ID,
      health_host_id: wrongHostId,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("probeProjectHostPublicRoute target containment (054 C R3)", () => {
  const savedLoopback = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  beforeEach(() => {
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    lookupCalls = [];
  });
  afterAll(() => {
    if (savedLoopback != null) {
      process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = savedLoopback;
    }
  });

  let lookupCalls: string[] = [];
  function fakeLookup(table: Record<string, string>) {
    return ((hostname: string, options: any, callback: any) => {
      lookupCalls.push(hostname);
      const address = table[hostname];
      if (!address) {
        process.nextTick(
          callback,
          Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
        );
      } else if (options?.all) {
        process.nextTick(callback, null, [{ address, family: 4 }]);
      } else {
        process.nextTick(callback, null, address, 4);
      }
    }) as any;
  }

  async function localServer(handler: (req: any, res: any) => void) {
    let connections = 0;
    let upgrades = 0;
    const server = createServer(handler);
    server.on("connection", () => (connections += 1));
    server.on("upgrade", (_req, socket) => {
      upgrades += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as any).port;
    return {
      port,
      counts: () => ({ connections, upgrades }),
      close: () => new Promise((r) => server.close(r)),
    };
  }

  it("refuses a public_url naming a refused address before any request", async () => {
    const fetchImpl = jest.fn();
    const websocketProbeImpl = jest.fn();
    for (const public_url of [
      "http://127.0.0.1:9002",
      "http://localhost:9002",
      "http://169.254.169.254/",
      "http://metadata.google.internal/",
      "http://[::ffff:7f00:1]/",
    ]) {
      await expect(
        probeProjectHostPublicRoute({
          public_url,
          origin: ORIGIN,
          expected_host_id: HOST_ID,
          fetchImpl,
          websocketProbeImpl,
        }),
      ).rejects.toThrow("not an allowed target");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(websocketProbeImpl).not.toHaveBeenCalled();
  });

  it("HTTP: a name that resolves to loopback never reaches the server", async () => {
    const server = await localServer((_req, res) => res.end("{}"));
    try {
      await expect(
        probeProjectHostPublicRoute({
          public_url: `http://probe.example:${server.port}`,
          origin: ORIGIN,
          expected_host_id: HOST_ID,
          lookup: fakeLookup({ "probe.example": "127.0.0.1" }),
          timeout_ms: 2000,
        }),
      ).rejects.toThrow();
      expect(server.counts()).toEqual({ connections: 0, upgrades: 0 });
      expect(lookupCalls).toContain("probe.example");
    } finally {
      await server.close();
    }
  });

  it("WebSocket: the default upgrade probe never reaches the server either", async () => {
    const server = await localServer((_req, res) => res.end());
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(response(204, corsHeaders()))
      .mockResolvedValueOnce(response(401, corsHeaders()));
    try {
      const result = await probeProjectHostPublicRoute({
        public_url: `http://probe.example:${server.port}`,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        fetchImpl,
        websocket_attempts: 2,
        lookup: fakeLookup({ "probe.example": "127.0.0.1" }),
        timeout_ms: 2000,
      }).catch((err) => err);
      expect(result).toBeInstanceOf(Error);
      expect(server.counts()).toEqual({ connections: 0, upgrades: 0 });
      // the HTTP stages were stubbed: only the WS upgrade resolved the name,
      // through the guarded agent's hook
      expect(lookupCalls).toContain("probe.example");
    } finally {
      await server.close();
    }
  });

  it("does not follow a redirect to another address", async () => {
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "1";
    const other = await localServer((_req, res) => res.end("{}"));
    const first = await localServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.1:${other.port}/healthz`);
      res.end();
    });
    try {
      await probeProjectHostPublicRoute({
        public_url: `http://127.0.0.1:${first.port}`,
        origin: ORIGIN,
        expected_host_id: HOST_ID,
        timeout_ms: 2000,
      }).catch(() => undefined);
      expect(first.counts().connections).toBeGreaterThan(0);
      expect(other.counts().connections).toBe(0);
    } finally {
      await first.close();
      await other.close();
    }
  });
});

describe("projectHostRequest (054 C A5)", () => {
  const savedLoopback = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  afterEach(() => {
    if (savedLoopback == null) {
      delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    } else {
      process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = savedLoopback;
    }
  });

  it("refuses refused URLs and names that resolve to them; never follows redirects", async () => {
    const { projectHostRequest } = await import("./public-route-probe");
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    await expect(projectHostRequest("http://127.0.0.1:1/")).rejects.toThrow(
      "not an allowed target",
    );
    let hits = 0;
    let otherHits = 0;
    const other = createServer((_req, res) => {
      otherHits += 1;
      res.end("other");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherPort = (other.address() as any).port;
    const server = createServer((_req, res) => {
      hits += 1;
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.1:${otherPort}/`);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const lookup = ((_h: string, o: any, cb: any) =>
        o?.all
          ? process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }])
          : process.nextTick(cb, null, "127.0.0.1", 4)) as any;
      await expect(
        projectHostRequest(`http://smoke.example:${port}/`, {}, { lookup }),
      ).rejects.toMatchObject({ code: "ECOCALC_REFUSED_TARGET" });
      expect(hits).toBe(0);
      process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "1";
      const r = await projectHostRequest(`http://127.0.0.1:${port}/`);
      expect(r.status).toBe(302);
      expect(hits).toBe(1);
      expect(otherHits).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => other.close(r));
    }
  });
});
