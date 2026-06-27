/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import type {
  AuthorizePublicDirectoryShareReadOptions,
  ResolvePublicDirectoryShareOptions,
} from "@cocalc/conat/hub/api/public-directory-shares";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import * as publicDirectoryShares from "@cocalc/server/public-directory-shares";

function isSeedBay(): boolean {
  return getConfiguredBayId() === getConfiguredClusterSeedBayId();
}

function seedPublicDirectorySharesClient() {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: getConfiguredClusterSeedBayId(),
  });
}

export async function resolve(opts: ResolvePublicDirectoryShareOptions) {
  return isSeedBay()
    ? await publicDirectoryShares.resolve(opts)
    : await seedPublicDirectorySharesClient().publicDirectoryShareResolve(opts);
}

export async function authorizeRead(
  opts: AuthorizePublicDirectoryShareReadOptions,
) {
  return isSeedBay()
    ? await publicDirectoryShares.authorizeRead(opts)
    : await seedPublicDirectorySharesClient().publicDirectoryShareAuthorizeRead(
        opts,
      );
}

export {
  create,
  copyToNewProject,
  copyToProject,
  list,
  listDirectory,
  listMine,
  listProject,
  update,
  upsert,
} from "@cocalc/server/public-directory-shares";
