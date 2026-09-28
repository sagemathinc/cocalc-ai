/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import {
  createInterBayAgentConnectorClient,
  type InterBayAgentConnectorApi,
} from "@cocalc/conat/inter-bay/agent-connector";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  beginManagedCocalcConnectorTurn,
  renewManagedCocalcConnectorTurn,
  endManagedCocalcConnectorTurn,
} from "./cocalc-connector-turn";
import {
  getCocalcConnectorConfig as getConfigAtHome,
  saveCocalcConnectorConfig as saveConfigAtHome,
  removeCocalcConnectorConfig as removeConfigAtHome,
} from "./cocalc-connector-config";

export const agentConnectorControl: InterBayAgentConnectorApi = {
  getConfig: getConfigAtHome,
  saveConfig: saveConfigAtHome,
  removeConfig: removeConfigAtHome,
  begin: beginManagedCocalcConnectorTurn,
  renew: renewManagedCocalcConnectorTurn,
  end: endManagedCocalcConnectorTurn,
};

function requiredAccount<T extends { account_id?: string }>(
  opts: T,
): T & { account_id: string } {
  if (!isValidUUID(opts.account_id))
    throw Error("authenticated account required");
  return opts as T & { account_id: string };
}

async function accountHomeApi(account_id: string) {
  if (!isValidUUID(account_id)) throw Error("invalid account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("account home unavailable");
  return home_bay_id === getConfiguredBayId()
    ? agentConnectorControl
    : createInterBayAgentConnectorClient(
        getInterBayFabricClient(),
        home_bay_id,
      );
}

function requiredHost<T extends { account_id?: string; host_id?: string }>(
  opts: T,
): T & { account_id: string; host_id: string } {
  if (!isValidUUID(opts.account_id) || !isValidUUID(opts.host_id)) {
    throw Error("authenticated project host required");
  }
  return opts as T & { account_id: string; host_id: string };
}

export const beginCocalcConnectorTurn: AgentApi["beginCocalcConnectorTurn"] =
  async (input) => {
    const opts = requiredHost(input);
    return await (await accountHomeApi(opts.account_id)).begin(opts);
  };

export const getCocalcConnectorConfig: AgentApi["getCocalcConnectorConfig"] =
  async (input) => {
    const opts = requiredAccount(input);
    return await (await accountHomeApi(opts.account_id)).getConfig(opts);
  };

export const saveCocalcConnectorConfig: AgentApi["saveCocalcConnectorConfig"] =
  async (input) => {
    const opts = requiredAccount(input);
    return await (await accountHomeApi(opts.account_id)).saveConfig(opts);
  };

export const renewCocalcConnectorTurn: AgentApi["renewCocalcConnectorTurn"] =
  async (input) => {
    const opts = requiredHost(input);
    return await (await accountHomeApi(opts.account_id)).renew(opts);
  };

export const removeCocalcConnectorConfig: AgentApi["removeCocalcConnectorConfig"] =
  async (input) => {
    const opts = requiredAccount(input);
    await (await accountHomeApi(opts.account_id)).removeConfig(opts);
  };

export const endCocalcConnectorTurn: AgentApi["endCocalcConnectorTurn"] =
  async (input) => {
    const opts = requiredHost(input);
    await (await accountHomeApi(opts.account_id)).end(opts);
  };
