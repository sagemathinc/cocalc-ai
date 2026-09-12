/*
Hub `agent.*` API contract and auth transform metadata.

Who calls this:
- Any caller using `initHubApi(...)` (browser/frontend, lite clients, server code)
  can invoke `hub.agent.execute(...)`, `hub.agent.manifest(...)`,
  `hub.agent.plan(...)`, and `hub.agent.run(...)`.
- On the server/lite side, the hub request dispatcher uses this file via
  `transformArgs` in `conat/hub/api/index.ts` to enforce account auth and
  shape typed request/response signatures.
*/
import {
  authFirstRequireAccount,
  authFirstRequireAccountWithBoundSession,
  authFirstRequireHostWithAccountTarget,
} from "./util";
import type {
  AgentIdentity,
  AgentCredential,
} from "@cocalc/conat/agents/protocol";

export const agent = {
  registerIdentity: authFirstRequireAccountWithBoundSession,
  listIdentities: authFirstRequireAccount,
  grantMessaging: authFirstRequireAccountWithBoundSession,
  revokeMessaging: authFirstRequireAccountWithBoundSession,
  disableIdentity: authFirstRequireAccountWithBoundSession,
  issueIdentity: authFirstRequireHostWithAccountTarget,
  endIdentityRun: authFirstRequireHostWithAccountTarget,
  authorizeDelivery: authFirstRequireHostWithAccountTarget,
  execute: authFirstRequireAccount,
  manifest: authFirstRequireAccount,
  plan: authFirstRequireAccount,
  run: authFirstRequireAccount,
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

export type AgentRunStep = {
  stepIndex: number;
  planner?: {
    summary?: string;
    raw?: string;
  };
  action?: AgentExecuteRequest["action"];
  execution?: AgentExecuteResponse;
  observation?: string;
};

export type AgentRunState = {
  goal: string;
  steps: AgentRunStep[];
  pendingConfirmation?: {
    stepIndex: number;
    action: AgentExecuteRequest["action"];
  };
  summary?: string;
};

export type AgentRunRequest = {
  account_id?: string;
  prompt: string;
  model?: string;
  maxSteps?: number;
  dryRun?: boolean;
  manifest?: AgentManifestEntry[];
  defaults?: {
    accountId?: string;
    projectId?: string;
  };
  state?: AgentRunState;
  confirmationToken?: string;
};

export type AgentRunResponse = {
  status: "completed" | "awaiting_confirmation" | "failed";
  requestId: string;
  state: AgentRunState;
  error?: string;
};

export interface AgentHumanAuth {
  account_id?: string;
  session_hash?: string;
}
export interface AgentHostAuth {
  account_id?: string;
  host_id?: string;
}
export interface AgentGrant {
  grant_id: string;
  source_agent_id: string;
  target_agent_id: string;
  allow_guidance: boolean;
  approved_by: string;
  reason: string;
  expires_at: Date | string;
  revoked_at?: Date | string | null;
}

export interface AgentApi {
  registerIdentity(
    opts: AgentHumanAuth & {
      project_id: string;
      path: string;
      thread_id: string;
    },
  ): Promise<AgentIdentity>;
  listIdentities(opts: {
    account_id?: string;
    project_id: string;
  }): Promise<AgentIdentity[]>;
  grantMessaging(
    opts: AgentHumanAuth & {
      source_agent_id: string;
      target_agent_id: string;
      ttl_seconds: number;
      reason: string;
      allow_guidance?: boolean;
    },
  ): Promise<AgentGrant>;
  revokeMessaging(opts: AgentHumanAuth & { grant_id: string }): Promise<void>;
  disableIdentity(opts: AgentHumanAuth & { agent_id: string }): Promise<void>;
  issueIdentity(
    opts: AgentHostAuth & {
      project_id: string;
      path: string;
      thread_id: string;
      run_id: string;
    },
  ): Promise<AgentCredential | undefined>;
  endIdentityRun(
    opts: AgentHostAuth & { agent_id: string; run_id: string },
  ): Promise<void>;
  authorizeDelivery(
    opts: AgentHostAuth & {
      project_id: string;
      path: string;
      thread_id: string;
      message_id: string;
    },
  ): Promise<void>;
  execute: (opts: AgentExecuteRequest) => Promise<AgentExecuteResponse>;
  manifest: (opts?: { account_id?: string }) => Promise<AgentManifestEntry[]>;
  plan: (opts: AgentPlanRequest) => Promise<AgentPlanResponse>;
  run: (opts: AgentRunRequest) => Promise<AgentRunResponse>;
}
