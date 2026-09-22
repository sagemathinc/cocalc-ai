import { readFile } from "node:fs/promises";
import { connect } from "@cocalc/conat/core/client";
import { withTimeout } from "./context";
import type {
  AgentNetworkDiscovery,
  AgentNetworkProposal,
} from "@cocalc/conat/agents/personal";
import {
  rpcOutcome,
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  validateAgentRpcBroadcastOutcome,
  validateAgentRpcPreparation,
  type AgentRpcRequest,
  type AgentRpcOutcome,
  type AgentRpcPreparation,
  type AgentRpcBroadcastOutcome,
} from "@cocalc/conat/agents/rpc";
import {
  AGENT_IDENTITY_FILE_ENV,
  AGENT_IDENTITY_TOKEN_PREFIX,
  agentMessagingSubject,
  agentInboxPrefix,
  requireUuid,
  validateAgentInspection,
  type AgentInspectionRequest,
  type AgentInspectionResult,
  type AgentCredential,
} from "@cocalc/conat/agents/protocol";
import type {
  AgentFileGrant,
  PreparedAgentFileGrant,
} from "@cocalc/conat/agents/file-grants";

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
  request: AgentInspectionRequest,
  apiUrl?: string,
): Promise<AgentInspectionResult>;
export function sendIdentityMessage(
  request: Extract<AgentRpcRequest, { action: "destinations" }>,
  apiUrl?: string,
): Promise<AgentNetworkDiscovery>;
export function sendIdentityMessage(
  request: Extract<AgentRpcRequest, { action: "propose-network" }>,
  apiUrl?: string,
): Promise<AgentNetworkProposal>;
export function sendIdentityMessage(
  request: Extract<AgentRpcRequest, { action: "broadcast" }>,
  apiUrl?: string,
): Promise<AgentRpcBroadcastOutcome>;
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
  request: Extract<AgentRpcRequest, { action: "file-grants" }>,
  apiUrl?: string,
): Promise<AgentFileGrant[]>;
export function sendIdentityMessage(
  request: Extract<AgentRpcRequest, { action: "prepare-file-grant" }>,
  apiUrl?: string,
): Promise<PreparedAgentFileGrant>;
export function sendIdentityMessage(
  request: AgentRpcRequest,
  apiUrl?: string,
): Promise<
  | AgentNetworkDiscovery
  | AgentRpcPreparation
  | AgentFileGrant[]
  | PreparedAgentFileGrant
>;
export async function sendIdentityMessage(
  request: AgentInspectionRequest | AgentRpcRequest,
  apiUrl?: string,
): Promise<
  | AgentInspectionResult
  | AgentNetworkDiscovery
  | AgentNetworkProposal
  | AgentRpcBroadcastOutcome
  | AgentRpcOutcome
  | AgentRpcPreparation
  | AgentFileGrant[]
  | PreparedAgentFileGrant
> {
  if ("version" in request) validateAgentRpcRequest(request);
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
    if ("version" in request && request.action === "broadcast")
      validateAgentRpcBroadcastOutcome(response.data.result, request);
    if (
      "version" in request &&
      (request.action === "send" ||
        request.action === "inspect" ||
        request.action === "cancel-attachments")
    )
      validateAgentRpcOutcome(response.data.result, request);
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
