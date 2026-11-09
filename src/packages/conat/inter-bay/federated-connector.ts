/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
Federated connector calls routed between bays: to the account's home bay
(turns, assignments, the broker's recheck), to the project's owning bay
(shared-project approvals and the project snapshot) and to the seed (the
site gate). Inter-bay subjects are reachable only by bay principals with an
active bay credential, so the snapshot and the recheck are never callable
by a host or an account directly.
*/

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  FederatedConnectorAssignment,
  FederatedConnectorTurnAnswer,
} from "@cocalc/util/ai/federated-connectors";

export interface FederationSnapshot {
  owning_bay_id: string;
  users_revision: number;
  account_role: string | null;
  other_members: number;
  pending_invites: number;
  approval_id: string | null;
}

/** The broker's mint request (G3), checked again on the home bay. */
export interface FederatedMintRequest {
  site_id: string;
  account_id: string;
  agent_id: string;
  project_id: string;
  host_id: string;
  run_id: string;
  grant_id: string;
  lease_id: string;
  grant_revision: number;
}

export interface InterBayFederatedConnectorApi {
  // Account home.
  beginTurn(opts: unknown): Promise<FederatedConnectorTurnAnswer>;
  endTurn(opts: unknown): Promise<Record<string, never>>;
  verifyLiveTurn(opts: FederatedMintRequest): Promise<void>;
  listAssignments(opts: {
    account_id: string;
  }): Promise<FederatedConnectorAssignment[]>;
  saveAssignment(opts: {
    account_id: string;
    session_hash?: string;
    agent_id: string;
    source_project_id: string;
    grant_id: string;
    enabled: boolean;
    expected_revision?: number;
  }): Promise<FederatedConnectorAssignment>;
  removeAssignment(opts: {
    account_id: string;
    session_hash?: string;
    agent_id: string;
    source_project_id: string;
    expected_revision: number;
  }): Promise<void>;
  // Project owning bay.
  snapshot(opts: {
    project_id: string;
    account_id: string;
  }): Promise<FederationSnapshot>;
  approve(opts: {
    account_id: string;
    session_hash?: string;
    project_id: string;
    approved_account_id: string;
  }): Promise<{ approval_id: string }>;
  revoke(opts: {
    account_id: string;
    session_hash?: string;
    project_id: string;
    approved_account_id: string;
  }): Promise<void>;
  // Seed.
  setGate(opts: {
    account_id: string;
    session_hash?: string;
    connectors: string[];
  }): Promise<{ connectors: string[] }>;
}

function subject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay_id");
  return `bay.${bay_id}.rpc.federated-connector.v1`;
}

export function createInterBayFederatedConnectorClient(
  client: Client,
  bay_id: string,
  timeout = 45_000,
): InterBayFederatedConnectorApi {
  return createServiceClient<InterBayFederatedConnectorApi>({
    client,
    service: "inter-bay-federated-connector",
    subject: subject(bay_id),
    timeout,
    noRetry: true,
  });
}

export function createInterBayFederatedConnectorHandler(
  bay_id: string,
  impl: InterBayFederatedConnectorApi,
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createServiceHandler<InterBayFederatedConnectorApi>({
    ...options,
    impl,
    service: "inter-bay-federated-connector",
    subject: subject(bay_id),
  });
}
