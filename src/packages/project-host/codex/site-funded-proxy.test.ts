/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { createServer } from "node:http";
import {
  DEFAULT_SITE_FUNDED_CODEX_POLICY,
  type SiteFundedCodexReservation,
  type SiteFundedCodexUsageEvent,
} from "@cocalc/util/ai/site-funded-codex";
import { uuid } from "@cocalc/util/misc";
import {
  shutdownSiteFundedCodexProxyForTests,
  siteFundedUsageEventId,
  startSiteFundedCodexProxySession,
} from "./site-funded-proxy";

afterAll(shutdownSiteFundedCodexProxyForTests);

function reservation(): SiteFundedCodexReservation {
  return {
    reservationId: uuid(),
    fundedTurnId: uuid(),
    poolId: "site-funded-codex-free",
    policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
    reservedMicrousd: DEFAULT_SITE_FUNDED_CODEX_POLICY.maxTurnCostMicrousd,
    poolReservedMicrousd: 400_000,
    committedMicrousd: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heartbeatIntervalMs: 30_000,
    status: "active",
  };
}

describe("site-funded Codex provider proxy", () => {
  it("uses a stable usage event id for reservation request retries", () => {
    const reservationId = uuid();
    expect(siteFundedUsageEventId(reservationId, 1)).toBe(
      siteFundedUsageEventId(reservationId, 1),
    );
    expect(siteFundedUsageEventId(reservationId, 1)).not.toBe(
      siteFundedUsageEventId(reservationId, 2),
    );
    expect(siteFundedUsageEventId(reservationId, 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("forces policy and records streaming usage without exposing the real key", async () => {
    let upstreamAuthorization = "";
    let upstreamProjectHeader: string | undefined;
    let upstreamCustomHeader: string | undefined;
    let upstreamBody: any;
    const upstream = createServer(async (request, response) => {
      upstreamAuthorization = `${request.headers.authorization ?? ""}`;
      upstreamProjectHeader = request.headers["openai-project"] as
        | string
        | undefined;
      upstreamCustomHeader = request.headers["x-project-controlled"] as
        | string
        | undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "req-header-1",
      });
      response.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-1",
            usage: {
              input_tokens: 10_000,
              input_tokens_details: { cached_tokens: 6_000 },
              output_tokens: 500,
              output_tokens_details: { reasoning_tokens: 200 },
            },
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const events: SiteFundedCodexUsageEvent[] = [];
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async (event) => {
        events.push(event);
      },
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const result = await fetch(`${localUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
        "openai-project": "proj-attacker-selected",
        "x-project-controlled": "do-not-forward",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
        service_tier: "priority",
        background: true,
        store: true,
        tools: [{ type: "function", name: "shell" }],
        // This is intentionally larger than the old byte-based pseudo-token
        // cap. Codex context management, not JSON byte length, owns compaction.
        input: "x".repeat(200_000),
      }),
    });
    expect(result.status).toBe(200);
    await result.text();
    expect(upstreamAuthorization).toBe("Bearer real-site-key");
    expect(upstreamProjectHeader).toBeUndefined();
    expect(upstreamCustomHeader).toBeUndefined();
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "medium" },
      service_tier: "default",
      background: false,
      store: false,
    });
    expect(upstreamBody.max_output_tokens).toBeGreaterThan(0);
    expect(upstreamBody.max_output_tokens).toBeLessThanOrEqual(32_000);
    expect(events).toEqual([
      expect.objectContaining({
        reservationId: session.reservationId,
        providerRequestId: "resp-1",
        requestSequence: 1,
        model: "gpt-5.6-luna",
        inputTokens: 10_000,
        cachedInputTokens: 6_000,
        outputTokens: 500,
        reasoningOutputTokens: 200,
      }),
    ]);
    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("serializes overlapping provider requests within a funded turn", async () => {
    let releaseUpstream!: () => void;
    let noteUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      noteUpstreamStarted = resolve;
    });
    const upstreamRelease = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    let upstreamRequests = 0;
    let upstreamRequestsInFlight = 0;
    let maxUpstreamRequestsInFlight = 0;
    const upstream = createServer(async (_request, response) => {
      upstreamRequests += 1;
      upstreamRequestsInFlight += 1;
      maxUpstreamRequestsInFlight = Math.max(
        maxUpstreamRequestsInFlight,
        upstreamRequestsInFlight,
      );
      noteUpstreamStarted();
      await upstreamRelease;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp-serialized",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
      upstreamRequestsInFlight -= 1;
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = () =>
      fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });

    const first = request();
    await upstreamStarted;
    const second = request();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(upstreamRequests).toBe(1);

    releaseUpstream();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(upstreamRequests).toBe(2);
    expect(maxUpstreamRequestsInFlight).toBe(1);
    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("bounds overlapping provider requests within a funded turn", async () => {
    let releaseUpstream!: () => void;
    let noteUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      noteUpstreamStarted = resolve;
    });
    const upstreamRelease = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = createServer(async (_request, response) => {
      noteUpstreamStarted();
      await upstreamRelease;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp-bounded",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = () =>
      fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });

    const accepted = [request()];
    await upstreamStarted;
    for (let i = 1; i < 8; i += 1) accepted.push(request());
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const rejected = await request();
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("too many overlapping"),
      },
    });

    releaseUpstream();
    expect(
      await Promise.all(accepted.map(async (result) => (await result).status)),
    ).toEqual(new Array(8).fill(200));
    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("queues a follow-on request while completed usage is settling", async () => {
    let upstreamRequests = 0;
    const upstream = createServer(async (_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `resp-${upstreamRequests}`,
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");

    let releaseFirstUsage!: () => void;
    let noteFirstUsageStarted!: () => void;
    const firstUsageStarted = new Promise<void>((resolve) => {
      noteFirstUsageStarted = resolve;
    });
    const firstUsageRelease = new Promise<void>((resolve) => {
      releaseFirstUsage = resolve;
    });
    let usageEvents = 0;
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {
        usageEvents += 1;
        if (usageEvents !== 1) return;
        noteFirstUsageStarted();
        await firstUsageRelease;
      },
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async () => {
      const result = await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      await result.text();
      return result.status;
    };

    expect(await request()).toBe(200);
    await firstUsageStarted;
    const second = request();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(upstreamRequests).toBe(1);

    releaseFirstUsage();
    expect(await second).toBe(200);
    expect(upstreamRequests).toBe(2);
    expect(usageEvents).toBe(2);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("rejects OpenAI-hosted paid tools before forwarding", async () => {
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: "http://127.0.0.1:1/v1",
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const result = await fetch(`${localUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: "hello",
        tools: [{ type: "web_search_preview" }],
      }),
    });
    expect(result.status).toBe(403);
    await expect(result.json()).resolves.toMatchObject({
      error: { type: "site_funded_codex_policy_error" },
    });
    session.close();
  });

  it("rejects provider-side context references and oversized requests", async () => {
    const limited = reservation();
    limited.policy = {
      ...limited.policy,
      contextWindowTokens: 100,
      autoCompactTokenLimit: 75,
    };
    const session = await startSiteFundedCodexProxySession({
      reservation: limited,
      apiKey: "real-site-key",
      upstreamBaseUrl: "http://127.0.0.1:1/v1",
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async (body: any) =>
      await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    expect(
      (await request({ input: "hello", previous_response_id: "resp-1" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request({
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: "https://example.com/a" },
              ],
            },
          ],
        })
      ).status,
    ).toBe(403);
    expect((await request({ input: "x".repeat(1_000) })).status).toBe(413);
    session.close();
  });

  it("forwards upstream errors without poisoning a retry", async () => {
    let requestCount = 0;
    const upstream = createServer(async (_request, response) => {
      requestCount += 1;
      response.writeHead(403, {
        "content-type": "application/json",
        "x-request-id": `req-rejected-${requestCount}`,
      });
      response.end(
        JSON.stringify({
          error: {
            message: "The API key cannot use this model.",
            type: "invalid_request_error",
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async () => {
      const response = await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      return { status: response.status, body: await response.json() };
    };

    await expect(request()).resolves.toMatchObject({
      status: 403,
      body: { error: { message: "The API key cannot use this model." } },
    });
    await expect(request()).resolves.toMatchObject({
      status: 403,
      body: { error: { message: "The API key cannot use this model." } },
    });
    expect(requestCount).toBe(2);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("allows a retry after a failed response that has no usage", async () => {
    let requestCount = 0;
    const upstream = createServer(async (_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            id: `resp-failed-${requestCount}`,
            status: "failed",
            error: { message: "temporary provider error" },
          },
        })}\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async () => {
      const response = await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      await response.text();
      return response.status;
    };

    await expect(request()).resolves.toBe(200);
    await expect(request()).resolves.toBe(200);
    expect(requestCount).toBe(2);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("survives an interrupted upstream stream and accepts a retry", async () => {
    let requestCount = 0;
    const upstream = createServer(async (_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        response.write('data: {"type":"response.output_text.delta"}\n\n');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        response.socket?.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp-after-interruption",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async () => {
      const response = await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      await response.text();
      return response.status;
    };

    await expect(request()).resolves.toBe(200);
    await expect(request()).resolves.toBe(200);
    expect(requestCount).toBe(2);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("accounts for a final SSE event without a trailing newline", async () => {
    const upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-final-line",
            status: "completed",
            usage: { input_tokens: 120, output_tokens: 30 },
          },
        })}`,
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const events: SiteFundedCodexUsageEvent[] = [];
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async (event) => events.push(event),
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const response = await fetch(`${localUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(events).toEqual([
      expect.objectContaining({
        providerRequestId: "resp-final-line",
        inputTokens: 120,
        outputTokens: 30,
      }),
    ]);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("stops a funded turn after a completed response omits usage", async () => {
    let requestCount = 0;
    const upstream = createServer(async (_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "resp-unmetered", status: "completed" }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const session = await startSiteFundedCodexProxySession({
      reservation: reservation(),
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async () => {},
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async () => {
      const response = await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      return { status: response.status, body: await response.json() };
    };

    await expect(request()).resolves.toMatchObject({ status: 200 });
    await expect(request()).resolves.toMatchObject({
      status: 403,
      body: {
        error: {
          message: expect.stringContaining("without usage data"),
        },
      },
    });
    expect(requestCount).toBe(1);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("reuses one runtime credential with isolated per-turn reservations", async () => {
    const upstream = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp-rebound",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const first = reservation();
    const second = reservation();
    const events: SiteFundedCodexUsageEvent[] = [];
    const session = await startSiteFundedCodexProxySession({
      reservation: first,
      apiKey: "real-site-key",
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      onUsage: async (event) => events.push(event),
    });
    const localUrl = session.baseUrl.replace(
      "host.containers.internal",
      "127.0.0.1",
    );
    const request = async () => {
      const response = await fetch(`${localUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      await response.text();
      return response.status;
    };

    expect(await request()).toBe(200);
    session.deactivate(first.reservationId);
    expect(await request()).toBe(403);
    session.activate({
      reservation: second,
      onUsage: async (event) => events.push(event),
    });
    expect(await request()).toBe(200);
    expect(events.map((event) => event.reservationId)).toEqual([
      first.reservationId,
      second.reservationId,
    ]);

    session.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});
