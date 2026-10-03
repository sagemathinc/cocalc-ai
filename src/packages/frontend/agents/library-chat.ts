/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";

// Hand-made artifacts live in each project's Library conversation (see
// library-create). Artifacts lists them as from "@artifacts".
export const LIBRARY_CHAT_SUFFIX = "/.local/share/cocalc/artifacts.chat";
const LIBRARY_AGENT_PREFIX = "library:";

export function isLibraryChat(path: string): boolean {
  return path.endsWith(LIBRARY_CHAT_SUFFIX);
}

export function libraryChatAgent(
  project_id: string,
  path: string,
  thread_id: string,
): NamedAgent {
  return {
    account_id: "",
    name: "artifacts",
    endpoint: { project_id, agent_id: `${LIBRARY_AGENT_PREFIX}${project_id}` },
    path,
    thread_id,
    thread_title: "Artifacts",
    available: true,
    updated_at: new Date(0).toISOString(),
  };
}

export function isLibraryChatAgent(agent: Pick<NamedAgent, "endpoint">) {
  return agent.endpoint.agent_id.startsWith(LIBRARY_AGENT_PREFIX);
}
