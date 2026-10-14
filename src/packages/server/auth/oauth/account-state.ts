/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An account's state for an OAuth client, decided on the account's home bay
// from its accounts row on the primary. The cluster directory is used only to
// find the home bay: it can still list an account for a while after the home
// bay deleted it.

import type { AccountLocalOAuthAccountState } from "@cocalc/conat/inter-bay/api";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { isValidUUID } from "@cocalc/util/misc";

export type OAuthAccountState = AccountLocalOAuthAccountState;

type AccountRow = {
  email_address?: string | null;
  email_address_verified?: Record<string, unknown> | null;
  banned?: boolean | null;
  deleted?: boolean | null;
  home_bay_id?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

/** Whether the account's current email address is verified. */
export function isCurrentEmailVerified(row: AccountRow): boolean {
  const email = `${row.email_address ?? ""}`.trim();
  if (!email) return false;
  const verified = row.email_address_verified;
  return (
    verified != null &&
    typeof verified === "object" &&
    Object.prototype.hasOwnProperty.call(verified, email) &&
    verified[email] != null
  );
}

/** On this bay: the account's state from its row on the primary. */
export async function getOAuthAccountStateLocal({
  account_id,
  include_membership,
}: {
  account_id: string;
  include_membership?: boolean;
}): Promise<OAuthAccountState> {
  if (!isValidUUID(account_id)) return { state: "missing" };
  const { rows } = await getPool().query<AccountRow>(
    `SELECT email_address, email_address_verified, banned, deleted, home_bay_id,
            display_name, first_name, last_name
       FROM accounts WHERE account_id = $1::UUID`,
    [account_id],
  );
  const row = rows[0];
  if (row == null || row.deleted || row.banned || !row.email_address) {
    return { state: "missing" };
  }
  const home_bay_id = `${row.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id !== getConfiguredBayId()) {
    return { state: "moved", home_bay_id };
  }
  return {
    state: "live",
    email_address: `${row.email_address}`.trim(),
    email_verified: isCurrentEmailVerified(row),
    display_name: displayNameFromAccount(row) || "",
    ...(include_membership
      ? { membership: await resolveMembershipForAccount(account_id) }
      : {}),
  };
}

async function getStateOnBay(
  home_bay_id: string,
  opts: { account_id: string; include_membership?: boolean },
): Promise<OAuthAccountState> {
  if (home_bay_id === getConfiguredBayId()) {
    return await getOAuthAccountStateLocal(opts);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).getOAuthAccountState(opts);
}

/** The account's state, asked of its home bay. The directory only routes; if
 * the bay it names says the account moved (a rehome), ask the new home once. */
export async function getOAuthAccountState(
  account_id: string,
  opts: { include_membership?: boolean } = {},
): Promise<OAuthAccountState> {
  if (!isValidUUID(account_id)) return { state: "missing" };
  const entry = await getClusterAccountById(account_id);
  if (entry == null) return { state: "missing" };
  const hinted = `${entry.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  const request = { account_id, include_membership: opts.include_membership };
  const first = await getStateOnBay(hinted, request);
  if (first.state !== "moved") return first;
  const second = await getStateOnBay(first.home_bay_id, request);
  if (second.state === "moved") {
    // A rehome is in progress. This is a temporary error, not "missing",
    // which callers report as a deleted account.
    throw new Error("account home bay is changing; try again");
  }
  return second;
}
