import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { assertCollab } from "@cocalc/server/conat/api/util";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
  getAccountRevokedBeforeCached,
} from "@cocalc/server/accounts/security-state";
import { agentStore, type AgentRun } from "./store";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";

export async function assertLocalAgentProject(project_id: string) {
  const owner = await resolveProjectBay(project_id);
  if (!owner || owner.bay_id !== getConfiguredBayId()) {
    throw new Error(
      "agent messaging currently requires projects owned by this bay",
    );
  }
}

export async function assertActor(account_id: string, project_id: string) {
  await assertLocalAgentProject(project_id);
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id)) throw new Error("account is disabled");
  await assertCollab({ account_id, project_id });
}

export async function assertAgent(agent: AgentIdentity) {
  if (agent.disabled_at) throw new Error("agent is disabled");
  await assertActor(agent.created_by, agent.project_id);
}

export async function assertRun(
  run: Pick<AgentRun, "account_id" | "project_id" | "issued_at">,
) {
  await assertActor(run.account_id, run.project_id);
  const revoked = getAccountRevokedBeforeCached(run.account_id);
  if (revoked && run.issued_at.getTime() <= new Date(revoked).getTime())
    throw new Error("agent session was revoked");
}

export async function checkDelivery(message_id: string) {
  const db = agentStore();
  const { rows } = await db.query(
    `SELECT i.*,g.approved_by,r.account_id AS sender_account_id,r.issued_at AS sender_issued_at FROM agent_message_inbox i
    JOIN agent_message_grants g USING(grant_id)
    JOIN agent_identity_runs r ON r.agent_id=i.source_agent_id AND r.run_id=i.source_run_id
    WHERE message_id=$1 AND i.state IN ('dispatching','dispatched','unconfirmed')
      AND g.revoked_at IS NULL AND g.expires_at>now()
      AND (NOT i.guidance OR g.allow_guidance)`,
    [message_id],
  );
  const delivery = rows[0];
  if (!delivery) throw new Error("message grant expired or was revoked");
  const source = await db.get(delivery.source_agent_id);
  const target = await db.get(delivery.target_agent_id);
  await assertAgent(source);
  await assertAgent(target);
  // An accepted message survives the end of its source runtime, but not removal
  // of its sender's access or revocation of that sender's sessions.
  await assertRun({
    account_id: delivery.sender_account_id,
    project_id: source.project_id,
    issued_at: delivery.sender_issued_at,
  });
  await assertActor(delivery.approved_by, source.project_id);
  await assertActor(delivery.approved_by, target.project_id);
  return { delivery, source, target };
}
