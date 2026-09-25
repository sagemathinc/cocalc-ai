import type { NamedAgent } from "@cocalc/conat/agents/personal";

export function agentProjectTitle(
  agent: NamedAgent,
  currentTitle?: string,
): string {
  return currentTitle?.trim() || agent.project_title?.trim() || "Agent project";
}
