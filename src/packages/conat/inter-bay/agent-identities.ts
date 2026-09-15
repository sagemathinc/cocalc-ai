/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  AgentIdentity,
  AgentPage,
  AgentPageOptions,
  AgentMessageHistoryEntry,
} from "@cocalc/conat/agents/protocol";
import type { AgentGrant } from "@cocalc/conat/hub/api/agent";

export interface AgentIdentityRoute {
  bay_id: string;
  epoch: number;
}

export interface AgentIdentityReadRequest {
  account_id: string;
  project_id: string;
  route: AgentIdentityRoute;
}

export interface AgentIdentityThreadRequest extends AgentIdentityReadRequest {
  path: string;
  thread_id: string;
}

export interface AgentIdentityLookupRequest extends AgentIdentityReadRequest {
  agent_id: string;
}

export interface InterBayAgentIdentityApi {
  list(opts: AgentIdentityReadRequest): Promise<AgentIdentity[]>;
  resolve(opts: AgentIdentityThreadRequest): Promise<AgentIdentity | undefined>;
  get(opts: AgentIdentityLookupRequest): Promise<AgentIdentity>;
  listGrants(
    opts: AgentIdentityLookupRequest & AgentPageOptions,
  ): Promise<AgentPage<AgentGrant>>;
  listMessageReceipts(
    opts: AgentIdentityLookupRequest & AgentPageOptions,
  ): Promise<AgentPage<AgentMessageHistoryEntry>>;
  register(
    opts: AgentIdentityThreadRequest & {
      // Entry hub verified fresh, non-impersonated human auth for this operation.
      // Valid only on the trusted fabric, never a public request argument.
      fresh_auth_at: number;
    },
  ): Promise<AgentIdentity>;
}

export function agentIdentityControlSubject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw new Error("invalid bay_id");
  return `bay.${bay_id}.rpc.agent-identities.v1`;
}

export function createInterBayAgentIdentityClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayAgentIdentityApi {
  return createServiceClient<InterBayAgentIdentityApi>({
    service: "inter-bay-agent-identities",
    subject: agentIdentityControlSubject(bay_id),
    client,
    timeout: 15_000,
  });
}

export function createInterBayAgentIdentityHandler({
  bay_id,
  impl,
  ...options
}: {
  bay_id: string;
  impl: InterBayAgentIdentityApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<InterBayAgentIdentityApi>({
    ...options,
    service: "inter-bay-agent-identities",
    subject: agentIdentityControlSubject(bay_id),
    impl,
  });
}
