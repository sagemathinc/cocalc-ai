import { randomUUID } from "node:crypto";
import type { AgentApi, AgentHumanAuth } from "@cocalc/conat/hub/api/agent";
import { requireUuid, validateAgentPage } from "@cocalc/conat/agents/protocol";
import type { AgentGrant } from "@cocalc/conat/hub/api/agent";
import { agentPage, ownMessageReceipts } from "./inspection";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { agentStore, agentMessagingEnabled, normalizeAgentPath } from "./store";
import { assertLocalAgentProject, assertActor, assertAgent } from "./access";
import { withAgentChat } from "./chat";
import { withAgentIdentityOwner } from "./identity-routing";

async function human(opts: AgentHumanAuth): Promise<string> {
  requireUuid(opts.account_id, "account_id");
  // No caller-supplied browser identifier as a substitute for the bound session.
  await requireDangerousSessionAuth({
    account_id: opts.account_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  return opts.account_id;
}

export const registerIdentity: AgentApi["registerIdentity"] = async (opts) => {
  const account_id = await human(opts);
  const request = {
    account_id,
    project_id: opts.project_id,
    path: opts.path,
    thread_id: opts.thread_id,
  };
  const fresh_auth_at = Date.now();
  return await withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => registerIdentityLocal(request),
    remote: (api, route) => api.register({ ...request, route, fresh_auth_at }),
  });
};

// Internal implementation; callers must establish fresh human auth first.
export const registerIdentityLocal: AgentApi["registerIdentity"] = async (
  opts,
) => {
  const db = agentStore();
  requireUuid(opts.account_id, "account_id");
  const account_id = opts.account_id;
  requireUuid(opts.project_id, "project_id");
  if (
    typeof opts.thread_id !== "string" ||
    !opts.thread_id ||
    opts.thread_id.length > 200
  )
    throw new Error("invalid thread_id");
  const path = normalizeAgentPath(opts.path);
  await assertActor(account_id, opts.project_id);
  return await withAgentChat(
    {
      project_id: opts.project_id,
      path,
      thread_id: opts.thread_id,
      created_by: account_id,
    },
    async (_db, thread) => {
      const { rows } = await db.query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,path,thread_id) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          opts.project_id,
          path,
          opts.thread_id,
          thread.name || opts.thread_id,
          account_id,
        ],
      );
      return rows[0] ?? (await db.find(opts.project_id, path, opts.thread_id)!);
    },
  );
};

export const listIdentities: AgentApi["listIdentities"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  const request = { account_id: opts.account_id, project_id: opts.project_id };
  return await withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => listIdentitiesLocal(request),
    remote: (api, route) => api.list({ ...request, route }),
  });
};

export const listIdentitiesLocal: AgentApi["listIdentities"] = async (opts) => {
  const db = agentStore();
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  await assertActor(opts.account_id, opts.project_id);
  return (
    await db.query(
      "SELECT * FROM agent_identities WHERE project_id=$1 ORDER BY created_at",
      [opts.project_id],
    )
  ).rows;
};

export const getIdentity: AgentApi["getIdentity"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.agent_id, "agent_id");
  if (opts.project_id === undefined) return getIdentityLocal(opts);
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    agent_id: opts.agent_id,
  };
  return withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => getIdentityLocal(request),
    remote: (api, route) => api.get({ ...request, route }),
  });
};

export const getIdentityLocal: AgentApi["getIdentity"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.agent_id, "agent_id");
  const agent = await agentStore().get(opts.agent_id);
  if (opts.project_id !== undefined && opts.project_id !== agent.project_id)
    throw new Error("agent identity does not belong to the requested project");
  await assertActor(opts.account_id, agent.project_id);
  return agent;
};

export const resolveIdentity: AgentApi["resolveIdentity"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    path: opts.path,
    thread_id: opts.thread_id,
  };
  return await withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => resolveIdentityLocal(request),
    remote: (api, route) => api.resolve({ ...request, route }),
  });
};

export const resolveIdentityLocal: AgentApi["resolveIdentity"] = async (
  opts,
) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  if (
    typeof opts.thread_id !== "string" ||
    !opts.thread_id ||
    opts.thread_id.length > 200
  )
    throw new Error("invalid thread_id");
  await assertActor(opts.account_id, opts.project_id);
  return agentStore().find(opts.project_id, opts.path, opts.thread_id);
};

export const listGrants: AgentApi["listGrants"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.agent_id, "agent_id");
  validateAgentPage(opts);
  if (opts.project_id === undefined) return listGrantsLocal(opts);
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    agent_id: opts.agent_id,
    limit: opts.limit,
    cursor: opts.cursor,
  };
  return withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => listGrantsLocal(request),
    remote: (api, route) => api.listGrants({ ...request, route }),
  });
};

export const listGrantsLocal: AgentApi["listGrants"] = async (opts) => {
  const limit = validateAgentPage(opts);
  const agent = await getIdentityLocal(opts);
  if (agent.created_by !== opts.account_id)
    throw new Error("only the endpoint registrant may inspect its links");
  const { rows } = await agentStore().query<AgentGrant>(
    `SELECT grant_id,source_agent_id,target_agent_id,allow_guidance,approved_by,reason,expires_at,revoked_at
     FROM agent_message_grants WHERE (source_agent_id=$1 OR target_agent_id=$1)
       AND ($2::uuid IS NULL OR grant_id>$2) ORDER BY grant_id LIMIT $3`,
    [agent.agent_id, opts.cursor ?? null, limit + 1],
  );
  return agentPage(rows, limit, (row) => row.grant_id);
};

export const listMessageReceipts: AgentApi["listMessageReceipts"] = async (
  opts,
) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.agent_id, "agent_id");
  validateAgentPage(opts);
  if (opts.project_id === undefined) return listMessageReceiptsLocal(opts);
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    agent_id: opts.agent_id,
    limit: opts.limit,
    cursor: opts.cursor,
  };
  return withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => listMessageReceiptsLocal(request),
    remote: (api, route) => api.listMessageReceipts({ ...request, route }),
  });
};

export const listMessageReceiptsLocal: AgentApi["listMessageReceipts"] = async (
  opts,
) => {
  validateAgentPage(opts);
  const agent = await getIdentityLocal(opts);
  if (agent.created_by !== opts.account_id)
    throw new Error("only the endpoint registrant may inspect its receipts");
  return ownMessageReceipts(agent.agent_id, opts);
};

export const grantMessaging: AgentApi["grantMessaging"] = async () => {
  throw new Error("Legacy grants are retired; approve an RPC link instead");
};

export const revokeMessaging: AgentApi["revokeMessaging"] = async (opts) => {
  const db = agentStore();
  const account_id = await human(opts);
  requireUuid(opts.grant_id, "grant_id");
  const grant = (
    await db.query("SELECT * FROM agent_message_grants WHERE grant_id=$1", [
      opts.grant_id,
    ])
  ).rows[0];
  if (!grant) throw new Error("link not found");
  const source = await db.get(grant.source_agent_id);
  const target = await db.get(grant.target_agent_id);
  if (account_id !== source.created_by && account_id !== target.created_by)
    throw new Error("only an endpoint registrant may revoke the link");
  await assertActor(
    account_id,
    account_id === source.created_by ? source.project_id : target.project_id,
  );
  await db.query(
    "UPDATE agent_message_grants SET revoked_at=COALESCE(revoked_at,now()),revoked_by=$2 WHERE grant_id=$1",
    [opts.grant_id, account_id],
  );
};

export const disableIdentity: AgentApi["disableIdentity"] = async (opts) => {
  const db = agentStore();
  const account_id = await human(opts);
  requireUuid(opts.agent_id, "agent_id");
  const agent = await db.get(opts.agent_id);
  await assertActor(account_id, agent.project_id);
  if (agent.created_by !== account_id)
    throw new Error("only the registrant may disable this agent");
  await db.query(
    "UPDATE agent_identities SET disabled_at=COALESCE(disabled_at,now()),disabled_by=$2 WHERE agent_id=$1",
    [opts.agent_id, account_id],
  );
};

export const issueIdentity: AgentApi["issueIdentity"] = async (opts) => {
  if (!agentMessagingEnabled()) return;
  await assertLocalAgentProject(opts.project_id);
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.project_id,
  });
  const db = agentStore();
  const agent = await db.find(opts.project_id, opts.path, opts.thread_id);
  if (!agent) return;
  await assertAgent(agent);
  requireUuid(opts.run_id, "run_id");
  return await db.issue(agent, opts.run_id, opts.account_id!);
};

// Host-scoped read for a human turn: source-host authority does not confer
// access to the destination. Resolve the destination as the actual human.
export const getMentionIdentity: AgentApi["getMentionIdentity"] = async (
  opts,
) => {
  await assertLocalAgentProject(opts.project_id);
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.project_id,
  });
  return await getIdentity({
    account_id: opts.account_id!,
    project_id: opts.target.project_id,
    agent_id: opts.target.agent_id,
  });
};

export const endIdentityRun: AgentApi["endIdentityRun"] = async (opts) => {
  const db = agentStore();
  const agent = await db.get(opts.agent_id);
  await assertLocalAgentProject(agent.project_id);
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: agent.project_id,
  });
  await db.query(
    "UPDATE agent_identity_runs SET ended_at=now() WHERE agent_id=$1 AND run_id=$2 AND account_id=$3",
    [opts.agent_id, opts.run_id, opts.account_id],
  );
};

// Compatibility gates for old hosts. Never revive experimental pending work.
export const authorizeDelivery: AgentApi["authorizeDelivery"] = async () => {
  throw new Error("Legacy agent delivery is retired; no work was authorized");
};
export const beginMessageAdmission: AgentApi["beginMessageAdmission"] =
  async () => {
    throw new Error("Legacy agent delivery is retired; no work was authorized");
  };
