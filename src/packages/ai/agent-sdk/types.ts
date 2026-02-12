/*
Core shared types for the CoCalc agent SDK control plane.
*/

export type AgentRiskLevel =
  | "read"
  | "write"
  | "destructive"
  | "access"
  | "billing"
  | "network"
  | "install";

export type AgentActionScope =
  | "ui"
  | "workspace"
  | "project"
  | "account"
  | "system";

export type AgentExecutionStatus = "completed" | "blocked" | "failed";

export type AgentActor = {
  accountId?: string;
  userId?: string;
  email?: string;
  role?: string;
};

export type AgentActionEnvelope<TArgs = unknown> = {
  actionType: string;
  args: TArgs;
  target?: Record<string, string>;
  riskLevel?: AgentRiskLevel;
  requiresConfirmation?: boolean;
  idempotencyKey?: string;
  auditContext?: Record<string, unknown>;
  dryRun?: boolean;
};

export type AgentHandlerContext<TContext = unknown> = {
  requestId: string;
  actor?: AgentActor;
  context: TContext;
  dryRun: boolean;
  confirmationToken?: string;
  signal?: AbortSignal;
  now: Date;
};

export type AgentActionHandler<
  TArgs = unknown,
  TResult = unknown,
  TContext = unknown,
> = (
  args: TArgs,
  context: AgentHandlerContext<TContext>,
) => Promise<TResult>;

export type AgentActionResult<TResult = unknown> = {
  status: AgentExecutionStatus;
  requestId: string;
  actionType: string;
  result?: TResult;
  error?: string;
  reason?: string;
  blockedByPolicy?: boolean;
  requiresConfirmation?: boolean;
  idempotentReplay?: boolean;
};

export type AgentAuditEventStatus = "started" | "completed" | "failed" | "blocked";

export type AgentAuditEvent = {
  requestId: string;
  timestamp: string;
  status: AgentAuditEventStatus;
  actionType: string;
  actor?: AgentActor;
  details?: Record<string, unknown>;
};

