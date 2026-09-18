/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";

export const MY_AGENTS_ORGANIZATION_SETTING =
  "experimental_my_agents_organization_v1";

const MAX_REMEMBERED_AGENTS = 500;

export interface AgentWorkspaceOrganization {
  version: 1;
  mode: "recent" | "custom";
  pinned: string[];
  custom: string[];
  hidden: string[];
  lastOpened: Record<string, number>;
}

export const DEFAULT_AGENT_WORKSPACE_ORGANIZATION: AgentWorkspaceOrganization =
  {
    version: 1,
    mode: "recent",
    pinned: [],
    custom: [],
    hidden: [],
    lastOpened: {},
  };

function uniqueIds(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value)
          .filter(([key]) => /^\d+$/.test(key))
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, id]) => id)
      : [];
  return [...new Set(values.filter((id) => typeof id === "string"))].slice(
    0,
    MAX_REMEMBERED_AGENTS,
  ) as string[];
}

export function normalizeAgentWorkspaceOrganization(
  value: unknown,
): AgentWorkspaceOrganization {
  const plain =
    value != null && typeof (value as any).toJS === "function"
      ? (value as any).toJS()
      : value;
  if (!plain || typeof plain !== "object") {
    return { ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION };
  }
  const input = plain as Record<string, unknown>;
  let rawLastOpened = input.lastOpened;
  if (typeof rawLastOpened === "string") {
    try {
      rawLastOpened = JSON.parse(rawLastOpened);
    } catch {
      rawLastOpened = {};
    }
  }
  const lastOpened = Object.fromEntries(
    Object.entries(
      rawLastOpened && typeof rawLastOpened === "object" ? rawLastOpened : {},
    )
      .filter(
        ([id, at]) =>
          typeof id === "string" &&
          typeof at === "number" &&
          Number.isFinite(at) &&
          at > 0,
      )
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, MAX_REMEMBERED_AGENTS),
  );
  return {
    version: 1,
    mode: input.mode === "custom" ? "custom" : "recent",
    pinned: uniqueIds(input.pinned),
    custom: uniqueIds(input.custom),
    hidden: uniqueIds(input.hidden),
    lastOpened,
  };
}

/** Nested account settings merge maps recursively, so encode replaceable
 * collections as scalars. This makes unpin/removal reliable across clients. */
export function serializeAgentWorkspaceOrganization(
  value: AgentWorkspaceOrganization,
) {
  const normalized = normalizeAgentWorkspaceOrganization(value);
  return {
    version: 1 as const,
    mode: normalized.mode,
    pinned: JSON.stringify(normalized.pinned),
    custom: JSON.stringify(normalized.custom),
    hidden: JSON.stringify(normalized.hidden),
    lastOpened: JSON.stringify(normalized.lastOpened),
  };
}

function byName(a: NamedAgent, b: NamedAgent): number {
  return (a.thread_title || a.name).localeCompare(b.thread_title || b.name);
}

function inStoredOrder(agents: NamedAgent[], order: string[]): NamedAgent[] {
  const index = new Map(order.map((id, position) => [id, position]));
  return [...agents].sort((a, b) => {
    const ai = index.get(a.endpoint.agent_id);
    const bi = index.get(b.endpoint.agent_id);
    if (ai != null && bi != null) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return byName(a, b);
  });
}

export function organizeAgents(
  agents: NamedAgent[],
  organization: AgentWorkspaceOrganization,
): { pinned: NamedAgent[]; unpinned: NamedAgent[]; hidden: NamedAgent[] } {
  const pinnedIds = new Set(organization.pinned);
  const hiddenIds = new Set(organization.hidden);
  const pinned = inStoredOrder(
    agents.filter(
      ({ endpoint }) =>
        pinnedIds.has(endpoint.agent_id) && !hiddenIds.has(endpoint.agent_id),
    ),
    organization.pinned,
  );
  const remainder = agents.filter(
    ({ endpoint }) =>
      !pinnedIds.has(endpoint.agent_id) && !hiddenIds.has(endpoint.agent_id),
  );
  const hidden = inStoredOrder(
    agents.filter(({ endpoint }) => hiddenIds.has(endpoint.agent_id)),
    organization.hidden,
  );
  const unpinned =
    organization.mode === "custom"
      ? inStoredOrder(remainder, organization.custom)
      : [...remainder].sort((a, b) => {
          const delta =
            (organization.lastOpened[b.endpoint.agent_id] ?? 0) -
            (organization.lastOpened[a.endpoint.agent_id] ?? 0);
          return delta || byName(a, b);
        });
  return { pinned, unpinned, hidden };
}

export type AgentRecencySection = {
  key: "today" | "last7days" | "older";
  title: "Today" | "Last 7 days" | "Older";
  agents: NamedAgent[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function groupAgentsByRecency(
  agents: NamedAgent[],
  lastOpened: Record<string, number>,
  now = Date.now(),
): AgentRecencySection[] {
  const sections: AgentRecencySection[] = [
    { key: "today", title: "Today", agents: [] },
    { key: "last7days", title: "Last 7 days", agents: [] },
    { key: "older", title: "Older", agents: [] },
  ];
  for (const agent of agents) {
    const opened = lastOpened[agent.endpoint.agent_id] ?? 0;
    const delta = Math.max(0, now - opened);
    const section =
      opened > 0 && delta < DAY_MS
        ? sections[0]
        : opened > 0 && delta < 7 * DAY_MS
          ? sections[1]
          : sections[2];
    section.agents.push(agent);
  }
  return sections.filter(({ agents }) => agents.length > 0);
}

export function setAgentHidden(
  agents: NamedAgent[],
  organization: AgentWorkspaceOrganization,
  agentId: string,
  hidden: boolean,
): AgentWorkspaceOrganization {
  const current = organizeAgents(agents, organization);
  const hiddenIds = orderedIds(current.hidden).filter((id) => id !== agentId);
  if (hidden) hiddenIds.unshift(agentId);
  return {
    ...organization,
    hidden: hiddenIds,
    pinned: organization.pinned.filter((id) => id !== agentId),
    custom: organization.custom.filter((id) => id !== agentId),
  };
}

function orderedIds(agents: NamedAgent[]): string[] {
  return agents.map(({ endpoint }) => endpoint.agent_id);
}

export function setAgentPinned(
  agents: NamedAgent[],
  organization: AgentWorkspaceOrganization,
  agentId: string,
  pinned: boolean,
): AgentWorkspaceOrganization {
  const current = organizeAgents(agents, organization);
  const nextPinned = orderedIds(current.pinned).filter((id) => id !== agentId);
  if (pinned) nextPinned.push(agentId);
  return {
    ...organization,
    pinned: nextPinned,
    custom: orderedIds(current.unpinned).filter((id) => id !== agentId),
    hidden: organization.hidden.filter((id) => id !== agentId),
  };
}

export function moveAgent(
  agents: NamedAgent[],
  organization: AgentWorkspaceOrganization,
  agentId: string,
  delta: -1 | 1,
): AgentWorkspaceOrganization {
  const current = organizeAgents(agents, organization);
  const inPinned = current.pinned.some(
    ({ endpoint }) => endpoint.agent_id === agentId,
  );
  const ids = orderedIds(inPinned ? current.pinned : current.unpinned);
  const index = ids.indexOf(agentId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return organization;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return {
    ...organization,
    mode: inPinned ? organization.mode : "custom",
    ...(inPinned ? { pinned: ids } : { custom: ids }),
  };
}

export function moveAgentToIndex(
  agents: NamedAgent[],
  organization: AgentWorkspaceOrganization,
  agentId: string,
  newIndex: number,
): AgentWorkspaceOrganization {
  const current = organizeAgents(agents, organization);
  const inPinned = current.pinned.some(
    ({ endpoint }) => endpoint.agent_id === agentId,
  );
  const ids = orderedIds(inPinned ? current.pinned : current.unpinned);
  const oldIndex = ids.indexOf(agentId);
  if (
    oldIndex < 0 ||
    newIndex < 0 ||
    newIndex >= ids.length ||
    oldIndex === newIndex
  ) {
    return organization;
  }
  ids.splice(oldIndex, 1);
  ids.splice(newIndex, 0, agentId);
  return {
    ...organization,
    mode: inPinned ? organization.mode : "custom",
    ...(inPinned ? { pinned: ids } : { custom: ids }),
  };
}

export function moveAgentBefore(
  agents: NamedAgent[],
  organization: AgentWorkspaceOrganization,
  agentId: string,
  beforeAgentId: string,
): AgentWorkspaceOrganization {
  const current = organizeAgents(agents, organization);
  const pinnedIds = new Set(orderedIds(current.pinned));
  if (pinnedIds.has(agentId) !== pinnedIds.has(beforeAgentId)) {
    return organization;
  }
  const pinned = pinnedIds.has(agentId);
  const ids = orderedIds(pinned ? current.pinned : current.unpinned).filter(
    (id) => id !== agentId,
  );
  const target = ids.indexOf(beforeAgentId);
  if (target < 0) return organization;
  ids.splice(target, 0, agentId);
  return {
    ...organization,
    mode: pinned ? organization.mode : "custom",
    ...(pinned ? { pinned: ids } : { custom: ids }),
  };
}

export function markAgentActive(
  organization: AgentWorkspaceOrganization,
  agentId: string,
  at = Date.now(),
): AgentWorkspaceOrganization {
  if ((organization.lastOpened[agentId] ?? 0) >= at) return organization;
  return normalizeAgentWorkspaceOrganization({
    ...organization,
    lastOpened: { ...organization.lastOpened, [agentId]: at },
  });
}
