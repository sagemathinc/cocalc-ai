/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CodexThreadConfig } from "@cocalc/chat";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import type { CodexReasoningId } from "@cocalc/util/ai/codex";

const AGENT_NAME_COUNTER_PREFIX = "cocalc-agent-name-counter-v1";

export function suggestedAgentProjectTitle(request: string): string {
  const firstLine = request.split(/\r?\n/, 1)[0].trim();
  const title = firstLine.replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!title) return "My first project";
  return title.length <= 80 ? title : `${title.slice(0, 77).trimEnd()}...`;
}

export async function createDefaultAgentProject({
  request,
  createProject,
}: {
  request: string;
  createProject: (opts: { title: string; start: false }) => Promise<string>;
}): Promise<{ projectId: string; title: string }> {
  const title = suggestedAgentProjectTitle(request);
  const projectId = await createProject({ title, start: false });
  return { projectId, title };
}

export function newAgentFundingConfig<T extends CodexThreadConfig>({
  config,
  paymentSource,
  useSubscriptionDefault,
}: {
  config: T;
  paymentSource?: CodexPaymentSourceInfo;
  useSubscriptionDefault: boolean;
}): T {
  const policy =
    paymentSource?.source === "site-api-key" &&
    paymentSource.siteFundedCodex?.enabled
      ? paymentSource.siteFundedCodex.policy
      : undefined;
  if (policy) {
    return {
      ...config,
      model: policy.model,
      reasoning: policy.reasoning as CodexReasoningId,
    };
  }
  if (paymentSource?.source === "subscription" && useSubscriptionDefault) {
    return { ...config, model: "gpt-6-sol", reasoning: "medium" };
  }
  return config;
}

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
