import { requireUuid } from "./protocol";
import {
  validateAttachmentMetadata,
  type AgentFileReference,
} from "./attachments";

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
  file_references?: AgentFileReference[];
}

export interface AgentRpcOutcome extends AgentRpcAttempt {
  outcome: "accepted" | "rejected" | "unknown";
  observed_at: number;
  reason?: string;
  code?: AgentRpcFailureCode;
  chat_effect?: "none" | "saved" | "unknown";
  operation?: { id: string; disposition: "queued" | "running" | "steered" };
}

export const AGENT_RPC_FAILURE_CODES = [
  "host_overloaded",
  "project_overloaded",
  "autostart_disabled",
  "project_slot_limit",
  "project_not_startable",
  "startup_deadline",
  "execution_not_allowed",
  "execution_ack_unknown",
  "submission_deadline",
  "attachment_unavailable",
] as const;
export type AgentRpcFailureCode = (typeof AGENT_RPC_FAILURE_CODES)[number];

export interface AgentRpcLink {
  /** Present only on an account-home authoritative personal grant. */
  principal_account_id?: string;
  link_id: string;
  source: AgentEndpoint;
  target: AgentEndpoint;
  approved_by: string;
  reason: string;
  expires_at: string | null;
  source_name?: string;
  target_name?: string;
  target_retired_names?: string[];
  source_named_agent?: import("./personal").NamedAgent;
  target_named_agent?: import("./personal").NamedAgent;
  revoked_at?: string | null;
  allow_guidance: boolean;
}

export type AgentRpcRequest =
  | ({
      version: 2;
      action: "request-connection";
    } & import("./personal").PersonalConnectionRequestOptions)
  | { version: 2; action: "connection-request"; request_id: string }
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
      keys.push("body", "guidance", "file_references");
      if (value.file_references !== undefined)
        validateAttachmentMetadata({
          kind: "project-files",
          files: value.file_references,
        });
      if (
        typeof value.body !== "string" ||
        !value.body.trim() ||
        new TextEncoder().encode(value.body).length > 32768
      )
        throw new Error("message must contain 1 to 32768 UTF-8 bytes");
      if (value.guidance !== undefined && typeof value.guidance !== "boolean")
        throw new Error("guidance must be boolean");
    }
  } else if (value.action === "request-connection") {
    keys.push(
      "request_id",
      "target",
      "reason",
      "ttl_seconds",
      "both_directions",
      "allow_guidance",
    );
    requireUuid(value.request_id, "request_id");
    validateAgentEndpoint(value.target);
    validatePersonalApproval(value);
  } else if (value.action === "connection-request") {
    keys.push("request_id");
    requireUuid(value.request_id, "request_id");
  } else if (value.action !== "destinations") {
    throw new Error("unsupported agent RPC operation");
  }
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("unexpected agent RPC field");
}

export function validatePersonalApproval(value: {
  reason: string;
  ttl_seconds?: number | null;
  both_directions?: boolean;
  allow_guidance?: boolean;
}): void {
  if (
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason.length > 2000
  )
    throw new Error("approval reason required (maximum 2000 characters)");
  if (
    value.ttl_seconds != null &&
    (!Number.isInteger(value.ttl_seconds) ||
      value.ttl_seconds < 1 ||
      value.ttl_seconds > 30 * 86400)
  )
    throw new Error("invalid approval duration");
  for (const key of ["both_directions", "allow_guidance"] as const)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`invalid ${key}`);
}

export function rpcOutcome(
  attempt: AgentRpcAttempt,
  outcome: AgentRpcOutcome["outcome"],
  extra: Partial<
    Pick<AgentRpcOutcome, "reason" | "code" | "chat_effect" | "operation">
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
    (value.code !== undefined &&
      !AGENT_RPC_FAILURE_CODES.includes(value.code)) ||
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
