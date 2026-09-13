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
} from "@cocalc/conat/agents/rpc";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { AgentIdentityRoute } from "./agent-identities";

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
  ): Promise<{ source: AgentIdentity; link: AgentRpcLink }>;
  submit(
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
  });
}
