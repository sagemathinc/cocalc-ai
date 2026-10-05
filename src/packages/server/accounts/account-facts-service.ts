/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The home bay's answers to other bays' questions about its accounts.

import type { InterBayAccountFactsApi } from "@cocalc/conat/inter-bay/account-facts";
import { isValidUUID } from "@cocalc/util/misc";
import { remoteHomeBay } from "./home-bay";
import userIsInGroup from "./is-in-group";
import { getAccountProductAccessTrustLocal } from "./trusted-product-access";

async function assertHomedHere(account_id: string): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  // Never forward a second time: only the home bay answers.
  if ((await remoteHomeBay(account_id)) != null) {
    throw Object.assign(new Error("account is not homed on this bay"), {
      code: 409,
    });
  }
}

export const accountFactsHome: InterBayAccountFactsApi = {
  async isAdmin({ account_id }) {
    await assertHomedHere(account_id);
    return await userIsInGroup(account_id, "admin");
  },
  async productAccessTrust({ account_id }) {
    await assertHomedHere(account_id);
    return await getAccountProductAccessTrustLocal(account_id);
  },
};
