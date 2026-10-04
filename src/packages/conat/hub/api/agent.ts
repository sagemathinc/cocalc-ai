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
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import type {
  AgentPaymentProvider,
  AgentPaymentTarget,
} from "@cocalc/util/ai/agent-payment-selection";
import type {
  AgentPaymentSelectionsResult,
  ResolvedAgentPaymentSelection,
  SetAgentPaymentSelectionsRequest,
} from "@cocalc/conat/inter-bay/agent-payment-selections";
import type {
  AgentIdentity,
  AgentCredential,
} from "@cocalc/conat/agents/protocol";
import type { AgentEndpoint, AgentRpcEnvelope } from "@cocalc/conat/agents/rpc";
import type {
  AgentNetwork,
  AgentNetworkActivity,
  AgentNetworkDirectory,
  AgentNetworkProposal,
  CreateAgentNetworkOptions,
  NamedAgent,
  NamedAgentDirectory,
  NameAgentOptions,
  RetireNamedAgentOptions,
  PersonalMessagingControls,
  ResolveAgentNetworkProposalOptions,
  SetPersonalMessagingStateOptions,
  UpdateAgentNetworkOptions,
} from "@cocalc/conat/agents/personal";

export const agent = {
  listNamedAgents: authFirstRequireAccount,
  // Owner-only: enabling memory and viewing or deleting notes need a human
  // session, never an agent's credential.
  manageAgentMemory: authFirstRequireAccountWithBoundSession,
  nameAgent: authFirstRequireAccountWithBoundSession,
  retireNamedAgent: authFirstRequireAccountWithBoundSession,
  listAgentNetworks: authFirstRequireAccount,
  createAgentNetwork: authFirstRequireAccountWithBoundSession,
  updateAgentNetwork: authFirstRequireAccountWithBoundSession,
  listAgentNetworkActivity: authFirstRequireAccount,
  inspectAgentNetworkAttempt: authFirstRequireAccount,
  listAgentNetworkProposals: authFirstRequireAccount,
  resolveAgentNetworkProposal: authFirstRequireAccountWithBoundSession,
  setPersonalMessagingState: authFirstRequireAccountWithBoundSession,
  authorizeRpcAdmission: authFirstRequireHostWithAccountTarget,
  authorizeRpcExecution: authFirstRequireHostWithAccountTarget,
  getMentionIdentity: authFirstRequireHostWithAccountTarget,
  registerIdentity: authFirstRequireAccount,
  startFreshConversation: authFirstRequireAccount,
  listIdentities: authFirstRequireAccount,
  getIdentity: authFirstRequireAccount,
  resolveIdentity: authFirstRequireAccount,
  getPaymentSelections: authFirstRequireAccount,
  listPaymentSelections: authFirstRequireAccount,
  setPaymentSelections: authFirstRequireAccount,
  copyPaymentSelection: authFirstRequireAccount,
  resolvePaymentSelection: authFirstRequireHostWithAccountTarget,
  disableIdentity: authFirstRequireAccountWithBoundSession,
  recoverIdentity: authFirstRequireAccountWithBoundSession,
  issueIdentity: authFirstRequireHostWithAccountTarget,
  endIdentityRun: authFirstRequireHostWithAccountTarget,
  getCocalcConnectorConfig: authFirstRequireAccount,
  saveCocalcConnectorConfig: authFirstRequireAccountWithBoundSession,
  removeCocalcConnectorConfig: authFirstRequireAccountWithBoundSession,
  beginCocalcConnectorTurn: authFirstRequireHostWithAccountTarget,
  renewCocalcConnectorTurn: authFirstRequireHostWithAccountTarget,
  endCocalcConnectorTurn: authFirstRequireHostWithAccountTarget,
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

export interface CocalcConnectorConfig {
  config_id: string;
  account_id: string;
  agent_id: string;
  source_project_id: string;
  scope: ApiKeyScope;
  revision: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CocalcConnectorTurnRef {
  chat_path: string;
  message_date: string;
  message_id: string;
  thread_id: string;
}

export interface CocalcConnectorTurnRequest extends AgentHostAuth {
  agent_id: string;
  source_project_id: string;
  run_id: string;
  turn_ref: CocalcConnectorTurnRef;
}

export interface CocalcConnectorTurnKey {
  turn_id: string;
  key_id: string;
  secret: string;
  expires_at: number;
  config_id: string;
  config_revision: number;
}

export interface AgentApi {
  beginCocalcConnectorTurn(
    opts: CocalcConnectorTurnRequest & { idempotency_key: string },
  ): Promise<CocalcConnectorTurnKey | undefined>;
  renewCocalcConnectorTurn(
    opts: CocalcConnectorTurnRequest & { turn_id: string },
  ): Promise<number>;
  endCocalcConnectorTurn(
    opts: Omit<CocalcConnectorTurnRequest, "turn_ref"> & { turn_id: string },
  ): Promise<void>;
  getCocalcConnectorConfig(opts: {
    account_id?: string;
    agent_id: string;
    source_project_id: string;
  }): Promise<CocalcConnectorConfig | null>;
  saveCocalcConnectorConfig(
    opts: AgentHumanAuth & {
      agent_id: string;
      source_project_id: string;
      expected_config_id?: string;
      expected_revision?: number;
      scope: ApiKeyScope;
      enabled: boolean;
    },
  ): Promise<CocalcConnectorConfig>;
  removeCocalcConnectorConfig(
    opts: AgentHumanAuth & {
      agent_id: string;
      source_project_id: string;
      expected_config_id: string;
      expected_revision: number;
    },
  ): Promise<void>;
  listNamedAgents(opts: { account_id?: string }): Promise<NamedAgentDirectory>;
  manageAgentMemory(
    opts: AgentHumanAuth &
      (
        | { op: "status" }
        | { op: "list" }
        | { op: "set-enabled"; enabled: boolean }
        | { op: "delete"; name: string }
        | { op: "delete-all" }
      ),
  ): Promise<any>;
  nameAgent(opts: AgentHumanAuth & NameAgentOptions): Promise<NamedAgent>;
  retireNamedAgent(
    opts: AgentHumanAuth & RetireNamedAgentOptions,
  ): Promise<void>;
  listAgentNetworks(opts: {
    account_id?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AgentNetworkDirectory>;
  createAgentNetwork(
    opts: AgentHumanAuth & CreateAgentNetworkOptions,
  ): Promise<AgentNetwork>;
  updateAgentNetwork(
    opts: AgentHumanAuth & UpdateAgentNetworkOptions,
  ): Promise<AgentNetwork>;
  listAgentNetworkActivity(opts: {
    account_id?: string;
    agent_network_id: string;
    limit?: number;
  }): Promise<AgentNetworkActivity[]>;
  inspectAgentNetworkAttempt(opts: {
    account_id?: string;
    agent_network_id: string;
    attempt_id: string;
  }): Promise<AgentNetworkActivity | undefined>;
  listAgentNetworkProposals(opts: {
    account_id?: string;
    limit?: number;
  }): Promise<AgentNetworkProposal[]>;
  resolveAgentNetworkProposal(
    opts: AgentHumanAuth & ResolveAgentNetworkProposalOptions,
  ): Promise<AgentNetworkProposal>;
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
  /** This account's payment selections for some agents, plus its defaults. */
  getPaymentSelections(opts: {
    account_id?: string;
    targets: AgentPaymentTarget[];
    /** Record that a turn is being sent with these selections. */
    touch?: boolean;
  }): Promise<AgentPaymentSelectionsResult>;
  /** All of this account's payment selections, for the Agents page. */
  listPaymentSelections(opts: {
    account_id?: string;
    provider?: AgentPaymentProvider;
    limit?: number;
  }): Promise<AgentPaymentSelectionsResult>;
  /** Set (or clear, with null) how this account pays for agents or defaults. */
  setPaymentSelections(
    opts: { account_id?: string } & SetAgentPaymentSelectionsRequest,
  ): Promise<{ updated: number }>;
  /** Keep a selection when a conversation is forked or started fresh. */
  copyPaymentSelection(opts: {
    account_id?: string;
    from: AgentPaymentTarget;
    to: AgentPaymentTarget;
  }): Promise<{ copied: boolean }>;
  /** Host admitting a turn for an account: how that account pays. */
  resolvePaymentSelection(
    opts: AgentHostAuth & {
      project_id: string;
      thread_id: string;
      provider: AgentPaymentProvider;
    },
  ): Promise<ResolvedAgentPaymentSelection>;
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
  startFreshConversation(
    opts: AgentHumanAuth & {
      project_id: string;
      agent_id: string;
      expected_thread_id: string;
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
