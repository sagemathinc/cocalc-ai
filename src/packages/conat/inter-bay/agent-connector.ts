/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";

type RequiredAccount<T> = Omit<T, "account_id"> & { account_id: string };
type RequiredHost<T> = Omit<RequiredAccount<T>, "host_id"> & {
  account_id: string;
  host_id: string;
};

/** A wake a sensor run wants to start, counted on the account's home bay. */
export interface SensorWakeBudgetRequest {
  account_id: string;
  project_id: string;
  agent_id: string;
  sensor_id: string;
  run_id: string;
}

/** A new watcher, counted on the account's home bay until released. */
export interface SensorWatcherBudgetRequest {
  account_id: string;
  project_id: string;
  agent_id: string;
  sensor_id: string;
  /** When the watcher gives up (ISO). */
  expires_at: string;
}

export interface InterBayAgentConnectorApi {
  getConfig(
    opts: RequiredAccount<Parameters<AgentApi["getCocalcConnectorConfig"]>[0]>,
  ): ReturnType<AgentApi["getCocalcConnectorConfig"]>;
  listConfigs(
    opts: RequiredAccount<
      NonNullable<Parameters<AgentApi["listCocalcConnectorConfigs"]>[0]>
    >,
  ): ReturnType<AgentApi["listCocalcConnectorConfigs"]>;
  saveConfig(
    opts: RequiredAccount<Parameters<AgentApi["saveCocalcConnectorConfig"]>[0]>,
  ): ReturnType<AgentApi["saveCocalcConnectorConfig"]>;
  removeConfig(
    opts: RequiredAccount<
      Parameters<AgentApi["removeCocalcConnectorConfig"]>[0]
    >,
  ): ReturnType<AgentApi["removeCocalcConnectorConfig"]>;
  listCliConnections(
    opts: RequiredAccount<
      NonNullable<Parameters<AgentApi["listCliConnections"]>[0]>
    >,
  ): ReturnType<AgentApi["listCliConnections"]>;
  getCliSetup(
    opts: RequiredAccount<
      NonNullable<Parameters<AgentApi["getCliConnectorSetup"]>[0]>
    >,
  ): ReturnType<AgentApi["getCliConnectorSetup"]>;
  startCliSignIn(
    opts: RequiredAccount<Parameters<AgentApi["startCliConnectorSignIn"]>[0]>,
  ): ReturnType<AgentApi["startCliConnectorSignIn"]>;
  pollCliSignIn(
    opts: RequiredAccount<Parameters<AgentApi["pollCliConnectorSignIn"]>[0]>,
  ): ReturnType<AgentApi["pollCliConnectorSignIn"]>;
  completeCliSignIn(
    opts: RequiredAccount<
      Parameters<AgentApi["completeCliConnectorSignIn"]>[0]
    >,
  ): ReturnType<AgentApi["completeCliConnectorSignIn"]>;
  disconnectCliConnection(
    opts: RequiredAccount<Parameters<AgentApi["disconnectCliConnection"]>[0]>,
  ): ReturnType<AgentApi["disconnectCliConnection"]>;
  listCliGrants(
    opts: RequiredAccount<
      NonNullable<Parameters<AgentApi["listCliConnectorGrants"]>[0]>
    >,
  ): ReturnType<AgentApi["listCliConnectorGrants"]>;
  saveCliGrant(
    opts: RequiredAccount<Parameters<AgentApi["saveCliConnectorGrant"]>[0]>,
  ): ReturnType<AgentApi["saveCliConnectorGrant"]>;
  beginCliTurn(
    opts: RequiredHost<Parameters<AgentApi["beginCliConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["beginCliConnectorTurn"]>;
  begin(
    opts: RequiredHost<Parameters<AgentApi["beginCocalcConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["beginCocalcConnectorTurn"]>;
  renew(
    opts: RequiredHost<Parameters<AgentApi["renewCocalcConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["renewCocalcConnectorTurn"]>;
  end(
    opts: RequiredHost<Parameters<AgentApi["endCocalcConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["endCocalcConnectorTurn"]>;
  // Sensor budgets, authoritative on the account's home bay (bay-internal).
  reserveSensorWake(
    opts: SensorWakeBudgetRequest,
  ): Promise<{ reserved: boolean }>;
  releaseSensorWake(opts: {
    account_id: string;
    run_id: string;
  }): Promise<void>;
  reserveSensorWatcher(opts: SensorWatcherBudgetRequest): Promise<void>;
  releaseSensorWatcher(opts: {
    account_id: string;
    sensor_id: string;
  }): Promise<void>;
}

function subject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay_id");
  return `bay.${bay_id}.rpc.agent-connector.v1`;
}

export function createInterBayAgentConnectorClient(
  client: Client,
  bay_id: string,
): InterBayAgentConnectorApi {
  return createServiceClient<InterBayAgentConnectorApi>({
    client,
    service: "inter-bay-agent-connector",
    subject: subject(bay_id),
    timeout: 45_000,
    noRetry: true,
  });
}

export function createInterBayAgentConnectorHandler(
  bay_id: string,
  impl: InterBayAgentConnectorApi,
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createServiceHandler<InterBayAgentConnectorApi>({
    ...options,
    impl,
    service: "inter-bay-agent-connector",
    subject: subject(bay_id),
  });
}
