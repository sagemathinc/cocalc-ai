import { randomUUID } from "node:crypto";
import type { AgentApi, AgentHumanAuth } from "@cocalc/conat/hub/api/agent";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { agentStore, agentMessagingEnabled, normalizeAgentPath } from "./store";
import {
  assertLocalAgentProject,
  assertActor,
  assertAgent,
  checkDelivery,
} from "./access";
import { withAgentChat } from "./chat";

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
  const db = agentStore();
  const account_id = await human(opts);
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

export const grantMessaging: AgentApi["grantMessaging"] = async (opts) => {
  const db = agentStore();
  const account_id = await human(opts);
  requireUuid(opts.source_agent_id, "source_agent_id");
  requireUuid(opts.target_agent_id, "target_agent_id");
  if (opts.source_agent_id === opts.target_agent_id)
    throw new Error("self-links are not supported");
  if (
    !Number.isInteger(opts.ttl_seconds) ||
    opts.ttl_seconds < 60 ||
    opts.ttl_seconds > 30 * 86400
  )
    throw new Error("TTL must be 60 seconds to 30 days");
  if (
    typeof opts.reason !== "string" ||
    !opts.reason.trim() ||
    opts.reason.length > 1024
  )
    throw new Error("a reason of at most 1024 characters is required");
  if (opts.allow_guidance != null && typeof opts.allow_guidance !== "boolean")
    throw new Error("allow_guidance must be boolean");
  const source = await db.get(opts.source_agent_id);
  const target = await db.get(opts.target_agent_id);
  await assertAgent(source);
  await assertAgent(target);
  await assertActor(account_id, source.project_id);
  await assertActor(account_id, target.project_id);
  // V1 never spends another registrant's agent budget on their behalf.
  if (target.created_by !== account_id)
    throw new Error("the target agent registrant must approve this link");
  const { rows } = await db.query(
    `INSERT INTO agent_message_grants(grant_id,source_agent_id,target_agent_id,allow_guidance,approved_by,reason,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second') RETURNING *`,
    [
      randomUUID(),
      source.agent_id,
      target.agent_id,
      opts.allow_guidance === true,
      account_id,
      opts.reason,
      opts.ttl_seconds,
    ],
  );
  return rows[0];
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

export const authorizeDelivery: AgentApi["authorizeDelivery"] = async (
  opts,
) => {
  requireUuid(opts.message_id, "message_id");
  const { target } = await checkDelivery(opts.message_id);
  if (
    target.project_id !== opts.project_id ||
    target.thread_id !== opts.thread_id ||
    target.path !== normalizeAgentPath(opts.path) ||
    target.created_by !== opts.account_id
  )
    throw new Error("message target mismatch");
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: target.project_id,
  });
};
