import type { Client } from "@cocalc/conat/core/client";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  AcpAutomationRequest,
  AcpAutomationResponse,
  AcpControlRequest,
  AcpControlResponse,
  AcpForkSessionRequest,
  AcpInterruptRequest,
  AcpRequest,
  AcpSteerRequest,
  AcpSteerResponse,
  AcpStreamMessage,
} from "./types";
import {
  acpAutomationSubject,
  acpControlSubject,
  acpForkSubject,
  acpInterruptSubject,
  acpSteerSubject,
  acpSubject,
} from "./server";

interface StreamOptions {
  timeout?: number;
}

function requireExplicitConatClient(client?: Client): Client {
  if (client != null) {
    return client;
  }
  throw new Error("must provide an explicit Conat client");
}

function isNonEmptySessionId(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export async function* streamAcp(
  request: AcpRequest,
  options: StreamOptions = {},
  client?: Client,
): AsyncGenerator<AcpStreamMessage> {
  const { timeout = 1000 * 60 * 60 * 2 } = options;

  if (!isValidUUID(request.project_id)) {
    throw Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(request.account_id)) {
    throw Error("account_id must be a valid uuid");
  }

  const subject = acpSubject({ project_id: request.project_id });
  // ACP helpers are shared across frontend, CLI, and backend code paths. Do
  // not silently grab the global singleton here; callers must choose the
  // intended routed client explicitly.
  const cn = requireExplicitConatClient(client);
  let seq = -1;

  for await (const resp of await cn.requestMany(subject, request, {
    maxWait: timeout,
  })) {
    if (resp.data == null) break;
    const message = resp.data as AcpStreamMessage;
    if (message.seq !== seq + 1) {
      throw Error("missed acp response");
    }
    seq = message.seq;
    yield message;
  }
}

export async function runAcp(
  request: AcpRequest,
  options: StreamOptions = {},
  client?: Client,
): Promise<{
  finalResponse: string;
  threadId: string | null;
  events: AcpStreamMessage[];
}> {
  const events: AcpStreamMessage[] = [];
  let finalResponse = "";
  let threadId: string | null = null;

  for await (const message of streamAcp(request, options, client)) {
    events.push(message);
    if (message.type === "summary") {
      finalResponse = message.finalResponse;
      threadId = message.threadId ?? null;
    } else if (message.type === "event") {
      continue;
    }
  }

  return { finalResponse, threadId, events };
}

export async function interruptAcp(
  request: AcpInterruptRequest,
  client?: Client,
): Promise<void> {
  if (!isValidUUID(request.project_id)) {
    throw Error("project_id must be a valid uuid");
  }
  const subject = acpInterruptSubject({ project_id: request.project_id });
  const cn = requireExplicitConatClient(client);
  const resp = await cn.request(subject, request, { timeout: 30 * 1000 });
  const error = resp?.data?.error;
  if (error) {
    throw Error(error);
  }
}

export async function steerAcp(
  request: AcpSteerRequest,
  client?: Client,
): Promise<AcpSteerResponse> {
  if (!isValidUUID(request.project_id)) {
    throw Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(request.account_id)) {
    throw Error("account_id must be a valid uuid");
  }
  const subject = acpSteerSubject({ project_id: request.project_id });
  const cn = requireExplicitConatClient(client);
  const resp = await cn.request(subject, request, { timeout: 30 * 1000 });
  const error = resp?.data?.error;
  if (error) {
    throw Error(error);
  }
  return (resp?.data ?? { ok: false, state: "missing" }) as AcpSteerResponse;
}

export async function forkAcpSession(
  request: AcpForkSessionRequest,
  client?: Client,
): Promise<{ sessionId: string }> {
  if (!isValidUUID(request.project_id)) {
    throw Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(request.account_id)) {
    throw Error("account_id must be a valid uuid");
  }
  if (!isNonEmptySessionId(request.sessionId)) {
    throw Error("sessionId must be a non-empty string");
  }
  if (
    request.newSessionId != null &&
    !isNonEmptySessionId(request.newSessionId)
  ) {
    throw Error("newSessionId must be a non-empty string");
  }
  const subject = acpForkSubject({ project_id: request.project_id });
  const cn = requireExplicitConatClient(client);
  const resp = await cn.request(subject, request, { timeout: 30 * 1000 });
  const error = resp?.data?.error;
  if (error) {
    throw Error(error);
  }
  const sessionId = resp?.data?.sessionId;
  if (!isNonEmptySessionId(sessionId)) {
    throw Error("invalid sessionId returned from fork");
  }
  return { sessionId };
}

export async function controlAcp(
  request: AcpControlRequest,
  client?: Client,
): Promise<AcpControlResponse> {
  if (!isValidUUID(request.project_id)) {
    throw Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(request.account_id)) {
    throw Error("account_id must be a valid uuid");
  }
  const subject = acpControlSubject({ project_id: request.project_id });
  const cn = requireExplicitConatClient(client);
  const resp = await cn.request(subject, request, { timeout: 30 * 1000 });
  const error = resp?.data?.error;
  if (error) {
    throw Error(error);
  }
  return (resp?.data ?? { ok: false, state: "missing" }) as AcpControlResponse;
}

export async function automationAcp(
  request: AcpAutomationRequest,
  client?: Client,
): Promise<AcpAutomationResponse> {
  if (!isValidUUID(request.project_id)) {
    throw Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(request.account_id)) {
    throw Error("account_id must be a valid uuid");
  }
  const subject = acpAutomationSubject({ project_id: request.project_id });
  const cn = requireExplicitConatClient(client);
  const resp = await cn.request(subject, request, { timeout: 30 * 1000 });
  const error = resp?.data?.error;
  if (error) {
    throw Error(error);
  }
  return (resp?.data ?? { ok: false }) as AcpAutomationResponse;
}
