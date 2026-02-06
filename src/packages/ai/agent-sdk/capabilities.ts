/*
Capability descriptors and registry for the CoCalc agent SDK.
*/

import type {
  AgentActionEnvelope,
  AgentActionHandler,
  AgentActionScope,
  AgentHandlerContext,
  AgentRiskLevel,
} from "./types";

export type AgentArgsValidator<TArgs> = (
  args: unknown,
  action: AgentActionEnvelope,
) => TArgs;

export type AgentPrecondition<TContext = unknown> = (
  context: AgentHandlerContext<TContext>,
  action: AgentActionEnvelope,
) => Promise<void> | void;

export type AgentCapabilityDescriptor<
  TArgs = unknown,
  TResult = unknown,
  TContext = unknown,
> = {
  actionType: string;
  namespace?: string;
  summary: string;
  description?: string;
  riskLevel?: AgentRiskLevel;
  sideEffectScope?: AgentActionScope;
  requiresConfirmationByDefault?: boolean;
  supportsDryRun?: boolean;
  reversible?: boolean;
  tags?: string[];
  validateArgs?: AgentArgsValidator<TArgs>;
  preconditions?: AgentPrecondition<TContext>[];
  handler: AgentActionHandler<TArgs, TResult, TContext>;
};

type AnyCapabilityDescriptor<TContext> = AgentCapabilityDescriptor<
  unknown,
  unknown,
  TContext
>;

export class AgentCapabilityRegistry<TContext = unknown> {
  private readonly capabilities = new Map<string, AnyCapabilityDescriptor<TContext>>();

  register<TArgs, TResult>(
    descriptor: AgentCapabilityDescriptor<TArgs, TResult, TContext>,
  ): this {
    if (this.capabilities.has(descriptor.actionType)) {
      throw new Error(`Capability '${descriptor.actionType}' is already registered`);
    }
    this.capabilities.set(descriptor.actionType, descriptor);
    return this;
  }

  registerMany(
    descriptors: AgentCapabilityDescriptor<unknown, unknown, TContext>[],
  ): this {
    for (const descriptor of descriptors) {
      this.register(descriptor);
    }
    return this;
  }

  get(actionType: string): AnyCapabilityDescriptor<TContext> | undefined {
    return this.capabilities.get(actionType);
  }

  list(): AnyCapabilityDescriptor<TContext>[] {
    return [...this.capabilities.values()];
  }
}

