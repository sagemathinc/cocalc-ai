/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import type { InterBayAccountLocalApi } from "@cocalc/conat/inter-bay/api";
import type {
  AuthorizePublicDirectoryShareReadOptions,
  CopyPublicDirectoryShareToNewProjectOptions,
  CopyPublicDirectoryShareToProjectOptions,
  GetTemporaryViewerReadPolicyOptions,
  GrantTemporaryViewerAccessOptions,
  ListPublicDirectoryShareDirectoryOptions,
  ResolvePublicDirectoryShareOptions,
  ResolvedPublicDirectoryShare,
} from "@cocalc/conat/hub/api/public-directory-shares";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { resolveProjectBayAcrossCluster } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import * as publicDirectoryShares from "@cocalc/server/public-directory-shares";

const log = getLogger("server:conat-api:public-directory-shares");

function publicDirectorySharesClient(dest_bay: string) {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
  });
}

function isPublicDirectoryShareNotFound(err: unknown): boolean {
  return /public directory share not found/i.test(
    `${(err as Error | undefined)?.message ?? err}`,
  );
}

async function publicDirectoryShareSearchBayIds(): Promise<string[]> {
  const bayIds = new Set<string>();
  const currentBay = getConfiguredBayId();
  const seedBay = getConfiguredClusterSeedBayId();
  bayIds.add(currentBay);
  bayIds.add(seedBay);
  try {
    const entries = await listClusterBayRegistry();
    for (const entry of entries) {
      if (entry.bay_id) {
        bayIds.add(entry.bay_id);
      }
    }
  } catch (err) {
    log.warn("failed to list bay registry for public share lookup", err);
  }
  return [...bayIds];
}

async function callPublicDirectoryShareBay<T>({
  bay_id,
  local,
  remote,
}: {
  bay_id: string;
  local: () => Promise<T>;
  remote: (client: InterBayAccountLocalApi) => Promise<T>;
}): Promise<T> {
  if (bay_id === getConfiguredBayId()) {
    return await local();
  }
  return await remote(publicDirectorySharesClient(bay_id));
}

async function resolvePublicDirectoryShareWithBay(
  opts: ResolvePublicDirectoryShareOptions,
): Promise<{ bay_id: string; share: ResolvedPublicDirectoryShare }> {
  let lastNotFound: unknown;
  for (const bay_id of await publicDirectoryShareSearchBayIds()) {
    try {
      const share = await callPublicDirectoryShareBay({
        bay_id,
        local: async () => await publicDirectoryShares.resolve(opts),
        remote: async (client) =>
          await client.publicDirectoryShareResolve(opts),
      });
      return { bay_id, share };
    } catch (err) {
      if (!isPublicDirectoryShareNotFound(err)) {
        throw err;
      }
      lastNotFound = err;
    }
  }
  throw lastNotFound ?? Error("public directory share not found");
}

async function projectPublicDirectoryShareBay(
  project_id: string,
): Promise<string> {
  const ownership = await resolveProjectBayAcrossCluster(project_id);
  return ownership?.bay_id ?? getConfiguredClusterSeedBayId();
}

export async function resolve(opts: ResolvePublicDirectoryShareOptions) {
  return (await resolvePublicDirectoryShareWithBay(opts)).share;
}

export async function authorizeRead(
  opts: AuthorizePublicDirectoryShareReadOptions,
) {
  const bay_id = await projectPublicDirectoryShareBay(opts.project_id);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.authorizeRead(opts),
    remote: async (client) =>
      await client.publicDirectoryShareAuthorizeRead(opts),
  });
}

export async function listDirectory(
  opts: ListPublicDirectoryShareDirectoryOptions,
) {
  const { bay_id } = await resolvePublicDirectoryShareWithBay(opts);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.listDirectory(opts),
    remote: async (client) =>
      await client.publicDirectoryShareListDirectory(opts),
  });
}

export async function copyToProject(
  opts: CopyPublicDirectoryShareToProjectOptions,
) {
  const { bay_id } = await resolvePublicDirectoryShareWithBay(opts);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.copyToProject(opts),
    remote: async (client) =>
      await client.publicDirectoryShareCopyToProject(opts),
  });
}

export async function copyToNewProject(
  opts: CopyPublicDirectoryShareToNewProjectOptions,
) {
  const { bay_id } = await resolvePublicDirectoryShareWithBay(opts);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.copyToNewProject(opts),
    remote: async (client) =>
      await client.publicDirectoryShareCopyToNewProject(opts),
  });
}

export async function grantTemporaryViewerAccess(
  opts: GrantTemporaryViewerAccessOptions,
) {
  const { bay_id } = await resolvePublicDirectoryShareWithBay(opts);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () =>
      await publicDirectoryShares.grantTemporaryViewerAccess(opts),
    remote: async (client) =>
      await client.publicDirectoryShareGrantTemporaryViewerAccess(opts),
  });
}

export async function getTemporaryViewerReadPolicy(
  opts: GetTemporaryViewerReadPolicyOptions,
) {
  const bay_id = await projectPublicDirectoryShareBay(opts.project_id);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () =>
      await publicDirectoryShares.getTemporaryViewerReadPolicy(opts),
    remote: async (client) =>
      await client.publicDirectoryShareGetTemporaryViewerReadPolicy(opts),
  });
}

export {
  create,
  disableMineByActor,
  list,
  listMine,
  listProject,
  update,
  upsert,
} from "@cocalc/server/public-directory-shares";
