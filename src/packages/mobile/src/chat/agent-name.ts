/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type { ProjectedChatThread } from "@cocalc/chat-client";

/** What to call the agent in this thread in labels and status lines. */
export function agentName(
  thread?: Pick<ProjectedChatThread, "agent_runtime">,
): string {
  const profile = thread?.agent_runtime?.profile;
  if (!profile) return "Codex";
  return profile.version === 2 && profile.id === "claude-code"
    ? "Claude"
    : "Agent";
}
