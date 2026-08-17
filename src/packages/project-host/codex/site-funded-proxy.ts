/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import getLogger from "@cocalc/backend/logger";
import {
  computeSiteFundedCodexRequestCost,
  siteFundedCodexMaxRequestBodyBytes,
  type SiteFundedCodexPolicy,
  type SiteFundedCodexReservation,
  type SiteFundedCodexUsageEvent,
} from "@cocalc/util/ai/site-funded-codex";

const logger = getLogger("project-host:codex:site-funded-proxy");
const DEFAULT_UPSTREAM_BASE_URL = "https://api.openai.com/v1";
const MAX_PROVIDER_REQUEST_QUEUE_DEPTH = 8;
const UNBILLED_PROVIDER_TOOL_TYPES = new Set([
  "custom",
  "function",
  "local_shell",
]);

export function siteFundedUsageEventId(
  reservationId: string,
  requestSequence: number,
): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${reservationId}:${requestSequence}`)
      .digest()
      .subarray(0, 16),
  );
  // Version 8 is reserved for application-defined deterministic UUIDs.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type ActiveTurn = {
  reservation: SiteFundedCodexReservation;
  policy: SiteFundedCodexPolicy;
  startedAt: number;
  requestSequence: number;
  costMicrousd: number;
  requestQueueTail: Promise<void>;
  requestQueueDepth: number;
  closed: boolean;
  blockedReason?: string;
  onUsage: (event: SiteFundedCodexUsageEvent) => Promise<void>;
};

type Session = {
  token: string;
  apiKey: string;
  upstreamBaseUrl: string;
  closed: boolean;
  activeTurn?: ActiveTurn;
};

export type SiteFundedProxySession = {
  reservationId: string;
  baseUrl: string;
  token: string;
  policy: SiteFundedCodexPolicy;
  activate: (opts: {
    reservation: SiteFundedCodexReservation;
    onUsage: (event: SiteFundedCodexUsageEvent) => Promise<void>;
  }) => void;
  deactivate: (reservationId: string) => void;
  close: () => void;
};

function jsonResponse(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message,
        type: "site_funded_codex_policy_error",
      },
    }),
  );
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw Object.assign(new Error("provider request body is too large"), {
        statusCode: 413,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function assertSelfContainedProviderInput(body: any): void {
  for (const field of ["conversation", "previous_response_id", "prompt"]) {
    if (body[field] != null) {
      throw Object.assign(
        new Error(
          `Provider-side '${field}' references are not available in site-funded Codex mode`,
        ),
        { statusCode: 403 },
      );
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    const type = `${item.type ?? ""}`;
    if (type === "input_image") {
      const imageUrl = `${item.image_url ?? ""}`;
      if (imageUrl && !imageUrl.startsWith("data:")) {
        throw Object.assign(
          new Error(
            "Externally referenced images are not available in site-funded Codex mode",
          ),
          { statusCode: 403 },
        );
      }
    }
    if (
      type === "input_file" &&
      (item.file_id != null || item.file_url != null)
    ) {
      throw Object.assign(
        new Error(
          "Provider-side file references are not available in site-funded Codex mode",
        ),
        { statusCode: 403 },
      );
    }
    for (const entry of Object.values(item)) visit(entry);
  };
  visit(body.input);
}

function usageFromProviderPayload(payload: any): {
  providerRequestId?: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
} | null {
  const response = payload?.response ?? payload;
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputDetails =
    usage.input_tokens_details ?? usage.inputTokensDetails ?? {};
  const outputDetails =
    usage.output_tokens_details ?? usage.outputTokensDetails ?? {};
  const number = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  };
  return {
    providerRequestId:
      typeof response?.id === "string" ? response.id : undefined,
    inputTokens: number(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: number(
      inputDetails.cached_tokens ??
        inputDetails.cachedTokens ??
        usage.cached_input_tokens,
    ),
    cacheWriteInputTokens: number(
      inputDetails.cache_write_tokens ??
        inputDetails.cacheWriteTokens ??
        usage.cache_write_tokens ??
        usage.cache_write_input_tokens,
    ),
    outputTokens: number(usage.output_tokens ?? usage.outputTokens),
    reasoningOutputTokens: number(
      outputDetails.reasoning_tokens ??
        outputDetails.reasoningTokens ??
        usage.reasoning_output_tokens,
    ),
  };
}

type ProviderResponseStatus = "completed" | "failed" | "incomplete";

function providerResponseStatus(payload: any): ProviderResponseStatus | null {
  const eventType = `${payload?.type ?? ""}`;
  if (eventType === "response.completed") return "completed";
  if (eventType === "response.failed") return "failed";
  if (eventType === "response.incomplete") return "incomplete";
  const status = `${(payload?.response ?? payload)?.status ?? ""}`;
  return status === "completed" ||
    status === "failed" ||
    status === "incomplete"
    ? status
    : null;
}

function assertAllowedTools(tools: unknown): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    const type = `${(tool as any)?.type ?? ""}`.trim();
    if (!UNBILLED_PROVIDER_TOOL_TYPES.has(type)) {
      throw Object.assign(
        new Error(
          `OpenAI tool '${type || "unknown"}' is not available in site-funded Codex mode`,
        ),
        { statusCode: 403 },
      );
    }
  }
}

function boundedProviderRequest({
  body,
  turn,
}: {
  body: any;
  turn: ActiveTurn;
}): any {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("provider request must be a JSON object"), {
      statusCode: 400,
    });
  }
  if (turn.closed) {
    throw Object.assign(new Error("site-funded Codex turn is closed"), {
      statusCode: 403,
    });
  }
  if (turn.blockedReason) {
    throw Object.assign(new Error(turn.blockedReason), { statusCode: 403 });
  }
  if (Date.now() - turn.startedAt >= turn.policy.maxTurnDurationMs) {
    throw Object.assign(
      new Error(
        "This included Codex turn reached its emergency duration limit. Start a new turn, upgrade your CoCalc membership, or connect a ChatGPT plan or personal OpenAI API key.",
      ),
      { statusCode: 403 },
    );
  }
  if (turn.requestSequence >= turn.policy.maxRequestsPerTurn) {
    throw Object.assign(
      new Error(
        "This included Codex turn reached its emergency request limit. Start a new turn, upgrade your CoCalc membership, or connect a ChatGPT plan or personal OpenAI API key.",
      ),
      { statusCode: 403 },
    );
  }
  assertSelfContainedProviderInput(body);
  assertAllowedTools(body.tools);
  const requestedOutput = Number(body.max_output_tokens);
  const outputLimit = Math.min(
    turn.policy.maxOutputTokensPerRequest,
    Number.isSafeInteger(requestedOutput) && requestedOutput > 0
      ? requestedOutput
      : turn.policy.maxOutputTokensPerRequest,
  );

  return {
    ...body,
    background: false,
    store: false,
    model: turn.policy.model,
    reasoning: {
      ...(body.reasoning && typeof body.reasoning === "object"
        ? body.reasoning
        : {}),
      effort: turn.policy.reasoning,
    },
    service_tier: "default",
    max_output_tokens: outputLimit,
  };
}

class SiteFundedCodexProxy {
  private readonly sessions = new Map<string, Session>();
  private server?: ReturnType<typeof createServer>;
  private port?: number;

  private async ensureListening(): Promise<number> {
    if (this.port != null) return this.port;
    if (!this.server) {
      this.server = createServer((request, response) => {
        void this.handle(request, response).catch((err) => {
          logger.warn("site-funded Codex proxy request failed", {
            err: `${err}`,
          });
          if (!response.headersSent) {
            jsonResponse(response, 502, `OpenAI request failed: ${err}`);
          } else if (!response.writableEnded) {
            response.destroy(err instanceof Error ? err : undefined);
          }
        });
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(0, "0.0.0.0");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to determine site-funded Codex proxy port");
    }
    this.port = address.port;
    this.server.unref();
    logger.info("site-funded Codex provider proxy listening", {
      port: this.port,
    });
    return this.port;
  }

  async startSession({
    reservation,
    apiKey,
    onUsage,
    upstreamBaseUrl = DEFAULT_UPSTREAM_BASE_URL,
  }: {
    reservation: SiteFundedCodexReservation;
    apiKey: string;
    onUsage: (event: SiteFundedCodexUsageEvent) => Promise<void>;
    upstreamBaseUrl?: string;
  }): Promise<SiteFundedProxySession> {
    const port = await this.ensureListening();
    const token = randomBytes(32).toString("base64url");
    const makeActiveTurn = ({
      reservation,
      onUsage,
    }: {
      reservation: SiteFundedCodexReservation;
      onUsage: (event: SiteFundedCodexUsageEvent) => Promise<void>;
    }): ActiveTurn => ({
      reservation,
      policy: reservation.policy,
      startedAt: Date.now(),
      requestSequence: 0,
      costMicrousd: 0,
      requestQueueTail: Promise.resolve(),
      requestQueueDepth: 0,
      closed: false,
      onUsage,
    });
    const session: Session = {
      token,
      apiKey,
      upstreamBaseUrl: upstreamBaseUrl.replace(/\/$/, ""),
      closed: false,
      activeTurn: makeActiveTurn({ reservation, onUsage }),
    };
    this.sessions.set(token, session);
    return {
      reservationId: reservation.reservationId,
      baseUrl: `http://host.containers.internal:${port}/v1`,
      token,
      policy: reservation.policy,
      activate: (opts) => {
        if (session.closed) {
          throw new Error("site-funded Codex proxy runtime is closed");
        }
        if (session.activeTurn && !session.activeTurn.closed) {
          throw new Error("site-funded Codex proxy already has an active turn");
        }
        session.activeTurn = makeActiveTurn(opts);
      },
      deactivate: (reservationId) => {
        const turn = session.activeTurn;
        if (!turn || turn.reservation.reservationId !== reservationId) return;
        turn.closed = true;
        session.activeTurn = undefined;
      },
      close: () => {
        session.closed = true;
        if (session.activeTurn) session.activeTurn.closed = true;
        session.activeTurn = undefined;
        this.sessions.delete(token);
      },
    };
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private sessionFor(request: IncomingMessage): Session | undefined {
    const authorization = `${request.headers.authorization ?? ""}`;
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match ? this.sessions.get(match[1]) : undefined;
  }

  private async recordUsage({
    turn,
    requestSequence,
    payload,
    providerRequestId,
    durationMs,
  }: {
    turn: ActiveTurn;
    requestSequence: number;
    payload: any;
    providerRequestId?: string;
    durationMs: number;
  }): Promise<boolean> {
    const usage = usageFromProviderPayload(payload);
    if (!usage) return false;
    const event: SiteFundedCodexUsageEvent = {
      eventId: siteFundedUsageEventId(
        turn.reservation.reservationId,
        requestSequence,
      ),
      reservationId: turn.reservation.reservationId,
      providerRequestId: usage.providerRequestId ?? providerRequestId,
      requestSequence,
      model: turn.policy.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      durationMs,
    };
    const cost = computeSiteFundedCodexRequestCost({
      model: event.model,
      usage: event,
    });
    turn.costMicrousd += cost.costMicrousd;
    if (turn.costMicrousd >= turn.policy.maxTurnCostMicrousd) {
      turn.blockedReason =
        "This included Codex turn reached its emergency cost limit. Start a new turn, upgrade your CoCalc membership, or connect a ChatGPT plan or personal OpenAI API key.";
    }
    try {
      await turn.onUsage(event);
    } catch (err) {
      turn.blockedReason =
        "Site-funded usage accounting is temporarily unavailable.";
      logger.error("failed to persist site-funded Codex provider usage", {
        reservationId: turn.reservation.reservationId,
        requestSequence,
        err: `${err}`,
      });
    }
    return true;
  }

  private blockCompletedResponseWithoutUsage({
    turn,
    requestSequence,
    providerRequestId,
    contentType,
  }: {
    turn: ActiveTurn;
    requestSequence: number;
    providerRequestId?: string;
    contentType: string;
  }): void {
    turn.blockedReason =
      "OpenAI completed a response without usage data, so CoCalc paused this included turn to prevent unmetered spending.";
    logger.error("completed site-funded Codex response omitted usage", {
      reservationId: turn.reservation.reservationId,
      requestSequence,
      providerRequestId,
      contentType,
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.sessionFor(request);
    if (!session || session.closed) {
      jsonResponse(response, 401, "invalid or expired funded proxy credential");
      return;
    }
    const turn = session.activeTurn;
    if (!turn || turn.closed) {
      jsonResponse(response, 403, "site-funded Codex turn is not active");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "POST" || requestUrl.pathname !== "/v1/responses") {
      jsonResponse(response, 404, "only POST /v1/responses is supported");
      return;
    }
    if (turn.requestQueueDepth >= MAX_PROVIDER_REQUEST_QUEUE_DEPTH) {
      jsonResponse(
        response,
        429,
        "too many overlapping provider requests for this funded turn",
      );
      return;
    }

    const startedAt = Date.now();
    let releaseRequest!: () => void;
    const previousRequest = turn.requestQueueTail;
    const currentRequest = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    turn.requestQueueTail = previousRequest.then(() => currentRequest);
    turn.requestQueueDepth += 1;
    const queueDepth = turn.requestQueueDepth;
    const queuedAt = Date.now();
    await previousRequest;
    const queueWaitMs = Date.now() - queuedAt;
    if (queueDepth > 1) {
      logger.info("serialized overlapping site-funded Codex request", {
        reservationId: turn.reservation.reservationId,
        queueDepth,
        queueWaitMs,
      });
    }
    try {
      let requestedBody: any;
      try {
        const bodyBuffer = await readBody(
          request,
          siteFundedCodexMaxRequestBodyBytes(turn.policy),
        );
        requestedBody = JSON.parse(bodyBuffer.toString("utf8"));
      } catch (err: any) {
        jsonResponse(
          response,
          err?.statusCode ?? 400,
          `${err?.message ?? err}`,
        );
        return;
      }
      let body: any;
      try {
        // Recheck turn limits after waiting because the preceding request may
        // have closed or exhausted this turn while persisting its usage.
        body = boundedProviderRequest({ body: requestedBody, turn });
      } catch (err: any) {
        jsonResponse(
          response,
          err?.statusCode ?? 400,
          `${err?.message ?? err}`,
        );
        return;
      }
      turn.requestSequence += 1;
      const requestSequence = turn.requestSequence;
      // Do not forward project-controlled OpenAI organization, project, or
      // feature headers with the site's credential.
      const headers = new Headers({
        authorization: `Bearer ${session.apiKey}`,
        "content-type": "application/json",
      });
      let upstream: Response;
      try {
        upstream = await fetch(`${session.upstreamBaseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        jsonResponse(response, 502, `OpenAI request failed: ${err}`);
        return;
      }
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          !["content-encoding", "content-length", "transfer-encoding"].includes(
            name,
          )
        ) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      const providerRequestId =
        upstream.headers.get("x-request-id") ?? undefined;
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!upstream.body) {
        response.end();
        if (upstream.ok) {
          this.blockCompletedResponseWithoutUsage({
            turn,
            requestSequence,
            providerRequestId,
            contentType,
          });
        }
        return;
      }

      if (!contentType.includes("text/event-stream")) {
        const text = await upstream.text();
        response.end(text);
        if (!upstream.ok) {
          logger.warn("OpenAI rejected site-funded Codex request", {
            reservationId: turn.reservation.reservationId,
            requestSequence,
            providerRequestId,
            status: upstream.status,
          });
          return;
        }
        try {
          const payload = JSON.parse(text);
          const recorded = await this.recordUsage({
            turn,
            requestSequence,
            payload,
            providerRequestId,
            durationMs: Date.now() - startedAt,
          });
          const status = providerResponseStatus(payload);
          if (!recorded && status !== "failed" && status !== "incomplete") {
            this.blockCompletedResponseWithoutUsage({
              turn,
              requestSequence,
              providerRequestId,
              contentType,
            });
          }
        } catch (err) {
          turn.blockedReason = `Invalid OpenAI usage response: ${err}`;
        }
        return;
      }

      const decoder = new TextDecoder();
      let pending = "";
      let usageRecorded = false;
      let terminalStatus: ProviderResponseStatus | null = null;
      const processEventLine = async (line: string): Promise<void> => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const payload = JSON.parse(data);
          const status = providerResponseStatus(payload);
          if (status) terminalStatus = status;
          if (!usageRecorded && status) {
            usageRecorded = await this.recordUsage({
              turn,
              requestSequence,
              payload,
              providerRequestId,
              durationMs: Date.now() - startedAt,
            });
          }
        } catch {
          // Ignore non-JSON SSE comments and partial diagnostic events.
        }
      };
      try {
        for await (const chunk of upstream.body as any) {
          const buffer = Buffer.from(chunk);
          response.write(buffer);
          pending += decoder.decode(buffer, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            await processEventLine(line);
          }
        }
        pending += decoder.decode();
        for (const line of pending.split("\n")) {
          await processEventLine(line);
        }
      } finally {
        response.end();
      }
      if (!upstream.ok) {
        logger.warn("OpenAI rejected streaming site-funded Codex request", {
          reservationId: turn.reservation.reservationId,
          requestSequence,
          providerRequestId,
          status: upstream.status,
        });
      } else if (
        !usageRecorded &&
        terminalStatus !== "failed" &&
        terminalStatus !== "incomplete"
      ) {
        this.blockCompletedResponseWithoutUsage({
          turn,
          requestSequence,
          providerRequestId,
          contentType,
        });
      }
    } finally {
      turn.requestQueueDepth -= 1;
      releaseRequest();
    }
  }
}

const proxy = new SiteFundedCodexProxy();

export async function startSiteFundedCodexProxySession(
  opts: Parameters<SiteFundedCodexProxy["startSession"]>[0],
): Promise<SiteFundedProxySession> {
  return await proxy.startSession(opts);
}

export async function shutdownSiteFundedCodexProxyForTests(): Promise<void> {
  await proxy.shutdown();
}
