import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  AgentEndpoint,
  AgentRpcSource,
  AgentRpcSend,
  AgentRpcAttempt,
  AgentRpcOutcome,
  AgentRpcPreparation,
} from "@cocalc/conat/agents/rpc";
import type { AgentSnapshot } from "@cocalc/conat/agents/attachments";
import type { AgentIdentityRoute } from "./agent-identities";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type {
  AgentSessionActivity,
  AgentSessionAuthorization,
  AgentSessionDiscovery,
  AgentSessionProposal,
  PersonalAgentDenial,
} from "@cocalc/conat/agents/personal";

export type PersonalHumanMethod =
  | "listNamedAgents"
  | "nameAgent"
  | "retireNamedAgent"
  | "listAgentSessions"
  | "createAgentSession"
  | "updateAgentSession"
  | "listAgentSessionActivity"
  | "inspectAgentSessionAttempt"
  | "listAgentSessionProposals"
  | "resolveAgentSessionProposal"
  | "setPersonalMessagingState";
export type PersonalControlRequest =
  | {
      [K in PersonalHumanMethod]: {
        action: K;
        options: Omit<
          Parameters<AgentApi[K]>[0],
          "account_id" | "session_hash"
        >;
      };
    }[PersonalHumanMethod]
  | {
      action: "checkSession";
      options: {
        agent_session_id: string;
        source: AgentRpcSource;
        run_id?: string;
        target: AgentRpcSource;
      };
    }
  | {
      action: "discoverSessions";
      options: { source: AgentRpcSource; run_id?: string };
    }
  | {
      action: "proposeSession";
      options: {
        source: AgentRpcSource;
        run_id?: string;
        proposal: import("@cocalc/conat/agents/personal").ProposeAgentSessionOptions;
      };
    }
  | {
      action: "beginBroadcast";
      options: {
        source: AgentRpcSource;
        run_id?: string;
        broadcast: import("@cocalc/conat/agents/rpc").AgentRpcBroadcast;
      };
    }
  | {
      action: "finishBroadcast";
      options: {
        broadcast_id: string;
        binding_hash: string;
        outcome: import("@cocalc/conat/agents/rpc").AgentRpcBroadcastOutcome;
      };
    }
  | { action: "observeSessionActivity"; options: AgentSessionActivity };
export type PersonalControlResult =
  | PersonalAgentDenial
  | void
  | Awaited<ReturnType<AgentApi[PersonalHumanMethod]>>
  | AgentSessionAuthorization
  | AgentSessionDiscovery
  | AgentSessionProposal
  | {
      claimed: boolean;
      binding_hash: string;
      outcome?: import("@cocalc/conat/agents/rpc").AgentRpcBroadcastOutcome;
    };
export interface RpcRoute {
  project_id: string;
  route: AgentIdentityRoute;
}
export interface RpcSource {
  source: AgentEndpoint;
  run_id: string;
}
export interface RpcSubmissionSource {
  /** Authenticated at the source bay; the account home independently rechecks it. */
  account_id: string;
  source: import("@cocalc/conat/agents/rpc").AgentRpcSource;
  run_id?: string;
}
type RegisteredRpcSend = Omit<AgentRpcSend, "target"> & {
  target: AgentEndpoint;
};
type RegisteredRpcAttempt = Omit<AgentRpcAttempt, "target"> & {
  target: AgentEndpoint;
};
export interface AgentRpcControlApi {
  external(
    opts: import("@cocalc/conat/agents/external").ExternalAgentControlRequest,
  ): Promise<
    import("@cocalc/conat/agents/external").ExternalAgentControlResult
  >;
  personal(opts: {
    account_id: string;
    home_bay_id: string;
    fresh_auth_at?: number;
    request: PersonalControlRequest;
  }): Promise<PersonalControlResult>;
  principal(
    opts: RpcRoute & RpcSource,
  ): Promise<{ account_id: string; personal_messaging: boolean }>;
  submit(
    opts: RpcRoute &
      RpcSubmissionSource & {
        request: RegisteredRpcSend;
        snapshot_payload?: AgentSnapshot[];
      },
  ): Promise<AgentRpcOutcome>;
  prepareAttachments(
    opts: RpcRoute & RpcSubmissionSource & { request: RegisteredRpcSend },
  ): Promise<AgentRpcPreparation>;
  cancelAttachments(
    opts: RpcRoute & RpcSubmissionSource & { request: RegisteredRpcSend },
  ): Promise<AgentRpcOutcome>;
  inspect(
    opts: RpcRoute & RpcSubmissionSource & { request: RegisteredRpcAttempt },
  ): Promise<AgentRpcOutcome>;
}
function subject(bay: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay)) throw new Error("invalid bay");
  return `bay.${bay}.rpc.agent-messaging.v3`;
}
export function createAgentRpcControlClient(
  client: Client,
  bay: string,
): AgentRpcControlApi {
  return createServiceClient<AgentRpcControlApi>({
    client,
    service: "agent-messaging-v3",
    subject: subject(bay),
    transport: "request",
    noRetry: true,
    timeout: 45_000,
  });
}
export function createAgentRpcControlHandler(
  bay: string,
  impl: AgentRpcControlApi,
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createServiceHandler({
    ...options,
    impl,
    service: "agent-messaging-v3",
    subject: subject(bay),
    transport: "request",
    parallel: true,
    maxParallelHandlers: 4,
    receiveLimits: {
      maxMessageBytes: 33 * 1024 * 1024,
      maxInflightBytes: 132 * 1024 * 1024,
      maxInflightMessages: 4,
      maxFragmentsPerMessage: 4096,
    },
    maxQueue: 4,
  });
}
