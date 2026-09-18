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
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { AgentStore, agentStore } from "./store";
import { isRestrictiveAgentManagement } from "./management";
import { getIdentity } from "./api";
import { agentRpcControl } from "./rpc";
import { PersonalAgentStore } from "./personal-store";
import { assertPersonalAccountAuthority } from "./personal-rehome";

const DEFAULT_MAX_NAMED_AGENTS = 5;
const DEFAULT_MAX_SESSION_MEMBERS = 3;
const MAX_SESSIONS = 100;

export async function personalAgentLimits(account_id: string) {
  const membership = await resolveMembershipForAccount(account_id);
  return {
    named:
      membership.effective_limits?.max_named_agents ?? DEFAULT_MAX_NAMED_AGENTS,
    members:
      membership.effective_limits?.max_agent_session_members ??
      DEFAULT_MAX_SESSION_MEMBERS,
  };
}

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
    if (opts.request.action === "checkSession")
      return { denied: "account_disabled" };
    else throw new PersonalAgentAuthorizationError("account_disabled");

  const request = opts.request;
  const store = personalStore(
    isRestrictiveAgentManagement(request) ? new AgentStore() : agentStore(),
  );
  const account = opts.account_id;
  await store.assertHome(account);
  switch (request.action) {
    case "listNamedAgents": {
      const agents = await store.names(account);
      return {
        enabled: true,
        agents,
        usage: {
          active: agents.length,
          limit: (await personalAgentLimits(account)).named,
        },
        controls: await store.controls(account),
      };
    }
    case "nameAgent":
      return store.name(
        account,
        request.options,
        (await personalAgentLimits(account)).named,
      );
    case "retireNamedAgent":
      return store.retire(account, request.options);
    case "listAgentSessions": {
      const result = await store.sessions(
        account,
        request.options.limit,
        request.options.cursor,
      );
      return {
        enabled: true,
        ...result,
        usage: {
          active_sessions: result.active_count,
          session_limit: MAX_SESSIONS,
          member_limit: (await personalAgentLimits(account)).members,
        },
        controls: await store.controls(account),
      };
    }
    case "createAgentSession":
      return store.createSession(
        account,
        request.options,
        (await personalAgentLimits(account)).members,
        opts.fresh_auth_at !== undefined && (fresh(opts.fresh_auth_at), true),
      );
    case "updateAgentSession":
      return store.updateSession(
        account,
        request.options as import("@cocalc/conat/agents/personal").UpdateAgentSessionOptions,
        (await personalAgentLimits(account)).members,
        opts.fresh_auth_at !== undefined && (fresh(opts.fresh_auth_at), true),
      );
    case "listAgentSessionActivity":
      return store.activity(
        account,
        request.options.agent_session_id,
        request.options.limit,
      );
    case "inspectAgentSessionAttempt":
      return store.inspectActivity(
        account,
        request.options.agent_session_id,
        request.options.attempt_id,
      );
    case "listAgentSessionProposals":
      return store.proposals(account, request.options.limit);
    case "resolveAgentSessionProposal": {
      const proposal = await store.getProposal(
        account,
        request.options.proposal_id,
      );
      if (request.options.action === "reject")
        return store.finishProposal(account, proposal.proposal_id, "rejected");
      const session = await store.createSession(
        account,
        {
          request_id: request.options.request_id,
          title: proposal.title ?? undefined,
          delivery_mode: proposal.delivery_mode,
          members: proposal.members,
        },
        (await personalAgentLimits(account)).members,
        opts.fresh_auth_at !== undefined && (fresh(opts.fresh_auth_at), true),
      );
      return store.finishProposal(
        account,
        proposal.proposal_id,
        "approved",
        session.agent_session_id,
      );
    }
    case "setPersonalMessagingState":
      if (request.options.action === "resume") fresh(opts.fresh_auth_at);
      return store.setControls(account, request.options);
    case "checkSession":
      try {
        return await store.checkSession(
          account,
          request.options.agent_session_id,
          request.options.source,
          request.options.run_id,
          request.options.target,
        );
      } catch (error) {
        if (error instanceof PersonalAgentAuthorizationError)
          return { denied: error.denial };
        throw error;
      }
    case "discoverSessions":
      return store.discover(
        account,
        request.options.source,
        request.options.run_id,
      );
    case "proposeSession":
      return store.proposeSession(
        account,
        request.options.source,
        request.options.run_id,
        request.options.proposal,
        (await personalAgentLimits(account)).members,
      );
    case "beginBroadcast":
      return store.beginBroadcast(
        account,
        request.options.source,
        request.options.run_id,
        request.options.broadcast,
      );
    case "finishBroadcast":
      return store.finishBroadcast(
        account,
        request.options.broadcast_id,
        request.options.binding_hash,
        request.options.outcome,
      );
    case "observeSessionActivity":
      return store.observeActivity(account, request.options);
    default:
      throw new Error("unsupported personal agent operation");
  }
};

async function freshHuman(account_id: string, session_hash: string) {
  await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  return Date.now();
}

async function human<K extends PersonalHumanMethod>(
  action: K,
  opts: Parameters<AgentApi[K]>[0],
): Promise<Awaited<ReturnType<AgentApi[K]>>> {
  requireUuid(opts.account_id, "account_id");
  const { account_id, session_hash, ...options } = opts as AgentHumanAuth &
    Record<string, unknown>;
  const request = { action, options } as PersonalControlRequest;
  enabled(request);
  let fresh_auth_at: number | undefined;
  if (
    action === "setPersonalMessagingState" &&
    (options as any).action === "resume"
  )
    fresh_auth_at = await freshHuman(account_id!, session_hash!);
  try {
    return (await withPersonalHome(
      account_id!,
      request,
      fresh_auth_at,
    )) as Awaited<ReturnType<AgentApi[K]>>;
  } catch (error) {
    if (
      ![
        "createAgentSession",
        "updateAgentSession",
        "resolveAgentSessionProposal",
      ].includes(action) ||
      !`${error}`.includes("fresh_auth_required")
    )
      throw error;
    fresh_auth_at = await freshHuman(account_id!, session_hash!);
    return (await withPersonalHome(
      account_id!,
      request,
      fresh_auth_at,
    )) as Awaited<ReturnType<AgentApi[K]>>;
  }
}

export const listNamedAgents: AgentApi["listNamedAgents"] = (opts) =>
  human("listNamedAgents", opts);
export const nameAgent: AgentApi["nameAgent"] = (opts) =>
  human("nameAgent", opts);
export const retireNamedAgent: AgentApi["retireNamedAgent"] = (opts) =>
  human("retireNamedAgent", opts);
export const listAgentSessions: AgentApi["listAgentSessions"] = (opts) =>
  human("listAgentSessions", opts);
export const createAgentSession: AgentApi["createAgentSession"] = (opts) =>
  human("createAgentSession", opts);
export const updateAgentSession: AgentApi["updateAgentSession"] = (opts) =>
  human("updateAgentSession", opts);
export const listAgentSessionActivity: AgentApi["listAgentSessionActivity"] = (
  opts,
) => human("listAgentSessionActivity", opts);
export const inspectAgentSessionAttempt: AgentApi["inspectAgentSessionAttempt"] =
  (opts) => human("inspectAgentSessionAttempt", opts);
export const listAgentSessionProposals: AgentApi["listAgentSessionProposals"] =
  (opts) => human("listAgentSessionProposals", opts);
export const resolveAgentSessionProposal: AgentApi["resolveAgentSessionProposal"] =
  (opts) => human("resolveAgentSessionProposal", opts);
export const setPersonalMessagingState: AgentApi["setPersonalMessagingState"] =
  (opts) => human("setPersonalMessagingState", opts);
