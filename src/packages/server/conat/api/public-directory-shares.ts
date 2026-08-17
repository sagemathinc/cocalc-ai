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
  ListMyPublicDirectorySharesOptions,
  ListPublicDirectoryShareDirectoryOptions,
  ListPublicDirectorySharesResponse,
  ListProjectPublicDirectorySharesOptions,
  PublicDirectoryShareSummary,
  ResolveLegacyPublicDirectorySharePathOptions,
  ResolveLegacyPublicDirectorySharePathResponse,
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
const LEGACY_PUBLIC_SHARE_LOOKUP_TIMEOUT_MS = 2_000;

function publicDirectorySharesClient(dest_bay: string, timeout?: number) {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout,
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
  timeout,
}: {
  bay_id: string;
  local: () => Promise<T>;
  remote: (client: InterBayAccountLocalApi) => Promise<T>;
  timeout?: number;
}): Promise<T> {
  if (bay_id === getConfiguredBayId()) {
    return await local();
  }
  return await remote(publicDirectorySharesClient(bay_id, timeout));
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

export async function resolveLegacyPublicDirectorySharePath(
  opts: ResolveLegacyPublicDirectorySharePathOptions,
): Promise<ResolveLegacyPublicDirectorySharePathResponse | null> {
  const bayIds = await publicDirectoryShareSearchBayIds();
  // Start every lookup immediately, but consume results in directory order so
  // duplicate legacy slugs resolve exactly like ordinary public-share slugs.
  // A dead bay is bounded and cannot serially add the default RPC timeout.
  const lookups = bayIds.map(async (bay_id) => {
    try {
      return {
        bay_id,
        resolved: await callPublicDirectoryShareBay({
          bay_id,
          timeout: LEGACY_PUBLIC_SHARE_LOOKUP_TIMEOUT_MS,
          local: async () =>
            await publicDirectoryShares.resolveLegacyPublicDirectorySharePath(
              opts,
            ),
          remote: async (client) =>
            await client.publicDirectoryShareResolveLegacyPath(opts),
        }),
        err: undefined,
      };
    } catch (err) {
      return { bay_id, resolved: null, err };
    }
  });
  let lastError: unknown;
  for (const lookup of lookups) {
    const result = await lookup;
    if (result.err != null) {
      lastError = result.err;
      log.warn("legacy public share path lookup failed on bay", {
        bay_id: result.bay_id,
        err: `${(result.err as Error | undefined)?.message ?? result.err}`,
      });
      continue;
    }
    if (result.resolved != null) return result.resolved;
  }
  if (lastError != null) throw lastError;
  return null;
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

function shareUpdatedAt(share: PublicDirectoryShareSummary): number {
  if (share.updated_at == null) return 0;
  const value =
    share.updated_at instanceof Date
      ? share.updated_at.valueOf()
      : new Date(share.updated_at).valueOf();
  return Number.isFinite(value) ? value : 0;
}

async function listMineOnBay({
  bay_id,
  opts,
  count,
}: {
  bay_id: string;
  opts: ListMyPublicDirectorySharesOptions;
  count: number;
}): Promise<ListPublicDirectorySharesResponse> {
  const shares: PublicDirectoryShareSummary[] = [];
  let total_count = 0;
  while (shares.length < count) {
    const page = await callPublicDirectoryShareBay({
      bay_id,
      local: async () =>
        await publicDirectoryShares.listMine({
          ...opts,
          offset: shares.length,
          limit: Math.min(1000, count - shares.length),
        }),
      remote: async (client) =>
        await client.publicDirectoryShareListMine({
          ...opts,
          offset: shares.length,
          limit: Math.min(1000, count - shares.length),
        }),
    });
    total_count = page.total_count;
    shares.push(...page.shares);
    if (page.shares.length === 0 || shares.length >= total_count) break;
  }
  return { shares, total_count };
}

export async function listMine(
  opts: ListMyPublicDirectorySharesOptions = {},
): Promise<ListPublicDirectorySharesResponse> {
  if (!opts.account_id) {
    throw Error("user must be signed in");
  }
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit = Math.max(1, Math.min(1000, Math.trunc(opts.limit ?? 100)));
  const count = offset + limit;
  const pages = await Promise.all(
    (await publicDirectoryShareSearchBayIds()).map(
      async (bay_id) => await listMineOnBay({ bay_id, opts, count }),
    ),
  );
  const byId = new Map<string, PublicDirectoryShareSummary>();
  for (const share of pages.flatMap((page) => page.shares)) {
    const current = byId.get(share.id);
    if (current == null || shareUpdatedAt(share) > shareUpdatedAt(current)) {
      byId.set(share.id, share);
    }
  }
  const shares = [...byId.values()]
    .sort(
      (left, right) =>
        shareUpdatedAt(right) - shareUpdatedAt(left) ||
        left.slug.localeCompare(right.slug, undefined, { sensitivity: "base" }),
    )
    .slice(offset, offset + limit);
  return {
    shares,
    total_count: pages.reduce((sum, page) => sum + page.total_count, 0),
  };
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
} from "@cocalc/server/public-directory-shares";
