/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details.
 */
import getPool from "@cocalc/database/pool";
import type {
  ComputeVm,
  CreateComputeVmRequest,
} from "@cocalc/conat/hub/api/compute";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import type {
  ComputeCreateVmWithVolumeRequest,
  ComputeOwnerMutationResult,
} from "@cocalc/conat/inter-bay/api";
import type { ComputeAgentAuth } from "@cocalc/util/compute-agent-auth";
import { fundingId } from "@cocalc/util/compute-funding";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import {
  routeComputeOwnerRead,
  listComputeOwnerResources,
  selectOwnedComputeResource,
  withLocalComputeResource,
} from "./owner-resource-routing";

type Create = CreateComputeVmRequest & { agent_auth?: ComputeAgentAuth };
async function authority(opts: Create) {
  const account_id = fundingId(
    opts.agent_auth?.account_id ?? opts.account_id,
    "Account",
  );
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  if (!home_bay_id)
    throw Error("The compute owner's account home is unavailable.");
  return { account_id, home_bay_id };
}

/** The disk stays on its resource bay when the account moves. Creation must
 * execute there too; forwarding does not waive any ordinary admission checks. */
export async function routeVmToHomeVolume(
  opts: Create,
): Promise<ComputeVm | undefined> {
  if (!opts.home_volume || !routeComputeOwnerRead()) return;
  const { account_id, home_bay_id } = await authority(opts);
  if (home_bay_id !== getConfiguredBayId())
    throw Error("Compute account home changed; refresh and retry.");
  const volume = selectOwnedComputeResource(
    await listComputeOwnerResources({ account_id, kind: "volume" }),
    opts.home_volume,
  );
  if (volume.owner_account_id !== account_id)
    throw Error("Compute volume not found or access denied.");
  if (volume.owning_bay_id === getConfiguredBayId()) return;
  const response = await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: volume.owning_bay_id,
    timeout: 60_000,
  }).computeCreateVmWithVolume({
    account_home_bay: home_bay_id,
    opts: {
      ...opts,
      account_id,
      home_volume: volume.id,
      session_hash:
        opts.session_hash ||
        getBrowserAuthSessionHash({
          account_id,
          browser_id: opts.browser_id ?? "",
        }) ||
        undefined,
    },
  });
  if (
    response.id !== volume.id ||
    response.owner_account_id !== account_id ||
    response.owning_bay_id !== volume.owning_bay_id
  )
    throw Error("Compute volume authority changed; refresh and retry.");
  if ("approval_required" in response)
    throw Object.assign(
      Error(response.approval_required.message),
      response.approval_required,
    );
  const vm = response.value as ComputeVm;
  if (
    vm.owner_account_id !== account_id ||
    vm.owning_bay_id !== volume.owning_bay_id ||
    vm.home_volume_id !== volume.id
  )
    throw Error("Created VM does not match its selected home volume.");
  return vm;
}

export async function createVmWithVolumeOnBay(
  request: ComputeCreateVmWithVolumeRequest,
): Promise<ComputeOwnerMutationResult> {
  const { account_id, home_bay_id } = await authority(request.opts);
  if (home_bay_id !== request.account_home_bay)
    throw Error("Compute account home changed; refresh and retry.");
  const id = fundingId(request.opts.home_volume, "Home volume");
  const { rows } = await getPool().query(
    "SELECT id FROM compute_volumes WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3 AND deleted_at IS NULL",
    [id, account_id, getConfiguredBayId()],
  );
  if (rows.length !== 1)
    throw Error("Compute volume not found or access denied.");
  const result = await withLocalComputeResource(async () =>
    (await import("@cocalc/server/conat/api/compute")).createVm({
      ...request.opts,
      account_id,
    }),
  )
    .then((value) => ({ value }))
    .catch(async (error) =>
      (await import("./turn-grants")).agentComputeApprovalRequired(error),
    );
  return {
    id,
    owner_account_id: account_id,
    owning_bay_id: getConfiguredBayId(),
    ...result,
  };
}
