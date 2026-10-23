/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type { ProjectedChatThread } from "@cocalc/chat-client";

/** The qualified Claude Code harness (paid by the claude-code selection). */
export function isClaudeCode(
  runtime?: ProjectedChatThread["agent_runtime"],
): boolean {
  return runtime?.profile.version === 2 && runtime.profile.id === "claude-code";
}

/** What to call the agent in this thread in labels and status lines. */
export function agentName(
  thread?: Pick<ProjectedChatThread, "agent_runtime">,
): string {
  if (!thread?.agent_runtime) return "Codex";
  return isClaudeCode(thread.agent_runtime) ? "Claude" : "Agent";
}
