/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  get_leaf_ids_in_order,
  get_node,
} from "@cocalc/frontend/frame-editors/frame-tree/tree-ops";

export function agentWorkspaceKey(
  agent: Pick<NamedAgent, "endpoint" | "path">,
): string {
  return `${agent.endpoint.project_id}\0${agent.path}`;
}

export function findWorkspaceAgentForThread(
  agents: NamedAgent[],
  projectId: string,
  path: string,
  threadId: string | undefined,
): NamedAgent | undefined {
  if (!threadId) return undefined;
  return agents.find(
    (agent) =>
      agent.endpoint.project_id === projectId &&
      agent.path === path &&
      agent.thread_id === threadId,
  );
}

export function selectedChatThreadFromLocalViewState(
  localViewState: any,
): string | undefined {
  const tree = localViewState?.get?.("frame_tree");
  if (!tree) return undefined;
  const activeId = localViewState?.get?.("active_id");
  const activeNode = activeId ? get_node(tree, activeId) : undefined;
  const activeThread = selectedThreadFromNode(activeNode);
  if (activeThread) return activeThread;
  for (const id of get_leaf_ids_in_order(tree)) {
    const thread = selectedThreadFromNode(get_node(tree, id));
    if (thread) return thread;
  }
  return undefined;
}

function selectedThreadFromNode(node: any): string | undefined {
  if (node?.get?.("type") !== "chatroom") return undefined;
  const value = node.get("data-selectedThreadKey");
  if (typeof value !== "string") return undefined;
  const thread = value.trim();
  return thread || undefined;
}
