/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useEditorRedux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const ACTIVE_ACP_STATES = new Set(["queue", "sending", "sent", "running"]);

export function agentThreadIsRunning(acpState: any, threadId: string): boolean {
  const state = acpState?.get?.(`thread:${threadId}`);
  return (
    typeof state === "string" &&
    ACTIVE_ACP_STATES.has(state.trim().toLowerCase())
  );
}

export function AgentRunningIndicator({
  agent,
  children,
}: {
  agent: NamedAgent;
  children: ReactNode;
}) {
  const useEditor = useEditorRedux<{ acpState?: any }>({
    project_id: agent.endpoint.project_id,
    path: agent.path,
  });
  const acpState = useEditor("acpState");
  const running = agentThreadIsRunning(acpState, agent.thread_id);

  return (
    <span
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        position: "relative",
      }}
    >
      {children}
      {running ? (
        <Tooltip title="Agent is running">
          <span
            role="status"
            aria-label={`@${agent.name} is running`}
            style={{
              background: UI_COLORS.success,
              border: `2px solid ${UI_COLORS.surface}`,
              borderRadius: "50%",
              bottom: -2,
              boxSizing: "border-box",
              height: 11,
              position: "absolute",
              right: -2,
              width: 11,
            }}
          />
        </Tooltip>
      ) : null}
    </span>
  );
}
