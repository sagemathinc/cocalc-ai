/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { ComputeFundingError, fundingId } from "@cocalc/util/compute-funding";
import type {
  PersonalResourceReview,
  PersonalResourceReviewRequest,
} from "@cocalc/util/compute-personal-funding-review";
import {
  normalizePersonalVmApprovalTerms,
  validatePersonalVmApprovalReview,
} from "./approval-personal";
import {
  normalizePersonalVolumeApprovalTerms,
  validatePersonalVolumeApprovalReview,
} from "./approval-volume-personal";

/** Private owning-bay endpoint; absence does not disclose another owner's VM. */
export async function reviewPersonalResourceOnBay(
  request: PersonalResourceReviewRequest,
): Promise<PersonalResourceReview | null> {
  const payer = fundingId(request.account_id, "Account");
  if (request.kind !== "vm" && request.kind !== "volume")
    throw Error("Unknown personal funding resource kind.");
  const id = fundingId(
    request.kind === "vm" ? request.terms.vm_id : request.terms.volume_id,
    "Resource",
  );
  const table = request.kind === "vm" ? "compute_vms" : "compute_volumes";
  const { rows } = await getPool().query(
    `SELECT id FROM ${table} WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3`,
    [id, payer, getConfiguredBayId()],
  );
  if (!rows.length) return null;
  if (request.kind === "vm") {
    return {
      kind: "vm",
      review: await (
        await import("./vm-personal")
      ).reviewPersonalVmFundingOnBay(payer, request.terms),
    };
  }
  return {
    kind: "volume",
    review: await (
      await import("./volume-personal")
    ).reviewPersonalVolumeFundingOnBay(payer, request.terms),
  };
}

/** Resource rows do not move with an account. Discovery is bounded and fails
 * closed on unavailable or contradictory ownership, outside financial locks. */
export async function resolvePersonalResourceReview(
  request: PersonalResourceReviewRequest,
): Promise<PersonalResourceReview> {
  fundingId(request.account_id, "Account");
  const local = getConfiguredBayId();
  const registered = isMultiBayCluster() ? await listClusterBayRegistry() : [];
  if (isMultiBayCluster() && !registered.some(({ bay_id }) => bay_id === local))
    throw new ComputeFundingError(
      "funding_unavailable",
      "The authoritative bay registry is incomplete.",
    );
  const bays = [
    ...new Set([
      local,
      ...getConfiguredClusterBayCatalog().map(({ bay_id }) => bay_id),
      ...registered.map(({ bay_id }) => bay_id),
    ]),
  ];
  if (bays.length > 32)
    throw new ComputeFundingError(
      "funding_unavailable",
      "Personal resource discovery exceeds the bounded bay limit.",
    );
  const results = await mapParallelLimit(
    bays,
    async (bay_id) => {
      const result =
        bay_id === local
          ? await reviewPersonalResourceOnBay(request)
          : await createInterBayAccountLocalClient({
              client: getInterBayFabricClient(),
              dest_bay: bay_id,
              timeout: 5_000,
            }).computeFundingReviewPersonalResource(request);
      if (result == null) return null;
      if (
        result.kind !== request.kind ||
        result.review.owning_bay_id !== bay_id
      )
        throw Error("Personal resource authority changed; refresh and retry.");
      if (result.kind === "vm" && request.kind === "vm")
        validatePersonalVmApprovalReview(
          request.account_id,
          normalizePersonalVmApprovalTerms({
            ...request.terms,
            kind: "personalVMfallback",
          }),
          result.review,
        );
      if (result.kind === "volume" && request.kind === "volume")
        validatePersonalVolumeApprovalReview(
          request.account_id,
          normalizePersonalVolumeApprovalTerms({
            ...request.terms,
            kind: "personalVolumeFunding",
          }),
          result.review,
        );
      return result;
    },
    4,
  );
  const found = results.filter((result) => result != null);
  if (found.length !== 1)
    throw new ComputeFundingError(
      "funding_unavailable",
      found.length
        ? "Conflicting resource ownership; personal funding is unavailable."
        : "Resource not found; personal funding requires its owner.",
    );
  return found[0];
}
