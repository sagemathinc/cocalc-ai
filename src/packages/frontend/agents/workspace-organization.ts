/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Native and web workspaces must interpret the same account preference identically.
export {
  MY_AGENTS_ORGANIZATION_SETTING,
  DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
  normalizeAgentWorkspaceOrganization,
  serializeAgentWorkspaceOrganization,
  organizeAgents,
  groupAgentsByRecency,
  groupAgentsByProject,
  moveAgentWithinProject,
  setAgentHidden,
  setAgentPinned,
  moveAgent,
  moveAgentToIndex,
  moveAgentBefore,
  markAgentActive,
} from "@cocalc/chat-client";
export type {
  AgentWorkspaceOrganization,
  AgentRecencySection,
  AgentProjectGroup,
} from "@cocalc/chat-client";
