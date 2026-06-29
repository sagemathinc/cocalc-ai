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
  CreatePublicDirectoryShareOptions,
  GetTemporaryViewerReadPolicyOptions,
  GrantTemporaryViewerAccessOptions,
  ListPublicDirectoryShareDirectoryOptions,
  ListProjectPublicDirectorySharesOptions,
  ResolvePublicDirectoryShareOptions,
  ResolvedPublicDirectoryShare,
  UpdatePublicDirectoryShareOptions,
  UpsertPublicDirectoryShareOptions,
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
  const attempted = new Set<string>();
  const authorizeOnBay = async (candidate_bay_id: string) => {
    attempted.add(candidate_bay_id);
    return await callPublicDirectoryShareBay({
      bay_id: candidate_bay_id,
      local: async () => await publicDirectoryShares.authorizeRead(opts),
      remote: async (client) =>
        await client.publicDirectoryShareAuthorizeRead(opts),
    });
  };
  try {
    return await authorizeOnBay(bay_id);
  } catch (err) {
    if (!isPublicDirectoryShareNotFound(err)) {
      throw err;
    }
    let lastNotFound: unknown = err;
    for (const candidate_bay_id of await publicDirectoryShareSearchBayIds()) {
      if (attempted.has(candidate_bay_id)) {
        continue;
      }
      try {
        return await authorizeOnBay(candidate_bay_id);
      } catch (fallbackErr) {
        if (!isPublicDirectoryShareNotFound(fallbackErr)) {
          throw fallbackErr;
        }
        lastNotFound = fallbackErr;
      }
    }
    throw lastNotFound ?? err;
  }
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

export async function listProject(
  opts: ListProjectPublicDirectorySharesOptions,
) {
  const bay_id = await projectPublicDirectoryShareBay(opts.project_id);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.listProject(opts),
    remote: async (client) =>
      await client.publicDirectoryShareListProject(opts),
  });
}

export async function create(opts: CreatePublicDirectoryShareOptions) {
  const bay_id = await projectPublicDirectoryShareBay(opts.project_id);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.create(opts),
    remote: async (client) => await client.publicDirectoryShareCreate(opts),
  });
}

export async function upsert(opts: UpsertPublicDirectoryShareOptions) {
  const bay_id = await projectPublicDirectoryShareBay(opts.project_id);
  return await callPublicDirectoryShareBay({
    bay_id,
    local: async () => await publicDirectoryShares.upsert(opts),
    remote: async (client) => await client.publicDirectoryShareUpsert(opts),
  });
}

export async function update(opts: UpdatePublicDirectoryShareOptions) {
  let lastNotFound: unknown;
  for (const bay_id of await publicDirectoryShareSearchBayIds()) {
    try {
      return await callPublicDirectoryShareBay({
        bay_id,
        local: async () => await publicDirectoryShares.update(opts),
        remote: async (client) => await client.publicDirectoryShareUpdate(opts),
      });
    } catch (err) {
      if (!isPublicDirectoryShareNotFound(err)) {
        throw err;
      }
      lastNotFound = err;
    }
  }
  throw lastNotFound ?? Error("public directory share not found");
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
  const attempted = new Set<string>();
  const rules: NonNullable<
    Awaited<
      ReturnType<typeof publicDirectoryShares.getTemporaryViewerReadPolicy>
    >["read_policy"]
  >["rules"] = [];
  const readFromBay = async (candidate_bay_id: string) => {
    attempted.add(candidate_bay_id);
    const response = await callPublicDirectoryShareBay({
      bay_id: candidate_bay_id,
      local: async () =>
        await publicDirectoryShares.getTemporaryViewerReadPolicy(opts),
      remote: async (client) =>
        await client.publicDirectoryShareGetTemporaryViewerReadPolicy(opts),
    });
    if (Array.isArray(response.read_policy?.rules)) {
      rules.push(...response.read_policy.rules);
    }
  };

  await readFromBay(bay_id);
  for (const candidate_bay_id of await publicDirectoryShareSearchBayIds()) {
    if (attempted.has(candidate_bay_id)) {
      continue;
    }
    try {
      await readFromBay(candidate_bay_id);
    } catch (err) {
      log.warn(
        "failed checking remote bay for public share temporary viewer grants",
        { bay_id: candidate_bay_id, err },
      );
    }
  }
  return {
    project_id: opts.project_id,
    account_id: opts.account_id ?? "",
    read_policy: rules.length > 0 ? { rules } : undefined,
  };
}

export {
  disableMineByActor,
  list,
  listMine,
} from "@cocalc/server/public-directory-shares";
