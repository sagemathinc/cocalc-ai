/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type NamedAgentExecutionState =
  | "enabled"
  | "disabled"
  | "legacy-missing";

export function namedAgentExecutionState(metadata: {
  agent_kind?: string | null;
  acp_config?: unknown;
}): NamedAgentExecutionState {
  if (metadata.agent_kind === "acp" || metadata.acp_config != null) {
    return "enabled";
  }
  if (metadata.agent_kind === "none") return "disabled";
  return "legacy-missing";
}
