/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type {
  ComputeApi,
  ComputeVm,
  ComputeVolume,
} from "@cocalc/conat/hub/api/compute";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import type {
  ComputeOwnerMutationMethod,
  ComputeOwnerMutationRequest,
} from "@cocalc/conat/inter-bay/api";
import type { ComputeAgentAuth } from "@cocalc/util/compute-agent-auth";
import { fundingId } from "@cocalc/util/compute-funding";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  routeComputeOwnerRead,
  listComputeOwnerResources,
  selectOwnedComputeResource,
  withLocalComputeResource,
} from "./owner-resource-routing";

const kinds = {
  startVm: "vm",
  stopVm: "vm",
  deleteVm: "vm",
  setVmTtl: "vm",
  setVmFundingMode: "vm",
  setVmMachineType: "vm",
  setVmPricingModel: "vm",
  resizeVolume: "volume",
  setVolumeFundingMode: "volume",
  deleteVolume: "volume",
} as const;

async function home(account_id: string): Promise<string> {
  fundingId(account_id, "Account");
  const result = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  if (!result.home_bay_id)
    throw Error("The compute owner's account home is unavailable.");
  return result.home_bay_id;
}
function client(bay: string) {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay,
    timeout: 15_000,
  });
}

/** This validates fresh auth at its authority; it never accepts a forwarded
 * boolean assertion that a different hub authenticated the user earlier. */
export async function checkComputeOwnerFreshAuthOnHome(opts: {
  account_id: string;
  session_hash: string;
}): Promise<void> {
  if ((await home(opts.account_id)) !== getConfiguredBayId())
    throw Error("Compute account home changed; refresh and retry.");
  await requireDangerousSessionAuth({
    ...opts,
    require_second_factor: "if_enabled",
  });
}
export async function requireComputeOwnerFreshAuth(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
}): Promise<void> {
  if (!isMultiBayCluster()) {
    await requireDangerousSessionAuth({
      ...opts,
      require_second_factor: "if_enabled",
    });
    return;
  }
  const account_id = fundingId(opts.account_id, "Account");
  const bay = await home(account_id);
  if (bay === getConfiguredBayId()) {
    await requireDangerousSessionAuth({
      ...opts,
      account_id,
      require_second_factor: "if_enabled",
    });
    return;
  }
  const session_hash =
    opts.session_hash ||
    getBrowserAuthSessionHash({
      account_id,
      browser_id: opts.browser_id ?? "",
    }) ||
    "";
  await client(bay).computeOwnerCheckFreshAuth({ account_id, session_hash });
}

/** Owner commands execute through the same public implementation on the owning
 * bay. Only routing is suppressed; funding, agent and fresh-auth checks remain. */
export async function computeOwnerMutationOnBay(
  request: ComputeOwnerMutationRequest,
) {
  if (!Object.hasOwn(kinds, request.method))
    throw Error("Unsupported compute resource operation.");
  const account_id = fundingId(
    request.opts.agent_auth?.account_id ?? request.opts.account_id,
    "Account",
  );
  if ((await home(account_id)) !== request.account_home_bay)
    throw Error("Compute account home changed; refresh and retry.");
  const id = fundingId(request.opts.id_or_name, "Resource");
  const table =
    kinds[request.method] === "vm" ? "compute_vms" : "compute_volumes";
  const { rows } = await getPool().query(
    `SELECT id FROM ${table} WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3`,
    [id, account_id, getConfiguredBayId()],
  );
  if (rows.length !== 1)
    throw Error("Compute resource not found or access denied.");
  return withLocalComputeResource(async () => {
    const api = await import("@cocalc/server/conat/api/compute");
    switch (request.method) {
      case "startVm":
        return api.startVm(request.opts);
      case "stopVm":
        return api.stopVm(request.opts);
      case "deleteVm":
        return api.deleteVm(request.opts);
      case "setVmTtl":
        return api.setVmTtl(request.opts);
      case "setVmFundingMode":
        return api.setVmFundingMode(request.opts);
      case "setVmMachineType":
        return api.setVmMachineType(request.opts);
      case "setVmPricingModel":
        return api.setVmPricingModel(request.opts);
      case "resizeVolume":
        return api.resizeVolume(request.opts);
      case "setVolumeFundingMode":
        return api.setVolumeFundingMode(request.opts);
      case "deleteVolume":
        return api.deleteVolume(request.opts);
    }
  });
}

export async function routeComputeOwnerMutation<
  M extends ComputeOwnerMutationMethod,
>(
  method: M,
  opts: Parameters<ComputeApi[M]>[0] & { agent_auth?: ComputeAgentAuth },
): Promise<Awaited<ReturnType<ComputeApi[M]>> | undefined> {
  if (!routeComputeOwnerRead()) return;
  const account_id = fundingId(
    opts.agent_auth?.account_id ?? opts.account_id,
    "Account",
  );
  const account_home_bay = await home(account_id);
  if (account_home_bay !== getConfiguredBayId())
    throw Error("Compute account home changed; refresh and retry.");
  const resources =
    kinds[method] === "vm"
      ? await listComputeOwnerResources({ account_id, kind: "vm" })
      : await listComputeOwnerResources({ account_id, kind: "volume" });
  const resource = selectOwnedComputeResource<ComputeVm | ComputeVolume>(
    resources,
    opts.id_or_name,
  );
  if (resource.owning_bay_id === getConfiguredBayId()) return;
  const actor = opts as { browser_id?: string; session_hash?: string };
  const request = {
    method,
    account_home_bay,
    opts: {
      ...opts,
      account_id,
      id_or_name: resource.id,
      session_hash:
        actor.session_hash ||
        getBrowserAuthSessionHash({
          account_id,
          browser_id: actor.browser_id ?? "",
        }) ||
        undefined,
    },
  } as ComputeOwnerMutationRequest;
  const result = await client(resource.owning_bay_id).computeOwnerMutate(
    request,
  );
  if (
    result.id !== resource.id ||
    result.owner_account_id !== account_id ||
    result.owning_bay_id !== resource.owning_bay_id
  )
    throw Error("Compute resource authority changed; refresh and retry.");
  return result as Awaited<ReturnType<ComputeApi[M]>>;
}
