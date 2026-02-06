import { authFirstRequireAccount } from "./util";

export const agent = {
  execute: authFirstRequireAccount,
  manifest: authFirstRequireAccount,
};

export type AgentExecuteRequest = {
  account_id?: string;
  action: {
    actionType: string;
    args: unknown;
    target?: Record<string, string>;
    riskLevel?: string;
    requiresConfirmation?: boolean;
    idempotencyKey?: string;
    auditContext?: Record<string, unknown>;
    dryRun?: boolean;
  };
  actor?: {
    accountId?: string;
    userId?: string;
    email?: string;
    role?: string;
  };
  confirmationToken?: string;
  defaults?: {
    accountId?: string;
    projectId?: string;
  };
};

export type AgentExecuteResponse = {
  status: "completed" | "blocked" | "failed";
  requestId: string;
  actionType: string;
  result?: unknown;
  error?: string;
  reason?: string;
  blockedByPolicy?: boolean;
  requiresConfirmation?: boolean;
  idempotentReplay?: boolean;
};

export type AgentManifestEntry = {
  actionType: string;
  namespace?: string;
  summary: string;
  description?: string;
  riskLevel: string;
  sideEffectScope: string;
  requiresConfirmationByDefault: boolean;
  supportsDryRun: boolean;
  reversible: boolean;
  tags: string[];
};

export interface AgentApi {
  execute: (opts: AgentExecuteRequest) => Promise<AgentExecuteResponse>;
  manifest: (opts?: { account_id?: string }) => Promise<AgentManifestEntry[]>;
}
