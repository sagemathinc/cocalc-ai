/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  redux,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { getLogger } from "@cocalc/frontend/logger";
import {
  markAgentOpened,
  moveAgent,
  moveAgentBefore,
  moveAgentToIndex,
  MY_AGENTS_ORGANIZATION_SETTING,
  normalizeAgentWorkspaceOrganization,
  organizeAgents,
  serializeAgentWorkspaceOrganization,
  setAgentPinned,
  type AgentWorkspaceOrganization,
} from "./workspace-organization";

const logger = getLogger("my-agents-workspace-organization");

export function useAgentWorkspaceOrganization(
  agents: NamedAgent[],
  activeAgentId?: string,
) {
  const accountId = useTypedRedux("account", "account_id");
  const otherSettings = useTypedRedux("account", "other_settings");
  const persisted = useMemo(
    () =>
      normalizeAgentWorkspaceOrganization(
        otherSettings?.get?.(MY_AGENTS_ORGANIZATION_SETTING),
      ),
    [otherSettings],
  );
  const [optimistic, setOptimistic] = useState<AgentWorkspaceOrganization>();
  const [saveError, setSaveError] = useState("");
  const latestRef = useRef(persisted);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const accountGenerationRef = useRef(0);
  const organization = optimistic ?? persisted;
  const groups = useMemo(
    () => organizeAgents(agents, organization),
    [agents, organization],
  );
  const openedAgentId =
    activeAgentId ??
    groups.pinned[0]?.endpoint.agent_id ??
    groups.unpinned[0]?.endpoint.agent_id;

  function save(value: AgentWorkspaceOrganization) {
    const generation = accountGenerationRef.current;
    latestRef.current = value;
    pendingRef.current += 1;
    setOptimistic(value);
    setSaveError("");
    queueRef.current = queueRef.current
      .catch(() => {})
      .then(async () => {
        if (
          generation !== accountGenerationRef.current ||
          redux.getStore("account")?.get("account_id") !== accountId
        ) {
          throw new Error("Account changed before organization could be saved");
        }
        await redux
          .getActions("account")
          .set_other_settings_and_wait(
            MY_AGENTS_ORGANIZATION_SETTING,
            serializeAgentWorkspaceOrganization(value),
          );
      })
      .catch((err) => {
        logger.warn("unable to save agent organization", err);
        if (generation === accountGenerationRef.current) {
          setSaveError("Unable to save agent organization. Try again.");
        }
      })
      .finally(() => {
        if (generation !== accountGenerationRef.current) return;
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0) setOptimistic(undefined);
      });
  }

  useEffect(() => {
    if (pendingRef.current === 0) latestRef.current = persisted;
  }, [persisted]);

  useEffect(() => {
    accountGenerationRef.current += 1;
    pendingRef.current = 0;
    latestRef.current = persisted;
    setOptimistic(undefined);
    setSaveError("");
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !openedAgentId) return;
    const timer = setTimeout(() => {
      if (redux.getStore("account")?.get("account_id") !== accountId) return;
      save(markAgentOpened(latestRef.current, openedAgentId));
    }, 750);
    return () => clearTimeout(timer);
  }, [accountId, openedAgentId]);

  return {
    organization,
    groups,
    saveError,
    setMode(mode: AgentWorkspaceOrganization["mode"]) {
      save({ ...latestRef.current, mode });
    },
    setPinned(agentId: string, pinned: boolean) {
      save(setAgentPinned(agents, latestRef.current, agentId, pinned));
    },
    move(agentId: string, delta: -1 | 1) {
      save(moveAgent(agents, latestRef.current, agentId, delta));
    },
    moveBefore(agentId: string, beforeAgentId: string) {
      save(moveAgentBefore(agents, latestRef.current, agentId, beforeAgentId));
    },
    moveToIndex(agentId: string, newIndex: number) {
      save(moveAgentToIndex(agents, latestRef.current, agentId, newIndex));
    },
  };
}
