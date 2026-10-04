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
  begin(
    opts: RequiredHost<Parameters<AgentApi["beginCocalcConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["beginCocalcConnectorTurn"]>;
  renew(
    opts: RequiredHost<Parameters<AgentApi["renewCocalcConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["renewCocalcConnectorTurn"]>;
  end(
    opts: RequiredHost<Parameters<AgentApi["endCocalcConnectorTurn"]>[0]>,
  ): ReturnType<AgentApi["endCocalcConnectorTurn"]>;
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
