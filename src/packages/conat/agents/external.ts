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
    };
export type ExternalAgentControlResult =
  | { message: ExternalAgentInboxMessage }
  | {
      challenge: { label: string; secret_hash: string; expires_at: string };
    }
  | { installation: ExternalAgentInstallation | null };

/** Authorized, bounded inbox delivery over the sealed inter-bay control API. */
export interface ExternalAgentEnqueueOptions {
  account_id: string;
  installation_id: string;
  attempt_id: string;
  agent_network_id: string;
  network_generation: string;
  source: import("./rpc").AgentRpcSource;
  body: string;
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
