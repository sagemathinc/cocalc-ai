import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type { AgentRpcControlApi } from "@cocalc/conat/inter-bay/agent-rpc";
import { createAgentRpcControlClient } from "@cocalc/conat/inter-bay/agent-rpc";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOrigin } from "@cocalc/server/bay-public-origin";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { claimExternalAgentLoginChallenge } from "@cocalc/server/auth/cli-auth";
import { ExternalAgentStore } from "./external-store";
import { agentStore } from "./store";
import { getIdentity } from "./api";
import {
  validateExternalAgentSource,
  type ExternalAgentSource,
} from "@cocalc/conat/agents/external";

export function assertExternalAgentLoginEnabled() {
  for (const flag of [
    "COCALC_AGENT_MESSAGING_ENABLED",
    "COCALC_AGENT_MESSAGING_RPC_ENABLED",
    "COCALC_AGENT_PERSONAL_MESSAGING_ENABLED",
    "COCALC_AGENT_EXTERNAL_LOGIN_ENABLED",
  ])
    if (process.env[flag] !== "1")
      throw new Error("external agent login is not enabled");
}

export function externalStore(db = agentStore()) {
  return new ExternalAgentStore(db, async (account_id, target) => {
    const identity = await getIdentity({ account_id, ...target });
    if (identity.disabled_at) throw new Error("agent_unavailable");
  });
}

async function home(account_id: string) {
  requireUuid(account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw new Error("account home unavailable");
  return home_bay_id;
}

function control(bay_id: string): Pick<AgentRpcControlApi, "external"> {
  return bay_id === getConfiguredBayId()
    ? { external: externalControl }
    : createAgentRpcControlClient(getInterBayFabricClient(), bay_id);
}

/** Sealed inter-bay API. A public caller cannot supply its own fresh attestation. */
export const externalControl: AgentRpcControlApi["external"] = async (opts) => {
  assertExternalAgentLoginEnabled();
  const home_bay_id = await home(opts.account_id);
  if (home_bay_id !== opts.home_bay_id)
    throw new Error("stale external account home");
  if (opts.action === "check-send") {
    if (home_bay_id !== getConfiguredBayId())
      throw new Error("external send requires account home");
    validateExternalAgentSource(opts.source);
    if (opts.source.account_id !== opts.account_id)
      throw new Error("external principal mismatch");
    const proof = await externalStore().check(
      opts.account_id,
      opts.source.installation_id,
      opts.target,
    );
    if (proof.source.agent_id !== opts.source.agent_id)
      throw new Error("external identity mismatch");
    return { proof };
  }
  if (opts.action === "claim-enrollment") {
    if (
      !Number.isFinite(opts.fresh_auth_at) ||
      Date.now() - opts.fresh_auth_at > 30_000 ||
      opts.fresh_auth_at > Date.now() + 5000
    )
      throw new Error("fresh external enrollment attestation required");
    return {
      challenge: await claimExternalAgentLoginChallenge(
        opts.challenge_id,
        opts.account_id,
      ),
    };
  }
  if (opts.action === "enrollment-status") {
    if (home_bay_id !== getConfiguredBayId())
      throw new Error("external enrollment requires account home");
    return {
      installation: await externalStore().enrollmentStatus(
        opts.account_id,
        opts.installation_id,
        opts.secret_hash,
      ),
    };
  }
  throw new Error("unsupported external agent control operation");
};

export async function checkExternalAgentSend(
  source: ExternalAgentSource,
  target: AgentEndpoint,
) {
  assertExternalAgentLoginEnabled();
  validateExternalAgentSource(source);
  const home_bay_id = await home(source.account_id);
  const result = await control(home_bay_id).external({
    action: "check-send",
    account_id: source.account_id,
    home_bay_id,
    source,
    target,
  });
  if (!("proof" in result))
    throw new Error("invalid external authorization response");
  return result.proof;
}

export async function approveExternalAgentLogin(opts: {
  account_id: string;
  session_hash: string;
  origin_bay_id: string;
  challenge_id: string;
  targets: AgentEndpoint[];
  ttl_seconds: number;
  agent_id?: string;
}) {
  assertExternalAgentLoginEnabled();
  const home_bay_id = await home(opts.account_id);
  if (home_bay_id !== getConfiguredBayId())
    throw new Error("approve external login at your account home");
  requireUuid(opts.challenge_id, "challenge_id");
  await requireDangerousSessionAuth({
    account_id: opts.account_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  const result = await control(opts.origin_bay_id).external({
    action: "claim-enrollment",
    account_id: opts.account_id,
    home_bay_id,
    challenge_id: opts.challenge_id,
    fresh_auth_at: Date.now(),
  });
  if (!("challenge" in result))
    throw new Error("invalid external enrollment response");
  const { label, secret_hash, expires_at } = result.challenge;
  if (new Date(expires_at).getTime() <= Date.now())
    throw new Error("external login challenge expired");
  const installation = await externalStore().enroll(
    opts.account_id,
    opts.session_hash,
    {
      installation_id: opts.challenge_id,
      secret_hash,
      label,
      targets: opts.targets,
      ttl_seconds: opts.ttl_seconds,
      ...(opts.agent_id ? { agent_id: opts.agent_id } : {}),
    },
    new Date(expires_at).getTime(),
  );
  return { installation };
}

export async function externalEnrollmentStatus(
  account_id: string,
  installation_id: string,
  secret_hash: string,
) {
  assertExternalAgentLoginEnabled();
  const home_bay_id = await home(account_id);
  const result = await control(home_bay_id).external({
    action: "enrollment-status",
    account_id,
    home_bay_id,
    installation_id,
    secret_hash,
  });
  if (!("installation" in result))
    throw new Error("invalid external enrollment status");
  return {
    installation: result.installation,
    api_url: await getBayPublicOrigin(home_bay_id),
  };
}
