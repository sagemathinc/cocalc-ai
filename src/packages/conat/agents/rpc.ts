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
export type AgentRpcTarget = AgentRpcSource;

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

export function validateAgentRpcTarget(target: AgentRpcTarget): void {
  if (isExternalAgentSource(target)) validateExternalAgentSource(target);
  else validateAgentEndpoint(target);
}

export function agentRpcSourceKey(source: AgentRpcSource): string {
  return isExternalAgentSource(source)
    ? `external/${source.account_id}/${source.agent_id}/${source.installation_id}`
    : `${source.project_id}/${source.agent_id}`;
}

export interface AgentRpcAttempt {
  version: 3;
  attempt_id: string;
  agent_network_id: string;
  target: AgentRpcTarget;
}

export interface AgentRpcSend extends AgentRpcAttempt {
  body: string;
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

export interface AgentRpcBroadcast {
  version: 3;
  action: "broadcast";
  broadcast_id: string;
  agent_network_id: string;
  targets: AgentRpcTarget[];
  body: string;
}

export interface AgentRpcBroadcastOutcome {
  version: 3;
  broadcast_id: string;
  agent_network_id: string;
  outcome: "accepted" | "rejected" | "unknown";
  observed_at: number;
  children: AgentRpcOutcome[];
}

export const AGENT_RPC_FAILURE_CODES = [
  "host_overloaded",
  "project_overloaded",
  "autostart_disabled",
  "project_slot_limit",
  "project_not_startable",
  "startup_deadline",
  "target_not_agent",
  "execution_not_allowed",
  "execution_ack_unknown",
  "submission_deadline",
  "attachment_unavailable",
  "attachment_preparation_expired",
  "attachment_preparation_unavailable",
  "attachment_invalid",
  "attachment_limit_exceeded",
  "network_unavailable",
  "network_stale",
  "principal_mismatch",
] as const;
export type AgentRpcFailureCode = (typeof AGENT_RPC_FAILURE_CODES)[number];

export type AgentRpcRequest =
  | (AgentRpcSend & { action: "send"; snapshot_payload?: AgentSnapshot[] })
  | (AgentRpcSend & { action: "prepare-attachments" | "cancel-attachments" })
  | (AgentRpcAttempt & { action: "inspect" })
  | { version: 3; action: "destinations" }
  | { version: 3; action: "inbox"; limit?: number }
  | { version: 3; action: "ack-inbox"; message_id: string }
  | AgentRpcBroadcast
  | ({
      version: 3;
      action: "propose-network";
    } & import("./personal").ProposeAgentNetworkOptions);

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
  if (value?.version !== 3) throw new Error("agent RPC version 3 required");
  const keys = ["version", "action"];
  if (
    ["send", "inspect", "prepare-attachments", "cancel-attachments"].includes(
      value.action,
    )
  ) {
    if (!("attempt_id" in value)) throw new Error("attempt required");
    keys.push("attempt_id", "agent_network_id", "target");
    requireUuid(value.attempt_id, "attempt_id");
    requireUuid(value.agent_network_id, "agent_network_id");
    validateAgentRpcTarget(value.target);
    if (value.action !== "inspect") {
      keys.push(
        "body",
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
    }
  } else if (value.action === "inbox") {
    keys.push("limit");
    if (
      value.limit !== undefined &&
      (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)
    )
      throw new Error("inbox limit must be an integer from 1 to 100");
  } else if (value.action === "ack-inbox") {
    keys.push("message_id");
    requireUuid(value.message_id, "message_id");
  } else if (value.action === "propose-network") {
    keys.push("proposal_id", "title", "delivery_mode", "members", "reason");
    requireUuid(value.proposal_id, "proposal_id");
    if (
      typeof value.title !== "string" ||
      !value.title.trim() ||
      value.title.length > 120
    )
      throw new Error("proposal title must contain 1 to 120 characters");
    if (
      value.delivery_mode !== undefined &&
      !["queued", "live"].includes(value.delivery_mode)
    )
      throw new Error("invalid proposed delivery mode");
    if (
      !Array.isArray(value.members) ||
      value.members.length < 2 ||
      value.members.length > 64
    )
      throw new Error("proposal requires 2 to 64 members");
    if (value.reason !== undefined && value.reason.length > 500)
      throw new Error("proposal reason is too long");
  } else if (value.action === "broadcast") {
    keys.push("broadcast_id", "agent_network_id", "targets", "body");
    requireUuid(value.broadcast_id, "broadcast_id");
    requireUuid(value.agent_network_id, "agent_network_id");
    if (
      !Array.isArray(value.targets) ||
      value.targets.length < 1 ||
      value.targets.length > 32
    )
      throw new Error("broadcast requires 1 to 32 targets");
    const targets = new Set<string>();
    for (const target of value.targets) {
      validateAgentRpcTarget(target);
      const key = agentRpcSourceKey(target);
      if (targets.has(key)) throw new Error("duplicate broadcast target");
      targets.add(key);
    }
    if (
      typeof value.body !== "string" ||
      !value.body.trim() ||
      new TextEncoder().encode(value.body).length > 32768
    )
      throw new Error("broadcast body must contain 1 to 32768 UTF-8 bytes");
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
    value.version !== 3 ||
    value.attempt_id !== request.attempt_id ||
    value.agent_network_id !== request.agent_network_id ||
    agentRpcSourceKey(value.target) !== agentRpcSourceKey(request.target) ||
    !Number.isFinite(value.expires_at)
  )
    throw new Error(
      "Attachment preparation acknowledgment is invalid or mismatched",
    );
}

export function rpcOutcome(
  attempt: AgentRpcAttempt,
  outcome: AgentRpcOutcome["outcome"],
  extra: Partial<
    Pick<AgentRpcOutcome, "reason" | "code" | "chat_effect" | "operation">
  > = {},
): AgentRpcOutcome {
  return {
    version: 3,
    target: attempt.target,
    agent_network_id: attempt.agent_network_id,
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
    value?.version !== 3 ||
    value.attempt_id !== attempt.attempt_id ||
    value.agent_network_id !== attempt.agent_network_id ||
    agentRpcSourceKey(value.target) !== agentRpcSourceKey(attempt.target) ||
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

export function validateAgentRpcBroadcastOutcome(
  value: AgentRpcBroadcastOutcome,
  request: AgentRpcBroadcast,
): void {
  if (
    value?.version !== 3 ||
    value.broadcast_id !== request.broadcast_id ||
    value.agent_network_id !== request.agent_network_id ||
    !["accepted", "rejected", "unknown"].includes(value.outcome) ||
    !Number.isFinite(value.observed_at) ||
    !Array.isArray(value.children) ||
    value.children.length > request.targets.length
  )
    throw new Error("Broadcast acknowledgment is invalid or mismatched");
  for (const child of value.children) {
    const target = request.targets.find(
      (candidate) =>
        agentRpcSourceKey(candidate) === agentRpcSourceKey(child.target),
    );
    if (!target || child.agent_network_id !== request.agent_network_id)
      throw new Error("Broadcast child acknowledgment is mismatched");
  }
}

/** Trusted owner-to-host envelope, not an agent-supplied authority claim. */
export interface AgentRpcEnvelope extends Omit<AgentRpcSend, "target"> {
  target: AgentEndpoint;
  permit_id: string;
  source: AgentRpcSource;
  source_label: string;
  target_label: string;
  network_title: string;
  run_id?: string;
  account_id: string;
  network_generation: string;
  account_generation: number;
  configured_delivery: import("./personal").AgentNetworkDeliveryMode;
  guidance: boolean;
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
    e.source_label,
    e.target.project_id,
    e.target.agent_id,
    e.target_label,
    e.run_id,
    e.agent_network_id,
    e.network_title,
    e.network_generation,
    e.account_generation,
    e.configured_delivery,
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
