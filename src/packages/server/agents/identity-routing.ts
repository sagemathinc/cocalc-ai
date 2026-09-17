import { requireUuid } from "@cocalc/conat/agents/protocol";
import { createInterBayAgentIdentityClient } from "@cocalc/conat/inter-bay/agent-identities";
import type {
  AgentIdentityRoute,
  InterBayAgentIdentityApi,
} from "@cocalc/conat/inter-bay/agent-identities";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

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
