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

const counted = (tokens: number) => ({
  type: "application/json",
  body: JSON.stringify({ input_tokens: tokens }),
});

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
    // No body on a GET: Node sends it without a length, so the server would
    // read it as a second, malformed request and drop the connection.
    req.end(method === "GET" ? undefined : JSON.stringify(body));
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

  it("sends the site key only to the configured upstream, whatever the request names", async () => {
    activate();
    const ok = await send(message, {
      path: "http://attacker.invalid/v1/messages?beta=true",
    });
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/v1/messages?beta=true");
  });

  it("refuses hosted tools beyond metered web search", async () => {
    activate();
    for (const body of [
      { ...message, mcp_servers: [{ url: "https://x" }] },
      { ...message, container: "c" },
      { ...message, tools: [{ type: "code_execution_20250825" }] },
      // Its pages would join the prompt unbounded.
      { ...message, tools: [{ type: "web_fetch_20260209", name: "f" }] },
    ]) {
      expect((await send(body)).status).toBe(403);
    }
    expect(seen).toEqual([]);
    const allowed = await send({
      ...message,
      tools: [
        { name: "Bash", input_schema: {} },
        { type: "web_search_20260209", name: "web_search" },
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
    expect(seen[0].body.tools[0].max_uses).toBe(3);
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
    // The compact request that was forwarded, not what came in, plus what
    // Anthropic adds beyond its bytes.
    const bytes = Buffer.byteLength(JSON.stringify(seen[0].body)) + 4_096;
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
    // Its compact bytes, plus what Anthropic adds beyond them.
    expect(event.inputTokens).toBe(
      Buffer.byteLength(JSON.stringify(seen[0].body)) + 4_096,
    );
    expect(
      computeSiteFundedCodexRequestCost({ model: event.model, usage: event })
        .costMicrousd,
    ).toBeLessThanOrEqual(siteFundedCodexFinalRequestHeadroomMicrousd(policy));
  });

  it("bounds a fallback by the prompt as counted", async () => {
    activate({ maxPromptTokens: 5_000 });
    reply = (seen) =>
      seen.url.startsWith("/v1/messages/count_tokens")
        ? counted(800)
        : { type: "application/json", body: JSON.stringify({ id: "msg_1" }) };
    await send({
      ...message,
      messages: [{ role: "user", content: "x".repeat(5_000) }],
    });
    expect(usage[0].inputTokens).toBe(800);
  });

  it("refuses a prompt over the cap with Anthropic's wording, sending nothing", async () => {
    activate({ maxPromptTokens: 5_000 });
    reply = (seen) =>
      seen.url.startsWith("/v1/messages/count_tokens")
        ? counted(6_000)
        : jsonReply({ input_tokens: 6_000, output_tokens: 5 })();
    const long = await send({
      ...message,
      system: "be brief",
      metadata: { user_id: "u" },
      output_config: { format: { type: "json_schema", schema: {} } },
      messages: [{ role: "user", content: "x".repeat(10_000) }],
    });
    expect(long.status).toBe(400);
    expect(JSON.parse(long.body).error).toEqual({
      type: "invalid_request_error",
      // With room for the count's error.
      message: "prompt is too long: 6000 tokens > 3000 maximum",
    });
    // Only counted, with the site key and every field that adds to the
    // prompt.
    expect(seen.map(({ url }) => url)).toEqual([
      "/v1/messages/count_tokens?beta=true",
    ]);
    expect(seen[0].headers["x-api-key"]).toBe("sk-ant-site-key");
    expect(Object.keys(seen[0].body).sort()).toEqual([
      "messages",
      "model",
      "output_config",
      "system",
    ]);
    expect(seen[0].body.model).toBe("claude-haiku-5-5");
    expect(usage).toEqual([]);
  });

  it("sends a prompt at the limit after counting it", async () => {
    activate({ maxPromptTokens: 5_000 });
    reply = (seen) =>
      seen.url.startsWith("/v1/messages/count_tokens")
        ? counted(3_000)
        : jsonReply({ input_tokens: 3_000, output_tokens: 5 })();
    const atCap = await send({
      ...message,
      messages: [{ role: "user", content: "x".repeat(10_000) }],
    });
    expect(atCap.status).toBe(200);
    expect(seen.map(({ url }) => url)).toEqual([
      "/v1/messages/count_tokens?beta=true",
      "/v1/messages?beta=true",
    ]);
    expect(usage[0].inputTokens).toBe(3_000);
  });

  it("counts any prompt with media, however few its bytes", async () => {
    activate();
    reply = (seen) =>
      seen.url.startsWith("/v1/messages/count_tokens")
        ? counted(1_500)
        : jsonReply({ input_tokens: 1_500, output_tokens: 5 })();
    const inline = { type: "base64", media_type: "image/png", data: "AAAA" };
    for (const block of [
      { type: "image", source: inline },
      {
        type: "tool_result",
        tool_use_id: "t",
        content: [{ type: "document", source: inline }],
      },
    ]) {
      seen = [];
      const sent = await send({
        ...message,
        messages: [{ role: "user", content: [block] }],
      });
      expect(sent.status).toBe(200);
      expect(seen.map(({ url }) => url)).toEqual([
        "/v1/messages/count_tokens?beta=true",
        "/v1/messages?beta=true",
      ]);
    }
    // A short text prompt is sent without counting.
    seen = [];
    await send({ ...message, messages: [{ role: "user", content: "hi" }] });
    expect(seen.map(({ url }) => url)).toEqual(["/v1/messages?beta=true"]);
  });

  it("refuses media by URL or file, which cannot be counted", async () => {
    activate();
    for (const block of [
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
      {
        type: "tool_result",
        tool_use_id: "t",
        content: [
          { type: "document", source: { type: "file", file_id: "file_1" } },
        ],
      },
      { type: "container_upload", file_id: "file_2" },
    ]) {
      const sent = await send({
        ...message,
        messages: [{ role: "user", content: [block] }],
      });
      expect(sent.status).toBe(403);
      expect(sent.body).toContain("only inline");
    }
    expect(seen).toEqual([]);
  });

  it("lets only a short prompt search the web, and bounds it by the cap", async () => {
    activate();
    const search = [{ type: "web_search_20260209", name: "web_search" }];
    const long = await send({
      ...message,
      tools: search,
      messages: [{ role: "user", content: "x".repeat(20_000) }],
    });
    expect(long.status).toBe(403);
    expect(long.body).toContain("only from a short prompt");
    const image = await send({
      ...message,
      tools: search,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AA" },
            },
          ],
        },
      ],
    });
    expect(image.status).toBe(403);
    expect(seen).toEqual([]);
    // A short one is sent without counting (count_tokens refuses server
    // tools); without usage it is charged as if its results filled the cap.
    reply = () => ({
      type: "application/json",
      body: JSON.stringify({ id: "msg_1" }),
    });
    const short = await send({
      ...message,
      tools: search,
      messages: [{ role: "user", content: "news today?" }],
    });
    expect(short.status).toBe(200);
    expect(seen.map(({ url }) => url)).toEqual(["/v1/messages?beta=true"]);
    expect(usage[0].inputTokens).toBe(100_000);
  });

  it("charges a broken search stream at the cap, not at its first count", async () => {
    activate();
    reply = () => ({
      type: "text/event-stream",
      body: [
        "event: message_start",
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 300, output_tokens: 1 } } })}`,
        "",
        "",
      ].join("\n"),
    });
    await send({
      ...message,
      stream: true,
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      messages: [{ role: "user", content: "news today?" }],
    });
    // The search results it may have added count toward the prompt.
    expect(usage[0]).toMatchObject({
      inputTokens: 100_000,
      cacheWrite1hInputTokens: 100_000,
      outputTokens: 1_000,
      providerToolFeesMicrousd: 30_000,
    });
  });

  it("passes on a refused count and sends nothing", async () => {
    activate({ maxPromptTokens: 5_000 });
    reply = () => ({
      status: 429,
      type: "application/json",
      body: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error" },
      }),
    });
    const refused = await send({
      ...message,
      messages: [{ role: "user", content: "x".repeat(5_000) }],
    });
    expect(refused.status).toBe(429);
    expect(seen).toHaveLength(1);
    // An unreadable count is refused too, rather than sent uncounted.
    reply = () => ({ type: "application/json", body: "{}" });
    seen = [];
    const unreadable = await send({
      ...message,
      messages: [{ role: "user", content: "x".repeat(5_000) }],
    });
    expect(unreadable.status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(usage).toEqual([]);
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
