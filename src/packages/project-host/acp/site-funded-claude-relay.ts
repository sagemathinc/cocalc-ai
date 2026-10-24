/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The host side of a site-funded Claude turn. Claude Code reaches it through
// the same in-container bridge as an account API key, but the agent can run
// any code in its container, so every limit is enforced here, not by Claude
// Code's settings: only the Messages API, the funded model, a capped output,
// no paid hosted tools beyond metered web search and web fetch, and nothing
// outside a funded turn. The site key is added here and never reaches the
// container. Every provider response's usage is metered exactly, from JSON or
// from the stream.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  computeSiteFundedCodexRequestCost,
  type SiteFundedCodexReservation,
  type SiteFundedCodexUsageEvent,
} from "@cocalc/util/ai/site-funded-codex";
import {
  siteFundedUsageFromAnthropic,
  type AnthropicMessagesUsage,
} from "@cocalc/util/ai/site-funded-claude";
import { CREDENTIAL_RELAY_AUTH_HEADER } from "./credential-http-relay";

const logger = getLogger("project-host:site-funded-claude-relay");

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 10 * 60_000;
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
// Request fields that cost more than the funded price or reach other services.
const REFUSED_FIELDS = ["mcp_servers", "container"] as const;
// Hosted tools Anthropic bills beyond tokens: web search is metered (1 cent
// a search); web fetch costs only its tokens. Others are refused.
const ALLOWED_HOSTED_TOOL = /^(web_search|web_fetch)_\d+$/;
// Client tools (run by Claude Code itself) carry no type, "custom", or one of
// Anthropic's schema-less client tool types.
const CLIENT_TOOL = /^(custom|bash_\d+|text_editor_\d+|computer_\d+)$/;

export type SiteFundedClaudeTurn = {
  reservation: SiteFundedCodexReservation;
  apiKey: string;
  onUsage: (event: SiteFundedCodexUsageEvent) => Promise<void>;
};

export interface SiteFundedClaudeRelay {
  socketPath: string;
  token: string;
  /** Funds requests with this turn until it is deactivated. */
  activate(turn: SiteFundedClaudeTurn): void;
  /** Stops funding requests (this reservation's, when given). */
  deactivate(reservationId?: string): void;
  close(): Promise<void>;
}

type ActiveTurn = SiteFundedClaudeTurn & {
  startedAt: number;
  /** Funded requests started, for the request limit. */
  requests: number;
  /** Usage events, numbered as they are metered: the ledger needs them in
   * order, and parallel requests (subagents) finish in any order. */
  usageSequence: number;
  committedMicrousd: number;
  blockedReason?: string;
};

class RelayError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  // Anthropic's error shape, so Claude Code reports the reason.
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(
    JSON.stringify({
      type: "error",
      error: {
        type: status === 403 ? "permission_error" : "invalid_request_error",
        message,
      },
    }),
  );
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new RelayError(413, "Request is too large for an included turn");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The request as the funded policy allows it, or an error saying why not. */
export function fundedClaudeRequest(
  body: unknown,
  turn: Pick<ActiveTurn, "reservation">,
  countTokens = false,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RelayError(400, "Request must be a JSON object");
  }
  const request = { ...(body as Record<string, unknown>) };
  const policy = turn.reservation.policy;
  for (const field of REFUSED_FIELDS) {
    if (request[field] != null) {
      throw new RelayError(
        403,
        `Included Claude turns cannot use ${field}. Use your own Claude subscription or Anthropic API key for it.`,
      );
    }
  }
  const tools = request.tools;
  if (tools != null) {
    if (!Array.isArray(tools)) {
      throw new RelayError(400, "tools must be an array");
    }
    for (const tool of tools) {
      const type = (tool as { type?: unknown })?.type;
      if (
        type == null ||
        (typeof type === "string" &&
          (CLIENT_TOOL.test(type) || ALLOWED_HOSTED_TOOL.test(type)))
      ) {
        continue;
      }
      throw new RelayError(
        403,
        `Included Claude turns cannot use the ${String(type)} tool. Use your own Claude subscription or Anthropic API key for it.`,
      );
    }
  }
  // The funded model, always: Claude Code also asks for others (aliases,
  // background tasks), and the agent can send anything.
  request.model = policy.model;
  // Price multipliers the funded price does not include.
  delete request.inference_geo;
  delete request.service_tier;
  if (!countTokens) {
    const requested = Number(request.max_tokens);
    const maxTokens = Math.min(
      policy.maxOutputTokensPerRequest,
      Number.isSafeInteger(requested) && requested > 0
        ? requested
        : policy.maxOutputTokensPerRequest,
    );
    request.max_tokens = maxTokens;
    // Extended thinking spends output tokens: never beyond the output cap.
    const thinking = request.thinking as
      | { budget_tokens?: unknown }
      | undefined;
    if (thinking && typeof thinking === "object") {
      const budget = Number(thinking.budget_tokens);
      if (Number.isSafeInteger(budget) && budget >= maxTokens) {
        request.thinking = {
          ...thinking,
          budget_tokens: Math.max(1024, maxTokens - 1),
        };
      }
    }
  }
  return request;
}

/**
 * The usage of a streamed response: message_start carries the input usage,
 * each message_delta the cumulative usage so far.
 */
export class StreamUsage {
  private buffer = "";
  usage: AnthropicMessagesUsage | undefined;

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trimEnd();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      let event: any;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event?.type === "message_start" && event.message?.usage) {
        this.usage = { ...event.message.usage };
      } else if (event?.type === "message_delta" && event.usage) {
        this.usage = { ...(this.usage ?? {}), ...stripNulls(event.usage) };
      }
    }
    // A line longer than any event: not an SSE stream we can read.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = "";
  }
}

function stripNulls(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry != null),
  );
}

export async function createSiteFundedClaudeRelay({
  socketPath,
  upstream = ANTHROPIC_ORIGIN,
  allowHttpForTests = false,
}: {
  socketPath: string;
  /** Tests only. */
  upstream?: string;
  allowHttpForTests?: boolean;
}): Promise<SiteFundedClaudeRelay> {
  const upstreamUrl = new URL(upstream);
  if (
    upstreamUrl.protocol !== "https:" &&
    !(allowHttpForTests && upstreamUrl.protocol === "http:")
  ) {
    throw Error("site-funded Claude relay upstream must be HTTPS");
  }
  const send =
    upstreamUrl.protocol === "https:"
      ? httpsRequest
      : (await import("node:http")).request;
  const token = randomBytes(32).toString("base64url");
  let turn: ActiveTurn | undefined;
  let closing = false;

  const current = (): ActiveTurn => {
    if (closing) throw new RelayError(503, "Relay is closed");
    if (!turn) {
      throw new RelayError(
        403,
        "No included Claude turn is active. Requests are funded only while CoCalc runs a turn.",
      );
    }
    if (turn.blockedReason) throw new RelayError(403, turn.blockedReason);
    const policy = turn.reservation.policy;
    if (Date.now() - turn.startedAt >= policy.maxTurnDurationMs) {
      throw new RelayError(
        403,
        "This included Claude turn reached its duration limit. Start a new turn.",
      );
    }
    if (turn.requests >= policy.maxRequestsPerTurn) {
      throw new RelayError(
        403,
        "This included Claude turn reached its request limit. Start a new turn.",
      );
    }
    return turn;
  };

  // Synchronous up to recording the event, so a response's usage is queued
  // before the response itself ends (and so before its turn can finish).
  const meter = (
    active: ActiveTurn,
    usage: AnthropicMessagesUsage | undefined,
    providerRequestId: string | undefined,
  ): void => {
    if (!usage) {
      logger.warn("site-funded Claude response without usage", {
        reservationId: active.reservation.reservationId,
        providerRequestId,
      });
      return;
    }
    let event: SiteFundedCodexUsageEvent;
    try {
      event = {
        ...siteFundedUsageFromAnthropic(usage),
        eventId: randomUUID(),
        reservationId: active.reservation.reservationId,
        providerRequestId,
        requestSequence: active.usageSequence + 1,
        model: active.reservation.policy.model,
      };
      const cost = computeSiteFundedCodexRequestCost({
        model: event.model,
        usage: event,
      });
      active.usageSequence = event.requestSequence;
      active.committedMicrousd += cost.costMicrousd;
      if (
        active.committedMicrousd >=
        active.reservation.policy.maxTurnCostMicrousd
      ) {
        active.blockedReason =
          "This included Claude turn reached its cost limit. Start a new turn, or use your own Claude subscription or Anthropic API key.";
      }
    } catch (err) {
      // Unreadable usage: stop funding this turn rather than run unmetered.
      active.blockedReason = "Included Claude usage could not be metered.";
      logger.error("site-funded Claude usage not metered", { err: `${err}` });
      return;
    }
    void active.onUsage(event).catch((err) =>
      logger.error("site-funded Claude usage not recorded", {
        reservationId: event.reservationId,
        err: `${err}`,
      }),
    );
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!sameToken(request.headers[CREDENTIAL_RELAY_AUTH_HEADER], token)) {
      request.resume();
      return fail(response, 401, "Relay authorization failed");
    }
    const url = new URL(request.url ?? "/", upstreamUrl);
    const countTokens = url.pathname === COUNT_TOKENS_PATH;
    if (
      request.method !== "POST" ||
      (url.pathname !== MESSAGES_PATH && !countTokens) ||
      [...url.searchParams.keys()].some((key) => key !== "beta")
    ) {
      request.resume();
      return fail(response, 403, "Only the Messages API is included");
    }
    const active = current();
    let body: unknown;
    try {
      body = JSON.parse((await readBody(request)).toString("utf8"));
    } catch (err) {
      if (err instanceof RelayError) throw err;
      throw new RelayError(400, "Request must be JSON");
    }
    const funded = fundedClaudeRequest(body, active, countTokens);
    // Counting tokens is free; it is not a funded request.
    if (!countTokens) active.requests += 1;
    const payload = Buffer.from(JSON.stringify(funded));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": `${payload.length}`,
      "x-api-key": active.apiKey,
      "anthropic-version": `${request.headers["anthropic-version"] ?? "2023-06-01"}`,
    };
    const beta = request.headers["anthropic-beta"];
    if (typeof beta === "string" && beta.trim()) {
      headers["anthropic-beta"] = beta;
    }
    await new Promise<void>((resolve) => {
      const target = new URL(
        `${url.pathname}${url.search}`,
        upstreamUrl,
      ).toString();
      const providerRequest = send(
        target,
        { method: "POST", headers },
        (providerResponse) => {
          const providerRequestId =
            `${providerResponse.headers["request-id"] ?? ""}` || undefined;
          const type = `${providerResponse.headers["content-type"] ?? ""}`;
          const ok = (providerResponse.statusCode ?? 500) < 400;
          response.writeHead(providerResponse.statusCode ?? 502, {
            "content-type": type || "application/json",
            "cache-control": "no-store",
            ...(providerRequestId ? { "request-id": providerRequestId } : {}),
          });
          if (countTokens || !ok) {
            // Errors are not billed; counting tokens is free.
            providerResponse.pipe(response);
            providerResponse.on("end", resolve);
            providerResponse.on("error", () => resolve());
            return;
          }
          if (type.includes("text/event-stream")) {
            const stream = new StreamUsage();
            providerResponse.on("data", (chunk) => {
              stream.push(chunk);
              response.write(chunk);
            });
            const done = () => {
              // Metered even if the stream broke: what was used is owed.
              meter(active, stream.usage, providerRequestId);
              response.end();
              resolve();
            };
            providerResponse.once("end", done);
            providerResponse.once("error", done);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          providerResponse.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_JSON_RESPONSE_BYTES) chunks.push(chunk);
            response.write(chunk);
          });
          providerResponse.once("end", () => {
            let usage: AnthropicMessagesUsage | undefined;
            try {
              usage = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.usage;
            } catch {
              usage = undefined;
            }
            meter(active, usage, providerRequestId);
            response.end();
            resolve();
          });
          providerResponse.once("error", () => {
            response.destroy();
            resolve();
          });
        },
      );
      providerRequest.setTimeout(PROVIDER_TIMEOUT_MS, () =>
        providerRequest.destroy(Error("provider timeout")),
      );
      providerRequest.on("error", () => {
        fail(response, 502, "Anthropic is unavailable");
        resolve();
      });
      response.on("close", () => {
        if (!response.writableFinished) providerRequest.destroy();
      });
      providerRequest.end(payload);
    });
  }

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch((err) => {
      request.resume();
      fail(
        response,
        err instanceof RelayError ? err.statusCode : 500,
        err instanceof RelayError
          ? err.message
          : "Included Claude request failed",
      );
    });
  });
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    token,
    activate: (next) => {
      turn = {
        ...next,
        startedAt: Date.now(),
        requests: 0,
        usageSequence: 0,
        committedMicrousd: 0,
      };
    },
    deactivate: (reservationId) => {
      if (!reservationId || turn?.reservation.reservationId === reservationId) {
        turn = undefined;
      }
    },
    close: async () => {
      closing = true;
      turn = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await unlink(socketPath).catch(() => {});
    },
  };
}
