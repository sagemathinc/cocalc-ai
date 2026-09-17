import { requireUuid } from "./protocol";
import {
  validateExternalAgentSource,
  type ExternalAgentSource,
} from "./external";
import {
  validateAttachmentMetadata,
  validateAttachmentPayload,
  type AgentFileReference,
  type AgentSnapshotMetadata,
  type AgentSnapshot,
} from "./attachments";

export interface AgentEndpoint {
  project_id: string;
  agent_id: string;
}

export type AgentRpcSource = AgentEndpoint | ExternalAgentSource;

export function isExternalAgentSource(
  source: AgentRpcSource,
): source is ExternalAgentSource {
  return "kind" in source && source.kind === "external";
}

/** Installation credentials are never represented as native project runs. */
export function validateAgentRpcSource(
  source: AgentRpcSource,
  run_id?: string,
): void {
  if (isExternalAgentSource(source)) {
    validateExternalAgentSource(source);
    if (run_id !== undefined)
      throw new Error("external source cannot claim a native run");
  } else {
    validateAgentEndpoint(source);
    requireUuid(run_id, "run_id");
  }
}

export function agentRpcSourceKey(source: AgentRpcSource): string {
  return isExternalAgentSource(source)
    ? `external/${source.account_id}/${source.agent_id}/${source.installation_id}`
    : `${source.project_id}/${source.agent_id}`;
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
  snapshot_manifest?: AgentSnapshotMetadata[];
  attachment_reservation?: string;
}

export interface AgentRpcPrepared extends AgentRpcAttempt {
  outcome: "prepared";
  reservation_id: string;
  expires_at: number;
}
export type AgentRpcPreparation = AgentRpcPrepared | AgentRpcOutcome;

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
  "attachment_preparation_expired",
  "attachment_preparation_unavailable",
  "attachment_invalid",
  "attachment_limit_exceeded",
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
  | (AgentRpcSend & { action: "send"; snapshot_payload?: AgentSnapshot[] })
  | (AgentRpcSend & { action: "prepare-attachments" | "cancel-attachments" })
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

export function validateAgentRpcRequest(
  value: AgentRpcRequest,
  metadataOnly = false,
): void {
  if (value?.version !== 2) throw new Error("agent RPC version 2 required");
  const keys = ["version", "action"];
  if (
    ["send", "inspect", "prepare-attachments", "cancel-attachments"].includes(
      value.action,
    )
  ) {
    if (!("attempt_id" in value)) throw new Error("attempt required");
    keys.push("attempt_id", "target");
    requireUuid(value.attempt_id, "attempt_id");
    validateAgentEndpoint(value.target);
    if (value.action !== "inspect") {
      keys.push(
        "body",
        "guidance",
        "file_references",
        "snapshot_manifest",
        "attachment_reservation",
      );
      if (value.action === "send") keys.push("snapshot_payload");
      if (value.snapshot_manifest !== undefined) {
        if (value.file_references !== undefined)
          throw new Error("cannot mix snapshot and reference attachments");
        validateAttachmentMetadata({
          kind: "snapshots",
          files: value.snapshot_manifest,
        });
        if (value.action === "prepare-attachments") {
          if (value.attachment_reservation !== undefined)
            throw new Error("preparation cannot reuse a reservation");
        } else {
          requireUuid(value.attachment_reservation, "attachment_reservation");
          if (value.action === "send" && !metadataOnly)
            validateAttachmentPayload(
              { kind: "snapshots", files: value.snapshot_manifest },
              value.snapshot_payload!,
            );
        }
      } else if (
        value.action !== "send" ||
        value.attachment_reservation !== undefined ||
        value.snapshot_payload !== undefined
      ) {
        throw new Error("snapshot manifest required");
      }
      if (value.file_references !== undefined)
        validateAttachmentMetadata({
          kind: "project-files",
          files: value.file_references,
        });
      if (
        typeof value.body !== "string" ||
        value.body.length > 32768 ||
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

export function validateAgentRpcPreparation(
  value: AgentRpcPreparation,
  request: AgentRpcAttempt,
): void {
  if (value?.outcome !== "prepared")
    return validateAgentRpcOutcome(value as AgentRpcOutcome, request);
  requireUuid(value.reservation_id, "reservation_id");
  if (
    value.version !== 2 ||
    value.attempt_id !== request.attempt_id ||
    value.target?.project_id !== request.target.project_id ||
    value.target?.agent_id !== request.target.agent_id ||
    !Number.isFinite(value.expires_at)
  )
    throw new Error(
      "Attachment preparation acknowledgment is invalid or mismatched",
    );
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
  source: AgentRpcSource;
  run_id?: string;
  link_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  deadline: number;
}

/** Stable metadata-only permit binding, independent of object insertion order. */
export function agentRpcEnvelopeKey(e: AgentRpcEnvelope): string {
  return JSON.stringify([
    e.version,
    e.permit_id,
    e.deadline,
    e.source.project_id,
    e.source.agent_id,
    e.target.project_id,
    e.target.agent_id,
    e.run_id,
    e.link_id,
    e.account_id,
    e.path,
    e.thread_id,
    e.attempt_id,
    e.body,
    e.guidance === true,
    e.file_references?.map(({ kind, path }) => [kind, path]) ?? null,
    e.snapshot_manifest?.map(({ name, size, sha256 }) => [
      name,
      size,
      sha256,
    ]) ?? null,
    e.attachment_reservation ?? null,
    // Preserve native permit keys while binding all external authority fields.
    ...(isExternalAgentSource(e.source) ? [agentRpcSourceKey(e.source)] : []),
  ]);
}
