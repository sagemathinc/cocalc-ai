/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where computer calls run: everything at the account's home bay. Fresh auth
// for approval is checked there, as for connectors.
// Design: src/.agents/computers-direct-host-2026-10-16.md.

import {
  createInterBayComputersClient,
  type InterBayComputersApi,
} from "@cocalc/conat/inter-bay/computers";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { getBayPublicOrigin } from "@cocalc/server/bay-public-origin";
import { listComputers, renameComputer, revokeComputer } from "./computers";
import {
  approveComputerRequest,
  createComputerRequest,
  declineComputerRequest,
  listComputerRequests,
} from "./requests";
import { computersSite } from "./site";

async function requireFreshAuth(account_id: string, session_hash?: string) {
  await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
}

export const computersAtThisBay: InterBayComputersApi = {
  createRequest: async (opts) => {
    const created = await createComputerRequest(opts);
    return { ...created, pairing_url: await pairingUrl(created.request_id) };
  },
  listRequests: async ({ account_id }) => {
    // The line to run on the machine, from the home bay (this one), as
    // createRequest gives it: never rebuilt from a browser's origin.
    const origin = await pairingOrigin();
    return (await listComputerRequests(account_id)).map((r) => ({
      ...r,
      pairing_url: `${origin}/c/${r.request_id}`,
    }));
  },
  approveRequest: async ({
    account_id,
    session_hash,
    request_id,
    pairing_phrase,
  }) => {
    await requireFreshAuth(account_id, session_hash);
    return await approveComputerRequest({
      account_id,
      request_id,
      pairing_phrase,
    });
  },
  declineRequest: async (opts) => await declineComputerRequest(opts),
  list: async ({ account_id }) => await listComputers(account_id),
  revoke: async (opts) => await revokeComputer(opts),
  rename: async (opts) => await renameComputer(opts),
};

/**
 * The line the owner runs on the computer: this (home) bay's public origin
 * and the request id. The machine talks to the computers endpoints there.
 */
export async function pairingUrl(request_id: string): Promise<string> {
  return `${await pairingOrigin()}/c/${request_id}`;
}

async function pairingOrigin(): Promise<string> {
  const origin =
    (await getBayPublicOrigin(getConfiguredBayId()).catch(() => undefined)) ??
    (await computersSite());
  return origin.replace(/\/+$/, "");
}

/** The computers API at a given bay (this one, or over the fabric). */
export function computersAtBay(bay_id: string): InterBayComputersApi {
  return bay_id === getConfiguredBayId()
    ? computersAtThisBay
    : createInterBayComputersClient(getInterBayFabricClient(), bay_id);
}

export async function accountHomeBay(account_id: string): Promise<string> {
  if (!isValidUUID(account_id)) throw Error("invalid account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("account home unavailable");
  return home_bay_id;
}

/** The computers API at the account's home bay. */
export async function computersAtAccountHome(
  account_id: string,
): Promise<InterBayComputersApi> {
  return computersAtBay(await accountHomeBay(account_id));
}
