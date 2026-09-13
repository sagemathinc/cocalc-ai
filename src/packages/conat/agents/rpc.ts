import { requireUuid } from "./protocol";

export interface AgentEndpoint {
  project_id: string;
  agent_id: string;
}

export interface AgentRpcAttempt {
  version: 2;
  attempt_id: string;
  target: AgentEndpoint;
}

export interface AgentRpcSend extends AgentRpcAttempt {
  body: string;
  guidance?: boolean;
}

export interface AgentRpcOutcome extends AgentRpcAttempt {
  outcome: "accepted" | "rejected" | "unknown";
  observed_at: number;
  reason?: string;
  chat_effect?: "none" | "saved" | "unknown";
  operation?: { id: string; disposition: "queued" | "running" | "steered" };
}

export interface AgentRpcLink {
  link_id: string;
  source: AgentEndpoint;
  target: AgentEndpoint;
  approved_by: string;
  reason: string;
  expires_at: string;
  revoked_at?: string | null;
  allow_guidance: boolean;
}

export type AgentRpcRequest =
  | (AgentRpcSend & { action: "send" })
  | (AgentRpcAttempt & { action: "inspect" })
  | { version: 2; action: "destinations" };

export function validateAgentEndpoint(value: AgentEndpoint): void {
  requireUuid(value?.project_id, "project_id");
  requireUuid(value?.agent_id, "agent_id");
  if (
    Object.keys(value).some((key) => !["project_id", "agent_id"].includes(key))
  )
    throw new Error("unexpected endpoint field");
}

export function validateAgentRpcRequest(value: AgentRpcRequest): void {
  if (value?.version !== 2) throw new Error("agent RPC version 2 required");
  const keys = ["version", "action"];
  if (value.action === "send" || value.action === "inspect") {
    keys.push("attempt_id", "target");
    requireUuid(value.attempt_id, "attempt_id");
    validateAgentEndpoint(value.target);
    if (value.action === "send") {
      keys.push("body", "guidance");
      if (
        typeof value.body !== "string" ||
        !value.body.trim() ||
        new TextEncoder().encode(value.body).length > 32768
      )
        throw new Error("message must contain 1 to 32768 UTF-8 bytes");
      if (value.guidance !== undefined && typeof value.guidance !== "boolean")
        throw new Error("guidance must be boolean");
    }
  } else if (value.action !== "destinations") {
    throw new Error("unsupported agent RPC operation");
  }
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("unexpected agent RPC field");
}

export function rpcOutcome(
  attempt: AgentRpcAttempt,
  outcome: AgentRpcOutcome["outcome"],
  extra: Partial<
    Pick<AgentRpcOutcome, "reason" | "chat_effect" | "operation">
  > = {},
): AgentRpcOutcome {
  return {
    version: 2,
    target: attempt.target,
    attempt_id: attempt.attempt_id,
    outcome,
    observed_at: Date.now(),
    ...extra,
  };
}

/** An acknowledgment is evidence only for the exact attempt that was sent. */
export function validateAgentRpcOutcome(
  value: AgentRpcOutcome,
  attempt: AgentRpcAttempt,
): void {
  if (
    value?.version !== 2 ||
    value.attempt_id !== attempt.attempt_id ||
    value.target?.project_id !== attempt.target.project_id ||
    value.target?.agent_id !== attempt.target.agent_id ||
    !["accepted", "rejected", "unknown"].includes(value.outcome) ||
    !Number.isFinite(value.observed_at) ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.chat_effect !== undefined &&
      !["none", "saved", "unknown"].includes(value.chat_effect)) ||
    (value.operation !== undefined &&
      (typeof value.operation.id !== "string" ||
        !["queued", "running", "steered"].includes(
          value.operation.disposition,
        )))
  )
    throw new Error("Recipient acknowledgment is invalid or mismatched");
}

/** Trusted owner-to-host envelope, not an agent-supplied authority claim. */
export interface AgentRpcEnvelope extends AgentRpcSend {
  permit_id: string;
  source: AgentEndpoint;
  run_id: string;
  link_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  deadline: number;
}
