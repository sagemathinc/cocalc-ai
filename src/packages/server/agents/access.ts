import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { assertCollab } from "@cocalc/server/conat/api/util";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
  getAccountRevokedBeforeCached,
} from "@cocalc/server/accounts/security-state";
import type { AgentRun } from "./store";
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
  // Registration is provenance, not execution authority in personal mode.
  // Callers must separately authorize the human/run principal.
  await assertLocalAgentProject(agent.project_id);
}

export async function assertRun(
  run: Pick<AgentRun, "account_id" | "project_id" | "issued_at">,
) {
  await assertActor(run.account_id, run.project_id);
  const revoked = getAccountRevokedBeforeCached(run.account_id);
  if (revoked && run.issued_at.getTime() <= new Date(revoked).getTime())
    throw new Error("agent session was revoked");
}
