import {
  validateAgentPage,
  type AgentIdentity,
  type AgentDestination,
  type AgentMessageHistoryEntry,
  type AgentPage,
  type AgentPageOptions,
} from "@cocalc/conat/agents/protocol";
import { agentStore } from "./store";
import { assertActor, assertAgent } from "./access";

export function agentPage<T>(
  rows: T[],
  limit: number,
  key: (row: T) => string,
): AgentPage<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    ...(rows.length > limit
      ? { next_cursor: key(items[items.length - 1]) }
      : {}),
  };
}

export async function ownMessageReceipts(
  agentId: string,
  options: AgentPageOptions,
): Promise<AgentPage<AgentMessageHistoryEntry>> {
  const limit = validateAgentPage(options);
  const { rows } = await agentStore().query<AgentMessageHistoryEntry>(
    `SELECT message_id,request_id,target_agent_id,state,created_at,updated_at,guidance,
       execution_receipt AS execution
     FROM agent_message_inbox
     WHERE source_agent_id=$1 AND ($2::uuid IS NULL OR (created_at,message_id)<(
       SELECT created_at,message_id FROM agent_message_inbox
       WHERE source_agent_id=$1 AND message_id=$2))
     ORDER BY created_at DESC,message_id DESC LIMIT $3`,
    [agentId, options.cursor ?? null, limit + 1],
  );
  return agentPage(rows, limit, (row) => row.message_id);
}

export async function approvedDestinations(
  source: AgentIdentity,
  options: AgentPageOptions,
): Promise<AgentPage<AgentDestination>> {
  const limit = validateAgentPage(options);
  const db = agentStore();
  const { rows } = await db.query<{ target_agent_id: string }>(
    `SELECT DISTINCT target_agent_id FROM agent_message_grants
     WHERE source_agent_id=$1 AND revoked_at IS NULL AND expires_at>now()
       AND ($2::uuid IS NULL OR target_agent_id>$2)
     ORDER BY target_agent_id LIMIT $3`,
    [source.agent_id, options.cursor ?? null, limit + 1],
  );
  const page = agentPage(rows, limit, (row) => row.target_agent_id);
  const items: AgentDestination[] = [];
  for (const { target_agent_id } of page.items) {
    const target = await db.get(target_agent_id);
    try {
      await assertAgent(target);
      // The grant approver is the target registrant in V1. Recheck both
      // memberships before exposing even the destination's display metadata.
      await assertActor(target.created_by, source.project_id);
    } catch {
      continue;
    }
    const { rows: grants } = await db.query<{
      expires_at: Date | null;
      allow_guidance: boolean;
    }>(
      `SELECT max(expires_at) AS expires_at, bool_or(allow_guidance) AS allow_guidance
       FROM agent_message_grants WHERE source_agent_id=$1 AND target_agent_id=$2
       AND approved_by=$3 AND revoked_at IS NULL AND expires_at>now()
       `,
      [source.agent_id, target.agent_id, target.created_by],
    );
    if (!grants[0]?.expires_at) continue;
    items.push({
      agent_id: target.agent_id,
      project_id: target.project_id,
      path: target.path,
      thread_id: target.thread_id,
      name: target.name,
      expires_at: grants[0].expires_at,
      allow_guidance: grants[0].allow_guidance,
    });
  }
  // The cursor covers scanned candidates, including those hidden by access
  // checks. An empty page can therefore still have a continuation cursor.
  return { ...page, items };
}
