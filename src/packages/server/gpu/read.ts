/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, read-only: the GPU catalog, stock per data center
and cloud, and pods, read with the account's own RunPod key. Results are the
allowlisted views from @cocalc/cloud/runpod, so they never carry env, start
commands or registry credentials. Errors are fixed text: never the key or
provider error bodies.

Custody: the key is read only on its owner's home bay. On any other bay,
each call is forwarded whole to the home bay (getGpu*), which runs it there
(getGpu*Local); only the request filters and the allowlisted result cross
between bays, never the key.
*/

import { RunpodApiError, type RunpodClient } from "@cocalc/cloud/runpod/client";
import { getRunpodCatalog } from "@cocalc/cloud/runpod/catalog";
import type { RunpodPodView } from "@cocalc/util/gpu/runpod";
import type {
  GpuAvailabilityFilter,
  GpuAvailabilityResult,
  GpuCatalogResult,
  GpuOffer,
  GpuPodsResult,
} from "@cocalc/conat/hub/api/gpu";
import {
  getRunpodCleanupForAccount,
  getRunpodClientForAccount,
  isGpuProviderKeysEntitled,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  listManagedGpuPodsLocal,
  recordSeenAddresses,
} from "@cocalc/server/gpu/pods";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import {
  type GpuProvider,
  isGpuProvider,
} from "@cocalc/util/gpu/provider-keys";
import {
  GPU_READ_TIMEOUT_MS,
  type RunpodCatalog,
  type RunpodCloud,
  type RunpodStockLevel,
} from "@cocalc/util/gpu/runpod";

// The catalog changes by the minute, but agents may ask several times in a
// row (catalog, then availability with filters); one fetch serves them.
const CATALOG_TTL_MS = 30_000;
const MAX_CACHED_ACCOUNTS = 1000;

// Catalog and stock are for choosing a launch, so they use the full client,
// which needs the live entitlement. The pod inventory uses the narrow
// cleanup capability and stays readable after a lapse, so the owner can see
// what is still running and billing.
export interface GpuReadDeps {
  listManaged?: typeof listManagedGpuPodsLocal;
  recordAddresses?: typeof recordSeenAddresses;
  // for tests
  getClient?: (account_id: string) => Promise<RunpodClient | undefined>;
  getCleanup?: (
    account_id: string,
  ) => Promise<RunpodCleanupCapability | undefined>;
  isEntitled?: (account_id: string) => Promise<boolean>;
  now?: () => number;
}

// How long a read forwarded to the key owner's home bay may take. The
// inter-bay default (10 s) is shorter than one RunPod request may take
// (30 s), so a remotely homed account would fail where a local read
// succeeds. A larger account's inventory is a step 3 concern (managed pods
// come from our own records), not a reason to wait out the theoretical
// 50-page maximum.
export const GPU_HOME_BAY_TIMEOUT_MS = GPU_READ_TIMEOUT_MS;

export interface GpuRoutingDeps {
  // for tests: the home bay's API, or undefined when this is the home bay
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
}

async function gpuHomeClient(
  account_id: string,
): Promise<InterBayGpuApi | undefined> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  if (home_bay_id === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
    timeout: GPU_HOME_BAY_TIMEOUT_MS,
  });
}

const catalogCache = new Map<
  string,
  { expires: number; catalog: Promise<RunpodCatalog> }
>();

export function clearGpuCatalogCache() {
  catalogCache.clear();
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !account_id) {
    throw Error("must be signed in");
  }
  return account_id;
}

function requireProvider(provider: unknown): GpuProvider {
  if (provider == null) return "runpod";
  if (!isGpuProvider(provider)) throw Error("unknown GPU provider");
  return provider;
}

// What to do next, never provider text.
function readError(err: unknown): Error {
  if (err instanceof RunpodApiError) {
    switch (err.kind) {
      case "auth":
        return Error(
          "RunPod rejected your API key; it may have been revoked. Connect a new key in Settings → Connectors.",
        );
      case "forbidden":
        return Error(
          "Your RunPod API key lacks permission for this. Create a key with read and write access to pods.",
        );
      case "rate_limited":
        return Error("RunPod is rate-limiting requests. Try again shortly.");
      case "not_found":
        return Error("RunPod could not find that resource.");
      case "network":
        return Error("RunPod could not be reached. Try again shortly.");
      default:
        return Error(
          "RunPod returned an unexpected response. Try again shortly.",
        );
    }
  }
  return Error("Reading from RunPod failed.");
}

async function client(
  account_id: string,
  deps: GpuReadDeps,
): Promise<RunpodClient> {
  // Checked here too for a clear message; the key helper checks it again.
  if (!(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))) {
    throw Error("Your membership doesn't include GPUs on your own key.");
  }
  return await loaded(() =>
    (deps.getClient ?? getRunpodClientForAccount)(account_id),
  );
}

async function cleanup(
  account_id: string,
  deps: GpuReadDeps,
): Promise<RunpodCleanupCapability> {
  return await loaded(() =>
    (deps.getCleanup ?? getRunpodCleanupForAccount)(account_id),
  );
}

async function loaded<T>(get: () => Promise<T | undefined>): Promise<T> {
  let c: T | undefined;
  try {
    c = await get();
  } catch {
    throw Error("Your RunPod API key could not be loaded. Try again shortly.");
  }
  if (c == null) {
    throw Error(
      "No RunPod API key is connected. Connect one in Settings → Connectors.",
    );
  }
  return c;
}

async function runpod<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw readError(err);
  }
}

async function cachedCatalog(
  account_id: string,
  deps: GpuReadDeps,
): Promise<RunpodCatalog> {
  const now = (deps.now ?? Date.now)();
  const hit = catalogCache.get(account_id);
  if (hit && hit.expires > now) return await hit.catalog;
  const c = await client(account_id, deps);
  const catalog = runpod(() => getRunpodCatalog(c));
  if (catalogCache.size >= MAX_CACHED_ACCOUNTS) {
    for (const [id, entry] of catalogCache) {
      if (entry.expires <= now) catalogCache.delete(id);
    }
    if (catalogCache.size >= MAX_CACHED_ACCOUNTS) catalogCache.clear();
  }
  catalogCache.set(account_id, { expires: now + CATALOG_TTL_MS, catalog });
  // A failure is not cached.
  catalog.catch(() => {
    if (catalogCache.get(account_id)?.catalog === catalog) {
      catalogCache.delete(account_id);
    }
  });
  return await catalog;
}

export async function getGpuCatalogLocal(
  opts: { account_id?: string; provider?: unknown },
  deps: GpuReadDeps = {},
): Promise<GpuCatalogResult> {
  const account_id = requireAccount(opts.account_id);
  const provider = requireProvider(opts.provider);
  return { provider, catalog: await cachedCatalog(account_id, deps) };
}

const STOCK_RANK: Record<RunpodStockLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

function stringList(v: unknown, name: string): string[] | undefined {
  if (v == null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (list.length > 100 || !list.every((x) => typeof x === "string")) {
    throw Error(`${name} must be a list of strings`);
  }
  const out = list.map((x) => x.trim().toLowerCase()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function normalizeFilter(f: GpuAvailabilityFilter) {
  const cloud = f.cloud == null ? undefined : `${f.cloud}`.toUpperCase();
  if (cloud != null && cloud !== "SECURE" && cloud !== "COMMUNITY") {
    throw Error("cloud must be SECURE or COMMUNITY");
  }
  const minStock =
    f.min_stock == null ? undefined : `${f.min_stock}`.toUpperCase();
  if (minStock != null && !(minStock in STOCK_RANK)) {
    throw Error("min_stock must be LOW, MEDIUM or HIGH");
  }
  const maxPrice = f.max_price_per_gpu_hour;
  if (maxPrice != null && !(typeof maxPrice === "number" && maxPrice > 0)) {
    throw Error("max_price_per_gpu_hour must be a positive number");
  }
  const minCount = f.min_count;
  if (minCount != null && !(Number.isInteger(minCount) && minCount > 0)) {
    throw Error("min_count must be a positive integer");
  }
  return {
    gpu: stringList(f.gpu, "gpu"),
    cloud: cloud as RunpodCloud | undefined,
    dataCenter: stringList(f.data_center, "data_center"),
    region: stringList(f.region, "region"),
    minStock: minStock as RunpodStockLevel | undefined,
    maxPrice,
    minCount,
  };
}

// The catalog pivoted to one row per (GPU type, cloud, data center) in
// stock, filtered.
export function availabilityOffers(
  catalog: RunpodCatalog,
  filter: GpuAvailabilityFilter = {},
): GpuOffer[] {
  const f = normalizeFilter(filter);
  const centers = new Map(catalog.dataCenters.map((dc) => [dc.id, dc]));
  const offers: GpuOffer[] = [];
  for (const type of catalog.gpuTypes) {
    if (
      f.gpu &&
      !f.gpu.includes(type.id.toLowerCase()) &&
      !f.gpu.includes(type.name.toLowerCase())
    ) {
      continue;
    }
    for (const [cloud, offer] of [
      ["SECURE", type.secure],
      ["COMMUNITY", type.community],
    ] as const) {
      if (offer == null || (f.cloud && f.cloud !== cloud)) continue;
      if (
        f.maxPrice != null &&
        !(offer.price != null && offer.price <= f.maxPrice)
      ) {
        continue;
      }
      if (f.minCount != null && !((offer.maxCount ?? 0) >= f.minCount)) {
        continue;
      }
      for (const [dcId, stock] of Object.entries(offer.dataCenters)) {
        if (f.minStock && STOCK_RANK[stock] < STOCK_RANK[f.minStock]) continue;
        if (f.dataCenter && !f.dataCenter.includes(dcId.toLowerCase()))
          continue;
        const dc = centers.get(dcId);
        if (
          f.region &&
          !f.region.includes(`${dc?.region ?? ""}`.toLowerCase())
        ) {
          continue;
        }
        const row: GpuOffer = {
          gpu_type_id: type.id,
          gpu_name: type.name,
          memory_gb: type.memoryGb,
          cloud,
          data_center_id: dcId,
          data_center_name: dc?.name,
          region: dc?.region,
          stock,
          price_per_gpu_hour: offer.price,
          max_count: offer.maxCount,
        };
        for (const k of Object.keys(row)) {
          if (row[k] === undefined) delete row[k];
        }
        offers.push(row);
      }
    }
  }
  return offers.sort(
    (a, b) =>
      (a.price_per_gpu_hour ?? Infinity) - (b.price_per_gpu_hour ?? Infinity) ||
      STOCK_RANK[b.stock] - STOCK_RANK[a.stock] ||
      a.gpu_type_id.localeCompare(b.gpu_type_id) ||
      a.cloud.localeCompare(b.cloud) ||
      a.data_center_id.localeCompare(b.data_center_id),
  );
}

export async function getGpuAvailabilityLocal(
  opts: { account_id?: string; provider?: unknown } & GpuAvailabilityFilter,
  deps: GpuReadDeps = {},
): Promise<GpuAvailabilityResult> {
  const account_id = requireAccount(opts.account_id);
  const provider = requireProvider(opts.provider);
  // Validate before any provider call.
  normalizeFilter(opts);
  const catalog = await cachedCatalog(account_id, deps);
  return {
    provider,
    as_of: catalog.as_of,
    offers: availabilityOffers(catalog, opts),
  };
}

const POD_ID = /^[A-Za-z0-9_-]{6,64}$/;

export async function getGpuPodsLocal(
  opts: {
    account_id?: string;
    provider?: unknown;
    pod_id?: unknown;
    scope?: unknown;
    include_ended?: unknown;
  },
  deps: GpuReadDeps = {},
): Promise<GpuPodsResult> {
  const account_id = requireAccount(opts.account_id);
  const provider = requireProvider(opts.provider);
  const podId = opts.pod_id;
  if (podId != null && !(typeof podId === "string" && POD_ID.test(podId))) {
    throw Error("invalid pod id");
  }
  const scope = opts.scope ?? "managed";
  if (scope !== "managed" && scope !== "account") {
    throw Error('scope must be "managed" or "account"');
  }
  const as_of = new Date((deps.now ?? Date.now)()).toISOString();
  if (scope === "account") {
    // Every pod in the provider account, including ones CoCalc didn't start
    // (what an unknown-pod alert points at). Account principals only.
    const c = await cleanup(account_id, deps);
    const pods =
      podId != null
        ? await runpod(async () => {
            const pod = await c.getPod(podId);
            return pod ? [pod] : [];
          })
        : await runpod(() => c.listPods());
    return { provider, as_of, scope, pods };
  }
  // The pods CoCalc started that this account pays for or is responsible
  // for, with live views of the ones RunPod knows.
  const records = await (deps.listManaged ?? listManagedGpuPodsLocal)({
    account_id,
    include_ended: opts.include_ended === true,
  });
  const selected =
    podId != null
      ? records.filter((r) => r.provider_pod_id === podId || r.handle === podId)
      : records;
  const bound = selected.filter(
    (r) =>
      r.provider_pod_id && r.state !== "terminated" && r.state !== "failed",
  );
  let pods: RunpodPodView[] = [];
  if (bound.length > 0) {
    // A record's pod is read with its key owner's key: the caller's own, as
    // records are scoped to pods the caller's key pays for (classes, with
    // another payer, come in step 7).
    const c = await cleanup(account_id, deps);
    const ids = new Set(bound.map((r) => r.provider_pod_id!));
    pods =
      podId != null && bound.length === 1
        ? await runpod(async () => {
            const pod = await c.getPod(bound[0].provider_pod_id!);
            return pod ? [pod] : [];
          })
        : (await runpod(() => c.listPods())).filter((p) => ids.has(p.id));
    await (deps.recordAddresses ?? recordSeenAddresses)(selected, pods).catch(
      () => {},
    );
  }
  return { provider, as_of, scope, pods, records: selected };
}

// ---- routed entry points (hub API) ----

// The request as it crosses to the home bay: the authenticated caller and
// the read's own parameters, nothing else.
function forwarded<T extends object>(
  account_id: string,
  opts: T,
  keys: string[],
) {
  const out: Record<string, unknown> = { account_id };
  for (const k of keys) {
    if (opts[k] !== undefined) out[k] = opts[k];
  }
  return out as T & { account_id: string };
}

const FILTER_KEYS = [
  "gpu",
  "cloud",
  "data_center",
  "region",
  "min_stock",
  "max_price_per_gpu_hour",
  "min_count",
];

export async function getGpuCatalog(
  opts: { account_id?: string; provider?: unknown },
  deps: GpuReadDeps & GpuRoutingDeps = {},
): Promise<GpuCatalogResult> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuHomeClient)(account_id);
  if (home) {
    return await home.gpuCatalog(
      forwarded(account_id, opts, ["provider"]) as any,
    );
  }
  return await getGpuCatalogLocal({ ...opts, account_id }, deps);
}

export async function getGpuAvailability(
  opts: { account_id?: string; provider?: unknown } & GpuAvailabilityFilter,
  deps: GpuReadDeps & GpuRoutingDeps = {},
): Promise<GpuAvailabilityResult> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuHomeClient)(account_id);
  if (home) {
    return await home.gpuAvailability(
      forwarded(account_id, opts, ["provider", ...FILTER_KEYS]) as any,
    );
  }
  return await getGpuAvailabilityLocal({ ...opts, account_id }, deps);
}

export async function getGpuPods(
  opts: {
    account_id?: string;
    provider?: unknown;
    pod_id?: unknown;
    scope?: unknown;
    include_ended?: unknown;
  },
  deps: GpuReadDeps & GpuRoutingDeps = {},
): Promise<GpuPodsResult> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuHomeClient)(account_id);
  if (home) {
    return await home.gpuPods(
      forwarded(account_id, opts, [
        "provider",
        "pod_id",
        "scope",
        "include_ended",
      ]) as any,
    );
  }
  return await getGpuPodsLocal({ ...opts, account_id }, deps);
}
