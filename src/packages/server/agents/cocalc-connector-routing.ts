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
  listCocalcConnectorConfigs as listConfigsAtHome,
  saveCocalcConnectorConfig as saveConfigAtHome,
  removeCocalcConnectorConfig as removeConfigAtHome,
} from "./cocalc-connector-config";
import {
  getCliConnectorSetup as getCliSetupAtHome,
  pollCliConnectorSignIn as pollCliSignInAtHome,
  completeCliConnectorSignIn as completeCliSignInAtHome,
  startCliConnectorSignIn as startCliSignInAtHome,
  disconnectCliConnection as disconnectCliConnectionAtHome,
  issueCliConnectorTurnTokens,
  listCliConnections as listCliConnectionsAtHome,
  listCliConnectorGrants as listCliGrantsAtHome,
  saveCliConnectorGrant as saveCliGrantAtHome,
} from "./cli-connectors";

export const agentConnectorControl: InterBayAgentConnectorApi = {
  getConfig: getConfigAtHome,
  listConfigs: listConfigsAtHome,
  saveConfig: saveConfigAtHome,
  removeConfig: removeConfigAtHome,
  listCliConnections: listCliConnectionsAtHome,
  getCliSetup: getCliSetupAtHome,
  startCliSignIn: startCliSignInAtHome,
  pollCliSignIn: pollCliSignInAtHome,
  completeCliSignIn: completeCliSignInAtHome,
  disconnectCliConnection: disconnectCliConnectionAtHome,
  listCliGrants: listCliGrantsAtHome,
  saveCliGrant: saveCliGrantAtHome,
  beginCliTurn: issueCliConnectorTurnTokens,
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
  // Only the hub's sensor scheduler may present a sensor run; a host request
  // is always about a chat turn on that host.
  const turn_ref = (opts as { turn_ref?: { sensor_run_id?: string } }).turn_ref;
  if (turn_ref && "sensor_run_id" in turn_ref) {
    const { sensor_run_id: _ignored, ...rest } = turn_ref;
    return { ...opts, turn_ref: rest } as T & {
      account_id: string;
      host_id: string;
    };
  }
  return opts as T & { account_id: string; host_id: string };
}

/**
 * The sensor scheduler's credentials for one run, issued on the approver's
 * home bay with the same grants, scopes and audit as a chat turn's. The run
 * itself (live, leased, approved by this account) replaces the live-turn
 * check. Internal: never reachable from a host or browser.
 */
export const sensorConnectors = {
  begin: async (opts: Parameters<InterBayAgentConnectorApi["begin"]>[0]) =>
    await (await accountHomeApi(opts.account_id)).begin(opts),
  renew: async (opts: Parameters<InterBayAgentConnectorApi["renew"]>[0]) =>
    await (await accountHomeApi(opts.account_id)).renew(opts),
  end: async (opts: Parameters<InterBayAgentConnectorApi["end"]>[0]) =>
    await (await accountHomeApi(opts.account_id)).end(opts),
  beginCli: async (
    opts: Parameters<InterBayAgentConnectorApi["beginCliTurn"]>[0],
  ) => await (await accountHomeApi(opts.account_id)).beginCliTurn(opts),
};

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

export const listCocalcConnectorConfigs: AgentApi["listCocalcConnectorConfigs"] =
  async (input) => {
    const opts = requiredAccount(input ?? {});
    return await (await accountHomeApi(opts.account_id)).listConfigs(opts);
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

export const listCliConnections: AgentApi["listCliConnections"] = async (
  input,
) => {
  const opts = requiredAccount(input ?? {});
  return await (await accountHomeApi(opts.account_id)).listCliConnections(opts);
};

export const getCliConnectorSetup: AgentApi["getCliConnectorSetup"] = async (
  input,
) => {
  const opts = requiredAccount(input ?? {});
  return await (await accountHomeApi(opts.account_id)).getCliSetup(opts);
};

export const startCliConnectorSignIn: AgentApi["startCliConnectorSignIn"] =
  async (input) => {
    const opts = requiredAccount(input);
    return await (await accountHomeApi(opts.account_id)).startCliSignIn(opts);
  };

export const pollCliConnectorSignIn: AgentApi["pollCliConnectorSignIn"] =
  async (input) => {
    const opts = requiredAccount(input);
    return await (await accountHomeApi(opts.account_id)).pollCliSignIn(opts);
  };

export const disconnectCliConnection: AgentApi["disconnectCliConnection"] =
  async (input) => {
    const opts = requiredAccount(input);
    await (await accountHomeApi(opts.account_id)).disconnectCliConnection(opts);
  };

export const listCliConnectorGrants: AgentApi["listCliConnectorGrants"] =
  async (input) => {
    const opts = requiredAccount(input ?? {});
    return await (await accountHomeApi(opts.account_id)).listCliGrants(opts);
  };

export const saveCliConnectorGrant: AgentApi["saveCliConnectorGrant"] = async (
  input,
) => {
  const opts = requiredAccount(input);
  return await (await accountHomeApi(opts.account_id)).saveCliGrant(opts);
};

export const beginCliConnectorTurn: AgentApi["beginCliConnectorTurn"] = async (
  input,
) => {
  const opts = requiredHost(input);
  return await (await accountHomeApi(opts.account_id)).beginCliTurn(opts);
};

export const completeCliConnectorSignIn: AgentApi["completeCliConnectorSignIn"] =
  async (input) => {
    const opts = requiredAccount(input);
    return await (
      await accountHomeApi(opts.account_id)
    ).completeCliSignIn(opts);
  };
