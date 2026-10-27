import { randomUUID } from "node:crypto";
import type { AgentApi, AgentHumanAuth } from "@cocalc/conat/hub/api/agent";
import {
  parseAgentTurnStatus,
  sameAgentTurnStatus,
} from "@cocalc/conat/agents/agent-status";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { agentStore, agentMessagingEnabled, normalizeAgentPath } from "./store";
import { assertLocalAgentProject, assertActor, assertAgent } from "./access";
import { withAgentChat } from "./chat";
import { withAgentIdentityOwner } from "./identity-routing";
import { controlAcp } from "@cocalc/conat/ai/acp/client";
import { conatWithProjectRoutingForAccount } from "@cocalc/server/conat/route-client";
import { copyPaymentSelection } from "./payment-selections";
import {
  agentRuntimeFromThread,
  parseAgentRuntimeSummary,
  sameAgentRuntime,
} from "@cocalc/util/ai/agent-runtime-kind";
import { notifyIdentityWatchers } from "./identity-watchers";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:agents:api");

export const startFreshConversation: AgentApi["startFreshConversation"] =
  async (opts) => {
    requireUuid(opts.account_id, "account_id");
    const request = {
      account_id: opts.account_id,
      project_id: opts.project_id,
      agent_id: opts.agent_id,
      expected_thread_id: opts.expected_thread_id,
    };
    const identity = await withAgentIdentityOwner({
      project_id: opts.project_id,
      local: () => startFreshConversationLocal(request),
      remote: (api, route) => api.startFreshConversation({ ...request, route }),
    });
    // The new conversation keeps how this account pays for the agent.
    if (identity.thread_id !== opts.expected_thread_id) {
      try {
        await copyPaymentSelection({
          account_id: opts.account_id,
          from: {
            project_id: opts.project_id,
            thread_id: opts.expected_thread_id,
          },
          to: {
            project_id: opts.project_id,
            thread_id: identity.thread_id,
            path: identity.path,
          },
        });
      } catch (err) {
        logger.warn("could not copy agent payment selection", {
          agent_id: opts.agent_id,
          err: `${err}`,
        });
      }
    }
    return identity;
  };

export const startFreshConversationLocal: AgentApi["startFreshConversation"] =
  async (opts) => {
    requireUuid(opts.account_id, "account_id");
    requireUuid(opts.project_id, "project_id");
    requireUuid(opts.agent_id, "agent_id");
    if (
      typeof opts.expected_thread_id !== "string" ||
      !opts.expected_thread_id ||
      opts.expected_thread_id.length > 200
    )
      throw new Error("invalid expected_thread_id");
    const db = agentStore();
    await assertLocalAgentProject(opts.project_id);
    await assertActor(opts.account_id, opts.project_id);
    const previous = await db.get(opts.agent_id);
    if (
      previous.project_id !== opts.project_id ||
      previous.created_by !== opts.account_id ||
      previous.disabled_at
    )
      throw new Error(
        "Only the active agent's registrant can start a fresh conversation",
      );
    if (previous.thread_id !== opts.expected_thread_id) {
      if (
        previous.conversation_history?.some(
          (entry) => entry.thread_id === opts.expected_thread_id,
        )
      )
        return previous;
      throw new Error(
        "The agent conversation changed; refresh before starting fresh",
      );
    }
    if ((previous.conversation_history?.length ?? 0) >= 1000)
      throw new Error("Agent conversation history capacity reached");
    // Remote host work never runs under a database lock. The host durably fences
    // old-thread admission and returns the same successor on an explicit retry.
    const prepared = await controlAcp(
      {
        project_id: previous.project_id,
        account_id: opts.account_id,
        path: previous.path,
        thread_id: previous.thread_id,
        user_message_id: previous.thread_id,
        action: "prepare_fresh_conversation",
      },
      conatWithProjectRoutingForAccount({ account_id: opts.account_id }),
    );
    if (!prepared.ok || !prepared.successor_thread_id)
      throw new Error(
        "Project host could not prepare a fresh conversation; retry to finish",
      );
    requireUuid(prepared.successor_thread_id, "successor_thread_id");
    await assertActor(opts.account_id, opts.project_id);
    const fresh = await db.transaction(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `agent-identities:${opts.project_id}`,
      ]);
      const current = (
        await sql.query(
          "SELECT * FROM agent_identities WHERE agent_id=$1 FOR UPDATE",
          [opts.agent_id],
        )
      ).rows[0];
      if (
        !current ||
        current.disabled_at ||
        current.created_by !== opts.account_id ||
        current.project_id !== previous.project_id ||
        current.path !== previous.path
      )
        throw new Error("Agent identity changed");
      if (current.thread_id !== previous.thread_id) return current;
      const history = [
        ...(current.conversation_history ?? []),
        { thread_id: previous.thread_id, ended_at: new Date().toISOString() },
      ];
      await sql.query(
        "UPDATE agent_identity_runs SET ended_at=COALESCE(ended_at,now()) WHERE agent_id=$1",
        [opts.agent_id],
      );
      return (
        await sql.query(
          `UPDATE agent_identities SET thread_id=$2,conversation_history=$3::jsonb
      WHERE agent_id=$1 RETURNING *`,
          [
            opts.agent_id,
            prepared.successor_thread_id,
            JSON.stringify(history),
          ],
        )
      ).rows[0];
    });
    // Everyone who named the agent sees its new conversation.
    void notifyIdentityWatchers(opts.agent_id);
    return fresh;
  };

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
  requireUuid(opts.account_id, "account_id");
  const account_id = opts.account_id;
  const request = {
    account_id,
    project_id: opts.project_id,
    path: opts.path,
    thread_id: opts.thread_id,
  };
  return await withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => registerIdentityLocal(request),
    remote: (api, route) => api.register({ ...request, route }),
  });
};

// Internal implementation; callers must establish the authenticated account.
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
        const runtime = agentRuntimeFromThread(thread);
        if (existing) {
          // Identities registered before runtimes were recorded.
          if (!existing.runtime && runtime) {
            const updated = (
              await sql.query(
                "UPDATE agent_identities SET runtime=$2::jsonb WHERE agent_id=$1 RETURNING *",
                [existing.agent_id, JSON.stringify(runtime)],
              )
            ).rows[0];
            void notifyIdentityWatchers(existing.agent_id);
            return updated;
          }
          return existing;
        }
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
            `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,runtime)
             VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
             ON CONFLICT(project_id,path,thread_id) WHERE disabled_at IS NULL
             DO NOTHING RETURNING *`,
            [
              randomUUID(),
              opts.project_id,
              path,
              opts.thread_id,
              thread.name || opts.thread_id,
              account_id,
              runtime ? JSON.stringify(runtime) : null,
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
  void notifyIdentityWatchers(opts.agent_id);
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
            `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,runtime)
             VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
            [
              randomUUID(),
              previous.project_id,
              previous.path,
              previous.thread_id,
              thread.name || previous.name,
              opts.account_id,
              JSON.stringify(
                agentRuntimeFromThread(thread) ?? previous.runtime ?? null,
              ),
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
  ).then((replacement) => {
    void notifyIdentityWatchers(previous.agent_id);
    return replacement;
  });
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

// The same host-scoped read for an external network member: found among
// the human's own Agent Networks, never by the source host's authority.
export const getMentionMember: AgentApi["getMentionMember"] = async (opts) => {
  await assertLocalAgentProject(opts.project_id);
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.project_id,
  });
  const target = opts.target;
  if (target?.kind !== "external") throw new Error("external target required");
  for (const field of ["account_id", "agent_id", "installation_id"] as const)
    requireUuid(target[field], field);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const { listAgentNetworks } = await import("./personal");
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const directory = await listAgentNetworks({
      account_id: opts.account_id!,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const network of directory.networks)
      for (const member of network.members)
        if (
          member.kind === "external" &&
          !member.removed_at &&
          same(member.source.account_id, target.account_id) &&
          same(member.source.agent_id, target.agent_id) &&
          same(member.source.installation_id, target.installation_id)
        )
          return { label: member.label, available: member.available };
    cursor = directory.next_cursor;
    if (!cursor) break;
  }
  return null;
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

// Host-scoped read for the turn context: the account's home verifies that the
// run belongs to this account, as for the agent's own `destinations`.
export const describeNetworkSelf: AgentApi["describeNetworkSelf"] = async (
  opts,
) => {
  requireUuid(opts.agent_id, "agent_id");
  requireUuid(opts.run_id, "run_id");
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.source_project_id,
  });
  const agent = await agentStore().get(opts.agent_id);
  if (agent.project_id !== opts.source_project_id)
    throw new Error("agent is not in this project");
  const { withPersonalHome } = await import("./personal");
  const directory = (await withPersonalHome(opts.account_id!, {
    action: "discoverNetworks",
    options: {
      source: { agent_id: agent.agent_id, project_id: agent.project_id },
      run_id: opts.run_id,
    },
  })) as import("@cocalc/conat/agents/personal").AgentNetworkDiscovery;
  return directory.self;
};

// Host-attested: the project host holding a turn whose sign-in failed asks
// when the turn's account last updated that credential, to resume the turn
// once it was signed in again (I4c). Routed to the account's home bay by the
// credential store; only the time and whether it is revoked come back.
export const credentialUpdatedAt: AgentApi["credentialUpdatedAt"] = async (
  opts,
) => {
  requireUuid(opts.credential_id, "credential_id");
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.project_id,
  });
  const provider =
    typeof opts.provider === "string" &&
    /^[a-z0-9_-]{1,64}$/.test(opts.provider)
      ? opts.provider
      : undefined;
  const { listAccountExternalCredentialsRouted } =
    await import("@cocalc/server/external-credentials/routing");
  // Summaries only (never the secret), from the account's home bay.
  const credentials = await listAccountExternalCredentialsRouted({
    owner_account_id: opts.account_id!,
    includeRevoked: true,
    ...(provider ? { provider } : {}),
  });
  const found = credentials.find(
    (credential) => credential.id === opts.credential_id,
  );
  const ms = (value: Date | string) => new Date(value).valueOf();
  const peers = credentials.filter(
    (credential) =>
      credential.revoked == null &&
      (found
        ? credential.provider === found.provider &&
          credential.kind === found.kind
        : provider != null && credential.provider === provider),
  );
  const newestCredential = peers.reduce<(typeof peers)[number] | undefined>(
    (best, credential) =>
      !best || ms(credential.updated) > ms(best.updated) ? credential : best,
    undefined,
  );
  return {
    ...(found
      ? { updated_at: ms(found.updated), revoked: found.revoked != null }
      : {}),
    ...(newestCredential
      ? {
          newest_updated_at: ms(newestCredential.updated),
          newest_credential_id: newestCredential.id,
        }
      : {}),
  };
};

// Host-attested: the project host running an agent's turns reports what it
// is doing. Kept on the identity, so it reaches everyone who named the agent
// (destinations, the Agents page) the way its runtime and appearance do.
/** A refresh of an unchanged status is stored at most this often. */
const STATUS_REFRESH_MIN_MS = 60 * 60_000;

export const reportStatus: AgentApi["reportStatus"] = async (opts) => {
  await assertLocalAgentProject(opts.project_id);
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.project_id,
  });
  const parsed = parseAgentTurnStatus(opts.status);
  if (!parsed) throw new Error("invalid agent status");
  // Never later than the hub's own clock: a host whose clock ran ahead
  // would otherwise outrank every later (correct) report, and outlive its
  // TTL.
  const status = { ...parsed, at: Math.min(parsed.at, Date.now()) };
  const db = agentStore();
  const agent = await db.find(opts.project_id, opts.path, opts.thread_id);
  if (!agent) return { registered: false };
  // Unchanged: kept, unless this refreshes it well before it would expire
  // (the host sends an unchanged status again every few hours).
  const stored = parseAgentTurnStatus(agent.turn_status);
  if (
    sameAgentTurnStatus(stored, status) &&
    status.at - (stored?.at ?? 0) < STATUS_REFRESH_MIN_MS
  )
    return { registered: true };
  // Atomically never older than what is stored: of two overlapping
  // reports (a retried one, say), the older cannot land last and win.
  const { rowCount } = await db.query(
    `UPDATE agent_identities SET turn_status=$2::jsonb
     WHERE agent_id=$1
       AND (turn_status IS NULL OR (turn_status->>'at')::bigint <= $3)`,
    [agent.agent_id, JSON.stringify(status), status.at],
  );
  if (rowCount) void notifyIdentityWatchers(agent.agent_id);
  return { registered: true };
};

// Host-attested: the project host admitting a turn reports the agent's
// runtime, which fills in identities registered before runtimes were recorded.
export const reportRuntime: AgentApi["reportRuntime"] = async (opts) => {
  await assertLocalAgentProject(opts.project_id);
  await assertProjectHostAgentTokenAccess({
    host_id: opts.host_id!,
    account_id: opts.account_id!,
    project_id: opts.project_id,
  });
  const runtime = parseAgentRuntimeSummary(opts.runtime);
  if (!runtime) throw new Error("invalid agent runtime");
  const db = agentStore();
  const agent = await db.find(opts.project_id, opts.path, opts.thread_id);
  if (!agent || sameAgentRuntime(agent.runtime, runtime)) return;
  await db.query(
    "UPDATE agent_identities SET runtime=$2::jsonb WHERE agent_id=$1",
    [agent.agent_id, JSON.stringify(runtime)],
  );
  void notifyIdentityWatchers(agent.agent_id);
};
