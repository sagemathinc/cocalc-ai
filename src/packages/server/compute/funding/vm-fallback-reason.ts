/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  CheckComputeVmFundingRequest,
  ComputeVmFallbackDecision,
} from "@cocalc/util/compute-vm-funding";
import { fundingBudgetSummary } from "@cocalc/util/compute-funding";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import { withFundingAccountTransaction } from "./backing";
import {
  getComputeFundingPolicyInTransaction,
  assertComputeFundingServicePolicy,
} from "./policy";
import {
  lockVmFundingReservation,
  VM_FUNDING_RUN_MS,
  VM_FUNDING_MARGIN_MS,
} from "./vm-reservations";

/** This is a reasoned payer-home observation, never a request to reserve funds.
 * Security/policy failures and uncertain meters throw, rather than imply consent.
 */
export async function getComputeVmFallbackDecisionLocal(
  opts: Pick<CheckComputeVmFundingRequest, "account_id" | "binding">,
): Promise<ComputeVmFallbackDecision> {
  return await withFundingAccountTransaction(opts.account_id, async (db) => {
    const { pool, grant, reservation, binding } =
      await lockVmFundingReservation(db, opts);
    const {
      rows: [{ now }],
    } = await db.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const decision: ComputeVmFallbackDecision = {
      reason: null,
      reservation_id: binding.reservation_id,
      funding_epoch: binding.funding_epoch,
      resource_generation: binding.resource_generation,
      as_of: now.toISOString(),
    };
    const request = reservation.pricing_snapshot.request;
    // A changed security authorization is never an exhaustion/expiry fallback.
    if (
      !["active", "scheduled"].includes(pool.state) ||
      !["active", "scheduled", "expired", "exhausted"].includes(grant.state) ||
      pool.starts_at > now ||
      grant.starts_at > now ||
      reservation.state === "settled" ||
      now < new Date(binding.stop_at) ||
      now >= new Date(binding.storage_delete_at) ||
      (request.requested_stop_at &&
        now >= new Date(request.requested_stop_at)) ||
      (request.requested_delete_at &&
        now >= new Date(request.requested_delete_at))
    )
      return decision;
    const policy = await getComputeFundingPolicyInTransaction(db, {
      payer_account_id: opts.account_id,
      lane: pool.lane,
      for_service: true,
    });
    if (!policy.backing_valid) return decision;
    if (request.provider === "gcp") {
      const meter = reservation.pricing_snapshot.meter;
      if (
        !meter?.egress_complete_through ||
        now.valueOf() - Date.parse(meter.egress_complete_through) >
          15 * 60_000 ||
        toDecimal(meter.public_egress_bytes ?? 0)
          .div(1_000_000_000)
          .mul("0.1")
          .gte(binding.egress_usd)
      )
        return decision;
    }
    const expiry = Math.min(pool.ends_at.valueOf(), grant.ends_at.valueOf());
    // Shutdown margin belongs to the stated expiry; a shorter user timer does not.
    if (expiry <= now.valueOf() + VM_FUNDING_MARGIN_MS) {
      decision.reason = "course_expired";
      return decision;
    }
    const until = Math.min(
      now.valueOf() + VM_FUNDING_RUN_MS + VM_FUNDING_MARGIN_MS,
      expiry,
      policy.windows["5h"].window?.resets_at.valueOf() ?? 0,
      policy.windows["7d"].window?.resets_at.valueOf() ?? 0,
    );
    if (until <= now.valueOf() + VM_FUNDING_MARGIN_MS) return decision;
    const delta = until - reservation.authorized_until.valueOf();
    if (delta <= 0) return decision;
    const additional = moneyRound2Up(
      toDecimal(request.hourly_cost_usd).mul(delta).div(3600_000),
    ).plus(
      moneyRound2Up(
        toDecimal(request.storage_hourly_cost_usd).mul(delta).div(3600_000),
      ),
    );
    // Account limits, suspensions, and missing payment authorization must not be
    // relabeled as an exhausted course grant merely because both fail today.
    assertComputeFundingServicePolicy(policy, {
      authorized_usd: additional.toString(),
      authorized_until: new Date(until).toISOString(),
    });
    if (
      [pool, grant].some((b) =>
        additional.gt(fundingBudgetSummary(b).available_usd),
      )
    )
      decision.reason = "course_exhausted";
    return decision;
  });
}
