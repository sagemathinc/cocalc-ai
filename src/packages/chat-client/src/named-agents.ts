/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type { DB } from "@cocalc/conat/hub/api/db";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  MY_AGENTS_ORGANIZATION_SETTING,
  normalizeAgentWorkspaceOrganization,
  serializeAgentWorkspaceOrganization,
  type AgentWorkspaceOrganization,
} from "./agent-organization";

export interface NamedAgentsApi {
  agent: Pick<AgentApi, "listNamedAgents">;
  db: Pick<DB, "userQuery">;
}

export async function loadNamedAgentWorkspace(
  api: NamedAgentsApi,
  accountId: string,
) {
  const [directory, result] = await Promise.all([
    api.agent.listNamedAgents({}),
    api.db.userQuery({
      query: { accounts: [{ account_id: accountId, other_settings: null }] },
    }),
  ]);
  const account = result?.accounts?.find(
    (row: { account_id: string }) => row.account_id === accountId,
  );
  if (!account)
    throw new Error("Unable to read agent organization for this account.");
  return {
    directory,
    organization: normalizeAgentWorkspaceOrganization(
      account.other_settings?.[MY_AGENTS_ORGANIZATION_SETTING],
    ),
  };
}

export async function saveNamedAgentOrganization(
  api: Pick<NamedAgentsApi, "db">,
  accountId: string,
  organization: AgentWorkspaceOrganization,
): Promise<void> {
  await api.db.userQuery({
    query: {
      accounts: {
        account_id: accountId,
        other_settings: {
          [MY_AGENTS_ORGANIZATION_SETTING]:
            serializeAgentWorkspaceOrganization(organization),
        },
      },
    },
  });
}

/** Resolve only the selected project's placement; never enumerate/start projects. */
export async function resolveNamedAgentHost(
  api: Pick<NamedAgentsApi, "db">,
  accountId: string,
  projectId: string,
): Promise<string> {
  const result = await api.db.userQuery({
    query: {
      account_project_index: [
        { account_id: accountId, project_id: projectId, host_id: null },
      ],
    },
  });
  const row = result?.account_project_index?.find(
    (value: { project_id: string }) => value.project_id === projectId,
  );
  if (!row?.host_id)
    throw new Error(
      "This agent's project has no available host. Open its project in the browser or retry after it is assigned a host.",
    );
  return row.host_id;
}

export function filterNamedAgents(
  agents: NamedAgent[],
  search: string,
): NamedAgent[] {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return agents.filter((agent) => {
    const text = [
      agent.name,
      agent.thread_title,
      agent.description,
      agent.project_title,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
