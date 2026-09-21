/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import type { ComputeVolume, ComputeVm } from "@cocalc/conat/hub/api/compute";
import type {
  ComputeOwnerResourcesRequest,
  ComputeOwnerResourcesResult,
  ComputeProjectResourcesRequest,
} from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { fundingId } from "@cocalc/util/compute-funding";

// Only the private owning-bay handler can select local-only reads. A public
// caller cannot disable routing with an option in its request.
const localRead = new AsyncLocalStorage<boolean>();
export function withLocalComputeResource<T>(fn: () => Promise<T>): Promise<T> {
  return localRead.run(true, fn);
}
export function routeComputeOwnerRead(): boolean {
  return isMultiBayCluster() && localRead.getStore() !== true;
}

export async function computeOwnerResourcesOnBay(
  request: ComputeOwnerResourcesRequest,
): Promise<ComputeOwnerResourcesResult> {
  fundingId(request.account_id, "Account");
  if (request.project_id) fundingId(request.project_id, "Project");
  if (request.kind !== "vm" && request.kind !== "volume")
    throw Error("Unknown compute resource kind.");
  const bay = getConfiguredBayId();
  const opts = {
    account_id: request.account_id,
    project_id: request.project_id,
    include_deleted: request.include_deleted === true,
  };
  return localRead.run(true, async () => {
    const api = await import("@cocalc/server/conat/api/compute");
    if (request.kind === "vm")
      return {
        kind: "vm",
        resources: (await api.listVms(opts)).filter(
          (v) => v.owning_bay_id === bay,
        ),
      };
    return {
      kind: "volume",
      resources: (await api.listVolumes(opts)).filter(
        (v) => v.owning_bay_id === bay,
      ),
    };
  });
}

export async function listComputeOwnerResources(
  request: ComputeOwnerResourcesRequest & { kind: "vm" },
): Promise<ComputeVm[]>;
export async function listComputeOwnerResources(
  request: ComputeOwnerResourcesRequest & { kind: "volume" },
): Promise<ComputeVolume[]>;
export async function listComputeOwnerResources(
  request: ComputeOwnerResourcesRequest,
): Promise<(ComputeVm | ComputeVolume)[]> {
  fundingId(request.account_id, "Account");
  return collectComputeResources(request);
}

/** Private delegated project read. The calling hub has checked project/host
 * identity and agent scope; this bay filters by live VM project-access grants. */
export async function computeProjectResourcesOnBay(
  request: ComputeProjectResourcesRequest,
): Promise<ComputeOwnerResourcesResult> {
  fundingId(request.project_id, "Project");
  if (request.kind !== "vm" && request.kind !== "volume")
    throw Error("Unknown compute resource kind.");
  return withLocalComputeResource(async () => {
    const api = await import("@cocalc/server/conat/api/compute");
    const opts = {
      project_id: request.project_id,
      include_deleted: request.include_deleted === true,
    };
    if (request.kind === "vm")
      return {
        kind: "vm",
        resources: (await api.listProjectVms(opts)).filter(
          (v) => v.owning_bay_id === getConfiguredBayId(),
        ),
      };
    return {
      kind: "volume",
      resources: (await api.listProjectVolumes(opts)).filter(
        (v) => v.owning_bay_id === getConfiguredBayId(),
      ),
    };
  });
}
export async function listComputeProjectResources(
  request: ComputeProjectResourcesRequest & { kind: "vm" },
): Promise<ComputeVm[]>;
export async function listComputeProjectResources(
  request: ComputeProjectResourcesRequest & { kind: "volume" },
): Promise<ComputeVolume[]>;
export async function listComputeProjectResources(
  request: ComputeProjectResourcesRequest,
): Promise<(ComputeVm | ComputeVolume)[]> {
  fundingId(request.project_id, "Project");
  return collectComputeResources(request);
}

async function collectComputeResources(
  request: ComputeOwnerResourcesRequest | ComputeProjectResourcesRequest,
): Promise<(ComputeVm | ComputeVolume)[]> {
  const local = getConfiguredBayId();
  const registered = isMultiBayCluster() ? await listClusterBayRegistry() : [];
  if (isMultiBayCluster() && !registered.some((b) => b.bay_id === local))
    throw Error("The authoritative compute bay registry is incomplete.");
  const bays = [
    ...new Set([
      local,
      ...getConfiguredClusterBayCatalog().map((b) => b.bay_id),
      ...registered.map((b) => b.bay_id),
    ]),
  ];
  if (bays.length > 32)
    throw Error("Compute resource discovery exceeds the bounded bay limit.");
  const seen = new Set<string>();
  const responses = await mapParallelLimit(
    bays,
    async (bay) => {
      const response =
        bay === local
          ? await ("account_id" in request
              ? computeOwnerResourcesOnBay(request)
              : computeProjectResourcesOnBay(request))
          : await (async () => {
              const api = createInterBayAccountLocalClient({
                client: getInterBayFabricClient(),
                dest_bay: bay,
                timeout: 5_000,
              });
              return "account_id" in request
                ? api.computeOwnerResources(request)
                : api.computeProjectResources(request);
            })();
      if (
        response.kind !== request.kind ||
        !Array.isArray(response.resources) ||
        response.resources.length > 2000
      )
        throw Error(
          "Invalid or oversized compute resource response; refresh and retry.",
        );
      for (const resource of response.resources) {
        fundingId(resource.id, "Resource");
        if (
          ("account_id" in request &&
            resource.owner_account_id !== request.account_id) ||
          resource.owning_bay_id !== bay ||
          (request.kind === "volume" &&
            request.project_id &&
            resource.project_id !== request.project_id) ||
          (!request.include_deleted && resource.deleted_at) ||
          seen.has(resource.id)
        )
          throw Error(
            "Conflicting compute resource ownership; refresh and retry.",
          );
        seen.add(resource.id);
      }
      return response.resources;
    },
    4,
  );
  return responses
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function selectOwnedComputeResource<
  T extends { id: string; name: string },
>(resources: T[], reference: string): T {
  const name = `${reference ?? ""}`.trim();
  const byId = resources.find((v) => v.id === name);
  if (byId) return byId;
  const matches = resources.filter((v) => v.name === name);
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? "More than one compute resource has that name; use its ID."
        : "Compute resource not found or access denied.",
    );
  return matches[0];
}
