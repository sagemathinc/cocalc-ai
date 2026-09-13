import { readFile } from "node:fs/promises";
import { connect } from "@cocalc/conat/core/client";
import { withTimeout } from "./context";
import {
  rpcOutcome,
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  type AgentRpcRequest,
  type AgentRpcLink,
  type AgentRpcOutcome,
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

export function sendIdentityMessage(
  request: AgentMessageRequest,
  apiUrl?: string,
): Promise<AgentMessageReceipt>;
export function sendIdentityMessage(
  request: AgentInspectionRequest,
  apiUrl?: string,
): Promise<AgentInspectionResult>;
export function sendIdentityMessage(
  request: AgentRpcRequest,
  apiUrl?: string,
): Promise<AgentRpcLink[] | AgentRpcOutcome>;
export async function sendIdentityMessage(
  request: AgentMessageRequest | AgentInspectionRequest | AgentRpcRequest,
  apiUrl?: string,
): Promise<
  AgentMessageReceipt | AgentInspectionResult | AgentRpcLink[] | AgentRpcOutcome
> {
  if (!("version" in request) && request.action === "send")
    throw new Error(
      "Legacy delivery is retired; use --rpc with an approved RPC link",
    );
  if ("version" in request) validateAgentRpcRequest(request);
  else if (request?.action === "receipt") validateAgentMessage(request);
  else validateAgentInspection(request);
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
    if ("version" in request && request.action !== "destinations")
      validateAgentRpcOutcome(response.data.result, request);
    return response.data.result;
  } catch (error) {
    if (
      "version" in request &&
      request.version === 2 &&
      request.action !== "destinations"
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
