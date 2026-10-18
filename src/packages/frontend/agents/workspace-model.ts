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

/** The thread shown in each chat frame, by frame id. */
export function chatThreadsByFrame(localViewState: any): Map<string, string> {
  const threads = new Map<string, string>();
  const tree = localViewState?.get?.("frame_tree");
  if (!tree) return threads;
  for (const id of get_leaf_ids_in_order(tree)) {
    const thread = selectedThreadFromNode(get_node(tree, id));
    if (thread) threads.set(id, thread);
  }
  return threads;
}

const ROUTE_ECHO_TIMEOUT_MS = 3000;
// After a route switch, a change back to the thread just left is a late echo.
const SETTLE_MS = 1500;
const MAX_REPORTS = 3;
const REPORT_WINDOW_MS = 2000;

/**
 * Agent selection has one owner: the route. The embedded chat is told which
 * thread to show, and this decides which of its view-state changes are the
 * person picking another thread there. Only a chat frame switching to a
 * different thread counts. Focusing another frame (opening an artifact or a
 * terminal) does not, nor does the late echo of an earlier selection while
 * a route change is being applied, or right after it was applied. A
 * runaway loop is cut off after three reports in two seconds.
 */
export class AgentSelectionReporter {
  private frames = new Map<string, string>();
  private pending?: { thread: string; at: number };
  private left?: { thread: string; until: number };
  private route?: string;
  private reports: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The route asked the embedded chat to show this thread. */
  requested(threadId: string, localViewState: any): void {
    if (this.route != null && this.route !== threadId) {
      this.left = { thread: this.route, until: this.now() + SETTLE_MS };
    }
    this.route = threadId;
    this.frames = chatThreadsByFrame(localViewState);
    const shown = selectedChatThreadFromLocalViewState(localViewState);
    this.pending =
      shown === threadId ? undefined : { thread: threadId, at: this.now() };
  }

  /** The thread the person selected in the chat, if this change is one. */
  viewStateChanged(
    localViewState: any,
    routeThread: string,
  ): string | undefined {
    const next = chatThreadsByFrame(localViewState);
    const previous = this.frames;
    this.frames = next;
    const changed = [...next].filter(
      ([id, thread]) => previous.has(id) && previous.get(id) !== thread,
    );
    if (changed.length === 0) return undefined;
    const activeId = localViewState?.get?.("active_id");
    const thread = (changed.find(([id]) => id === activeId) ?? changed[0])[1];
    if (this.pending) {
      if (this.now() - this.pending.at > ROUTE_ECHO_TIMEOUT_MS) {
        this.pending = undefined;
      } else if (thread !== this.pending.thread) {
        return undefined; // a stale view of the previous selection
      } else {
        this.pending = undefined;
        if (this.left) this.left.until = this.now() + SETTLE_MS;
        return thread;
      }
    }
    if (thread === routeThread) return thread;
    const now = this.now();
    if (this.left && thread === this.left.thread && now < this.left.until) {
      return undefined; // the previous selection echoing back
    }
    this.reports = this.reports.filter((at) => now - at < REPORT_WINDOW_MS);
    if (this.reports.length >= MAX_REPORTS) {
      console.warn(
        "agent selection is changing repeatedly; ignoring the chat's selection of",
        thread,
      );
      return undefined;
    }
    this.reports.push(now);
    return thread;
  }
}
