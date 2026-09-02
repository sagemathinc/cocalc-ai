import type { Client, Subscription } from "@cocalc/conat/core/client";
import { getLogger } from "@cocalc/conat/logger";
import type {
  AcpAttentionRequest,
  AcpAttentionResponse,
  AcpAutomationRequest,
  AcpAutomationResponse,
  AcpControlRequest,
  AcpControlResponse,
  AcpForkSessionRequest,
  AcpInterruptRequest,
  AcpInterruptResponse,
  AcpRequest,
  AcpSteerRequest,
  AcpSteerResponse,
  AcpTruncateSessionRequest,
  AcpStreamPayload,
} from "./types";
import {
  ACP_CLIENT_REFRESH_REQUIRED_CODE,
  ACP_CLIENT_REFRESH_REQUIRED_MESSAGE,
  acpSubscriptionSubject,
  legacyAcpSubscriptionSubject,
  parseAcpSubject,
  type AcpOperation,
} from "./subjects";
import { ConcurrencyLimiter } from "./concurrency-limiter";

export {
  acpAttentionSubject,
  acpAutomationSubject,
  acpControlSubject,
  acpForkSubject,
  acpInterruptSubject,
  acpSteerSubject,
  acpSubject,
  acpTruncateSubject,
} from "./subjects";

const logger = getLogger("conat:ai:acp:server");

let apiSub: Subscription | null = null;
let interruptSub: Subscription | null = null;
let steerSub: Subscription | null = null;
let forkSub: Subscription | null = null;
let truncateSub: Subscription | null = null;
let controlSub: Subscription | null = null;
let automationSub: Subscription | null = null;
let attentionSub: Subscription | null = null;
const legacySubs: Subscription[] = [];
function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

const MAX_CONCURRENCY = Math.max(
  1,
  nonNegativeIntegerFromEnv("COCALC_ACP_MAX_CONCURRENCY", 64),
);
const MAX_PENDING = nonNegativeIntegerFromEnv(
  "COCALC_ACP_MAX_PENDING",
  MAX_CONCURRENCY * 4,
);
const limiter = new ConcurrencyLimiter(MAX_CONCURRENCY);
const inFlightChatTurnKeys = new Map<
  string,
  { startedAt: number; subject: string }
>();
const inFlightSessionTurnKeys = new Map<
  string,
  { startedAt: number; subject: string }
>();

async function rejectOverloaded(label: string, mesg): Promise<void> {
  const error = `ACP server is busy; too many pending ${label} requests`;
  logger.warn("rejecting ACP request because pending queue is full", {
    label,
    activeCount: limiter.activeCount,
    pendingCount: limiter.pendingCount,
    maxConcurrency: MAX_CONCURRENCY,
    maxPending: MAX_PENDING,
    subject: mesg?.subject,
  });
  if (label === "message") {
    await mesg.respond({ seq: 0, type: "error", error }, { noThrow: true });
    await mesg.respond(null, { noThrow: true });
    return;
  }
  await mesg.respond({ error }, { noThrow: true });
}

async function runLimited(
  label: string,
  mesg,
  fn: () => Promise<void>,
): Promise<void> {
  if (limiter.pendingCount >= MAX_PENDING) {
    await rejectOverloaded(label, mesg);
    return;
  }
  void limiter.run(async () => {
    try {
      await fn();
    } catch (err) {
      logger.debug(`error handling acp ${label}`, err);
    }
  });
}

type StreamHandler = (payload?: AcpStreamPayload | null) => Promise<void>;

type EvaluateHandler = (
  options: AcpRequest & { stream: StreamHandler },
) => Promise<void>;

type InterruptHandler = (
  options: AcpInterruptRequest,
) => Promise<AcpInterruptResponse>;
type SteerHandler = (options: AcpSteerRequest) => Promise<AcpSteerResponse>;
type ForkHandler = (
  options: AcpForkSessionRequest,
) => Promise<{ sessionId: string }>;
type TruncateHandler = (
  options: AcpTruncateSessionRequest,
) => Promise<{ ok: boolean; truncated: boolean }>;
type ControlHandler = (
  options: AcpControlRequest,
) => Promise<AcpControlResponse>;
type AutomationHandler = (
  options: AcpAutomationRequest,
) => Promise<AcpAutomationResponse>;
type AttentionHandler = (
  options: AcpAttentionRequest,
) => Promise<AcpAttentionResponse>;

export async function init(
  handlers: {
    evaluate: EvaluateHandler;
    interrupt?: InterruptHandler;
    steer?: SteerHandler;
    forkSession?: ForkHandler;
    truncateSession?: TruncateHandler;
    control?: ControlHandler;
    automation?: AutomationHandler;
    attention?: AttentionHandler;
  },
  client: Client,
): Promise<void> {
  if (client == null) {
    throw Error("acp server init must provide an explicit Conat client");
  }
  apiSub = await client.subscribe(acpSubscriptionSubject("api"), {
    queue: "acp-q",
  });
  listenApi(handlers.evaluate);
  await subscribeLegacy(client, "api");
  if (handlers.interrupt) {
    interruptSub = await client.subscribe(acpSubscriptionSubject("interrupt"), {
      queue: "acp-interrupt-q",
    });
    listenInterrupts(handlers.interrupt);
    await subscribeLegacy(client, "interrupt");
  }
  if (handlers.steer) {
    steerSub = await client.subscribe(acpSubscriptionSubject("steer"), {
      queue: "acp-steer-q",
    });
    listenSteers(handlers.steer);
    await subscribeLegacy(client, "steer");
  }
  if (handlers.forkSession) {
    forkSub = await client.subscribe(acpSubscriptionSubject("fork"), {
      queue: "acp-fork-q",
    });
    listenForks(handlers.forkSession);
    await subscribeLegacy(client, "fork");
  }
  if (handlers.truncateSession) {
    truncateSub = await client.subscribe(acpSubscriptionSubject("truncate"), {
      queue: "acp-truncate-q",
    });
    listenTruncates(handlers.truncateSession);
    await subscribeLegacy(client, "truncate");
  }
  if (handlers.control) {
    controlSub = await client.subscribe(acpSubscriptionSubject("control"), {
      queue: "acp-control-q",
    });
    listenControls(handlers.control);
    await subscribeLegacy(client, "control");
  }
  if (handlers.automation) {
    automationSub = await client.subscribe(
      acpSubscriptionSubject("automation"),
      {
        queue: "acp-automation-q",
      },
    );
    listenAutomations(handlers.automation);
    await subscribeLegacy(client, "automation");
  }
  if (handlers.attention) {
    attentionSub = await client.subscribe(acpSubscriptionSubject("attention"), {
      queue: "acp-attention-q",
    });
    listenAttentions(handlers.attention);
    await subscribeLegacy(client, "attention");
  }
}

async function subscribeLegacy(
  client: Client,
  operation: AcpOperation,
): Promise<void> {
  const sub = await client.subscribe(legacyAcpSubscriptionSubject(operation), {
    queue: `acp-legacy-${operation}-q`,
  });
  legacySubs.push(sub);
  listenLegacy(sub, operation);
}

export async function close(): Promise<void> {
  if (apiSub != null) {
    apiSub.close();
    apiSub = null;
  }
  if (interruptSub != null) {
    interruptSub.close();
    interruptSub = null;
  }
  if (steerSub != null) {
    steerSub.close();
    steerSub = null;
  }
  if (forkSub != null) {
    forkSub.close();
    forkSub = null;
  }
  if (truncateSub != null) {
    truncateSub.close();
    truncateSub = null;
  }
  if (controlSub != null) {
    controlSub.close();
    controlSub = null;
  }
  if (automationSub != null) {
    automationSub.close();
    automationSub = null;
  }
  if (attentionSub != null) {
    attentionSub.close();
    attentionSub = null;
  }
  while (legacySubs.length > 0) {
    legacySubs.pop()?.close();
  }
}

function listenLegacy(sub: Subscription, operation: AcpOperation): void {
  (async () => {
    for await (const mesg of sub) {
      void rejectLegacyRequest(mesg, operation).catch((err) => {
        logger.debug("failed responding to legacy ACP request", {
          operation,
          subject: mesg.subject,
          err,
        });
      });
    }
  })().catch((err) => {
    logger.warn("legacy ACP listener stopped", { operation, err });
  });
}

async function rejectLegacyRequest(
  mesg,
  operation: AcpOperation,
): Promise<void> {
  const parsed = parseAcpSubject(mesg.subject);
  logger.warn("rejecting legacy ACP client request", {
    code: ACP_CLIENT_REFRESH_REQUIRED_CODE,
    operation,
    project_id: parsed?.project_id,
    subject: mesg.subject,
  });
  const error = {
    code: ACP_CLIENT_REFRESH_REQUIRED_CODE,
    error: ACP_CLIENT_REFRESH_REQUIRED_MESSAGE,
    retryable: false,
  };
  if (operation === "api") {
    await mesg.respond({ seq: 0, type: "error", ...error }, { noThrow: true });
    await mesg.respond(null, { noThrow: true });
    return;
  }
  await mesg.respond(error, { noThrow: true });
}

function listenApi(evaluate: EvaluateHandler): void {
  if (apiSub == null) throw Error("must init first");
  (async () => {
    for await (const mesg of apiSub!) {
      void runLimited("message", mesg, () => handleMessage(mesg, evaluate));
    }
  })().catch((err) => {
    logger.warn("acp api listener stopped", err);
  });
}

function listenInterrupts(interruptHandler: InterruptHandler): void {
  if (interruptSub == null) return;
  (async () => {
    for await (const mesg of interruptSub!) {
      void runLimited("interrupt", mesg, () =>
        handleInterruptMessage(mesg, interruptHandler),
      );
    }
  })().catch((err) => {
    logger.warn("acp interrupt listener stopped", err);
  });
}

function listenSteers(steerHandler: SteerHandler): void {
  if (steerSub == null) return;
  (async () => {
    for await (const mesg of steerSub!) {
      void runLimited("steer", mesg, () =>
        handleSteerMessage(mesg, steerHandler),
      );
    }
  })().catch((err) => {
    logger.warn("acp steer listener stopped", err);
  });
}

function listenForks(forkHandler: ForkHandler): void {
  if (forkSub == null) return;
  (async () => {
    for await (const mesg of forkSub!) {
      void runLimited("fork", mesg, () => handleForkMessage(mesg, forkHandler));
    }
  })().catch((err) => {
    logger.warn("acp fork listener stopped", err);
  });
}

function listenTruncates(truncateHandler: TruncateHandler): void {
  if (truncateSub == null) return;
  (async () => {
    for await (const mesg of truncateSub!) {
      void runLimited("truncate", mesg, () =>
        handleTruncateMessage(mesg, truncateHandler),
      );
    }
  })().catch((err) => {
    logger.warn("acp truncate listener stopped", err);
  });
}

function listenControls(controlHandler: ControlHandler): void {
  if (controlSub == null) return;
  (async () => {
    for await (const mesg of controlSub!) {
      void runLimited("control", mesg, () =>
        handleControlMessage(mesg, controlHandler),
      );
    }
  })().catch((err) => {
    logger.warn("acp control listener stopped", err);
  });
}

function listenAutomations(automationHandler: AutomationHandler): void {
  if (automationSub == null) return;
  (async () => {
    for await (const mesg of automationSub!) {
      void runLimited("automation", mesg, () =>
        handleAutomationMessage(mesg, automationHandler),
      );
    }
  })().catch((err) => {
    logger.warn("acp automation listener stopped", err);
  });
}

function listenAttentions(attentionHandler: AttentionHandler): void {
  if (attentionSub == null) return;
  (async () => {
    for await (const mesg of attentionSub!) {
      void runLimited("attention", mesg, () =>
        handleAttentionMessage(mesg, attentionHandler),
      );
    }
  })().catch((err) => {
    logger.warn("acp attention listener stopped", { err });
  });
}

async function handleMessage(mesg, evaluate: EvaluateHandler) {
  const options = mesg.data ?? {};
  logger.debug("handleMessage", {
    subject: mesg.subject,
    hasChat: !!options.chat,
  });
  let activeChatTurnKey: string | undefined;
  let activeSessionTurnKey: string | undefined;

  let done = false;
  let seq = -1;
  const respond = async (payload?: any, error?: string) => {
    if (done) return;

    seq += 1;
    const data: any = {
      seq,
      ...(payload ?? {}),
    };
    if (error) {
      data.error = error;
      data.type = "error";
    }
    try {
      await mesg.respond(data);
    } catch (err) {
      logger.debug(`ACP respond failed -- ${err}`);
      await end();
    }
  };

  const end = async () => {
    if (done) return;
    done = true;
    await mesg.respond(null, { noThrow: true });
  };

  const stream: StreamHandler = async (payload) => {
    if (done) return;
    if (payload == null) {
      await end();
    } else {
      await respond(payload);
    }
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "api");
    if (!options.chat) {
      activeChatTurnKey = chatTurnKey(options);
      if (activeChatTurnKey != null) {
        const existing = inFlightChatTurnKeys.get(activeChatTurnKey);
        if (existing != null) {
          logger.warn(
            "duplicate acp evaluate request rejected while turn is in-flight",
            {
              chatTurnKey: activeChatTurnKey,
              subject: mesg.subject,
              existingSubject: existing.subject,
              inFlightMs: Date.now() - existing.startedAt,
            },
          );
          throw Error(
            "duplicate acp evaluate request for this chat turn while it is already running",
          );
        }
        inFlightChatTurnKeys.set(activeChatTurnKey, {
          startedAt: Date.now(),
          subject: mesg.subject,
        });
      }
      activeSessionTurnKey = sessionTurnKey(options);
      if (activeSessionTurnKey != null) {
        const existing = inFlightSessionTurnKeys.get(activeSessionTurnKey);
        if (existing != null) {
          logger.warn(
            "duplicate acp evaluate request rejected while session turn is in-flight",
            {
              sessionTurnKey: activeSessionTurnKey,
              subject: mesg.subject,
              existingSubject: existing.subject,
              inFlightMs: Date.now() - existing.startedAt,
            },
          );
          throw Error(
            "ACP agent is already processing a request for this session",
          );
        }
        inFlightSessionTurnKeys.set(activeSessionTurnKey, {
          startedAt: Date.now(),
          subject: mesg.subject,
        });
      }
    }

    await evaluate({
      ...options,
      prompt: options.prompt ?? "",
      stream,
    });
    await stream(null);
  } catch (err) {
    if (!done) {
      await respond(undefined, `${err}`);
      await end();
    }
  } finally {
    if (activeChatTurnKey != null) {
      inFlightChatTurnKeys.delete(activeChatTurnKey);
    }
    if (activeSessionTurnKey != null) {
      inFlightSessionTurnKeys.delete(activeSessionTurnKey);
    }
  }
}

function bindOptionsToSubject(
  options,
  subject: string,
  expectedOperation: AcpOperation,
): void {
  if (
    options == null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw Error("ACP request payload must be an object");
  }
  const parsed = parseAcpSubject(subject);
  if (
    parsed?.version !== "account-project" ||
    parsed.operation !== expectedOperation
  ) {
    throw Error("ACP subject must bind an account and project");
  }
  if (options.project_id != null && options.project_id !== parsed.project_id) {
    throw Error("project_id does not match subject");
  }
  if (options.account_id != null && options.account_id !== parsed.account_id) {
    throw Error("account_id does not match subject");
  }
  options.project_id = parsed.project_id;
  options.account_id = parsed.account_id;
  if (options.chat) {
    if (
      options.chat.project_id != null &&
      options.chat.project_id !== parsed.project_id
    ) {
      throw Error("chat.project_id does not match subject");
    }
    options.chat.project_id = parsed.project_id;
  }
}

function chatTurnKey(options: AcpRequest): string | undefined {
  const chat = options.chat;
  if (
    !chat ||
    typeof chat.project_id !== "string" ||
    typeof chat.path !== "string" ||
    typeof chat.message_date !== "string"
  ) {
    return undefined;
  }
  return `${chat.project_id}:${chat.path}:${chat.message_date}`;
}

function sessionTurnKey(options: AcpRequest): string | undefined {
  const projectId = options.project_id;
  const sessionId = options.session_id;
  if (typeof projectId !== "string" || typeof sessionId !== "string") {
    return undefined;
  }
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) return undefined;
  return `${projectId}:${trimmed}`;
}

async function handleInterruptMessage(
  mesg,
  interrupt: InterruptHandler,
): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) {
      data.error = error;
    }
    await mesg.respond(data, { noThrow: true });
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "interrupt");
    const result = await interrupt(options);
    await respond(result);
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

async function handleSteerMessage(mesg, steer: SteerHandler): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) {
      data.error = error;
    }
    await mesg.respond(data, { noThrow: true });
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "steer");
    const result = await steer(options);
    await respond(result);
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

async function handleForkMessage(
  mesg,
  forkSession: ForkHandler,
): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) {
      data.error = error;
    }
    await mesg.respond(data, { noThrow: true });
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "fork");
    const result = await forkSession(options);
    await respond(result);
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

async function handleTruncateMessage(
  mesg,
  truncateSession: TruncateHandler,
): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) {
      data.error = error;
    }
    await mesg.respond(data, { noThrow: true });
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "truncate");
    const result = await truncateSession(options);
    await respond(result);
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

async function handleControlMessage(
  mesg,
  control: ControlHandler,
): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) {
      data.error = error;
    }
    await mesg.respond(data, { noThrow: true });
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "control");
    const result = await control(options);
    await respond(result);
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

async function handleAutomationMessage(
  mesg,
  automation: AutomationHandler,
): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) {
      data.error = error;
    }
    await mesg.respond(data, { noThrow: true });
  };

  try {
    bindOptionsToSubject(options, mesg.subject, "automation");
    const result = await automation(options);
    await respond(result);
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

async function handleAttentionMessage(
  mesg,
  attention: AttentionHandler,
): Promise<void> {
  const options = mesg.data ?? {};
  const respond = async (payload?: any, error?: string) => {
    const data: any = payload ?? {};
    if (error) data.error = error;
    await mesg.respond(data, { noThrow: true });
  };
  try {
    bindOptionsToSubject(options, mesg.subject, "attention");
    await respond(await attention(options));
  } catch (err) {
    await respond(undefined, `${err}`);
  }
}

export const __test__ = {
  bindOptionsToSubject,
  rejectLegacyRequest,
};
