import type { AgentApi, AgentHumanAuth } from "@cocalc/conat/hub/api/agent";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { PersonalAgentAuthorizationError } from "@cocalc/conat/agents/personal";
import type {
  AgentRpcControlApi,
  PersonalControlRequest,
  PersonalHumanMethod,
} from "@cocalc/conat/inter-bay/agent-rpc";
import { createAgentRpcControlClient } from "@cocalc/conat/inter-bay/agent-rpc";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { AgentStore, agentStore } from "./store";
import { isRestrictiveAgentManagement } from "./management";
import { getIdentity } from "./api";
import { agentRpcControl } from "./rpc";
import { PersonalAgentStore } from "./personal-store";
import { assertPersonalAccountAuthority } from "./personal-rehome";

export const personalMessagingEnabled = () => true;
function enabled(request: PersonalControlRequest) {
  if (isRestrictiveAgentManagement(request)) return;
}
function fresh(at?: number) {
  if (
    at === undefined ||
    !Number.isFinite(at) ||
    Date.now() - at > 30_000 ||
    at > Date.now() + 5000
  )
    throw new Error("fresh human approval attestation expired");
}
function requiresFresh(request: PersonalControlRequest): boolean {
  switch (request.action) {
    case "grantPersonalConnection":
      return true;
    case "setPersonalConnectionState":
      return request.options.state === "active";
    case "setPersonalMessagingState":
      return request.options.action === "resume";
    case "resolvePersonalConnectionRequest":
      return request.options.decision === "approve";
    default:
      return false;
  }
}
async function principal(source: AgentEndpoint, run_id: string) {
  const route = await resolveProjectBay(source.project_id);
  if (!route) throw new Error("source owner unavailable");
  const api =
    route.bay_id === getConfiguredBayId()
      ? agentRpcControl
      : createAgentRpcControlClient(getInterBayFabricClient(), route.bay_id);
  const proof = await api.principal({
    source,
    run_id,
    project_id: source.project_id,
    route: { bay_id: route.bay_id, epoch: route.epoch },
  });
  if (!proof.personal_messaging)
    throw new Error("personal source mode changed");
  return proof.account_id;
}
export function personalStore(db = agentStore()) {
  return new PersonalAgentStore(
    db,
    (account_id, endpoint) => getIdentity({ account_id, ...endpoint }),
    principal,
    assertPersonalAccountAuthority,
  );
}

export async function withPersonalHome(
  account_id: string,
  request: PersonalControlRequest,
  fresh_auth_at?: number,
) {
  enabled(request);
  requireUuid(account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw new Error("account home unavailable");
  const api =
    home_bay_id === getConfiguredBayId()
      ? agentRpcControl
      : createAgentRpcControlClient(getInterBayFabricClient(), home_bay_id);
  return api.personal({ account_id, home_bay_id, request, fresh_auth_at });
}

export const personalControl: AgentRpcControlApi["personal"] = async (opts) => {
  enabled(opts.request);
  requireUuid(opts.account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: opts.account_id,
  });
  if (home_bay_id !== getConfiguredBayId() || opts.home_bay_id !== home_bay_id)
    throw new Error("stale personal account home route");
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(opts.account_id))
    if (opts.request.action === "check") return { denied: "account_disabled" };
    else throw new PersonalAgentAuthorizationError("account_disabled");
  const request = opts.request;
  if (requiresFresh(request)) fresh(opts.fresh_auth_at);
  const store = personalStore(
      isRestrictiveAgentManagement(request) ? new AgentStore() : agentStore(),
    ),
    account = opts.account_id;
  // Reads reject stale routing too; writes/checks recheck under their own
  // transaction fence after any remote endpoint validation has completed.
  await store.assertHome(account);
  switch (request.action) {
    case "listNamedAgents":
      return {
        enabled: true,
        agents: await store.names(account),
        controls: await store.controls(account),
      };
    case "nameAgent":
      return store.name(account, request.options);
    case "listPersonalConnections":
      return {
        enabled: true,
        connections: await store.connections(account),
        controls: await store.controls(account),
      };
    case "grantPersonalConnection":
      return store.grant(account, request.options);
    case "setPersonalConnectionState":
      return store.setConnection(account, request.options);
    case "setPersonalMessagingState":
      return store.setControls(account, request.options);
    case "links":
      return store.links(account, request.options.source);
    case "check":
      try {
        return await store.check(
          account,
          request.options.source,
          request.options.target,
          request.options.guidance,
        );
      } catch (error) {
        if (error instanceof PersonalAgentAuthorizationError)
          return { denied: error.denial };
        throw error;
      }
    case "request":
      return store.request(account, request.options);
    case "requestRead":
      return store.readRequest(
        account,
        request.options.request_id,
        request.options,
      );
    case "observe":
      return store.observe(
        account,
        request.options.link_id,
        request.options.accepted,
      );
    case "listPersonalConnectionRequests":
      return {
        enabled: true,
        requests: await store.requests(account),
      };
    case "resolvePersonalConnectionRequest":
      return store.resolveRequest(
        account,
        request.options.request_id,
        request.options.decision,
      );
    default:
      throw new Error("unsupported personal agent operation");
  }
};

async function human<K extends PersonalHumanMethod>(
  action: K,
  opts: Parameters<AgentApi[K]>[0],
): Promise<Awaited<ReturnType<AgentApi[K]>>> {
  requireUuid(opts.account_id, "account_id");
  const { account_id, session_hash } = opts as AgentHumanAuth;
  const fields: Record<PersonalHumanMethod, string[]> = {
    listNamedAgents: [],
    listPersonalConnections: [],
    listPersonalConnectionRequests: [],
    nameAgent: [
      "endpoint",
      "name",
      "description",
      "project_title",
      "thread_title",
    ],
    grantPersonalConnection: [
      "source",
      "target",
      "approval_request_id",
      "ttl_seconds",
      "both_directions",
      "allow_guidance",
      "reason",
    ],
    setPersonalConnectionState: ["direction_group_id", "state"],
    setPersonalMessagingState: ["action"],
    resolvePersonalConnectionRequest: ["request_id", "decision"],
  };
  const options = Object.fromEntries(
    fields[action]
      .filter((key) => opts[key] !== undefined)
      .map((key) => [key, opts[key]]),
  );
  const request = { action, options } as PersonalControlRequest;
  enabled(request);
  let fresh_auth_at: number | undefined;
  if (requiresFresh(request)) {
    await requireDangerousSessionAuth({
      account_id,
      session_hash,
      require_second_factor: "if_enabled",
      allow_actor_impersonation: false,
    });
    fresh_auth_at = Date.now();
  }
  return (await withPersonalHome(
    account_id!,
    request,
    fresh_auth_at,
  )) as Awaited<ReturnType<AgentApi[K]>>;
}
export const listNamedAgents: AgentApi["listNamedAgents"] = (opts) =>
  human("listNamedAgents", opts);
export const nameAgent: AgentApi["nameAgent"] = (opts) =>
  human("nameAgent", opts);
export const listPersonalConnections: AgentApi["listPersonalConnections"] = (
  opts,
) => human("listPersonalConnections", opts);
export const grantPersonalConnection: AgentApi["grantPersonalConnection"] = (
  opts,
) => human("grantPersonalConnection", opts);
export const setPersonalConnectionState: AgentApi["setPersonalConnectionState"] =
  (opts) => human("setPersonalConnectionState", opts);
export const setPersonalMessagingState: AgentApi["setPersonalMessagingState"] =
  (opts) => human("setPersonalMessagingState", opts);
export const listPersonalConnectionRequests: AgentApi["listPersonalConnectionRequests"] =
  (opts) => human("listPersonalConnectionRequests", opts);
export const resolvePersonalConnectionRequest: AgentApi["resolvePersonalConnectionRequest"] =
  (opts) => human("resolvePersonalConnectionRequest", opts);
