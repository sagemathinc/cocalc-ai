/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAccountDirectoryClient,
  type AccountDirectoryEntry,
} from "@cocalc/conat/inter-bay/api";
import { updateClusterAccountEmailAddressVerifiedDirect } from "@cocalc/server/accounts/cluster-directory";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

export async function updateClusterAccountEmailAddressVerified(opts: {
  account_id: string;
  email_address_verified: boolean;
}): Promise<AccountDirectoryEntry> {
  const normalized = {
    account_id: `${opts.account_id ?? ""}`.trim().toLowerCase(),
    email_address_verified: !!opts.email_address_verified,
  };
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await updateClusterAccountEmailAddressVerifiedDirect(normalized);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).updateEmailAddressVerified(normalized);
}
