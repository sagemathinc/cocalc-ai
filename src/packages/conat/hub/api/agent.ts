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
  AgentPage,
  AgentPageOptions,
  AgentMessageHistoryEntry,
} from "@cocalc/conat/agents/protocol";
import type {
  AgentEndpoint,
  AgentRpcEnvelope,
  AgentRpcLink,
} from "@cocalc/conat/agents/rpc";
import type { AgentRpcLinkApproval } from "@cocalc/conat/inter-bay/agent-rpc";
import type {
  NamedAgent,
  NamedAgentDirectory,
  NameAgentOptions,
  RetireNamedAgentOptions,
  PersonalConnection,
  PersonalConnectionDirectory,
  PersonalMessagingControls,
  GrantPersonalConnectionOptions,
  SetPersonalConnectionStateOptions,
  SetPersonalMessagingStateOptions,
  PersonalConnectionRequest,
} from "@cocalc/conat/agents/personal";

export const agent = {
  listPersonalConnectionRequests: authFirstRequireAccount,
  resolvePersonalConnectionRequest: authFirstRequireAccountWithBoundSession,
  listNamedAgents: authFirstRequireAccount,
  nameAgent: authFirstRequireAccountWithBoundSession,
  retireNamedAgent: authFirstRequireAccountWithBoundSession,
  listPersonalConnections: authFirstRequireAccount,
  grantPersonalConnection: authFirstRequireAccountWithBoundSession,
  setPersonalConnectionState: authFirstRequireAccountWithBoundSession,
  setPersonalMessagingState: authFirstRequireAccountWithBoundSession,
  grantRpcLink: authFirstRequireAccountWithBoundSession,
  revokeRpcLink: authFirstRequireAccountWithBoundSession,
  listRpcLinks: authFirstRequireAccount,
  authorizeRpcAdmission: authFirstRequireHostWithAccountTarget,
  authorizeRpcExecution: authFirstRequireHostWithAccountTarget,
  getMentionIdentity: authFirstRequireHostWithAccountTarget,
  registerIdentity: authFirstRequireAccountWithBoundSession,
  listIdentities: authFirstRequireAccount,
  getIdentity: authFirstRequireAccount,
  resolveIdentity: authFirstRequireAccount,
  listGrants: authFirstRequireAccount,
  listMessageReceipts: authFirstRequireAccount,
  grantMessaging: authFirstRequireAccountWithBoundSession,
  revokeMessaging: authFirstRequireAccountWithBoundSession,
  disableIdentity: authFirstRequireAccountWithBoundSession,
  recoverIdentity: authFirstRequireAccountWithBoundSession,
  issueIdentity: authFirstRequireHostWithAccountTarget,
  endIdentityRun: authFirstRequireHostWithAccountTarget,
  authorizeDelivery: authFirstRequireHostWithAccountTarget,
  beginMessageAdmission: authFirstRequireHostWithAccountTarget,
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

export interface AgentIdentityLocator {
  account_id?: string;
  agent_id: string;
  /** Owning project for routing. Omitted only for legacy, bay-local callers. */
  project_id?: string;
}

export interface AgentApi {
  listPersonalConnectionRequests(opts: {
    account_id?: string;
  }): Promise<{ enabled: boolean; requests: PersonalConnectionRequest[] }>;
  resolvePersonalConnectionRequest(
    opts: AgentHumanAuth & { request_id: string; decision: "approve" | "deny" },
  ): Promise<PersonalConnectionRequest>;
  listNamedAgents(opts: { account_id?: string }): Promise<NamedAgentDirectory>;
  nameAgent(opts: AgentHumanAuth & NameAgentOptions): Promise<NamedAgent>;
  retireNamedAgent(
    opts: AgentHumanAuth & RetireNamedAgentOptions,
  ): Promise<void>;
  listPersonalConnections(opts: {
    account_id?: string;
  }): Promise<PersonalConnectionDirectory>;
  grantPersonalConnection(
    opts: AgentHumanAuth & GrantPersonalConnectionOptions,
  ): Promise<PersonalConnection[]>;
  setPersonalConnectionState(
    opts: AgentHumanAuth & SetPersonalConnectionStateOptions,
  ): Promise<PersonalConnection[]>;
  setPersonalMessagingState(
    opts: AgentHumanAuth & SetPersonalMessagingStateOptions,
  ): Promise<PersonalMessagingControls>;
  grantRpcLink(
    opts: AgentHumanAuth & AgentRpcLinkApproval,
  ): Promise<AgentRpcLink>;
  revokeRpcLink(
    opts: AgentHumanAuth & { source: AgentEndpoint; link_id: string },
  ): Promise<void>;
  listRpcLinks(opts: {
    account_id?: string;
    source: AgentEndpoint;
  }): Promise<AgentRpcLink[]>;
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
  listGrants(
    opts: AgentIdentityLocator & AgentPageOptions,
  ): Promise<AgentPage<AgentGrant>>;
  listMessageReceipts(
    opts: AgentIdentityLocator & AgentPageOptions,
  ): Promise<AgentPage<AgentMessageHistoryEntry>>;
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
      grant_id?: string;
      source_agent_id: string;
      target_agent_id: string;
      ttl_seconds: number;
      reason: string;
      allow_guidance?: boolean;
    },
  ): Promise<AgentGrant>;
  revokeMessaging(opts: AgentHumanAuth & { grant_id: string }): Promise<void>;
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
  authorizeDelivery(
    opts: AgentHostAuth & {
      project_id: string;
      path: string;
      thread_id: string;
      message_id: string;
      recovery_generation?: string;
    },
  ): Promise<void>;
  /** One-use queue attempt, not a replayable capability. False means observe only. */
  beginMessageAdmission(
    opts: AgentHostAuth & {
      project_id: string;
      path: string;
      thread_id: string;
      message_id: string;
      recovery_generation: string;
      operation_id: string;
    },
  ): Promise<boolean>;
  execute: (opts: AgentExecuteRequest) => Promise<AgentExecuteResponse>;
  manifest: (opts?: { account_id?: string }) => Promise<AgentManifestEntry[]>;
  plan: (opts: AgentPlanRequest) => Promise<AgentPlanResponse>;
  run: (opts: AgentRunRequest) => Promise<AgentRunResponse>;
}
