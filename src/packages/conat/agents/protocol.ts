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

export type AgentMessageState =
  | "pending"
  | "dispatching"
  | "dispatched"
  | "rejected"
  | "unconfirmed";

export interface AgentMessageReceipt {
  message_id: string;
  request_id: string;
  target_agent_id: string;
  state: AgentMessageState;
}

export type AgentMessageRequest =
  | {
      action: "send";
      request_id: string;
      target_agent_id?: string;
      target?: { project_id: string; path: string; thread_id: string };
      body: string;
      guidance?: boolean;
    }
  | { action: "receipt"; request_id: string };

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

export function validateAgentMessage(request: AgentMessageRequest): void {
  if (!request || !["send", "receipt"].includes(request.action)) {
    throw new Error("unsupported agent message operation");
  }
  const fields =
    request.action === "receipt"
      ? ["action", "request_id"]
      : [
          "action",
          "request_id",
          "target_agent_id",
          "target",
          "body",
          "guidance",
        ];
  if (Object.keys(request).some((key) => !fields.includes(key))) {
    throw new Error(
      "unknown agent message field; sender identity is assigned by the server",
    );
  }
  requireUuid(request.request_id, "request_id");
  if (request.action === "receipt") return;
  if (typeof request.body !== "string" || !request.body.trim()) {
    throw new Error("message body is required");
  }
  if (new TextEncoder().encode(request.body).length > AGENT_MESSAGE_MAX_BYTES) {
    throw new Error("agent messages must be at most 32 KiB");
  }
  if (request.guidance != null && typeof request.guidance !== "boolean") {
    throw new Error("guidance must be boolean");
  }
  if (!!request.target_agent_id === !!request.target) {
    throw new Error("specify exactly one target agent or project/path/thread");
  }
  if (request.target_agent_id)
    requireUuid(request.target_agent_id, "target_agent_id");
  if (request.target) {
    requireUuid(request.target.project_id, "target project_id");
    if (
      typeof request.target.path !== "string" ||
      !request.target.path.trim() ||
      request.target.path.length > 4096 ||
      typeof request.target.thread_id !== "string" ||
      !request.target.thread_id.trim() ||
      request.target.thread_id.length > 200 ||
      Object.keys(request.target).some(
        (key) => !["project_id", "path", "thread_id"].includes(key),
      )
    ) {
      throw new Error("target path and thread_id are required");
    }
  }
}
