/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import { getDedicatedHostPolicySnapshotLocal } from "@cocalc/server/project-host/admission";
import { isTrustedAdminPostpaid } from "@cocalc/server/project-host/funding-policy";
import {
  ensureAccountUsageWindowsForEvent,
  getActiveAccountUsageWindows,
} from "@cocalc/server/membership/usage-windows";
import type {
  AccountUsageWindow,
  AccountUsageWindowName,
} from "@cocalc/server/membership/usage-windows";
import {
  ComputeFundingError,
  fundingAmount,
  fundingDate,
  fundingId,
} from "@cocalc/util/compute-funding";
import type { ComputeFundingLane } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  getAccountFundingBacking,
  fundingPolicyInputs,
  requireFundingAccountTransaction,
} from "./backing";
import type { AccountFundingBacking } from "./backing";

export interface ComputeFundingPolicy {
  payer_account_id: string;
  lane: ComputeFundingLane;
  // The allocation primitive subtracts existing lane holds from this envelope.
  backing_capacity_usd: string;
  available_backing_usd: string;
  backing_valid: boolean;
  outstanding_resource_usd: string;
  service_headroom_usd: string;
  windows: Record<
    AccountUsageWindowName,
    {
      limit_usd: string;
      used_usd: string;
      headroom_usd: string;
      window?: AccountUsageWindow;
    }
  >;
}

function nonnegative(value: ReturnType<typeof toDecimal>): string {
  return moneyToDbString(value.lt(0) ? 0 : value);
}

/** Pure policy arithmetic. Never accept the snapshot or exposure from an RPC. */
export function evaluateComputeFundingPolicy({
  payer_account_id,
  lane,
  snapshot,
  backing,
  outstanding_resource_usd,
  windows,
}: {
  payer_account_id: string;
  lane: ComputeFundingLane;
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
  backing: AccountFundingBacking;
  outstanding_resource_usd: string;
  windows: Partial<Record<AccountUsageWindowName, AccountUsageWindow>>;
}): ComputeFundingPolicy {
  if (
    snapshot.account_id !== payer_account_id ||
    !["prepaid", "postpaid"].includes(lane)
  )
    throw new ComputeFundingError(
      "funding_conflict",
      "The funding policy does not match the payer and lane.",
    );
  if (!snapshot.can_create_hosts)
    throw new ComputeFundingError(
      "funding_unavailable",
      "The payer's membership does not allow dedicated compute. Choose an eligible membership or contact the site administrator.",
    );
  if (!snapshot.has_active_second_factor)
    throw new ComputeFundingError(
      "funding_unavailable",
      "The payer must enable two-factor authentication in account settings before funding dedicated compute.",
    );
  if (
    lane === "postpaid" &&
    !isTrustedAdminPostpaid(snapshot) &&
    (!snapshot.has_payment_method || !snapshot.has_usage_subscription)
  )
    throw new ComputeFundingError(
      "funding_unavailable",
      "Postpaid compute funding requires approved automatic billing or an explicit manual-collection override.",
    );
  const limits = snapshot.effective_limits;
  const limit5h =
    lane === "prepaid"
      ? limits.prepaid_host_usage_limit_5h_usd
      : limits.credit_spend_limit_5h_usd;
  const limit7d =
    lane === "prepaid"
      ? limits.prepaid_host_usage_limit_7d_usd
      : limits.credit_spend_limit_7d_usd;
  for (const limit of [limit5h, limit7d])
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)
      throw new ComputeFundingError(
        "funding_unavailable",
        "Compute funding requires positive 5-hour and 7-day spending limits.",
      );
  const usage = snapshot.dedicated_host_window_usage;
  const used5h = fundingAmount(
    lane === "prepaid" ? usage.prepaid_5h_usd : usage.credit_5h_usd,
  );
  const used7d = fundingAmount(
    lane === "prepaid" ? usage.prepaid_7d_usd : usage.credit_7d_usd,
  );
  const outstanding = fundingAmount(outstanding_resource_usd);
  const remaining5h = nonnegative(
    toDecimal(limit5h!).minus(used5h).minus(outstanding),
  );
  const remaining7d = nonnegative(
    toDecimal(limit7d!).minus(used7d).minus(outstanding),
  );
  const capacity =
    lane === "prepaid"
      ? nonnegative(toDecimal(backing.ledger_balance_usd))
      : nonnegative(toDecimal(limit7d!).minus(used7d));
  const held =
    lane === "prepaid"
      ? backing.prepaid_held_usd
      : backing.postpaid_committed_usd;
  return {
    payer_account_id,
    lane,
    backing_capacity_usd: capacity,
    available_backing_usd: nonnegative(
      toDecimal(capacity).minus(fundingAmount(held)),
    ),
    backing_valid: toDecimal(held).lte(capacity),
    outstanding_resource_usd: outstanding,
    service_headroom_usd: toDecimal(remaining5h).lt(remaining7d)
      ? remaining5h
      : remaining7d,
    windows: {
      "5h": {
        limit_usd: moneyToDbString(limit5h!),
        used_usd: used5h,
        headroom_usd: remaining5h,
        window: windows["5h"],
      },
      "7d": {
        limit_usd: moneyToDbString(limit7d!),
        used_usd: used7d,
        headroom_usd: remaining7d,
        window: windows["7d"],
      },
    },
  };
}

/** Called for new/renewed service, not to block settlement of existing work. */
export function assertComputeFundingServicePolicy(
  policy: ComputeFundingPolicy,
  opts: {
    authorized_usd: string;
    authorized_until: string;
    already_reserved?: boolean;
  },
): void {
  if (!policy.backing_valid)
    throw new ComputeFundingError(
      "funding_unavailable",
      "The payer's remaining backing no longer covers its commitments.",
    );
  const amount = fundingAmount(opts.authorized_usd, { positive: true });
  // Dispatch rechecks the existing commitment, not a second copy of it. Use
  // raw exposure: clamped headroom would hide a newly reduced limit.
  const exceedsWindow = opts.already_reserved
    ? Object.values(policy.windows).some(({ used_usd, limit_usd }) =>
        toDecimal(used_usd).plus(policy.outstanding_resource_usd).gt(limit_usd),
      )
    : toDecimal(amount).gt(policy.service_headroom_usd);
  if (exceedsWindow)
    throw new ComputeFundingError(
      "insufficient_funding",
      "The payer's usage windows cannot cover this resource reservation.",
    );
  const until = new Date(fundingDate(opts.authorized_until));
  for (const name of ["5h", "7d"] as const) {
    const window = policy.windows[name].window;
    if (
      !window ||
      window.account_id !== policy.payer_account_id ||
      until > window.resets_at
    )
      throw new ComputeFundingError(
        "funding_unavailable",
        "Service must be authorized within the payer's current usage windows.",
      );
  }
}

/** Account-home only. Reads ledger and usage through the funding transaction;
 * the existing membership/payment policy remains authoritative. Pool creation
 * alone must not start a new usage window. Service admission may create one,
 * atomically with its reservation, and must persist the returned window IDs.
 */
export async function getComputeFundingPolicyInTransaction(
  client: PoolClient,
  opts: {
    payer_account_id: string;
    lane: ComputeFundingLane;
    for_service?: boolean;
  },
): Promise<ComputeFundingPolicy> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  requireFundingAccountTransaction(client, payer);
  if (!["prepaid", "postpaid"].includes(opts.lane))
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Invalid compute funding lane.",
    );
  const windows = opts.for_service
    ? await ensureAccountUsageWindowsForEvent({ account_id: payer, client })
    : await getActiveAccountUsageWindows({ account_id: payer, client });
  const snapshot = await getDedicatedHostPolicySnapshotLocal(payer, {
    funding_mode_override:
      opts.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
    client,
    policy_inputs: fundingPolicyInputs(client, payer),
  });
  const backing = await getAccountFundingBacking(client, payer);
  const row = opts.for_service
    ? (
        await client.query<{ outstanding: string }>(
          // Both sources consume the same membership window envelope. Pool backing
          // alone is not service usage; count only its actual resource reservations.
          `SELECT COALESCE(SUM(r.authorized_usd-r.spent_usd-r.released_usd),0)::text AS outstanding
     FROM compute_funding_reservations r LEFT JOIN compute_funding_pools p ON p.id=r.pool_id
     LEFT JOIN account_funding_holds h ON h.payer_account_id=r.payer_account_id
       AND h.source_kind='resource' AND h.source_id=r.id
     WHERE r.payer_account_id=$1 AND COALESCE(p.lane,h.lane)=$2`,
          [payer, opts.lane],
        )
      ).rows[0]
    : { outstanding: "0" };
  return evaluateComputeFundingPolicy({
    payer_account_id: payer,
    lane: opts.lane,
    snapshot,
    backing,
    outstanding_resource_usd: row.outstanding,
    windows,
  });
}
