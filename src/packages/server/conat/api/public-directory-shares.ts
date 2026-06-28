/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import type {
  AuthorizePublicDirectoryShareReadOptions,
  CopyPublicDirectoryShareToNewProjectOptions,
  CopyPublicDirectoryShareToProjectOptions,
  ListPublicDirectoryShareDirectoryOptions,
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

export async function listDirectory(
  opts: ListPublicDirectoryShareDirectoryOptions,
) {
  return isSeedBay()
    ? await publicDirectoryShares.listDirectory(opts)
    : await seedPublicDirectorySharesClient().publicDirectoryShareListDirectory(
        opts,
      );
}

export async function copyToProject(
  opts: CopyPublicDirectoryShareToProjectOptions,
) {
  return isSeedBay()
    ? await publicDirectoryShares.copyToProject(opts)
    : await seedPublicDirectorySharesClient().publicDirectoryShareCopyToProject(
        opts,
      );
}

export async function copyToNewProject(
  opts: CopyPublicDirectoryShareToNewProjectOptions,
) {
  return isSeedBay()
    ? await publicDirectoryShares.copyToNewProject(opts)
    : await seedPublicDirectorySharesClient().publicDirectoryShareCopyToNewProject(
        opts,
      );
}

export {
  create,
  list,
  listMine,
  listProject,
  update,
  upsert,
} from "@cocalc/server/public-directory-shares";
