import { requireUuid } from "./protocol";
import { validateAgentEndpoint, type AgentEndpoint } from "./rpc";

export const EXTERNAL_AGENT_TOKEN_PREFIX = "cocalc_external_agent_v1.";
export const EXTERNAL_AGENT_MAX_LIFETIME_SECONDS = 30 * 86400;
export const EXTERNAL_AGENT_MAX_DESTINATIONS = 32;

/** External identities have no project locator and cannot receive messages. */
export interface ExternalAgentSource {
  kind: "external";
  account_id: string;
  agent_id: string;
  installation_id: string;
}

export interface ExternalAgentDestination {
  link_id: string;
  target: AgentEndpoint;
}

export interface ExternalAgentInstallation {
  installation_id: string;
  account_id: string;
  agent_id: string;
  label: string;
  state: "active" | "revoked";
  expires_at: string;
  created_at: string;
  destinations: ExternalAgentDestination[];
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
  targets: AgentEndpoint[];
  ttl_seconds: number;
}): void {
  if (
    Object.keys(options).some(
      (key) =>
        ![
          "installation_id",
          "agent_id",
          "targets",
          "ttl_seconds",
          "label",
          "secret_hash",
        ].includes(key),
    )
  )
    throw new Error("unexpected external approval field");
  requireUuid(options.installation_id, "installation_id");
  if (options.agent_id !== undefined) requireUuid(options.agent_id, "agent_id");
  if (
    !Number.isInteger(options.ttl_seconds) ||
    options.ttl_seconds < 1 ||
    options.ttl_seconds > EXTERNAL_AGENT_MAX_LIFETIME_SECONDS
  )
    throw new Error("external credentials require an expiry within 30 days");
  if (
    !Array.isArray(options.targets) ||
    options.targets.length < 1 ||
    options.targets.length > EXTERNAL_AGENT_MAX_DESTINATIONS
  )
    throw new Error("approve between 1 and 32 explicit destinations");
  const seen = new Set<string>();
  for (const target of options.targets) {
    validateAgentEndpoint(target);
    const key = `${target.project_id}/${target.agent_id}`;
    if (seen.has(key)) throw new Error("duplicate external agent destination");
    seen.add(key);
  }
}
