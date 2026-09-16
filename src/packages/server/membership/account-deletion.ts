/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { cleanupSiteLicenseAccessForAccountDeletionOnSeed } from "./site-licenses";

export async function cleanupSiteLicenseAccessForAccountDeletion({
  account_id,
}: {
  account_id: string;
}): Promise<void> {
  const seedBayId = getConfiguredClusterSeedBayId();
  if (getConfiguredBayId() === seedBayId) {
    await cleanupSiteLicenseAccessForAccountDeletionOnSeed({ account_id });
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: seedBayId,
  }).cleanupSiteLicenseAccessForAccountDeletion({ account_id });
}
