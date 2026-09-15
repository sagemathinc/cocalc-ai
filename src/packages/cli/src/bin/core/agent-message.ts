import { readFile } from "node:fs/promises";
import { connect } from "@cocalc/conat/core/client";
import { withTimeout } from "./context";
import type { AgentConnectionRequest } from "@cocalc/conat/agents/personal";
import {
  rpcOutcome,
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  validateAgentRpcPreparation,
  type AgentRpcRequest,
  type AgentRpcLink,
  type AgentRpcOutcome,
  type AgentRpcPreparation,
} from "@cocalc/conat/agents/rpc";
import {
  AGENT_IDENTITY_FILE_ENV,
  AGENT_IDENTITY_TOKEN_PREFIX,
  agentMessagingSubject,
  agentInboxPrefix,
  requireUuid,
  validateAgentMessage,
  validateAgentInspection,
  type AgentInspectionRequest,
  type AgentInspectionResult,
  type AgentCredential,
  type AgentMessageRequest,
  type AgentMessageReceipt,
} from "@cocalc/conat/agents/protocol";

export function validateIdentityCredential(value: AgentCredential): void {
  if (
    !value ||
    typeof value.token !== "string" ||
    !value.token.startsWith(AGENT_IDENTITY_TOKEN_PREFIX)
  )
    throw new Error("invalid agent identity credential");
  requireUuid(value.agent_id, "agent_id");
  requireUuid(value.run_id, "run_id");
  if (!Number.isFinite(value.expires_at) || value.expires_at <= Date.now())
    throw new Error(
      "agent identity credential has expired; no account/project fallback is permitted",
    );
}

export async function readIdentityCredential(): Promise<AgentCredential> {
  const file = process.env[AGENT_IDENTITY_FILE_ENV];
  if (!file)
    throw new Error(
      "a runtime-issued COCALC_AGENT_IDENTITY_FILE is required; this operation never uses account/project credentials",
    );
  let credential: AgentCredential;
  try {
    credential = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(
      "unable to read agent identity credential; no account/project fallback is permitted",
    );
  }
  validateIdentityCredential(credential);
  return credential;
}

export function sendIdentityMessage(
  request: AgentMessageRequest,
  apiUrl?: string,
): Promise<AgentMessageReceipt>;
export function sendIdentityMessage(
  request: AgentInspectionRequest,
  apiUrl?: string,
): Promise<AgentInspectionResult>;
export function sendIdentityMessage(
  request: Extract<
    AgentRpcRequest,
    { action: "request-connection" | "connection-request" }
  >,
  apiUrl?: string,
): Promise<AgentConnectionRequest>;
export function sendIdentityMessage(
  request: Extract<AgentRpcRequest, { action: "destinations" }>,
  apiUrl?: string,
): Promise<AgentRpcLink[]>;
export function sendIdentityMessage(
  request: Extract<AgentRpcRequest, { action: "send" | "inspect" }>,
  apiUrl?: string,
): Promise<AgentRpcOutcome>;
export function sendIdentityMessage(
  request: Extract<
    AgentRpcRequest,
    { action: "prepare-attachments" | "cancel-attachments" }
  >,
  apiUrl?: string,
): Promise<AgentRpcPreparation>;
export function sendIdentityMessage(
  request: AgentRpcRequest,
  apiUrl?: string,
): Promise<AgentRpcLink[] | AgentRpcPreparation | AgentConnectionRequest>;
export async function sendIdentityMessage(
  request: AgentMessageRequest | AgentInspectionRequest | AgentRpcRequest,
  apiUrl?: string,
): Promise<
  | AgentMessageReceipt
  | AgentInspectionResult
  | AgentRpcLink[]
  | AgentRpcOutcome
  | AgentRpcPreparation
  | AgentConnectionRequest
> {
  if (!("version" in request) && request.action === "send")
    throw new Error(
      "Legacy delivery is retired; use --rpc with an approved RPC link",
    );
  if ("version" in request) validateAgentRpcRequest(request);
  else if (request?.action === "receipt") validateAgentMessage(request);
  else validateAgentInspection(request);
  const credential = await readIdentityCredential();
  const address = apiUrl || credential.api_url || process.env.COCALC_API_URL;
  if (!address) throw new Error("COCALC_API_URL or --api is required");
  const client = connect({
    address,
    noCache: true,
    rejectUnauthorized: true,
    auth: { bearer: credential.token },
    inboxPrefix: agentInboxPrefix(credential.agent_id, credential.run_id),
  });
  try {
    const pending = client.request(
      agentMessagingSubject(credential.agent_id, credential.run_id),
      request,
      {
        timeout: "version" in request ? 50_000 : 30_000,
        waitForInterest: false,
      },
    );
    // Transport timeouts may not include DNS, connection, or sign-in waits.
    // Closing the client in finally prevents a late connection from sending.
    const response =
      "version" in request
        ? await withTimeout(pending, 50_000, "agent RPC deadline exceeded")
        : await pending;
    if (response.data?.error) throw new Error(response.data.error);
    if (!response.data?.result)
      throw new Error("message receipt was not confirmed");
    if ("version" in request && request.action === "prepare-attachments")
      validateAgentRpcPreparation(response.data.result, request);
    if (
      "version" in request &&
      (request.action === "send" ||
        request.action === "inspect" ||
        request.action === "cancel-attachments")
    )
      validateAgentRpcOutcome(response.data.result, request);
    if (
      "version" in request &&
      (request.action === "request-connection" ||
        request.action === "connection-request")
    ) {
      const result = response.data.result as AgentConnectionRequest;
      requireUuid(result.request_id, "connection request_id");
      if (
        (request.action === "connection-request" &&
          result.request_id !== request.request_id) ||
        (request.action === "request-connection" &&
          (result.target?.agent_id !== request.target.agent_id ||
            result.target?.project_id !== request.target.project_id ||
            result.reason !== request.reason.trim() ||
            (result.ttl_seconds === undefined ? 86400 : result.ttl_seconds) !==
              (request.ttl_seconds === undefined
                ? 86400
                : request.ttl_seconds) ||
            !!result.both_directions !== !!request.both_directions ||
            !!result.allow_guidance !== !!request.allow_guidance)) ||
        result.run_id !== credential.run_id ||
        result.source?.agent_id !== credential.agent_id ||
        !["pending", "approved", "denied", "expired", "invalidated"].includes(
          result.state,
        )
      )
        throw new Error(
          "Connection approval response is invalid or mismatched; inspect the request before explicitly trying again",
        );
    }
    return response.data.result;
  } catch (error) {
    if ("version" in request && request.action === "prepare-attachments")
      return rpcOutcome(request, "rejected", {
        code: "attachment_preparation_unavailable",
        chat_effect: "none",
        reason:
          "Attachment preparation was not acknowledged; no file payload or message was sent. Project startup may still finish.",
      });
    if (
      "version" in request &&
      request.version === 2 &&
      (request.action === "send" || request.action === "inspect")
    )
      return rpcOutcome(request, "unknown", {
        reason:
          "No authoritative response; inspection is safe, explicit retry may duplicate work",
      });
    throw error;
  } finally {
    client.close();
  }
}
