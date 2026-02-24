import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";

export const AGENT_DOCK_OPEN_EVENT = "cocalc:agent-dock:open";
export const AGENT_DOCK_CLOSE_EVENT = "cocalc:agent-dock:close";

export interface AgentDockOpenDetail {
  projectId: string;
  session: AgentSessionRecord;
}

export interface AgentDockCloseDetail {
  projectId: string;
}

export function openFloatingAgentSession(
  projectId: string,
  session: AgentSessionRecord,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AgentDockOpenDetail>(AGENT_DOCK_OPEN_EVENT, {
      detail: { projectId, session },
    }),
  );
}

export function closeFloatingAgentSession(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AgentDockCloseDetail>(AGENT_DOCK_CLOSE_EVENT, {
      detail: { projectId },
    }),
  );
}
