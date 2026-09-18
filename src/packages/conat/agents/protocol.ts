import { isValidUUID } from "@cocalc/util/misc";

export const AGENT_IDENTITY_TOKEN_PREFIX = "cocalc_agent_identity_";
export const AGENT_MESSAGE_MAX_BYTES = 32 * 1024;
export const AGENT_IDENTITY_FILE_ENV = "COCALC_AGENT_IDENTITY_FILE";

export interface AgentIdentity {
  agent_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  name: string;
  created_by: string;
  disabled_at: Date | string | null;
}

export interface AgentCredential {
  agent_id: string;
  run_id: string;
  token: string;
  expires_at: number;
  api_url?: string;
}

export type AgentInspectionRequest = { action: "whoami" };

export interface AgentSelf {
  identity: AgentIdentity;
  run_id: string;
  protocol_version: 3;
  capabilities: string[];
}

export type AgentInspectionResult = AgentSelf;

export function validateAgentInspection(request: AgentInspectionRequest): void {
  if (!request || request.action !== "whoami")
    throw new Error("unsupported agent inspection operation");
  if (Object.keys(request).some((key) => key !== "action"))
    throw new Error("unknown agent inspection field");
}

export function requireUuid(
  value: unknown,
  name: string,
): asserts value is string {
  if (!isValidUUID(value)) throw new Error(`${name} must be a UUID`);
}

export function agentMessagingSubject(agentId: string, runId: string): string {
  requireUuid(agentId, "agent_id");
  requireUuid(runId, "run_id");
  return `agent-messaging.${agentId}.${runId}`;
}

export function agentInboxPrefix(agentId: string, runId: string): string {
  requireUuid(agentId, "agent_id");
  requireUuid(runId, "run_id");
  return `_INBOX.agent-identity.${agentId}.${runId}`;
}

export function allowsAgentSubject(
  agentId: string,
  runId: string,
  subject: string,
  type: "pub" | "sub",
): boolean {
  return type === "pub"
    ? subject === agentMessagingSubject(agentId, runId)
    : subject.startsWith(`${agentInboxPrefix(agentId, runId)}.`);
}

export function parseAgentMessagingSubject(subject: string) {
  const parts = subject.split(".");
  if (parts.length !== 3 || parts[0] !== "agent-messaging") {
    throw new Error("invalid agent messaging subject");
  }
  requireUuid(parts[1], "agent_id");
  requireUuid(parts[2], "run_id");
  return { agent_id: parts[1], run_id: parts[2] };
}
