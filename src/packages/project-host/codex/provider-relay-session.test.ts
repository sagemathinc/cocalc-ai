import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import {
  setSiteFundedCodexProxyPortsForTests,
  shutdownSiteFundedCodexProxyForTests,
  startProviderRelaySession,
} from "./site-funded-proxy";

beforeAll(() => setSiteFundedCodexProxyPortsForTests([0]));
afterAll(shutdownSiteFundedCodexProxyForTests);

type Seen = {
  method?: string;
  url?: string;
  authorization?: string;
  headers?: Record<string, any>;
};

async function upstreamServer(seen: Seen[]) {
  const server = createServer((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      headers: { ...request.headers },
    });
    request.resume();
    if (request.url?.startsWith("/v1/messages/slow")) return; // never answers
    // this one answers after a while
    const delay = request.url?.startsWith("/v1/messages/delay") ? 250 : 0;
    setTimeout(() => {
      response.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.1",
      });
      response.end(JSON.stringify({ ok: true }));
    }, delay);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return server;
}

function send(
  baseUrl: string,
  path: string,
  bearer: string,
  method = "POST",
): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  // Tests reach host.containers.internal as the loopback it maps to.
  const url = new URL(
    path,
    baseUrl.replace("host.containers.internal", "127.0.0.1"),
  );
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          "x-api-key": "should-not-pass",
          "content-type": "application/json",
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(method === "POST" ? '{"model":"x"}' : undefined);
  });
}

describe("provider relay sessions on the project-reachable proxy", () => {
  it("swaps the session token for the real credential, within its policy", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const port = (upstream.address() as AddressInfo).port;
    let calls = 0;
    const session = await startProviderRelaySession({
      upstream: `http://127.0.0.1:${port}`,
      allowedPathPrefix: "/v1/",
      allowedMethods: ["POST"],
      credentialHeader: "authorization",
      credentialValue: () => {
        calls++;
        return "Bearer real-subscription-token";
      },
      tokenPrefix: "sk-ant-oat01-cocalc-",
      allowHttpForTests: true,
    });
    try {
      expect(session.token).toMatch(/^sk-ant-oat01-cocalc-[A-Za-z0-9_-]{40,}$/);
      expect(session.baseUrl).toMatch(
        /^http:\/\/host\.containers\.internal:\d+$/,
      );

      const ok = await send(
        session.baseUrl,
        "/v1/messages?beta=true",
        session.token,
      );
      expect(ok.status).toBe(200);
      expect(ok.headers["anthropic-ratelimit-unified-5h-utilization"]).toBe(
        "0.1",
      );
      expect(seen.map(({ headers: _headers, ...rest }) => rest)).toEqual([
        {
          method: "POST",
          url: "/v1/messages?beta=true",
          authorization: "Bearer real-subscription-token",
        },
      ]);
      // Revalidated for every request.
      expect(calls).toBe(1);

      // Outside the policy: another path or method never reaches upstream.
      expect(
        (await send(session.baseUrl, "/api/oauth/profile", session.token))
          .status,
      ).toBe(403);
      expect(
        (await send(session.baseUrl, "/v1/messages", session.token, "GET"))
          .status,
      ).toBe(405);
      // Another bearer is not this session (the funded-Codex path refuses it).
      expect(
        (
          await send(
            session.baseUrl,
            "/v1/messages",
            "sk-ant-oat01-cocalc-guess",
          )
        ).status,
      ).toBe(401);
      expect(seen).toHaveLength(1);

      // Closed: the token is worthless.
      session.close();
      expect(
        (await send(session.baseUrl, "/v1/messages", session.token)).status,
      ).toBe(401);
      expect(seen).toHaveLength(1);
    } finally {
      session.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("refuses when the credential is no longer available", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const port = (upstream.address() as AddressInfo).port;
    const session = await startProviderRelaySession({
      upstream: `http://127.0.0.1:${port}`,
      allowedPathPrefix: "/v1/",
      credentialHeader: "authorization",
      credentialValue: async () => {
        throw Error("internal-detail-xyz");
      },
      allowHttpForTests: true,
    });
    try {
      const refused = await send(
        session.baseUrl,
        "/v1/messages",
        session.token,
      );
      expect(refused.status).toBe(403);
      expect(refused.body).not.toMatch(/internal-detail-xyz/);
      expect(seen).toHaveLength(0);
    } finally {
      session.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects an unsafe policy", async () => {
    await expect(
      startProviderRelaySession({
        upstream: "http://api.anthropic.com",
        allowedPathPrefix: "/v1/",
        credentialHeader: "authorization",
        credentialValue: () => "Bearer x",
      }),
    ).rejects.toThrow("fixed HTTPS origin");
    await expect(
      startProviderRelaySession({
        upstream: "https://api.anthropic.com",
        allowedPathPrefix: "/v1/",
        credentialHeader: "authorization",
        credentialValue: () => "Bearer x",
        tokenPrefix: "bad prefix",
      }),
    ).rejects.toThrow("Invalid relay token prefix");
  });
  // One request with this exact request-target, sent as is (no client-side
  // URL handling), and its status (0 when the connection was reset).
  function sendRaw(
    baseUrl: string,
    target: string,
    headers: Record<string, string>,
    method = "POST",
  ): Promise<number> {
    const port = Number(new URL(baseUrl).port);
    const body = method === "POST" ? '{"model":"x"}' : "";
    return new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("error", () => resolve(0));
      socket.on("close", () =>
        resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)),
      );
      socket.write(
        [
          `${method} ${target} HTTP/1.1`,
          "Host: host.containers.internal",
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          `Content-Length: ${body.length}`,
          "Connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
  }

  async function withRelay(
    opts: Partial<Parameters<typeof startProviderRelaySession>[0]>,
    fn: (ctx: {
      session: Awaited<ReturnType<typeof startProviderRelaySession>>;
      seen: Seen[];
      port: number;
    }) => Promise<void>,
  ) {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const port = (upstream.address() as AddressInfo).port;
    const session = await startProviderRelaySession({
      upstream: `http://127.0.0.1:${port}`,
      allowedPathPrefix: "/v1/",
      allowedMethods: ["POST"],
      credentialHeader: "authorization",
      credentialValue: () => "Bearer real-subscription-token",
      allowHttpForTests: true,
      ...opts,
    });
    try {
      await fn({ session, seen, port });
    } finally {
      session.close();
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }

  it("never sends a request naming another host (B3)", async () => {
    // a second fake upstream stands for the attacker's host
    const evilSeen: Seen[] = [];
    const evil = await upstreamServer(evilSeen);
    const evilPort = (evil.address() as AddressInfo).port;
    try {
      await withRelay({}, async ({ session, seen }) => {
        const auth = { Authorization: `Bearer ${session.token}` };
        for (const target of [
          `http://127.0.0.1:${evilPort}/v1/messages`,
          `//127.0.0.1:${evilPort}/v1/messages`,
        ]) {
          expect(await sendRaw(session.baseUrl, target, auth)).toBe(403);
        }
        expect(evilSeen).toHaveLength(0);
        expect(seen).toHaveLength(0);
      });
    } finally {
      await new Promise<void>((resolve) => evil.close(() => resolve()));
    }
  });

  it("refuses encoded or backslash separators and dots, as sent (S1)", async () => {
    // a prefix-only policy: these must not reach the provider either
    await withRelay({}, async ({ session, seen }) => {
      const auth = { Authorization: `Bearer ${session.token}` };
      for (const target of [
        "/v1/..%2Fapi%2Foauth%2Fprofile",
        "/v1/..%2fapi",
        "/v1/..%5capi",
        "/v1/%2e%2e/api",
        "/v1/%2E%2E/api",
        "/v1\\api",
        "/v1/messages?x=%2f",
      ]) {
        expect([target, await sendRaw(session.baseUrl, target, auth)]).toEqual([
          target,
          403,
        ]);
      }
      expect(seen).toHaveLength(0);
      // the control: a plain path in the prefix passes
      expect(await sendRaw(session.baseUrl, "/v1/other", auth)).toBe(200);
      expect(seen).toHaveLength(1);
    });
  });

  it("allows only the exact endpoints listed, matched as sent (S1)", async () => {
    await withRelay(
      { allowedPaths: ["/v1/messages", "/v1/messages/count_tokens"] },
      async ({ session, seen }) => {
        const auth = { Authorization: `Bearer ${session.token}` };
        for (const target of [
          "/v1/models",
          "/v1/messages/",
          "/v1/./messages",
          "/v1/x/../messages",
          "/v1/messages/batches",
        ]) {
          expect([
            target,
            await sendRaw(session.baseUrl, target, auth),
          ]).toEqual([target, 403]);
        }
        expect(seen).toHaveLength(0);
        expect(
          await sendRaw(session.baseUrl, "/v1/messages?beta=true", auth),
        ).toBe(200);
        expect(
          await sendRaw(session.baseUrl, "/v1/messages/count_tokens", auth),
        ).toBe(200);
        expect(seen.map((r) => r.url)).toEqual([
          "/v1/messages?beta=true",
          "/v1/messages/count_tokens",
        ]);
      },
    );
    await expect(
      startProviderRelaySession({
        upstream: "https://api.anthropic.com",
        allowedPathPrefix: "/v1/",
        allowedPaths: ["/v1/%2e%2e/x"],
        credentialHeader: "authorization",
        credentialValue: () => "Bearer x",
      }),
    ).rejects.toThrow("Invalid relay paths");
  });

  it("passes on only the relay's credential, whatever the caller sends (P3)", async () => {
    await withRelay({}, async ({ session, seen }) => {
      expect(
        await sendRaw(session.baseUrl, "/v1/messages", {
          Authorization: `Bearer ${session.token}`,
          "X-Api-Key": "k",
          "Proxy-Authorization": "Basic eA==",
        }),
      ).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].headers!.authorization).toBe(
        "Bearer real-subscription-token",
      );
      expect(seen[0].headers).not.toHaveProperty("x-api-key");
      expect(seen[0].headers).not.toHaveProperty("proxy-authorization");
    });
  });

  it("sends nothing when the session closes while the credential is looked up (P5)", async () => {
    let release!: (value: string) => void;
    let asked!: () => void;
    const lookingUp = new Promise<void>((resolve) => (asked = resolve));
    await withRelay(
      {
        credentialValue: () =>
          new Promise<string>((resolve) => {
            release = resolve;
            asked();
          }),
      },
      async ({ session, seen }) => {
        const status = sendRaw(session.baseUrl, "/v1/messages", {
          Authorization: `Bearer ${session.token}`,
        });
        await lookingUp;
        session.close();
        release("Bearer real-subscription-token");
        expect(await status).not.toBe(200);
        expect(seen).toHaveLength(0);
      },
    );
  });

  it("between turns, suspends a session idle too long, until the next turn (B2)", async () => {
    await withRelay({ idleMs: 100 }, async ({ session, seen }) => {
      const auth = { Authorization: `Bearer ${session.token}` };
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
      // used within the idle time: still open, and the idle clock restarts
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
      await new Promise((r) => setTimeout(r, 160));
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(401);
      expect(seen).toHaveLength(2);
      // the next turn makes it usable again
      session.beginTurn();
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
      expect(seen).toHaveLength(3);
    });
  });

  it("is never idle during a turn, and idle again once it ends (B2)", async () => {
    await withRelay({ idleMs: 100 }, async ({ session }) => {
      const auth = { Authorization: `Bearer ${session.token}` };
      session.beginTurn();
      // a long tool run without a model request
      await new Promise((r) => setTimeout(r, 160));
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
      session.endTurn();
      await new Promise((r) => setTimeout(r, 160));
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(401);
      // a turn after the idle window works: the turn renews the session
      session.beginTurn();
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
    });
  });

  it("counts the idle time from a request's end, not only its start (B2)", async () => {
    await withRelay({ idleMs: 150 }, async ({ session }) => {
      const auth = { Authorization: `Bearer ${session.token}` };
      // answered after 250 ms, longer than the idle time
      expect(await sendRaw(session.baseUrl, "/v1/messages/delay", auth)).toBe(
        200,
      );
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
    });
  });

  it("is not idle while a request is in flight (B2)", async () => {
    await withRelay({ idleMs: 100 }, async ({ session, seen }) => {
      const auth = { Authorization: `Bearer ${session.token}` };
      // the provider never answers this one, so it stays in flight
      const inFlight = sendRaw(session.baseUrl, "/v1/messages/slow", auth);
      while (seen.length < 1) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 160));
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
      session.close();
      expect(await inFlight).not.toBe(200);
    });
  });

  it("never limits a running turn, however long, and is usable right after it (B2)", async () => {
    await withRelay({ idleMs: 100 }, async ({ session, seen }) => {
      const auth = { Authorization: `Bearer ${session.token}` };
      const now = Date.now();
      const clock = jest.spyOn(Date, "now");
      try {
        clock.mockReturnValue(now);
        session.beginTurn();
        // seven hours into the turn
        clock.mockReturnValue(now + 7 * 60 * 60_000);
        expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
        clock.mockReturnValue(now + 9 * 60 * 60_000);
        session.endTurn();
        // right after the long turn ended: not idle yet
        expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(200);
        clock.mockReturnValue(now + 9 * 60 * 60_000 + 200);
        expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(401);
      } finally {
        clock.mockRestore();
      }
      expect(seen).toHaveLength(2);
      // and close ends it for good
      session.close();
      session.beginTurn();
      expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(401);
    });
  });

  it("sends nothing when the session is suspended while the credential is looked up (B2)", async () => {
    let release!: (value: string) => void;
    let asked!: () => void;
    const lookingUp = new Promise<void>((resolve) => (asked = resolve));
    let first = true;
    await withRelay(
      {
        idleMs: 100,
        credentialValue: () =>
          first
            ? new Promise<string>((resolve) => {
                first = false;
                release = resolve;
                asked();
              })
            : "Bearer real-subscription-token",
      },
      async ({ session, seen }) => {
        const auth = { Authorization: `Bearer ${session.token}` };
        const status = sendRaw(session.baseUrl, "/v1/messages", auth);
        await lookingUp;
        // between turns, idle past the limit: the next request suspends it
        await new Promise((r) => setTimeout(r, 160));
        expect(await sendRaw(session.baseUrl, "/v1/messages", auth)).toBe(401);
        release("Bearer real-subscription-token");
        expect(await status).not.toBe(200);
        expect(seen).toHaveLength(0);
      },
    );
  });
});
