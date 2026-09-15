import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  AgentEndpoint,
  AgentRpcLink,
  AgentRpcSend,
  AgentRpcAttempt,
  AgentRpcOutcome,
  AgentRpcPreparation,
} from "@cocalc/conat/agents/rpc";
import type { AgentSnapshot } from "@cocalc/conat/agents/attachments";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { AgentIdentityRoute } from "./agent-identities";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type {
  PersonalConnectionRequest,
  PersonalConnectionRequestOptions,
  PersonalAgentDenial,
} from "@cocalc/conat/agents/personal";

export type PersonalHumanMethod =
  | "listNamedAgents"
  | "nameAgent"
  | "listPersonalConnections"
  | "grantPersonalConnection"
  | "setPersonalConnectionState"
  | "setPersonalMessagingState"
  | "listPersonalConnectionRequests"
  | "resolvePersonalConnectionRequest";
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
  | { action: "links"; options: { source: AgentEndpoint } }
  | {
      action: "check";
      options: {
        source: AgentEndpoint;
        target: AgentEndpoint;
        guidance: boolean;
      };
    }
  | { action: "request"; options: PersonalConnectionRequestOptions & RpcSource }
  | { action: "requestRead"; options: RpcSource & { request_id: string } }
  | { action: "observe"; options: { link_id: string; accepted: boolean } };
export type PersonalControlResult =
  | PersonalAgentDenial
  | void
  | Awaited<ReturnType<AgentApi[PersonalHumanMethod]>>
  | AgentRpcLink
  | AgentRpcLink[]
  | PersonalConnectionRequest;

export interface AgentRpcLinkApproval {
  source: AgentEndpoint;
  target: AgentEndpoint;
  link_id: string;
  ttl_seconds: number;
  reason: string;
  allow_guidance?: boolean;
}
export interface RpcRoute {
  project_id: string;
  route: AgentIdentityRoute;
}
export interface RpcSource {
  source: AgentEndpoint;
  run_id: string;
}
export interface AgentRpcControlApi {
  personal(opts: {
    account_id: string;
    home_bay_id: string;
    fresh_auth_at?: number;
    request: PersonalControlRequest;
  }): Promise<PersonalControlResult>;
  principal(
    opts: RpcRoute & RpcSource,
  ): Promise<{ account_id: string; personal_messaging: boolean }>;
  grant(
    opts: RpcRoute &
      AgentRpcLinkApproval & { account_id: string; fresh_auth_at: number },
  ): Promise<AgentRpcLink>;
  revoke(
    opts: RpcRoute & {
      source: AgentEndpoint;
      link_id: string;
      account_id: string;
      fresh_auth_at: number;
    },
  ): Promise<void>;
  links(
    opts: RpcRoute & {
      source: AgentEndpoint;
      account_id?: string;
      run_id?: string;
    },
  ): Promise<AgentRpcLink[]>;
  check(
    opts: RpcRoute & RpcSource & { target: AgentEndpoint; guidance: boolean },
  ): Promise<
    { source: AgentIdentity; link: AgentRpcLink } | PersonalAgentDenial
  >;
  submit(
    opts: RpcRoute &
      RpcSource & { request: AgentRpcSend; snapshot_payload?: AgentSnapshot[] },
  ): Promise<AgentRpcOutcome>;
  prepareAttachments(
    opts: RpcRoute & RpcSource & { request: AgentRpcSend },
  ): Promise<AgentRpcPreparation>;
  cancelAttachments(
    opts: RpcRoute & RpcSource & { request: AgentRpcSend },
  ): Promise<AgentRpcOutcome>;
  inspect(
    opts: RpcRoute & RpcSource & { request: AgentRpcAttempt },
  ): Promise<AgentRpcOutcome>;
}
function subject(bay: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay)) throw new Error("invalid bay");
  return `bay.${bay}.rpc.agent-messaging.v2`;
}
export function createAgentRpcControlClient(
  client: Client,
  bay: string,
): AgentRpcControlApi {
  return createServiceClient<AgentRpcControlApi>({
    client,
    service: "agent-messaging-v2",
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
    service: "agent-messaging-v2",
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
