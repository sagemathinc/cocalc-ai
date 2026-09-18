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
import type { AgentEndpoint, AgentRpcEnvelope } from "@cocalc/conat/agents/rpc";
import type {
  AgentSession,
  AgentSessionActivity,
  AgentSessionDirectory,
  AgentSessionProposal,
  CreateAgentSessionOptions,
  NamedAgent,
  NamedAgentDirectory,
  NameAgentOptions,
  RetireNamedAgentOptions,
  PersonalMessagingControls,
  ResolveAgentSessionProposalOptions,
  SetPersonalMessagingStateOptions,
  UpdateAgentSessionOptions,
} from "@cocalc/conat/agents/personal";

export const agent = {
  listNamedAgents: authFirstRequireAccount,
  nameAgent: authFirstRequireAccountWithBoundSession,
  retireNamedAgent: authFirstRequireAccountWithBoundSession,
  listAgentSessions: authFirstRequireAccount,
  createAgentSession: authFirstRequireAccountWithBoundSession,
  updateAgentSession: authFirstRequireAccountWithBoundSession,
  listAgentSessionActivity: authFirstRequireAccount,
  inspectAgentSessionAttempt: authFirstRequireAccount,
  listAgentSessionProposals: authFirstRequireAccount,
  resolveAgentSessionProposal: authFirstRequireAccountWithBoundSession,
  setPersonalMessagingState: authFirstRequireAccountWithBoundSession,
  authorizeRpcAdmission: authFirstRequireHostWithAccountTarget,
  authorizeRpcExecution: authFirstRequireHostWithAccountTarget,
  getMentionIdentity: authFirstRequireHostWithAccountTarget,
  registerIdentity: authFirstRequireAccountWithBoundSession,
  listIdentities: authFirstRequireAccount,
  getIdentity: authFirstRequireAccount,
  resolveIdentity: authFirstRequireAccount,
  disableIdentity: authFirstRequireAccountWithBoundSession,
  recoverIdentity: authFirstRequireAccountWithBoundSession,
  issueIdentity: authFirstRequireHostWithAccountTarget,
  endIdentityRun: authFirstRequireHostWithAccountTarget,
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
export interface AgentIdentityLocator {
  account_id?: string;
  agent_id: string;
  /** Owning project for routing. Omitted only for legacy, bay-local callers. */
  project_id?: string;
}

export interface AgentApi {
  listNamedAgents(opts: { account_id?: string }): Promise<NamedAgentDirectory>;
  nameAgent(opts: AgentHumanAuth & NameAgentOptions): Promise<NamedAgent>;
  retireNamedAgent(
    opts: AgentHumanAuth & RetireNamedAgentOptions,
  ): Promise<void>;
  listAgentSessions(opts: {
    account_id?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AgentSessionDirectory>;
  createAgentSession(
    opts: AgentHumanAuth & CreateAgentSessionOptions,
  ): Promise<AgentSession>;
  updateAgentSession(
    opts: AgentHumanAuth & UpdateAgentSessionOptions,
  ): Promise<AgentSession>;
  listAgentSessionActivity(opts: {
    account_id?: string;
    agent_session_id: string;
    limit?: number;
  }): Promise<AgentSessionActivity[]>;
  inspectAgentSessionAttempt(opts: {
    account_id?: string;
    agent_session_id: string;
    attempt_id: string;
  }): Promise<AgentSessionActivity | undefined>;
  listAgentSessionProposals(opts: {
    account_id?: string;
    limit?: number;
  }): Promise<AgentSessionProposal[]>;
  resolveAgentSessionProposal(
    opts: AgentHumanAuth & ResolveAgentSessionProposalOptions,
  ): Promise<AgentSessionProposal>;
  setPersonalMessagingState(
    opts: AgentHumanAuth & SetPersonalMessagingStateOptions,
  ): Promise<PersonalMessagingControls>;
  authorizeRpcAdmission(
    opts: AgentHostAuth & { envelope: AgentRpcEnvelope },
  ): Promise<void>;
  authorizeRpcExecution(
    opts: AgentHostAuth & {
      authorization: NonNullable<
        import("@cocalc/conat/ai/acp/types").AcpChatContext["agent_rpc_execution"]
      >;
    },
  ): Promise<void>;
  resolveIdentity(opts: {
    account_id?: string;
    project_id: string;
    path: string;
    thread_id: string;
  }): Promise<AgentIdentity | undefined>;
  getIdentity(opts: AgentIdentityLocator): Promise<AgentIdentity>;
  getMentionIdentity(
    opts: AgentHostAuth & { project_id: string; target: AgentEndpoint },
  ): Promise<AgentIdentity>;
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
  disableIdentity(opts: AgentHumanAuth & { agent_id: string }): Promise<void>;
  recoverIdentity(
    opts: AgentHumanAuth & { project_id: string; agent_id: string },
  ): Promise<AgentIdentity>;
  issueIdentity(
    opts: AgentHostAuth & {
      project_id: string;
      path: string;
      thread_id: string;
      run_id: string;
      recover_expired_run_id?: string;
    },
  ): Promise<AgentCredential | undefined>;
  endIdentityRun(
    opts: AgentHostAuth & { agent_id: string; run_id: string },
  ): Promise<void>;
  execute: (opts: AgentExecuteRequest) => Promise<AgentExecuteResponse>;
  manifest: (opts?: { account_id?: string }) => Promise<AgentManifestEntry[]>;
  plan: (opts: AgentPlanRequest) => Promise<AgentPlanResponse>;
  run: (opts: AgentRunRequest) => Promise<AgentRunResponse>;
}
