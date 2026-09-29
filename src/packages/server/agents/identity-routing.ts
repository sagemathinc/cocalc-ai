import { requireUuid } from "@cocalc/conat/agents/protocol";
import { createInterBayAgentIdentityClient } from "@cocalc/conat/inter-bay/agent-identities";
import type {
  AgentIdentityRoute,
  InterBayAgentIdentityApi,
} from "@cocalc/conat/inter-bay/agent-identities";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { agentStore } from "./store";

export async function verifyActiveAgentRun({
  account_id,
  project_id,
  agent_id,
  run_id,
}: {
  account_id: string;
  project_id: string;
  agent_id: string;
  run_id: string;
}): Promise<number> {
  requireUuid(account_id, "account_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(run_id, "run_id");
  const result = await withAgentIdentityOwner({
    project_id,
    local: async () => {
      const run = await agentStore().activeRun(agent_id, run_id);
      if (run.account_id !== account_id || run.project_id !== project_id) {
        throw new Error("agent run does not match requested owner or project");
      }
      return { expires_at: new Date(run.expires_at).valueOf() };
    },
    remote: (api, route) =>
      api.verifyActiveRun({
        account_id,
        project_id,
        agent_id,
        run_id,
        route,
      }),
  });
  if (!Number.isFinite(result.expires_at) || result.expires_at <= Date.now()) {
    throw new Error("agent run has expired");
  }
  return result.expires_at;
}

export async function withAgentIdentityOwner<T>({
  project_id,
  local,
  remote,
}: {
  project_id: string;
  local: () => Promise<T>;
  remote: (
    api: InterBayAgentIdentityApi,
    route: AgentIdentityRoute,
  ) => Promise<T>;
}): Promise<T> {
  requireUuid(project_id, "project_id");
  const owner = await resolveProjectBay(project_id);
  if (!owner) throw new Error("agent identity project owner is unavailable");
  if (owner.bay_id === getConfiguredBayId()) return await local();
  // Only the trusted fabric follows directory routes. No caller URL or secret.
  return await remote(
    createInterBayAgentIdentityClient({
      client: getInterBayFabricClient(),
      bay_id: owner.bay_id,
    }),
    { bay_id: owner.bay_id, epoch: owner.epoch },
  );
}
