/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterSeedBayId,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import {
  billingAccountsTable,
  ensureBillingAccount,
} from "@cocalc/server/purchases/billing-account";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import { ComputeFundingError } from "@cocalc/util/compute-funding";
import type { ComputeVmFundingBinding } from "@cocalc/util/compute-vm-funding";

/** Resolve outside the transaction: local DB ownership alone is insufficient
 * when an old bay has been restored from a pre-handoff backup.
 */
export async function assertFundingAccountHome(payer: string): Promise<void> {
  (
    await import("@cocalc/server/purchases/billing-authority/client")
  ).assertBillingAuthorityTopology();
  if (isBillingAuthorityEnabled()) {
    if (
      isMultiBayCluster() &&
      getConfiguredBayId() !== getConfiguredClusterSeedBayId()
    )
      throw new ComputeFundingError(
        "funding_conflict",
        "Financial operations must run on the seed billing authority.",
      );
    await ensureBillingAccount(payer);
    return;
  }
  const home = isMultiBayCluster()
    ? await (
        await import("@cocalc/server/inter-bay/accounts")
      ).getClusterAccountById(payer)
    : await (
        await import("@cocalc/server/bay-directory")
      ).resolveAccountHomeBay({ account_id: payer });
  if (home?.home_bay_id !== getConfiguredBayId())
    throw new ComputeFundingError(
      "funding_conflict",
      "Financial account is homed on another home bay.",
    );
}

/** A predecessor epoch can settle/check only a reservation that was actually
 * imported by the activated successor. It cannot authorize a new reservation.
 * Called under the normal account transaction, before pool/reservation locks.
 */
export async function assertFundingReservationAuthority(
  client: PoolClient,
  payer: string,
  current_epoch: string,
  binding: ComputeVmFundingBinding,
): Promise<void> {
  if (payer !== binding.payer_account_id)
    throw new ComputeFundingError(
      "funding_conflict",
      "Reservation payer mismatch.",
    );
  if (binding.payer_authority_epoch === current_epoch) return;
  const {
    rows: [table],
  } = await client.query(
    "SELECT to_regclass('public.account_financial_handoffs') AS name",
  );
  if (table?.name) {
    const { rows } = await client.query(
      `SELECT 1 FROM account_financial_handoffs h
      WHERE h.account_id=$1 AND h.dest_epoch=$2 AND h.dest_bay_id=$3 AND h.state='active'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(h.snapshot::jsonb->'rows'->'compute_funding_reservations') r
        WHERE r->>'id'=$4 AND r->'pricing_snapshot'->'binding' @> $5::jsonb) LIMIT 1`,
      [
        payer,
        current_epoch,
        getConfiguredBayId(),
        binding.reservation_id,
        JSON.stringify({
          payer_account_id: payer,
          payer_authority_epoch: binding.payer_authority_epoch,
          reservation_id: binding.reservation_id,
          source: binding.source,
          resource_id: binding.resource_id,
          resource_generation: binding.resource_generation,
          owning_bay_id: binding.owning_bay_id,
          owner_account_id: binding.owner_account_id,
          funding_epoch: binding.funding_epoch,
          resource_kind: binding.resource_kind,
        }),
      ],
    );
    if (rows.length === 1) return;
  }
  throw new ComputeFundingError(
    "funding_conflict",
    "Stale payer funding authority.",
  );
}

/** Until funding records participate in account portability, refuse a move
 * rather than abandon backing or recreate financial history on another bay.
 * The account rehome coordinator calls this while holding its existing fence.
 */
export async function assertFundingAccountCanRehome(
  client: Pick<PoolClient, "query">,
  payer: string,
): Promise<void> {
  if (isBillingAuthorityEnabled()) {
    // Financial records are seed-global and do not move with account-home state.
    return;
  }
  const tables = [
    ["purchases", "account_id", ""],
    ["subscriptions", "account_id", ""],
    ["statements", "account_id", ""],
    ["subscription_renewal_attempts", "account_id", ""],
    ["credit_payment_roots", "account_id", ""],
    ["credit_transfers", "sender_account_id", ""],
    ["credit_transfer_deliveries", "recipient_account_id", ""],
    ["credit_transfer_entries", "account_id", ""],
    ["credit_transfer_ledger_observations", "account_id", ""],
    ["account_funding_holds", "payer_account_id", ""],
    ["compute_funding_pools", "payer_account_id", ""],
    ["payment_fulfillments", "account_id", "AND state='pending'"],
    ["provider_refund_attempts", "account_id", "AND state='pending'"],
  ];
  for (const [table, owner, condition] of tables) {
    const { rows } = await client.query(
      "SELECT to_regclass($1) AS table_name",
      [`public.${table}`],
    );
    if (!rows[0]?.table_name) continue;
    const { rows: obligations } = await client.query(
      `SELECT 1 FROM ${table} WHERE ${owner}=$1 ${condition} LIMIT 1`,
      [payer],
    );
    if (obligations.length)
      throw new ComputeFundingError(
        "funding_unavailable",
        "Account funding records are not yet portable; this account cannot be rehomed.",
      );
  }
}

/** Called only after the account rehome and spending fences, before budget rows.
 * A stable epoch identifies this financial authority, not an individual request.
 * Frozen/retired records are never recreated or reactivated by ordinary work.
 * Handoff state changes belong to the forthcoming financial rehome coordinator;
 * this initializer does not provide account portability by itself.
 */
export async function lockFundingAuthority(
  client: PoolClient,
  payer: string,
): Promise<string> {
  const central = isBillingAuthorityEnabled() && isMultiBayCluster();
  const home = central ? getConfiguredClusterSeedBayId() : getConfiguredBayId();
  const accountTable = billingAccountsTable();
  const {
    rows: [account],
  } = await client.query<{ home_bay_id: string }>(
    `SELECT COALESCE(NULLIF(BTRIM(home_bay_id),''),$2) AS home_bay_id FROM ${accountTable}
     WHERE account_id=$1 AND deleted IS NOT TRUE FOR SHARE`,
    [payer, home],
  );
  if (!account || (!central && account.home_bay_id !== home))
    throw new ComputeFundingError(
      "funding_conflict",
      central
        ? "The billing account is unavailable for funding."
        : "The local account is not authoritative for funding.",
    );
  await client.query(
    `INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state)
     VALUES ($1,$2,$3,'active') ON CONFLICT (payer_account_id) DO NOTHING`,
    [payer, randomUUID(), home],
  );
  const {
    rows: [authority],
  } = await client.query<{ epoch: string; home_bay_id: string; state: string }>(
    "SELECT epoch,home_bay_id,state FROM account_funding_authorities WHERE payer_account_id=$1 FOR UPDATE",
    [payer],
  );
  if (
    !authority ||
    authority.home_bay_id !== home ||
    authority.state !== "active"
  )
    throw new ComputeFundingError(
      "funding_unavailable",
      "Financial authority is not active on this bay; reconcile the account handoff.",
    );
  return authority.epoch;
}
