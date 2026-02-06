/*
Hub `agent.*` API contract and auth transform metadata.

Who calls this:
- Any caller using `initHubApi(...)` (browser/frontend, lite clients, server code)
  can invoke `hub.agent.execute(...)`, `hub.agent.manifest(...)`, and
  `hub.agent.plan(...)`.
- On the server/lite side, the hub request dispatcher uses this file via
  `transformArgs` in `conat/hub/api/index.ts` to enforce account auth and
  shape typed request/response signatures.
*/
import { authFirstRequireAccount } from "./util";

export const agent = {
  execute: authFirstRequireAccount,
  manifest: authFirstRequireAccount,
  plan: authFirstRequireAccount,
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
  argsSchema?: unknown;
  riskLevel: string;
  sideEffectScope: string;
  requiresConfirmationByDefault: boolean;
  supportsDryRun: boolean;
  reversible: boolean;
  tags: string[];
};

export type AgentPlanRequest = {
  account_id?: string;
  prompt: string;
  manifest?: AgentManifestEntry[];
  model?: string;
  maxActions?: number;
  defaults?: {
    accountId?: string;
    projectId?: string;
  };
};

export type AgentPlanResponse = {
  status: "planned" | "failed";
  requestId: string;
  plan?: {
    summary?: string;
    actions: AgentExecuteRequest["action"][];
  };
  error?: string;
  raw?: string;
};

export interface AgentApi {
  execute: (opts: AgentExecuteRequest) => Promise<AgentExecuteResponse>;
  manifest: (opts?: { account_id?: string }) => Promise<AgentManifestEntry[]>;
  plan: (opts: AgentPlanRequest) => Promise<AgentPlanResponse>;
}
