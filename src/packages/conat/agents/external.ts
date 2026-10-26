import type { AgentSnapshot, AgentSnapshotMetadata } from "./attachments";
import { requireUuid } from "./protocol";

export const EXTERNAL_AGENT_TOKEN_PREFIX = "cocalc_external_agent_v1.";
export const EXTERNAL_AGENT_MAX_LIFETIME_SECONDS = 30 * 86400;

/** External identities have no project locator and use a bounded network inbox. */
export interface ExternalAgentSource {
  kind: "external";
  project_id?: never;
  account_id: string;
  agent_id: string;
  installation_id: string;
}

export function validateExternalAgentSource(source: ExternalAgentSource): void {
  if (
    source?.kind !== "external" ||
    Object.keys(source).some(
      (key) =>
        !["kind", "account_id", "agent_id", "installation_id"].includes(key),
    )
  )
    throw new Error("invalid external agent source");
  for (const key of ["account_id", "agent_id", "installation_id"] as const)
    requireUuid(source[key], key);
}

export interface ExternalAgentInstallation {
  installation_id: string;
  account_id: string;
  agent_id: string;
  label: string;
  state: "active" | "revoked";
  expires_at: string;
  created_at: string;
  agent_network_id: string;
}

export interface ExternalAgentInboxMessage {
  message_id: string;
  attempt_id: string;
  agent_network_id: string;
  source: import("./rpc").AgentRpcSource;
  body: string;
  created_at: string;
  expires_at: string;
  /** Listed with include_acknowledged only: whether it was acknowledged. */
  state?: "pending" | "acknowledged";
  acknowledged_at?: string;
  /** The files sent with it, in order; fetch each with inbox-attachment. */
  attachments?: AgentSnapshotMetadata[];
}

/** One attachment of an inbox message, with its content. */
export interface ExternalAgentInboxAttachment extends AgentSnapshot {
  message_id: string;
  index: number;
  /** How many attachments the message has. */
  count: number;
}

/** What became of a message sent to an external inbox (for its sender). */
export interface ExternalAgentDelivery {
  /** pending: not acknowledged (read) yet; acknowledged: the agent read it. */
  state: "pending" | "acknowledged";
  created_at: string;
  expires_at: string;
  acknowledged_at?: string;
}

export type ExternalAgentControlRequest =
  | ({ action: "enqueue"; home_bay_id: string } & ExternalAgentEnqueueOptions)
  | {
      action: "claim-enrollment";
      account_id: string;
      home_bay_id: string;
      challenge_id: string;
      fresh_auth_at: number;
    }
  | {
      action: "enrollment-status";
      account_id: string;
      home_bay_id: string;
      installation_id: string;
      secret_hash: string;
    }
  | {
      /** The sender asks what became of its message. */
      action: "inspect";
      account_id: string;
      home_bay_id: string;
      installation_id: string;
      attempt_id: string;
      /** The network the message was sent in (proved by the caller's bay). */
      agent_network_id: string;
      source: import("./rpc").AgentRpcSource;
      /** The sender's authenticated account (with source, who sent it). */
      source_account_id: string;
    }
  | ({
      /** Admit files before their bytes: see ExternalAgentReservationOptions. */
      action: "reserve-attachments";
      home_bay_id: string;
    } & ExternalAgentReservationOptions)
  | {
      /** The sender gives up a reservation it holds (cancel-attachments). */
      action: "release-attachments";
      account_id: string;
      home_bay_id: string;
      installation_id: string;
      attempt_id: string;
      reservation_id: string;
      source: import("./rpc").AgentRpcSource;
      source_account_id: string;
    };
export type ExternalAgentControlResult =
  | { message: ExternalAgentInboxMessage }
  | {
      challenge: { label: string; secret_hash: string; expires_at: string };
    }
  | { installation: ExternalAgentInstallation | null }
  | { delivery: ExternalAgentDelivery | null }
  | { reservation: ExternalAgentReservation }
  | { released: boolean };

/**
 * A reservation of an inbox's room for one attempt's files, made at the
 * account's home before any bytes move (prepare-attachments), bound to the
 * sender, target, network generation, attempt and manifest. The send that
 * carries the files must name it; storing the message consumes it.
 */
export interface ExternalAgentReservationOptions {
  account_id: string;
  installation_id: string;
  attempt_id: string;
  agent_network_id: string;
  network_generation: string;
  source: import("./rpc").AgentRpcSource;
  source_account_id: string;
  manifest: AgentSnapshotMetadata[];
}

export interface ExternalAgentReservation {
  reservation_id: string;
  /** ms since the epoch */
  expires_at: number;
}

/** Authorized, bounded inbox delivery over the sealed inter-bay control API. */
export interface ExternalAgentEnqueueOptions {
  account_id: string;
  installation_id: string;
  attempt_id: string;
  agent_network_id: string;
  network_generation: string;
  source: import("./rpc").AgentRpcSource;
  /** The sender's authenticated account: only it may later inspect. Absent
   * from a bay that predates it: the message is delivered, but can never be
   * inspected. */
  source_account_id?: string;
  body: string;
  /** Files sent with it (at most 16 and 32 MiB, as to any network member). */
  attachments?: AgentSnapshot[];
  /** Required with attachments: the reservation made for them. */
  reservation_id?: string;
}

export function externalAgentSubject(
  account_id: string,
  installation_id: string,
): string {
  requireUuid(account_id, "account_id");
  requireUuid(installation_id, "installation_id");
  return `agent-external.${account_id}.${installation_id}`;
}

export function externalAgentInbox(
  account_id: string,
  installation_id: string,
): string {
  externalAgentSubject(account_id, installation_id);
  return `_INBOX.agent-external.${account_id}.${installation_id}`;
}

export function parseExternalAgentSubject(subject: string) {
  const [prefix, account_id, installation_id, extra] = subject.split(".");
  if (prefix !== "agent-external" || extra !== undefined)
    throw new Error("invalid external subject");
  externalAgentSubject(account_id, installation_id);
  return { account_id, installation_id };
}

export function allowsExternalAgentSubject(
  account_id: string,
  installation_id: string,
  subject: string,
  type: "pub" | "sub",
) {
  return type === "pub"
    ? subject === externalAgentSubject(account_id, installation_id)
    : subject.startsWith(`${externalAgentInbox(account_id, installation_id)}.`);
}

/** Parsing provides a routing hint, not authentication. */
export function parseExternalAgentToken(token: string) {
  if (
    typeof token !== "string" ||
    !token.startsWith(EXTERNAL_AGENT_TOKEN_PREFIX)
  )
    throw new Error("invalid external agent credential");
  const [account_id, installation_id, secret, extra] = token
    .slice(EXTERNAL_AGENT_TOKEN_PREFIX.length)
    .split(".");
  requireUuid(account_id, "external account_id");
  requireUuid(installation_id, "external installation_id");
  if (extra !== undefined || !/^[a-f0-9]{64}$/.test(secret ?? ""))
    throw new Error("invalid external agent credential");
  return { account_id, installation_id, secret };
}

export function validateExternalAgentLabel(label: string): void {
  if (
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 80 ||
    /[\x00-\x1f\x7f]/.test(label)
  )
    throw new Error(
      "external agent label must contain 1 to 80 printable characters",
    );
}

/**
 * The @name peers use for an external agent: its label's leading name, in
 * the form registered agent names take ("ops0 on alpha.cocalc.ai (ops
 * project)" is @ops0). Labels are free text, so it may not be unique, and a
 * label without such a name has none.
 */
export function externalAgentHandle(label: string): string | undefined {
  const lead = `${label ?? ""}`.trim().split(/\s|\(/)[0] ?? "";
  const handle = lead
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(handle)
    ? handle
    : undefined;
}

export function validateExternalAgentApproval(options: {
  installation_id: string;
  agent_id?: string;
  agent_network_id: string;
  ttl_seconds: number;
}): void {
  if (
    Object.keys(options).some(
      (key) =>
        ![
          "installation_id",
          "agent_id",
          "agent_network_id",
          "ttl_seconds",
          "label",
          "secret_hash",
        ].includes(key),
    )
  )
    throw new Error("unexpected external approval field");
  requireUuid(options.installation_id, "installation_id");
  requireUuid(options.agent_network_id, "agent_network_id");
  if (options.agent_id !== undefined) requireUuid(options.agent_id, "agent_id");
  if (
    !Number.isInteger(options.ttl_seconds) ||
    options.ttl_seconds < 1 ||
    options.ttl_seconds > EXTERNAL_AGENT_MAX_LIFETIME_SECONDS
  )
    throw new Error("external credentials require an expiry within 30 days");
}
