/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  redux,
  useEffect,
  useMemo,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  markAgentOpened,
  moveAgent,
  moveAgentBefore,
  MY_AGENTS_ORGANIZATION_SETTING,
  normalizeAgentWorkspaceOrganization,
  organizeAgents,
  setAgentPinned,
  type AgentWorkspaceOrganization,
} from "./workspace-organization";

export function useAgentWorkspaceOrganization(
  agents: NamedAgent[],
  activeAgentId?: string,
) {
  const accountId = useTypedRedux("account", "account_id");
  const otherSettings = useTypedRedux("account", "other_settings");
  const organization = useMemo(
    () =>
      normalizeAgentWorkspaceOrganization(
        otherSettings?.get?.(MY_AGENTS_ORGANIZATION_SETTING),
      ),
    [otherSettings],
  );
  const groups = useMemo(
    () => organizeAgents(agents, organization),
    [agents, organization],
  );
  const openedAgentId =
    activeAgentId ??
    groups.pinned[0]?.endpoint.agent_id ??
    groups.unpinned[0]?.endpoint.agent_id;

  function latest(): AgentWorkspaceOrganization {
    return normalizeAgentWorkspaceOrganization(
      redux
        .getStore("account")
        ?.get("other_settings")
        ?.get?.(MY_AGENTS_ORGANIZATION_SETTING),
    );
  }

  function save(value: AgentWorkspaceOrganization) {
    redux
      .getActions("account")
      .set_other_settings(MY_AGENTS_ORGANIZATION_SETTING, value);
  }

  useEffect(() => {
    if (!accountId || !openedAgentId) return;
    const timer = setTimeout(() => {
      if (redux.getStore("account")?.get("account_id") !== accountId) return;
      save(markAgentOpened(latest(), openedAgentId));
    }, 750);
    return () => clearTimeout(timer);
  }, [accountId, openedAgentId]);

  return {
    organization,
    groups,
    setMode(mode: AgentWorkspaceOrganization["mode"]) {
      save({ ...latest(), mode });
    },
    setPinned(agentId: string, pinned: boolean) {
      save(setAgentPinned(agents, latest(), agentId, pinned));
    },
    move(agentId: string, delta: -1 | 1) {
      save(moveAgent(agents, latest(), agentId, delta));
    },
    moveBefore(agentId: string, beforeAgentId: string) {
      save(moveAgentBefore(agents, latest(), agentId, beforeAgentId));
    },
  };
}
