/*
Policy evaluation contracts and default policy behavior.
*/

import type { AgentCapabilityDescriptor } from "./capabilities";
import type { AgentActionEnvelope, AgentActor, AgentRiskLevel } from "./types";

export type AgentPolicyDecision = {
  allow: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
};

export type AgentPolicyInput<TContext = unknown> = {
  action: AgentActionEnvelope;
  descriptor: AgentCapabilityDescriptor<unknown, unknown, TContext>;
  actor?: AgentActor;
  context: TContext;
};

export type AgentPolicyEvaluator<TContext = unknown> = (
  input: AgentPolicyInput<TContext>,
) => Promise<AgentPolicyDecision> | AgentPolicyDecision;

const CONFIRMATION_RISKS = new Set<AgentRiskLevel>([
  "destructive",
  "access",
  "billing",
  "network",
  "install",
]);

export function defaultPolicyEvaluator<TContext = unknown>({
  action,
  descriptor,
}: AgentPolicyInput<TContext>): AgentPolicyDecision {
  const risk = action.riskLevel ?? descriptor.riskLevel ?? "write";
  if (risk === "read") {
    return { allow: true, requiresConfirmation: false };
  }
  if (CONFIRMATION_RISKS.has(risk)) {
    return { allow: true, requiresConfirmation: true };
  }
  return { allow: true, requiresConfirmation: false };
}

