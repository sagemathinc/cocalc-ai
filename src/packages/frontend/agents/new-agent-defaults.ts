/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CodexThreadConfig } from "@cocalc/chat";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const AGENT_NAME_COUNTER_PREFIX = "cocalc-agent-name-counter-v1";

function agentNameCounterKey(accountId?: string): string {
  return `${AGENT_NAME_COUNTER_PREFIX}:${accountId ?? "anonymous"}`;
}

export function suggestedAgentName(
  agents: NamedAgent[],
  accountId?: string,
): string {
  const used = new Set(agents.map(({ name }) => name));
  const observed = agents.reduce((maximum, { name }) => {
    const match = /^agent-(\d+)$/.exec(name);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  let remembered = 0;
  try {
    remembered = Number.parseInt(
      globalThis.localStorage?.getItem(agentNameCounterKey(accountId)) ?? "0",
      10,
    );
  } catch {
    // Local storage is only a monotonic naming convenience.
  }
  for (
    let index = Math.max(1, observed + 1, remembered + 1);
    index < 100_000;
    index += 1
  ) {
    const candidate = `agent-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `agent-${Date.now()}`;
}

export function rememberAgentName(name: string, accountId?: string): void {
  const match = /^agent-(\d+)$/.exec(name);
  if (!match) return;
  try {
    globalThis.localStorage?.setItem(agentNameCounterKey(accountId), match[1]);
  } catch {
    // Naming still works when storage is unavailable.
  }
}

export function freshAgentExecutionConfig(
  source?: CodexThreadConfig,
): CodexThreadConfig {
  if (!source) return {};
  const executionConfig = { ...source };
  delete executionConfig.sessionId;
  return executionConfig;
}
