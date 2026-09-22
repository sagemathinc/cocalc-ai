import type {
  AgentIdentityReadRequest,
  InterBayAgentIdentityApi,
} from "@cocalc/conat/inter-bay/agent-identities";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import {
  listIdentitiesLocal,
  resolveIdentityLocal,
  registerIdentityLocal,
  getIdentityLocal,
  recoverIdentityLocal,
  startFreshConversationLocal,
} from "./api";
import {
  authorizeFileGrantReadLocal,
  listFileGrantsLocal,
  revokeFileGrantLocal,
  saveFileGrantLocal,
} from "./file-grants";

async function assertOwner(opts: AgentIdentityReadRequest) {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  const owner = await resolveProjectBay(opts.project_id);
  if (
    !owner ||
    owner.bay_id !== getConfiguredBayId() ||
    opts.route?.bay_id !== owner.bay_id ||
    opts.route?.epoch !== owner.epoch
  ) {
    throw new Error("stale agent identity project routing");
  }
}

// Only exposed on the trusted inter-bay fabric, not the public hub agent API.
export const agentIdentityControl: InterBayAgentIdentityApi = {
  authorizeFileGrantRead: async (opts) => {
    await assertOwner(opts);
    return authorizeFileGrantReadLocal({
      account_id: opts.account_id,
      host_id: opts.host_id,
      source_project_id: opts.project_id,
      target_project_id: opts.target_project_id,
      grant_id: opts.grant_id,
      agent_id: opts.agent_id,
      run_id: opts.run_id,
    });
  },
  listFileGrants: async (opts) => {
    await assertOwner(opts);
    return listFileGrantsLocal(opts);
  },
  saveFileGrant: async (opts) => {
    await assertOwner(opts);
    return saveFileGrantLocal(opts);
  },
  revokeFileGrant: async (opts) => {
    await assertOwner(opts);
    return revokeFileGrantLocal(opts);
  },
  startFreshConversation: async (opts) => {
    await assertOwner(opts);
    return startFreshConversationLocal(opts);
  },
  get: async (opts) => {
    await assertOwner(opts);
    return getIdentityLocal({
      account_id: opts.account_id,
      project_id: opts.project_id,
      agent_id: opts.agent_id,
    });
  },
  list: async (opts) => {
    await assertOwner(opts);
    return await listIdentitiesLocal({
      account_id: opts.account_id,
      project_id: opts.project_id,
    });
  },
  resolve: async (opts) => {
    await assertOwner(opts);
    return await resolveIdentityLocal({
      account_id: opts.account_id,
      project_id: opts.project_id,
      path: opts.path,
      thread_id: opts.thread_id,
    });
  },
  register: async (opts) => {
    await assertOwner(opts);
    return await registerIdentityLocal({
      account_id: opts.account_id,
      project_id: opts.project_id,
      path: opts.path,
      thread_id: opts.thread_id,
    });
  },
  recover: async (opts) => {
    await assertOwner(opts);
    const age = Date.now() - opts.fresh_auth_at;
    if (!Number.isFinite(opts.fresh_auth_at) || age < -5000 || age > 30_000)
      throw new Error(
        "agent recovery fresh-auth attestation expired or missing",
      );
    return recoverIdentityLocal({
      account_id: opts.account_id,
      project_id: opts.project_id,
      agent_id: opts.agent_id,
    });
  },
};
