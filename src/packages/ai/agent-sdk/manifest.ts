/*
Build machine-readable capability manifests for planner grounding.
*/

import type { AgentCapabilityDescriptor, AgentCapabilityRegistry } from "./capabilities";
import type { AgentActionScope, AgentRiskLevel } from "./types";

export type AgentCapabilityManifestEntry = {
  actionType: string;
  namespace?: string;
  summary: string;
  description?: string;
  argsSchema?: unknown;
  riskLevel: AgentRiskLevel;
  sideEffectScope: AgentActionScope;
  requiresConfirmationByDefault: boolean;
  supportsDryRun: boolean;
  reversible: boolean;
  tags: string[];
};

function toEntry<TContext = unknown>(
  descriptor: AgentCapabilityDescriptor<unknown, unknown, TContext>,
): AgentCapabilityManifestEntry {
  return {
    actionType: descriptor.actionType,
    namespace: descriptor.namespace,
    summary: descriptor.summary,
    description: descriptor.description,
    ...(descriptor.argsSchema != null
      ? { argsSchema: descriptor.argsSchema }
      : {}),
    riskLevel: descriptor.riskLevel ?? "write",
    sideEffectScope: descriptor.sideEffectScope ?? "project",
    requiresConfirmationByDefault:
      descriptor.requiresConfirmationByDefault ?? false,
    supportsDryRun: descriptor.supportsDryRun ?? true,
    reversible: descriptor.reversible ?? false,
    tags: [...(descriptor.tags ?? [])],
  };
}

export function buildCapabilityManifest<TContext = unknown>(
  registry:
    | AgentCapabilityRegistry<TContext>
    | AgentCapabilityDescriptor<unknown, unknown, TContext>[],
): AgentCapabilityManifestEntry[] {
  const descriptors = Array.isArray(registry) ? registry : registry.list();
  return descriptors
    .map((descriptor) => toEntry(descriptor))
    .sort((a, b) => a.actionType.localeCompare(b.actionType));
}
