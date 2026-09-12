import { readFile } from "node:fs/promises";
import { connect } from "@cocalc/conat/core/client";
import {
  AGENT_IDENTITY_FILE_ENV,
  AGENT_IDENTITY_TOKEN_PREFIX,
  agentMessagingSubject,
  agentInboxPrefix,
  requireUuid,
  validateAgentMessage,
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

export async function sendIdentityMessage(
  request: AgentMessageRequest,
  apiUrl?: string,
): Promise<AgentMessageReceipt> {
  validateAgentMessage(request);
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
  const address = apiUrl || process.env.COCALC_API_URL;
  if (!address) throw new Error("COCALC_API_URL or --api is required");
  const client = connect({
    address,
    noCache: true,
    rejectUnauthorized: true,
    auth: { bearer: credential.token },
    inboxPrefix: agentInboxPrefix(credential.agent_id, credential.run_id),
  });
  try {
    const response = await client.request(
      agentMessagingSubject(credential.agent_id, credential.run_id),
      request,
      { timeout: 30_000 },
    );
    if (response.data?.error) throw new Error(response.data.error);
    if (!response.data?.result)
      throw new Error("message receipt was not confirmed");
    return response.data.result;
  } finally {
    client.close();
  }
}
