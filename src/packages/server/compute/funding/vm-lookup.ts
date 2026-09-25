/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { fundingId } from "@cocalc/util/compute-funding";
import type {
  ComputeVmFundingBinding,
  LookupComputeVmFundingRequest,
} from "@cocalc/util/compute-vm-funding";
import {
  fundingAuthorityEpoch,
  withFundingAccountTransaction,
} from "./backing";
import { fundingConflict } from "./vm-reservations";
import { assertFundingReservationAuthority } from "./authority";

/** Payer-home authority is resolved by the existing account transaction fence.
 * Expired/revoked sources still need lookup and settlement during recovery.
 */
export async function lookupComputeVmFundingLocal(
  request: LookupComputeVmFundingRequest,
): Promise<ComputeVmFundingBinding | null> {
  const payer = fundingId(request.account_id, "Payer route");
  for (const value of [
    request.resource_id,
    request.owner_account_id,
    request.funding_epoch,
    ...(request.source.kind === "course"
      ? [request.source.pool_id, request.source.grant_id]
      : [request.source.consent_id]),
  ])
    fundingId(value, "Funding identity");
  if (
    !["course", "personal"].includes(request.source.kind) ||
    !request.owning_bay_id ||
    !Number.isSafeInteger(request.resource_generation) ||
    request.resource_generation < 1 ||
    !["compute-vm", "compute-volume"].includes(
      request.resource_kind ?? "compute-vm",
    )
  )
    fundingConflict("Unsupported funding recovery identity.");
  return await withFundingAccountTransaction(payer, async (db) => {
    const {
      rows: [row],
    } = await db.query<{ binding: ComputeVmFundingBinding }>(
      `SELECT pricing_snapshot->'binding' AS binding FROM compute_funding_reservations
      WHERE payer_account_id=$1 AND operation_id=$2 FOR SHARE`,
      [payer, request.funding_epoch],
    );
    if (!row) return null;
    const binding = row.binding;
    if (
      !binding ||
      binding.payer_account_id !== payer ||
      (binding.resource_kind ?? "compute-vm") !==
        (request.resource_kind ?? "compute-vm") ||
      binding.resource_id !== request.resource_id ||
      binding.resource_generation !== request.resource_generation ||
      binding.owner_account_id !== request.owner_account_id ||
      binding.owning_bay_id !== request.owning_bay_id ||
      binding.funding_epoch !== request.funding_epoch ||
      (request.source.kind === "course"
        ? binding.source.kind !== "course" ||
          binding.source.pool_id !== request.source.pool_id ||
          binding.source.grant_id !== request.source.grant_id
        : binding.source.kind !== "personal" ||
          binding.source.consent_id !== request.source.consent_id)
    )
      fundingConflict("Funding recovery found a mismatched authorization.");
    // A lost reply may be recovered after an account move. Accept the old
    // epoch only when this active successor imported this exact reservation,
    // just as settlement does; lookup never creates a new authorization.
    await assertFundingReservationAuthority(
      db,
      payer,
      fundingAuthorityEpoch(db, payer),
      binding,
    );
    return binding;
  });
}
