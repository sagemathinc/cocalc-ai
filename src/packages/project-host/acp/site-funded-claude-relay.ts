/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The host side of a site-funded Claude turn. Claude Code reaches it through
// the same in-container bridge as an account API key, but the agent can run
// any code in its container, so every limit is enforced here, not by Claude
// Code's settings: only the Messages API, the funded model, a capped output,
// no paid hosted tools beyond capped web search on a short prompt, no prompt
// longer than the policy's cap (longer prompts cost 5x), and nothing outside a
// funded turn. The site key is added here and never reaches the
// container.
//
// A turn's requests run one at a time, and every limit is checked as each one
// starts, so a turn passes its cost limit by at most one request; the ledger
// holds room for the dearest possible request beyond the limit. Every
// response is metered: exactly when it is complete, and at its upper bound
// when it is not (a broken stream, missing usage), so nothing escapes the
// ledger. A turn that ends waits for its running request to be metered.

import {
  createServer,
  type ClientRequest,
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
  SITE_FUNDED_CLAUDE_MAX_WEB_SEARCHES_PER_REQUEST,
  siteFundedUsageFromAnthropic,
  type AnthropicMessagesUsage,
} from "@cocalc/util/ai/site-funded-claude";
import { CREDENTIAL_RELAY_AUTH_HEADER } from "./credential-http-relay";

const logger = getLogger("project-host:site-funded-claude-relay");

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 10 * 60_000;
const COUNT_TIMEOUT_MS = 30_000;
// Tokens a prompt can have beyond its bytes: role and tool formatting, and
// the definitions of hosted tools, which Anthropic adds.
const PROMPT_OVERHEAD_TOKENS = 4_096;
// The fields of a request that add to its prompt, all of which
// /v1/messages/count_tokens accepts.
const COUNTED_FIELDS = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "output_format",
] as const;
// Anthropic's count is an estimate that "might differ by a small amount":
// a counted prompt must fit with this much to spare.
const COUNT_MARGIN_TOKENS = 2_000;
// Searches add their results to the prompt while the request runs, which no
// count can include (count_tokens refuses server tools): only a short prompt
// may search, leaving the rest of the cap to its (at most three) searches.
// Claude Code searches in a request of its own, with just the query.
const SEARCH_PROMPT_TOKENS = 16_000;
// How long an ending turn waits for its running request before aborting it.
const DRAIN_TIMEOUT_MS = 2 * 60_000;
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
// Request fields that cost more than the funded price or reach other services.
const REFUSED_FIELDS = ["mcp_servers", "container"] as const;
// Hosted tools Anthropic bills beyond tokens: web search is capped and
// metered (1 cent a search). Others are refused, web fetch included: its
// pages join the prompt unbounded (Claude Code's WebFetch runs locally).
const WEB_SEARCH_TOOL = /^web_search_\d+$/;
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
  /**
   * Stops funding requests (this reservation's, when given). Resolves once
   * the turn's running request is metered, aborting it after `timeoutMs`.
   */
  deactivate(
    reservationId?: string,
    options?: { timeoutMs?: number },
  ): Promise<void>;
  close(): Promise<void>;
}

type ActiveTurn = SiteFundedClaudeTurn & {
  startedAt: number;
  /** Requests started (counting tokens included), for the request limit. */
  requests: number;
  /** Usage events, numbered in order for the ledger. */
  usageSequence: number;
  committedMicrousd: number;
  blockedReason?: string;
  ended: boolean;
  /** The tail of this turn's requests: each runs after the previous ends. */
  queue: Promise<void>;
  /** Usage events still being recorded; a turn settles after them. */
  persisting: Set<Promise<void>>;
  /** Aborts the running provider request. */
  abort?: () => void;
};

/** What one request can cost at most, for metering an incomplete response. */
type RequestBounds = {
  /** An upper bound on its prompt tokens: as counted by Anthropic, else the
   * forwarded request's size in bytes plus overhead; at most the cap. */
  promptTokens: number;
  maxTokens: number;
  maxSearches: number;
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
): {
  request: Record<string, unknown>;
  maxTokens: number;
  maxSearches: number;
} {
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
  if (remoteMedia(request.messages) || remoteMedia(request.system)) {
    // Not countable (count_tokens refuses them), and their size is unknown.
    throw new RelayError(
      403,
      "Included Claude turns take images and documents only inline (base64), not by URL or file.",
    );
  }
  let maxSearches = 0;
  if (request.tools != null) {
    if (!Array.isArray(request.tools)) {
      throw new RelayError(400, "tools must be an array");
    }
    request.tools = request.tools.map((tool) => {
      const type = (tool as { type?: unknown })?.type;
      if (type == null || (typeof type === "string" && CLIENT_TOOL.test(type)))
        return tool;
      if (typeof type === "string" && WEB_SEARCH_TOOL.test(type)) {
        // Searches cost money: never more than the cap per request.
        const requested = Number((tool as { max_uses?: unknown }).max_uses);
        const uses = Math.min(
          SITE_FUNDED_CLAUDE_MAX_WEB_SEARCHES_PER_REQUEST,
          Number.isSafeInteger(requested) && requested > 0
            ? requested
            : SITE_FUNDED_CLAUDE_MAX_WEB_SEARCHES_PER_REQUEST,
        );
        maxSearches += uses;
        return { ...(tool as object), max_uses: uses };
      }
      throw new RelayError(
        403,
        `Included Claude turns cannot use the ${String(type)} tool. Use your own Claude subscription or Anthropic API key for it.`,
      );
    });
    if (
      maxSearches * 10_000 >
      (policy.maxProviderToolFeesMicrousdPerRequest ?? 0)
    ) {
      throw new RelayError(403, "Too many web search tools in one request");
    }
  }
  // The funded model, always: Claude Code also asks for others (aliases,
  // background tasks), and the agent can send anything.
  request.model = policy.model;
  // Price multipliers the funded price does not include.
  delete request.inference_geo;
  delete request.service_tier;
  let maxTokens = 0;
  if (!countTokens) {
    const requested = Number(request.max_tokens);
    maxTokens = Math.min(
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
  return { request, maxTokens, maxSearches };
}

/**
 * Whether a request's prompt holds media (images, documents, anything with a
 * source): their tokens are not bounded by their bytes, and one given by URL
 * has almost no bytes at all, so such a prompt is always counted.
 */
export function hasMedia(value: unknown, depth = 0): boolean {
  // Deeper than any real prompt: count it rather than search further.
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((v) => hasMedia(v, depth + 1));
  if (value == null || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  if (block.type === "image" || block.type === "document") return true;
  if (block.source != null) return true;
  return Object.values(block).some((v) => hasMedia(v, depth + 1));
}

/** Whether a prompt refers to media by URL or file rather than inline. */
export function remoteMedia(value: unknown, depth = 0): boolean {
  // Deeper than any real prompt: refuse rather than search further.
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((v) => remoteMedia(v, depth + 1));
  if (value == null || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  if (block.type === "container_upload" || block.file_id != null) return true;
  const source = block.source as { type?: unknown } | undefined;
  if (
    source != null &&
    typeof source === "object" &&
    (source.type === "url" || source.type === "file")
  ) {
    return true;
  }
  return Object.values(block).some((v) => remoteMedia(v, depth + 1));
}

/**
 * The usage of a streamed response: message_start carries the input usage,
 * each message_delta the cumulative usage so far, and message_stop marks
 * that the final usage has arrived.
 */
export class StreamUsage {
  private buffer = "";
  usage: AnthropicMessagesUsage | undefined;
  complete = false;

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
      } else if (event?.type === "message_stop") {
        this.complete = true;
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

/**
 * The usage to charge for a response that did not finish (a broken or
 * aborted stream, missing usage): what was reported, raised to what the
 * request could have cost. Fails closed: never less than it may have used.
 */
export function upperBoundUsage(
  seen: AnthropicMessagesUsage | undefined,
  bounds: RequestBounds,
): AnthropicMessagesUsage {
  const searches = Math.max(
    seen?.server_tool_use?.web_search_requests ?? 0,
    bounds.maxSearches,
  );
  if (seen?.input_tokens != null && bounds.maxSearches === 0) {
    // message_start reported the prompt exactly; only the output is unknown.
    return {
      ...seen,
      output_tokens: Math.max(seen.output_tokens ?? 0, bounds.maxTokens),
      server_tool_use: { web_search_requests: searches },
    };
  }
  // Nothing reported, or a search, whose results join the prompt after
  // message_start counted it: the prompt at its bound, as the dearest writes.
  const input = Math.max(
    bounds.promptTokens,
    (seen?.input_tokens ?? 0) +
      (seen?.cache_read_input_tokens ?? 0) +
      (seen?.cache_creation_input_tokens ?? 0),
  );
  return {
    input_tokens: 0,
    cache_creation_input_tokens: input,
    cache_creation: { ephemeral_1h_input_tokens: input },
    output_tokens: Math.max(seen?.output_tokens ?? 0, bounds.maxTokens),
    server_tool_use: { web_search_requests: searches },
  };
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

  // Checked as each request starts, after the ones before it finished.
  const assertMayStart = (active: ActiveTurn) => {
    if (closing) throw new RelayError(503, "Relay is closed");
    if (active.ended || turn !== active) {
      throw new RelayError(403, "This included Claude turn has ended.");
    }
    if (active.blockedReason) throw new RelayError(403, active.blockedReason);
    const policy = active.reservation.policy;
    // The reservation's own deadline too: its usage is accepted only before.
    const expiresAt = Date.parse(active.reservation.expiresAt ?? "");
    if (
      Date.now() - active.startedAt >= policy.maxTurnDurationMs ||
      (Number.isFinite(expiresAt) && Date.now() >= expiresAt)
    ) {
      throw new RelayError(
        403,
        "This included Claude turn reached its duration limit. Start a new turn.",
      );
    }
    if (active.requests >= policy.maxRequestsPerTurn) {
      throw new RelayError(
        403,
        "This included Claude turn reached its request limit. Start a new turn.",
      );
    }
  };

  // Synchronous up to queueing the event, so its usage is recorded before
  // the response ends and before the turn can be settled.
  const meter = (
    active: ActiveTurn,
    usage: AnthropicMessagesUsage,
    providerRequestId: string | undefined,
  ): void => {
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
    // Not recorded: fund nothing more, and settle only after it is known.
    const persisted = active.onUsage(event).catch((err) => {
      active.blockedReason = "Included Claude usage could not be recorded.";
      logger.error("site-funded Claude usage not recorded", {
        reservationId: event.reservationId,
        err: `${err}`,
      });
    });
    active.persisting.add(persisted);
    void persisted.finally(() => active.persisting.delete(persisted));
  };

  /** One request to Anthropic; resolves once its response is metered. */
  const forward = (
    active: ActiveTurn,
    path: string,
    payload: Buffer,
    headers: Record<string, string>,
    response: ServerResponse,
    bounds: RequestBounds | undefined,
  ) =>
    new Promise<void>((resolve) => {
      let settled = false;
      // What the response has reported so far, if it began.
      let reported: () => AnthropicMessagesUsage | undefined = () => undefined;
      // Every way a request ends meters it exactly once: exactly when its
      // usage is complete, else at its upper bound.
      const settle = (
        usage: AnthropicMessagesUsage | undefined,
        complete: boolean,
        providerRequestId?: string,
      ) => {
        if (settled) return;
        settled = true;
        active.abort = undefined;
        if (bounds) {
          meter(
            active,
            complete && usage ? usage : upperBoundUsage(usage, bounds),
            providerRequestId,
          );
        }
        resolve();
      };
      let providerRequest: ClientRequest;
      try {
        providerRequest = send(
          new URL(path, upstreamUrl).toString(),
          { method: "POST", headers },
          (providerResponse) => {
            const providerRequestId =
              `${providerResponse.headers["request-id"] ?? ""}` || undefined;
            const type = `${providerResponse.headers["content-type"] ?? ""}`;
            const status = providerResponse.statusCode ?? 502;
            if (!response.headersSent && !response.destroyed) {
              response.writeHead(status, {
                "content-type": type || "application/json",
                "cache-control": "no-store",
                ...(providerRequestId
                  ? { "request-id": providerRequestId }
                  : {}),
              });
            }
            // The client may have gone: keep reading, so usage is exact.
            const write = (chunk: Buffer) => {
              if (!response.destroyed) response.write(chunk);
            };
            const finish = () => {
              if (!response.destroyed) response.end();
            };
            if (status >= 400) {
              // Anthropic does not bill a request it refused.
              providerResponse.on("data", write);
              const unbilled = () => {
                settled = true;
                active.abort = undefined;
                resolve();
              };
              providerResponse.once("end", () => {
                unbilled();
                finish();
              });
              providerResponse.once("error", unbilled);
              providerResponse.once("close", unbilled);
              return;
            }
            if (type.includes("text/event-stream")) {
              const stream = new StreamUsage();
              reported = () => stream.usage;
              providerResponse.on("data", (chunk: Buffer) => {
                stream.push(chunk);
                write(chunk);
              });
              providerResponse.once("end", () => {
                settle(stream.usage, stream.complete, providerRequestId);
                finish();
              });
              providerResponse.once("error", () => {
                settle(stream.usage, false, providerRequestId);
                response.destroy();
              });
              // Closed without end (aborted): whatever it reported, bounded.
              providerResponse.once("close", () =>
                settle(stream.usage, false, providerRequestId),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            providerResponse.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= MAX_JSON_RESPONSE_BYTES) chunks.push(chunk);
              write(chunk);
            });
            providerResponse.once("end", () => {
              let usage: AnthropicMessagesUsage | undefined;
              try {
                usage = JSON.parse(
                  Buffer.concat(chunks).toString("utf8"),
                )?.usage;
              } catch {
                usage = undefined;
              }
              settle(usage, usage != null, providerRequestId);
              finish();
            });
            providerResponse.once("error", () => {
              settle(undefined, false, providerRequestId);
              response.destroy();
            });
            providerResponse.once("close", () =>
              settle(undefined, false, providerRequestId),
            );
          },
        );
      } catch {
        fail(response, 502, "Anthropic is unavailable");
        settle(undefined, false);
        return;
      }
      active.abort = () => providerRequest.destroy(Error("turn ended"));
      providerRequest.setTimeout(PROVIDER_TIMEOUT_MS, () =>
        providerRequest.destroy(Error("provider timeout")),
      );
      providerRequest.on("error", () => {
        // The request may have reached Anthropic: charge its upper bound.
        fail(response, 502, "Anthropic is unavailable");
        settle(reported(), false);
      });
      providerRequest.end(payload);
    });

  /**
   * The prompt's tokens as Anthropic counts them (free of charge), or the
   * provider's refusal to pass on. Abortable like a request, when the turn
   * ends.
   */
  const countPromptTokens = (
    active: ActiveTurn,
    search: string,
    funded: Record<string, unknown>,
    headers: Record<string, string>,
  ) =>
    new Promise<number | { status: number; body: string }>((resolve) => {
      const body = Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            COUNTED_FIELDS.filter((field) => funded[field] != null).map(
              (field) => [field, funded[field]],
            ),
          ),
        ),
      );
      const unavailable = () => {
        active.abort = undefined;
        resolve({
          status: 503,
          body: JSON.stringify({
            type: "error",
            error: {
              type: "api_error",
              message: "Could not check the prompt's size. Try again.",
            },
          }),
        });
      };
      let countRequest: ClientRequest;
      try {
        countRequest = send(
          new URL(`${COUNT_TOKENS_PATH}${search}`, upstreamUrl).toString(),
          {
            method: "POST",
            headers: { ...headers, "content-length": `${body.length}` },
          },
          (countResponse) => {
            const chunks: Buffer[] = [];
            let size = 0;
            countResponse.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= 1024 * 1024) chunks.push(chunk);
            });
            countResponse.once("error", unavailable);
            countResponse.once("end", () => {
              active.abort = undefined;
              const text = Buffer.concat(chunks).toString("utf8");
              const status = countResponse.statusCode ?? 502;
              if (status !== 200) {
                resolve({ status, body: text });
                return;
              }
              let tokens: unknown;
              try {
                tokens = JSON.parse(text)?.input_tokens;
              } catch {
                tokens = undefined;
              }
              if (Number.isSafeInteger(tokens) && (tokens as number) >= 0) {
                resolve(tokens as number);
              } else {
                unavailable();
              }
            });
          },
        );
      } catch {
        unavailable();
        return;
      }
      active.abort = () => countRequest.destroy(Error("turn ended"));
      countRequest.setTimeout(COUNT_TIMEOUT_MS, () =>
        countRequest.destroy(Error("count timeout")),
      );
      countRequest.on("error", unavailable);
      countRequest.end(body);
    });

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
    const active = turn;
    if (!active || closing) {
      request.resume();
      return fail(
        response,
        403,
        "No included Claude turn is active. Requests are funded only while CoCalc runs a turn.",
      );
    }
    let body: unknown;
    try {
      const raw = await readBody(request);
      body = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      if (err instanceof RelayError) throw err;
      throw new RelayError(400, "Request must be JSON");
    }
    const {
      request: funded,
      maxTokens,
      maxSearches,
    } = fundedClaudeRequest(body, active, countTokens);
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
    // One request at a time per turn; limits are checked as each starts.
    const run = active.queue.then(async () => {
      try {
        assertMayStart(active);
      } catch (err) {
        fail(
          response,
          err instanceof RelayError ? err.statusCode : 500,
          `${(err as Error).message}`,
        );
        return;
      }
      // Counting tokens is free, but it counts toward the request limit.
      active.requests += 1;
      let bounds: RequestBounds | undefined;
      if (!countTokens) {
        // The bytes of what is sent (compact JSON, not whatever padding came
        // in) bound the tokens of a text prompt.
        let promptTokens = payload.length + PROMPT_OVERHEAD_TOKENS;
        const cap = active.reservation.policy.maxPromptTokens;
        if (
          cap != null &&
          maxSearches > 0 &&
          (promptTokens > SEARCH_PROMPT_TOKENS ||
            hasMedia(funded.messages) ||
            hasMedia(funded.system))
        ) {
          fail(
            response,
            403,
            "Included Claude turns can search the web only from a short prompt. Ask in a new conversation, or use your own Claude subscription or Anthropic key.",
          );
          return;
        }
        if (
          cap != null &&
          maxSearches === 0 &&
          (promptTokens > cap - COUNT_MARGIN_TOKENS ||
            hasMedia(funded.messages) ||
            hasMedia(funded.system))
        ) {
          // It may be over the cap: count it exactly first.
          const counted = await countPromptTokens(
            active,
            url.search,
            funded,
            headers,
          );
          if (typeof counted !== "number") {
            if (!response.headersSent) {
              response.writeHead(counted.status, {
                "content-type": "application/json",
                "cache-control": "no-store",
              });
            }
            response.end(counted.body);
            return;
          }
          const limit = cap - COUNT_MARGIN_TOKENS;
          if (counted > limit) {
            // Anthropic's wording, so Claude Code compacts and retries.
            fail(
              response,
              400,
              `prompt is too long: ${counted} tokens > ${limit} maximum`,
            );
            return;
          }
          promptTokens = counted;
          // The turn may have ended while counting.
          try {
            assertMayStart(active);
          } catch (err) {
            fail(
              response,
              err instanceof RelayError ? err.statusCode : 500,
              `${(err as Error).message}`,
            );
            return;
          }
        }
        bounds = {
          // A search adds its results to the prompt as it runs: up to the cap.
          promptTokens:
            cap == null
              ? promptTokens
              : maxSearches > 0
                ? cap
                : Math.min(promptTokens, cap),
          maxTokens,
          maxSearches,
        };
      }
      await forward(
        active,
        `${url.pathname}${url.search}`,
        payload,
        headers,
        response,
        bounds,
      );
    });
    active.queue = run.catch(() => {});
    await run;
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

  // Turns that ended but whose running request may not be metered yet.
  const ending = new Map<string, Promise<void>>();

  // Stops a turn and waits for its running request to be metered.
  const end = (active: ActiveTurn, timeoutMs: number): Promise<void> => {
    const reservationId = active.reservation.reservationId;
    const already = ending.get(reservationId);
    if (already) return already;
    active.ended = true;
    if (turn === active) turn = undefined;
    const timer = setTimeout(() => active.abort?.(), timeoutMs);
    const drained = active.queue
      .then(() => Promise.allSettled([...active.persisting]))
      .then(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        ending.delete(reservationId);
      });
    ending.set(reservationId, drained);
    return drained;
  };

  return {
    socketPath,
    token,
    activate: (next) => {
      if (turn) void end(turn, DRAIN_TIMEOUT_MS);
      turn = {
        ...next,
        startedAt: Date.now(),
        requests: 0,
        usageSequence: 0,
        committedMicrousd: 0,
        ended: false,
        queue: Promise.resolve(),
        persisting: new Set(),
      };
    },
    deactivate: async (
      reservationId,
      { timeoutMs = DRAIN_TIMEOUT_MS } = {},
    ) => {
      const active = turn;
      if (
        active &&
        (!reservationId || active.reservation.reservationId === reservationId)
      ) {
        await end(active, timeoutMs);
        return;
      }
      // Already ended (the hub stopped it, say): still wait for its drain.
      if (reservationId) await ending.get(reservationId);
    },
    close: async () => {
      closing = true;
      const active = turn;
      if (active) await end(active, 0);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await unlink(socketPath).catch(() => {});
    },
  };
}
