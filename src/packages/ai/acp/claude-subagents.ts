/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Claude's subagents, as CoCalc subagent events.

claude-agent-acp reports a subagent as an ordinary tool call named "Agent"
(`_meta.claudeCode.toolName`), and everything the subagent does as updates
stamped with `_meta.claudeCode.parentToolUseId` = that call's id. This turns
the Agent calls into the `subagent` events Codex turns already produce, so the
chat shows "N subagents working" and the subagents panel for Claude too.
*/

import type { AcpStreamEvent } from "@cocalc/conat/ai/acp/types";

export type SubagentEvent = Extract<AcpStreamEvent, { type: "subagent" }>;

const MAX_TEXT = 2_000;
const MAX_AGENTS = 256;

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (!text) return;
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}...`;
}

function claudeMeta(update: any): Record<string, unknown> | undefined {
  const meta = update?._meta?.claudeCode;
  return meta && typeof meta === "object" ? meta : undefined;
}

/** The Agent call an update belongs to, if a subagent produced it. */
export function claudeParentToolUseId(update: unknown): string | undefined {
  const id = claudeMeta(update)?.parentToolUseId;
  return typeof id === "string" && id.length > 0 && id.length <= 1024
    ? id
    : undefined;
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return;
  const parts: string[] = [];
  for (const item of content.slice(0, 16)) {
    const text = item?.type === "content" ? item.content?.text : undefined;
    if (typeof text === "string") parts.push(text);
  }
  return bounded(parts.join("\n"));
}

function stateFromStatus(status: unknown): SubagentEvent["state"] | undefined {
  switch (status) {
    case "pending":
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

interface Agent {
  state: SubagentEvent["state"];
  task?: string;
  model?: string;
}

export class ClaudeSubagentTracker {
  private readonly agents = new Map<string, Agent>();

  /** The subagent event an ACP session update implies, if any. */
  observe(update: any): SubagentEvent | undefined {
    if (
      update?.sessionUpdate !== "tool_call" &&
      update?.sessionUpdate !== "tool_call_update"
    ) {
      return;
    }
    const id = update.toolCallId;
    if (typeof id !== "string" || !id || id.length > 1024) return;
    let agent = this.agents.get(id);
    if (agent == null) {
      // Only the tool_call that starts an Agent call says what it is.
      if (
        update.sessionUpdate !== "tool_call" ||
        claudeMeta(update)?.toolName !== "Agent" ||
        this.agents.size >= MAX_AGENTS
      ) {
        return;
      }
      agent = { state: "running" };
      this.agents.set(id, agent);
    }
    const input =
      update.rawInput && typeof update.rawInput === "object"
        ? update.rawInput
        : undefined;
    const task = bounded(input?.description) ?? bounded(input?.prompt);
    if (task) agent.task = task;
    if (typeof input?.model === "string") agent.model = bounded(input.model);
    const state = stateFromStatus(update.status) ?? agent.state;
    agent.state = state;
    return {
      type: "subagent",
      operationId: id,
      threadId: id,
      state,
      tool: update.sessionUpdate === "tool_call" ? "spawn" : "activity",
      task: agent.task,
      message:
        state === "completed" || state === "failed"
          ? contentText(update.content)
          : undefined,
      model: agent.model,
    };
  }

  /**
   * At the end of the turn: subagents that never reported an outcome. A
   * cancelled turn interrupted them; otherwise their outcome is unknown.
   */
  finish(stopReason: string | undefined): SubagentEvent[] {
    const events: SubagentEvent[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.state !== "running") continue;
      agent.state = stopReason === "cancelled" ? "interrupted" : "unknown";
      events.push({
        type: "subagent",
        operationId: `finish:${id}`,
        threadId: id,
        state: agent.state,
        tool: "activity",
        task: agent.task,
        message:
          agent.state === "interrupted"
            ? "The turn was cancelled."
            : "The turn ended before this subagent reported its outcome.",
      });
    }
    return events;
  }
}
