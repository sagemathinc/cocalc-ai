/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The two lookups runAgentSearch needs: an agent's past conversation
// threads, and matching messages in one thread (on the project host).

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { personalAgentApi } from "./api";

export async function agentHistory(agent: NamedAgent): Promise<string[]> {
  return (
    (
      await personalAgentApi().getIdentity({
        project_id: agent.endpoint.project_id,
        agent_id: agent.endpoint.agent_id,
      })
    ).conversation_history?.map((h) => h.thread_id) ?? []
  );
}

export async function searchAgentThread(
  agent: NamedAgent,
  threadId: string,
  query: string,
): Promise<ChatStoreSearchHit[]> {
  const result = await webapp_client.conat_client.hub.projects.chatStoreSearch({
    project_id: agent.endpoint.project_id,
    chat_path: agent.path,
    thread_id: threadId,
    query,
    include_head: true,
    limit: 20,
  });
  if (!result.includes_head)
    throw new Error("Project host needs an update to search recent messages");
  return result.hits;
}
