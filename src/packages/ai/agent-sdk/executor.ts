/*
Policy-gated executor for agent actions.
*/

import type { AgentCapabilityRegistry } from "./capabilities";
import { defaultPolicyEvaluator, type AgentPolicyEvaluator } from "./policy";
import type {
  AgentActionEnvelope,
  AgentActionResult,
  AgentActor,
  AgentAuditEvent,
  AgentAuditEventStatus,
} from "./types";

export type AgentIdempotencyStore = {
  get(key: string): Promise<AgentActionResult | undefined>;
  set(key: string, value: AgentActionResult): Promise<void>;
};

export type AgentAuditSink = {
  record(event: AgentAuditEvent): Promise<void> | void;
};

export type AgentExecutorOptions<TContext = unknown> = {
  registry: AgentCapabilityRegistry<TContext>;
  policy?: AgentPolicyEvaluator<TContext>;
  idempotencyStore?: AgentIdempotencyStore;
  audit?: AgentAuditSink;
  requestIdFactory?: () => string;
};

export type ExecuteActionInput<TContext = unknown> = {
  action: AgentActionEnvelope;
  actor?: AgentActor;
  context: TContext;
  confirmationToken?: string;
  signal?: AbortSignal;
  now?: Date;
};

function createRequestId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export class AgentExecutor<TContext = unknown> {
  private readonly registry: AgentCapabilityRegistry<TContext>;
  private readonly policy: AgentPolicyEvaluator<TContext>;
  private readonly idempotencyStore?: AgentIdempotencyStore;
  private readonly audit?: AgentAuditSink;
  private readonly requestIdFactory: () => string;

  constructor(options: AgentExecutorOptions<TContext>) {
    this.registry = options.registry;
    this.policy = options.policy ?? defaultPolicyEvaluator;
    this.idempotencyStore = options.idempotencyStore;
    this.audit = options.audit;
    this.requestIdFactory = options.requestIdFactory ?? createRequestId;
  }

  async execute(input: ExecuteActionInput<TContext>): Promise<AgentActionResult> {
    const requestId = this.requestIdFactory();
    const { action, actor } = input;
    const descriptor = this.registry.get(action.actionType);
    if (descriptor == null) {
      return {
        status: "failed",
        requestId,
        actionType: action.actionType,
        error: `Unknown action '${action.actionType}'`,
      };
    }

    if (action.idempotencyKey && this.idempotencyStore) {
      const cached = await this.idempotencyStore.get(action.idempotencyKey);
      if (cached) {
        return {
          ...cached,
          requestId,
          actionType: action.actionType,
          idempotentReplay: true,
        };
      }
    }

    const now = input.now ?? new Date();
    const handlerContext = {
      requestId,
      actor,
      context: input.context,
      dryRun: action.dryRun ?? false,
      confirmationToken: input.confirmationToken,
      signal: input.signal,
      now,
    };

    const policyDecision = await this.policy({
      action,
      descriptor,
      actor,
      context: input.context,
    });
    if (!policyDecision.allow) {
      const blocked: AgentActionResult = {
        status: "blocked",
        requestId,
        actionType: action.actionType,
        blockedByPolicy: true,
        reason: policyDecision.reason ?? "Action denied by policy",
      };
      await this.recordAudit(requestId, action.actionType, actor, "blocked", {
        reason: blocked.reason,
        blockedByPolicy: true,
      });
      return blocked;
    }

    const requiresConfirmation =
      action.requiresConfirmation ??
      descriptor.requiresConfirmationByDefault ??
      policyDecision.requiresConfirmation ??
      false;
    if (requiresConfirmation && !input.confirmationToken) {
      const blocked: AgentActionResult = {
        status: "blocked",
        requestId,
        actionType: action.actionType,
        requiresConfirmation: true,
        reason: "Action requires confirmation",
      };
      await this.recordAudit(requestId, action.actionType, actor, "blocked", {
        reason: blocked.reason,
        requiresConfirmation: true,
      });
      return blocked;
    }

    let parsedArgs: unknown = action.args;
    try {
      if (descriptor.validateArgs) {
        parsedArgs = descriptor.validateArgs(action.args, action);
      }
    } catch (err) {
      const failed: AgentActionResult = {
        status: "failed",
        requestId,
        actionType: action.actionType,
        error: `Invalid arguments: ${getErrorMessage(err)}`,
      };
      await this.recordAudit(requestId, action.actionType, actor, "failed", {
        error: failed.error,
      });
      return failed;
    }

    try {
      for (const precondition of descriptor.preconditions ?? []) {
        await precondition(handlerContext, action);
      }
    } catch (err) {
      const blocked: AgentActionResult = {
        status: "blocked",
        requestId,
        actionType: action.actionType,
        reason: `Precondition failed: ${getErrorMessage(err)}`,
      };
      await this.recordAudit(requestId, action.actionType, actor, "blocked", {
        reason: blocked.reason,
      });
      return blocked;
    }

    await this.recordAudit(requestId, action.actionType, actor, "started", {
      dryRun: handlerContext.dryRun,
    });

    try {
      const result = await descriptor.handler(parsedArgs, handlerContext);
      const completed: AgentActionResult = {
        status: "completed",
        requestId,
        actionType: action.actionType,
        result,
      };
      if (action.idempotencyKey && this.idempotencyStore) {
        await this.idempotencyStore.set(action.idempotencyKey, completed);
      }
      await this.recordAudit(requestId, action.actionType, actor, "completed");
      return completed;
    } catch (err) {
      const failed: AgentActionResult = {
        status: "failed",
        requestId,
        actionType: action.actionType,
        error: getErrorMessage(err),
      };
      await this.recordAudit(requestId, action.actionType, actor, "failed", {
        error: failed.error,
      });
      return failed;
    }
  }

  private async recordAudit(
    requestId: string,
    actionType: string,
    actor: AgentActor | undefined,
    status: AgentAuditEventStatus,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) {
      return;
    }
    await this.audit.record({
      requestId,
      timestamp: new Date().toISOString(),
      actionType,
      actor,
      status,
      details,
    });
  }
}

