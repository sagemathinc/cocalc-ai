/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Which runtime an agent uses, as a server-side fact about the agent (kept
// on its identity record), so lists can show it without loading the chat.

import { isCodexModelName } from "./codex";

export type AgentRuntimeKind = "codex" | "claude-code" | "acp";

export interface AgentRuntimeSummary {
  kind: AgentRuntimeKind;
  /** Harness id for generic ACP agents. */
  name?: string;
}

export function parseAgentRuntimeSummary(
  value: unknown,
): AgentRuntimeSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  if (obj.kind === "codex" || obj.kind === "claude-code")
    return { kind: obj.kind };
  if (obj.kind === "acp") {
    const name =
      typeof obj.name === "string" && obj.name.trim()
        ? obj.name.trim().slice(0, 100)
        : undefined;
    return { kind: "acp", ...(name ? { name } : {}) };
  }
}

export function agentRuntimeFromProfile(
  profile: { version: number; id: string } | undefined,
): AgentRuntimeSummary {
  if (!profile) return { kind: "codex" };
  if (profile.version === 2 && profile.id === "claude-code")
    return { kind: "claude-code" };
  return {
    kind: "acp",
    name: `${profile.id ?? ""}`.slice(0, 100) || undefined,
  };
}

/** From a chat thread's configuration; undefined if it is not an agent. */
export function agentRuntimeFromThread(thread: {
  agent_runtime?: { profile?: { version: number; id: string } } | null;
  agent_kind?: string | null;
  agent_model?: string | null;
  acp_config?: unknown;
}): AgentRuntimeSummary | undefined {
  if (thread.agent_runtime?.profile)
    return agentRuntimeFromProfile(thread.agent_runtime.profile);
  if (
    thread.agent_kind === "acp" ||
    thread.acp_config != null ||
    isCodexModelName(thread.agent_model ?? undefined)
  )
    return { kind: "codex" };
}

export function sameAgentRuntime(
  a: AgentRuntimeSummary | null | undefined,
  b: AgentRuntimeSummary | null | undefined,
): boolean {
  return (a?.kind ?? null) === (b?.kind ?? null) && a?.name === b?.name;
}

export function agentRuntimeLabel(runtime: AgentRuntimeSummary): string {
  if (runtime.kind === "codex") return "Codex";
  if (runtime.kind === "claude-code") return "Claude Code";
  return runtime.name ? `ACP: ${runtime.name}` : "ACP";
}
