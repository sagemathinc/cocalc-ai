import { randomUUID } from "node:crypto";
import type { AgentApi, AgentHumanAuth } from "@cocalc/conat/hub/api/agent";
import { requireUuid } from "@cocalc/conat/agents/protocol";
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
      // Loading the live chat may wait on routing or synchronization.
      await assertActor(account_id, opts.project_id);
      return db.transaction(async (sql) => {
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`agent-identities:${opts.project_id}`],
        );
        const existing = (
          await sql.query(
            `SELECT * FROM agent_identities
             WHERE project_id=$1 AND path=$2 AND thread_id=$3
               AND disabled_at IS NULL`,
            [opts.project_id, path, opts.thread_id],
          )
        ).rows[0];
        if (existing) return existing;
        const count = (
          await sql.query(
            "SELECT count(*) AS count FROM agent_identities WHERE project_id=$1",
            [opts.project_id],
          )
        ).rows[0];
        if (+count.count >= 10_000)
          throw new Error("agent_identity_project_capacity");
        return (
          await sql.query(
            `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(project_id,path,thread_id) WHERE disabled_at IS NULL
             DO NOTHING RETURNING *`,
            [
              randomUUID(),
              opts.project_id,
              path,
              opts.thread_id,
              thread.name || opts.thread_id,
              account_id,
            ],
          )
        ).rows[0];
      });
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

async function assertIdentityRecoveryOwner(
  account_id: string,
  project_id: string,
): Promise<string> {
  await assertLocalAgentProject(project_id);
  const owners = (
    await agentStore().query<{ account_id: string }>(
      `SELECT owner.key AS account_id FROM projects,
       jsonb_each(projects.users) AS owner(key,value)
       WHERE projects.project_id=$1 AND owner.value->>'group'='owner'
       ORDER BY owner.key`,
      [project_id],
    )
  ).rows.map((row) => row.account_id);
  if (owners.includes(account_id)) {
    await assertActor(account_id, project_id);
    return account_id;
  }
  throw new Error("only a project owner may recover an agent identity");
}

export const recoverIdentity: AgentApi["recoverIdentity"] = async (opts) => {
  const account_id = await human(opts);
  const request = {
    account_id,
    project_id: opts.project_id,
    agent_id: opts.agent_id,
  };
  const fresh_auth_at = Date.now();
  return withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => recoverIdentityLocal(request),
    remote: (api, route) => api.recover({ ...request, route, fresh_auth_at }),
  });
};

export const recoverIdentityLocal: AgentApi["recoverIdentity"] = async (
  opts,
) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  requireUuid(opts.agent_id, "agent_id");
  const db = agentStore();
  const previous = await db.get(opts.agent_id);
  if (previous.project_id !== opts.project_id)
    throw new Error("agent identity does not belong to the requested project");
  const routingAccount = await assertIdentityRecoveryOwner(
    opts.account_id,
    opts.project_id,
  );
  return withAgentChat(
    { ...previous, created_by: routingAccount },
    async (_chat, thread) => {
      await assertIdentityRecoveryOwner(opts.account_id!, opts.project_id);
      return db.transaction(async (sql) => {
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`agent-identities:${opts.project_id}`],
        );
        const active = (
          await sql.query(
            `SELECT agent_id FROM agent_identities
             WHERE project_id=$1 AND path=$2 AND thread_id=$3
               AND disabled_at IS NULL AND agent_id<>$4 FOR UPDATE`,
            [
              previous.project_id,
              previous.path,
              previous.thread_id,
              previous.agent_id,
            ],
          )
        ).rows[0];
        if (active) throw new Error("thread already has an active identity");
        const count = (
          await sql.query(
            "SELECT count(*) AS count FROM agent_identities WHERE project_id=$1",
            [opts.project_id],
          )
        ).rows[0];
        if (+count.count >= 10_000)
          throw new Error("agent_identity_project_capacity");
        await sql.query(
          `UPDATE agent_identities SET disabled_at=COALESCE(disabled_at,now()),
             disabled_by=COALESCE(disabled_by,$2)
           WHERE agent_id=$1`,
          [previous.agent_id, opts.account_id],
        );
        await sql.query(
          "UPDATE agent_identity_runs SET ended_at=COALESCE(ended_at,now()) WHERE agent_id=$1",
          [previous.agent_id],
        );
        const replacement = (
          await sql.query(
            `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
            [
              randomUUID(),
              previous.project_id,
              previous.path,
              previous.thread_id,
              thread.name || previous.name,
              opts.account_id,
            ],
          )
        ).rows[0];
        await sql.query(
          "UPDATE agent_identities SET replaced_by=$2 WHERE agent_id=$1",
          [previous.agent_id, replacement.agent_id],
        );
        return replacement;
      });
    },
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
  if (opts.recover_expired_run_id)
    requireUuid(opts.recover_expired_run_id, "recover_expired_run_id");
  return await db.issue(
    agent,
    opts.run_id,
    opts.account_id!,
    opts.recover_expired_run_id,
  );
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
