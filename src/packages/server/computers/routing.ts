/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where computer operations run: everything at the account's home bay,
// project attestations at the project's owning bay. Fresh auth for the
// human-only widenings (approve, extend) is checked at the home bay, as for
// connectors. Plan: src/.agents/computers-plan-2026-10-11.md ("Multi-bay").

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
import { attestProjectLocal } from "./attestation";
import {
  extendComputer,
  getComputerByRef,
  getComputerForAgent,
  listComputersForAgent,
  listComputers,
  renameComputer,
  revokeComputer,
  setComputerNotes,
  setEffectivePolicy,
} from "./computers";
import {
  approveComputerRequest,
  createComputerRequest,
  declineComputerRequest,
  getPairingView,
  listComputerRequests,
  submitPairing,
} from "./requests";
import { computersSite } from "./site";
import { issueComputerTicket } from "./tickets";

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
  listRequests: async ({ account_id }) =>
    await listComputerRequests(account_id),
  getPairingView: async ({ request_id }) => await getPairingView(request_id),
  submitPairing: async (opts) => await submitPairing(opts),
  approveRequest: async ({
    account_id,
    session_hash,
    request_id,
    transcript_hash,
  }) => {
    await requireFreshAuth(account_id, session_hash);
    return await approveComputerRequest({
      account_id,
      request_id,
      transcript_hash,
    });
  },
  declineRequest: async (opts) => await declineComputerRequest(opts),
  list: async ({ account_id }) => await listComputers(account_id),
  listForAgent: async ({ account_id, agent_id, project_id }) =>
    await listComputersForAgent(account_id, agent_id, project_id),
  getForAgent: async ({ account_id, agent_id, project_id, computer }) =>
    await getComputerForAgent(account_id, agent_id, project_id, computer),
  get: async ({ account_id, computer }) =>
    await getComputerByRef(account_id, computer),
  revoke: async (opts) => await revokeComputer(opts),
  extend: async ({ account_id, session_hash, computer_id, seconds }) => {
    await requireFreshAuth(account_id, session_hash);
    return await extendComputer({ account_id, computer_id, seconds });
  },
  rename: async (opts) => await renameComputer(opts),
  setNotes: async ({ account_id, computer, ...rest }) => {
    const { computer_id } = await getComputerByRef(account_id, computer);
    return await setComputerNotes({ account_id, computer_id, ...rest });
  },
  setEffectivePolicy: async (opts) => await setEffectivePolicy(opts),
  issueTicket: async (opts) =>
    await issueComputerTicket({ ...opts, operation: opts.operation as any }),
  attestProject: async (opts) => await attestProjectLocal(opts),
};

/**
 * The line the owner runs on the computer: this (home) bay's public origin
 * and the request id. The machine talks to the pairing endpoints there.
 */
export async function pairingUrl(request_id: string): Promise<string> {
  const origin =
    (await getBayPublicOrigin(getConfiguredBayId()).catch(() => undefined)) ??
    (await computersSite());
  return `${origin.replace(/\/+$/, "")}/c/${request_id}`;
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
