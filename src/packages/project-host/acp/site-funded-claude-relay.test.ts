/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SITE_FUNDED_CLAUDE_POLICY } from "@cocalc/util/ai/site-funded-claude";
import {
  computeSiteFundedCodexRequestCost,
  siteFundedCodexFinalRequestHeadroomMicrousd,
  type SiteFundedCodexUsageEvent,
} from "@cocalc/util/ai/site-funded-codex";
import {
  createSiteFundedClaudeRelay,
  type SiteFundedClaudeRelay,
} from "./site-funded-claude-relay";
import { CREDENTIAL_RELAY_AUTH_HEADER } from "./credential-http-relay";

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

type Seen = { url: string; headers: Record<string, unknown>; body: any };

let upstream: Server;
let upstreamUrl: string;
let seen: Seen[];
// What the fake Anthropic answers with.
let reply: (seen: Seen) => {
  status?: number;
  type: string;
  body: string;
  /** Wait before answering; never answer when "hang". */
  delayMs?: number | "hang";
};
// Requests the fake Anthropic is answering right now, and the most at once.
let inFlight = 0;
let maxInFlight = 0;
let dir: string;
let relay: SiteFundedClaudeRelay;
let usage: SiteFundedCodexUsageEvent[];

const jsonReply = (usage: object) => () => ({
  type: "application/json",
  body: JSON.stringify({ id: "msg_1", content: [], usage }),
});

beforeEach(async () => {
  seen = [];
  usage = [];
  inFlight = 0;
  maxInFlight = 0;
  reply = jsonReply({ input_tokens: 10, output_tokens: 5 });
  upstream = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const entry = {
        url: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(data || "{}"),
      };
      seen.push(entry);
      const { status = 200, type, body, delayMs = 0 } = reply(entry);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on("close", () => (inFlight -= 1));
      if (delayMs === "hang") {
        res.writeHead(status, { "content-type": type, "request-id": "req_1" });
        res.write(body);
        return;
      }
      setTimeout(() => {
        res.writeHead(status, { "content-type": type, "request-id": "req_1" });
        res.end(body);
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = upstream.address() as { port: number };
  upstreamUrl = `http://127.0.0.1:${address.port}`;
  dir = await mkdtemp(join(tmpdir(), "funded-relay-"));
  relay = await createSiteFundedClaudeRelay({
    socketPath: join(dir, "relay.sock"),
    upstream: upstreamUrl,
    allowHttpForTests: true,
  });
});

afterEach(async () => {
  await relay.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const policy = {
  ...DEFAULT_SITE_FUNDED_CLAUDE_POLICY,
  maxOutputTokensPerRequest: 1_000,
  maxRequestsPerTurn: 3,
  maxTurnCostMicrousd: 100_000,
};

function activate(
  overrides: Partial<typeof policy> = {},
  {
    expiresAt,
    onUsage,
  }: {
    expiresAt?: string;
    onUsage?: (event: SiteFundedCodexUsageEvent) => Promise<void>;
  } = {},
) {
  relay.activate({
    reservation: {
      reservationId: "reservation-1",
      policy: { ...policy, ...overrides },
      expiresAt,
    } as any,
    apiKey: "sk-ant-site-key",
    onUsage:
      onUsage ??
      (async (event) => {
        usage.push(event);
      }),
  });
}

function send(
  body: unknown,
  {
    path = "/v1/messages?beta=true",
    token = relay.token,
    method = "POST",
    headers = {},
  }: {
    path?: string;
    token?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: relay.socketPath,
        path,
        method,
        headers: {
          "content-type": "application/json",
          [CREDENTIAL_RELAY_AUTH_HEADER]: token,
          "x-api-key": "cocalc-credential-relay",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          });
        res.on("end", done);
        // Cut off by the relay (its turn ended): what arrived.
        res.on("error", done);
        res.on("close", done);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const message = { model: "claude-fable-5-1", max_tokens: 64_000, messages: [] };

describe("site-funded Claude relay", () => {
  it("refuses a caller without the relay token, and anything outside a turn", async () => {
    activate();
    expect((await send(message, { token: "wrong" })).status).toBe(401);
    relay.deactivate();
    const outside = await send(message);
    expect(outside.status).toBe(403);
    expect(outside.body).toContain("No included Claude turn is active");
    expect(seen).toEqual([]);
  });

  it("forwards only the Messages API, with the site key and the funded model", async () => {
    activate();
    expect(
      (await send(message, { path: "/v1/models", method: "GET" })).status,
    ).toBe(403);
    expect((await send(message, { path: "/v1/messages/batches" })).status).toBe(
      403,
    );
    expect((await send(message, { path: "/v1/messages?other=1" })).status).toBe(
      403,
    );
    const ok = await send(
      { ...message, inference_geo: "us", service_tier: "priority" },
      { headers: { "anthropic-beta": "some-beta" } },
    );
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
    const [forwarded] = seen;
    expect(forwarded.url).toBe("/v1/messages?beta=true");
    expect(forwarded.headers["x-api-key"]).toBe("sk-ant-site-key");
    expect(forwarded.headers["anthropic-beta"]).toBe("some-beta");
    expect(forwarded.headers[CREDENTIAL_RELAY_AUTH_HEADER]).toBeUndefined();
    expect(forwarded.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 1_000,
    });
    expect(forwarded.body.inference_geo).toBeUndefined();
    expect(forwarded.body.service_tier).toBeUndefined();
    // The site key never comes back.
    expect(JSON.stringify(ok)).not.toContain("sk-ant-site-key");
  });

  it("refuses hosted tools beyond metered web search and fetch", async () => {
    activate();
    for (const body of [
      { ...message, mcp_servers: [{ url: "https://x" }] },
      { ...message, container: "c" },
      { ...message, tools: [{ type: "code_execution_20250825" }] },
    ]) {
      expect((await send(body)).status).toBe(403);
    }
    expect(seen).toEqual([]);
    const allowed = await send({
      ...message,
      tools: [
        { name: "Bash", input_schema: {} },
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
      ],
    });
    expect(allowed.status).toBe(200);
  });

  it("meters a JSON response's usage, in order", async () => {
    activate();
    reply = jsonReply({
      input_tokens: 100,
      cache_read_input_tokens: 1_000,
      output_tokens: 50,
      server_tool_use: { web_search_requests: 2 },
    });
    await send(message);
    await send(message);
    expect(usage.map(({ requestSequence }) => requestSequence)).toEqual([1, 2]);
    expect(usage[0]).toMatchObject({
      reservationId: "reservation-1",
      providerRequestId: "req_1",
      model: "claude-haiku-5-5",
      inputTokens: 1_100,
      cachedInputTokens: 1_000,
      outputTokens: 50,
      providerToolFeesMicrousd: 20_000,
    });
  });

  it("meters a streamed response from message_start and message_delta", async () => {
    activate();
    reply = () => ({
      type: "text/event-stream",
      body: [
        "event: message_start",
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 30, cache_creation_input_tokens: 200, output_tokens: 1 } } })}`,
        "",
        "event: content_block_delta",
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}`,
        "",
        "event: message_delta",
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}`,
        "",
        "event: message_stop",
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
        "",
      ].join("\n"),
    });
    const streamed = await send({ ...message, stream: true });
    expect(streamed.body).toContain("content_block_delta");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 230,
      cacheWriteInputTokens: 200,
      outputTokens: 42,
    });
  });

  it("does not meter counting tokens or provider errors", async () => {
    activate();
    await send(message, { path: "/v1/messages/count_tokens" });
    reply = () => ({
      status: 529,
      type: "application/json",
      body: JSON.stringify({ type: "error" }),
    });
    expect((await send(message)).status).toBe(529);
    expect(usage).toEqual([]);
    // Counting tokens leaves max_tokens alone.
    expect(seen[0].body.max_tokens).toBe(64_000);
  });

  it("stops a turn at its request and cost limits", async () => {
    activate();
    for (let i = 0; i < 3; i++) expect((await send(message)).status).toBe(200);
    const limited = await send(message);
    expect(limited.status).toBe(403);
    expect(limited.body).toContain("request limit");
    activate({ maxTurnCostMicrousd: 1 });
    expect((await send(message)).status).toBe(200);
    const costly = await send(message);
    expect(costly.status).toBe(403);
    expect(costly.body).toContain("cost limit");
  });

  it("runs a turn's requests one at a time, so limits cannot race", async () => {
    activate({ maxRequestsPerTurn: 2 });
    reply = () => ({
      ...jsonReply({ input_tokens: 10, output_tokens: 5 })(),
      delayMs: 50,
    });
    const results = await Promise.all([
      send(message),
      send(message),
      send(message),
    ]);
    expect(maxInFlight).toBe(1);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 200, 403]);
    expect(seen).toHaveLength(2);
    expect(usage.map(({ requestSequence }) => requestSequence)).toEqual([1, 2]);
  });

  it("counts token counting toward the request limit", async () => {
    activate({ maxRequestsPerTurn: 2 });
    const count = { path: "/v1/messages/count_tokens" };
    expect((await send(message, count)).status).toBe(200);
    expect((await send(message, count)).status).toBe(200);
    expect((await send(message, count)).status).toBe(403);
    expect(usage).toEqual([]);
  });

  it("caps web searches per request", async () => {
    activate();
    await send({
      ...message,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 50 },
      ],
    });
    expect(seen[0].body.tools[0].max_uses).toBe(5);
    const twice = await send({
      ...message,
      tools: [
        { type: "web_search_20260209", name: "a" },
        { type: "web_search_20260209", name: "b" },
      ],
    });
    expect(twice.status).toBe(403);
  });

  it("charges an unfinished stream at its upper bound", async () => {
    activate();
    reply = () => ({
      type: "text/event-stream",
      body: [
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1 } } })}`,
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}`,
        "",
      ].join("\n"),
    });
    await send({ ...message, stream: true });
    // The prompt was reported; the output may have run to max_tokens.
    expect(usage[0]).toMatchObject({ inputTokens: 30, outputTokens: 1_000 });
  });

  it("charges a response without usage at its upper bound", async () => {
    activate();
    reply = () => ({
      type: "application/json",
      body: JSON.stringify({ id: "msg_1" }),
    });
    const body = {
      ...message,
      messages: [{ role: "user", content: "x".repeat(500) }],
    };
    await send(body);
    // The compact request that was forwarded, not what came in.
    const bytes = Buffer.byteLength(JSON.stringify(seen[0].body));
    expect(usage[0]).toMatchObject({
      inputTokens: bytes,
      cacheWriteInputTokens: bytes,
      cacheWrite1hInputTokens: bytes,
      outputTokens: 1_000,
    });
  });

  it("does not charge a refused request", async () => {
    activate();
    reply = () => ({
      status: 400,
      type: "application/json",
      body: JSON.stringify({ type: "error" }),
    });
    expect((await send(message)).status).toBe(400);
    expect(usage).toEqual([]);
  });

  it("ends a turn only after its running request is metered, aborting it if it hangs", async () => {
    activate();
    reply = () => ({
      type: "text/event-stream",
      body: `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1 } } })}\n`,
      delayMs: "hang",
    });
    const pending = send({ ...message, stream: true }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usage).toEqual([]);
    await relay.deactivate("reservation-1", { timeoutMs: 50 });
    // Aborted, and charged at its upper bound before the turn could settle.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 30, outputTokens: 1_000 });
    await pending;
    // And nothing more is funded.
    expect((await send(message)).status).toBe(403);
  });

  it("never charges a padded request's fallback beyond the room for one request", async () => {
    activate();
    reply = () => ({
      type: "application/json",
      body: JSON.stringify({ id: "msg_1" }),
    });
    // Whitespace padding: valid JSON, forwarded compact.
    const padded = `{${" ".repeat(4 * 1024 * 1024)}"model":"x","max_tokens":10,"messages":[]}`;
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          socketPath: relay.socketPath,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CREDENTIAL_RELAY_AUTH_HEADER]: relay.token,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(padded);
    });
    const [event] = usage;
    expect(event.inputTokens).toBe(
      Buffer.byteLength(JSON.stringify(seen[0].body)),
    );
    expect(
      computeSiteFundedCodexRequestCost({ model: event.model, usage: event })
        .costMicrousd,
    ).toBeLessThanOrEqual(siteFundedCodexFinalRequestHeadroomMicrousd(policy));
  });

  it("bounds a fallback by the largest prompt the model accepts", async () => {
    activate({ maxPromptTokens: 100 });
    reply = () => ({
      type: "application/json",
      body: JSON.stringify({ id: "msg_1" }),
    });
    await send({
      ...message,
      messages: [{ role: "user", content: "x".repeat(5_000) }],
    });
    expect(usage[0].inputTokens).toBe(100);
  });

  it("stops funding a turn whose usage could not be recorded, and settles after it", async () => {
    let recorded: () => void = () => {};
    let attempts = 0;
    activate(
      {},
      {
        onUsage: () => {
          attempts += 1;
          return new Promise((_, reject) => {
            recorded = () => reject(Error("outbox unavailable"));
          });
        },
      },
    );
    expect((await send(message)).status).toBe(200);
    let settled = false;
    const ending = relay.deactivate("reservation-1").then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The turn waits for its usage to be recorded (here: to fail).
    expect(settled).toBe(false);
    recorded();
    await ending;
    expect(attempts).toBe(1);
  });

  it("blocks the next request once a usage record fails", async () => {
    activate(
      {},
      { onUsage: async () => Promise.reject(Error("outbox unavailable")) },
    );
    expect((await send(message)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const blocked = await send(message);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toContain("could not be recorded");
  });

  it("starts no request after the reservation's deadline", async () => {
    activate({}, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const late = await send(message);
    expect(late.status).toBe(403);
    expect(seen).toEqual([]);
  });
});
