/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { InterBayUsernamesApi } from "@cocalc/conat/inter-bay/usernames";
import { createInterBayUsernamesClient } from "@cocalc/conat/inter-bay/usernames";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type { PersonalUrlOwner } from "@cocalc/util/personal-urls";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import isAdmin from "./is-admin";
import {
  assertUsernameAuthority,
  getUsernameLocal,
  setUsernameLocal,
  releaseUsernameRedirectLocal,
  resolveUsernameOwnerLocal,
} from "./usernames-store";

export async function authorizeAdmin(
  account_id: string,
  session_hash?: string,
  fresh = false,
): Promise<void> {
  requireUuid(account_id, "account_id");
  account_id = account_id.toLowerCase();
  const account = await getClusterAccountById(account_id);
  if (!account?.home_bay_id || account.banned)
    throw Error("Admin account unavailable");
  const remote =
    account.home_bay_id === getConfiguredBayId()
      ? undefined
      : createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: account.home_bay_id,
        });
  if (
    !(remote ? await remote.isAdmin({ account_id }) : await isAdmin(account_id))
  )
    throw Error("Must be an admin");
  if (fresh) {
    // Only the transport-bound session is accepted. Never fall back to a
    // caller-nominated browser or forward a reusable cookie/bearer credential.
    if (!session_hash)
      throw Object.assign(Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
    const opts = {
      account_id,
      session_hash,
      require_second_factor: true,
      allow_actor_impersonation: false,
    };
    if (remote) await remote.requireFreshAuth(opts);
    else await requireDangerousSessionAuth(opts);
  }
  // The existing account-local role/session RPCs do not fence account rehome.
  // Reject a cutover rather than authorizing from an obsolete home snapshot.
  const current = await getClusterAccountById(account_id);
  if (!current || current.banned || current.home_bay_id !== account.home_bay_id)
    throw Error("Admin authority changed; retry the operation");
}

export const usernameSeedControl: InterBayUsernamesApi = {
  async getUsername({ account_id, owner_account_id }) {
    assertUsernameAuthority();
    requireUuid(account_id, "account_id");
    const owner = owner_account_id ?? account_id;
    requireUuid(owner, "owner_account_id");
    if (owner.toLowerCase() !== account_id.toLowerCase()) {
      await authorizeAdmin(account_id);
      return getUsernameLocal(owner, { inspect: true });
    }
    return getUsernameLocal(owner);
  },
  async setUsername({ account_id, username }) {
    assertUsernameAuthority();
    requireUuid(account_id, "account_id");
    return setUsernameLocal(account_id, username);
  },
  async releaseRedirect({
    account_id,
    session_hash,
    owner_account_id,
    username,
    reason,
  }) {
    assertUsernameAuthority();
    await authorizeAdmin(account_id, session_hash, true);
    return releaseUsernameRedirectLocal({
      account_id,
      owner_account_id,
      username,
      reason,
    });
  },
  async resolveOwner({ owner }) {
    return resolveUsernameOwnerLocal(owner);
  },
};

function authority(): InterBayUsernamesApi {
  const seed = getConfiguredClusterSeedBayId();
  return seed === getConfiguredBayId()
    ? usernameSeedControl
    : createInterBayUsernamesClient(getInterBayFabricClient(), seed);
}

export const usernameApi: InterBayUsernamesApi = {
  getUsername: (opts) => authority().getUsername(opts),
  setUsername: (opts) => authority().setUsername(opts),
  releaseRedirect: (opts) => authority().releaseRedirect(opts),
  resolveOwner: (opts) => authority().resolveOwner(opts),
};

export async function resolveUsernameOwner(
  owner: string,
): Promise<PersonalUrlOwner> {
  return usernameApi.resolveOwner({ owner });
}
