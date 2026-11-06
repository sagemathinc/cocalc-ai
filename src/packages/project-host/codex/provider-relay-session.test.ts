import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  setSiteFundedCodexProxyPortsForTests,
  shutdownSiteFundedCodexProxyForTests,
  startProviderRelaySession,
} from "./site-funded-proxy";

beforeAll(() => setSiteFundedCodexProxyPortsForTests([0]));
afterAll(shutdownSiteFundedCodexProxyForTests);

type Seen = { method?: string; url?: string; authorization?: string };

async function upstreamServer(seen: Seen[]) {
  const server = createServer((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    request.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
    });
    response.end(JSON.stringify({ ok: true }));
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
      expect(seen).toEqual([
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
});
