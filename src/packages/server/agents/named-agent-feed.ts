/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Live updates for the Agents page: name-book changes in the account's home
// bay are pushed to that account's connected browsers as whole rows
// (agent.upsert / agent.remove on the account feed), so clients patch their
// list in place instead of reloading it.

import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { AccountFeedEvent } from "@cocalc/conat/hub/api/account-feed";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";
import type { PersonalAgentHooks } from "./personal-store";
import { loadAgentPayments } from "./payment-selections";
import { watchIdentity } from "./identity-watchers";

export const namedAgentHooks: PersonalAgentHooks = {
  watch: (account_id, endpoint, watching) =>
    watchIdentity({ account_id, ...endpoint, watching }),

  async upsert(account_id: string, agent: NamedAgent) {
    await publishAccountFeedEventBestEffort({
      account_id,
      event: {
        type: "agent.upsert",
        ts: Date.now(),
        account_id,
        agent,
      } satisfies AccountFeedEvent,
    });
  },

  async remove(account_id: string, endpoint: AgentEndpoint) {
    await publishAccountFeedEventBestEffort({
      account_id,
      event: {
        type: "agent.remove",
        ts: Date.now(),
        account_id,
        project_id: endpoint.project_id,
        agent_id: endpoint.agent_id,
      } satisfies AccountFeedEvent,
    });
  },

  payments: loadAgentPayments,
  backgroundRepair: true,
};

/** After a payment change: push the affected named agents (home bay). */
export async function publishNamedAgentsForThreads(
  account_id: string,
  threads: { project_id: string; thread_id: string }[],
): Promise<void> {
  if (threads.length === 0) return;
  const { personalStore } = await import("./personal");
  await personalStore().publishThreads(account_id, threads);
}
