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
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { AgentFileGrant } from "@cocalc/conat/agents/file-grants";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";

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
  register(opts: AgentIdentityThreadRequest): Promise<AgentIdentity>;
  startFreshConversation(
    opts: AgentIdentityLookupRequest & { expected_thread_id: string },
  ): Promise<AgentIdentity>;
  recover(
    opts: AgentIdentityLookupRequest & {
      fresh_auth_at: number;
    },
  ): Promise<AgentIdentity>;
  listFileGrants(opts: AgentIdentityLookupRequest): Promise<AgentFileGrant[]>;
  saveFileGrant(
    opts: AgentIdentityLookupRequest & {
      target_project_id: string;
      roots: string[];
      mode?: "read" | "read-write";
    },
  ): Promise<AgentFileGrant>;
  revokeFileGrant(
    opts: AgentIdentityLookupRequest & { grant_id: string },
  ): Promise<void>;
  authorizeFileGrantRead(
    opts: AgentIdentityLookupRequest & {
      host_id: string;
      target_project_id: string;
      grant_id: string;
      run_id: string;
    },
  ): Promise<{
    read_policy: ProjectViewerReadPolicy;
    mode?: "read" | "read-write";
  }>;
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
