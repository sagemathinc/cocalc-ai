/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";

export function notificationAgentName({
  agents,
  projectId,
  path,
  threadId,
}: {
  agents?: NamedAgent[];
  projectId?: string | null;
  path?: string | null;
  threadId?: string | null;
}): string | undefined {
  if (!projectId || !path || !threadId) return;
  const name = agents
    ?.find(
      (agent) =>
        agent.endpoint.project_id === projectId &&
        agent.path === path &&
        agent.thread_id === threadId,
    )
    ?.name.trim();
  return name ? `@${name}` : undefined;
}
