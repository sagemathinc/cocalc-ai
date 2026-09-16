/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { lockAccountSpending } from "@cocalc/server/purchases/lock-account-spending";
import { getAccountFundingHolds } from "@cocalc/server/purchases/get-spendable-balance";
import {
  ComputeFundingError,
  fundingAmount,
  fundingId,
} from "@cocalc/util/compute-funding";
import type { ComputeFundingLane } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import getBalance from "@cocalc/server/purchases/get-balance";
import { ensureAccountUsageWindowSchema } from "@cocalc/server/membership/usage-windows";
import { lockFundingAuthority, assertFundingAccountHome } from "./authority";
import { assertAccountWriteOnHomeBay } from "@cocalc/database/postgres/account-rehome-fence";
import { prepareDedicatedHostPolicyInputsLocal } from "@cocalc/server/project-host/admission";
import type { DedicatedHostPolicyInputs } from "@cocalc/server/project-host/admission";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";

export interface AccountFundingBacking {
  ledger_balance_usd: string;
  prepaid_held_usd: string;
  postpaid_committed_usd: string;
  spendable_prepaid_usd: string;
}

export interface FundingHold {
  id: string;
  payer_account_id: string;
  source_kind: "course-pool" | "resource" | "transfer";
  source_id: string;
  lane: ComputeFundingLane;
  authorized_usd: string;
  remaining_usd: string;
}

const fundingTransactions = new WeakMap<
  PoolClient,
  {
    payer: string;
    epoch: string;
    policy?: DedicatedHostPolicyInputs;
    policyError?: unknown;
  }
>();

export function requireFundingAccountTransaction(
  client: PoolClient,
  payer: string,
): void {
  if (fundingTransactions.get(client)?.payer !== payer) {
    throw new ComputeFundingError(
      "funding_conflict",
      "Funding changes require an active transaction locked for this payer.",
    );
  }
}

export function fundingAuthorityEpoch(
  client: PoolClient,
  payer: string,
): string {
  requireFundingAccountTransaction(client, payer);
  return fundingTransactions.get(client)!.epoch;
}

export function fundingPolicyInputs(
  client: PoolClient,
  payer: string,
): DedicatedHostPolicyInputs {
  requireFundingAccountTransaction(client, payer);
  const state = fundingTransactions.get(client)!;
  if (!state.policy)
    throw (
      state.policyError ??
      new ComputeFundingError(
        "funding_unavailable",
        "Funding policy is unavailable.",
      )
    );
  return state.policy;
}

/** Internal payer-home transaction; callers must separately authorize the actor.
 * Rehome fence -> funding account -> authority -> source (pool/grant or personal
 * hold) -> reservation -> purchase. Never hold these locks across provider calls.
 */
export async function withFundingAccountTransaction<T>(
  accountId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const account_id = fundingId(accountId, "Payer account");
  await assertFundingAccountHome(account_id);
  if (!isBillingAuthorityEnabled()) {
    await assertAccountWriteOnHomeBay({
      db: getPool(),
      account_id,
      action: "prepare account funding",
    });
  }
  // Policy failure blocks new authorization, not settlement or replay of work
  // already authorized. Provider and seed-bay calls finish before BEGIN.
  let policy: DedicatedHostPolicyInputs | undefined;
  let policyError: unknown;
  try {
    policy = await prepareDedicatedHostPolicyInputsLocal(account_id);
  } catch (error) {
    policyError = error;
  }
  // Schema initialization uses its own connection; finish it before BEGIN,
  // including in single-connection development databases.
  await ensureAccountUsageWindowSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockAccountSpending(client, account_id);
    const epoch = await lockFundingAuthority(client, account_id);
    fundingTransactions.set(client, {
      payer: account_id,
      epoch,
      policy,
      policyError,
    });
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    fundingTransactions.delete(client);
    client.release();
  }
}

/** Read under the payer funding lock when the result is used for admission. */
export async function getAccountFundingBacking(
  client: PoolClient,
  accountId: string,
): Promise<AccountFundingBacking> {
  const account_id = fundingId(accountId, "Payer account");
  requireFundingAccountTransaction(client, account_id);
  const balance = toDecimal(
    await getBalance({ account_id, client, noSave: true }),
  );
  const held = await getAccountFundingHolds({ account_id, client });
  return {
    ledger_balance_usd: moneyToDbString(balance),
    ...held,
    spendable_prepaid_usd: moneyToDbString(
      balance.minus(held.prepaid_held_usd),
    ),
  };
}

/** Called inside withFundingAccountTransaction, never directly from an RPC.
 * capacity_usd is a server-computed lane envelope before existing holds, not
 * client-supplied credit. The caller must read it under the same account lock.
 */
export async function reserveAccountFundingBacking(
  client: PoolClient,
  opts: Omit<FundingHold, "id" | "remaining_usd"> & { capacity_usd: string },
): Promise<FundingHold> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  requireFundingAccountTransaction(client, payer);
  const source = fundingId(opts.source_id, "Funding source");
  const amount = fundingAmount(opts.authorized_usd, { positive: true });
  const capacity = fundingAmount(opts.capacity_usd);
  if (
    !["prepaid", "postpaid"].includes(opts.lane) ||
    !["course-pool", "resource", "transfer"].includes(opts.source_kind) ||
    (opts.source_kind === "transfer" && opts.lane !== "prepaid")
  ) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Invalid funding lane or source.",
    );
  }
  const {
    rows: [existing],
  } = await client.query<FundingHold>(
    "SELECT * FROM account_funding_holds WHERE payer_account_id=$1 AND source_kind=$2 AND source_id=$3 FOR UPDATE",
    [payer, opts.source_kind, source],
  );
  if (existing) {
    if (
      existing.lane !== opts.lane ||
      !toDecimal(existing.authorized_usd).eq(amount)
    ) {
      throw new ComputeFundingError(
        "funding_conflict",
        "The funding source already has a different backing authorization.",
      );
    }
    return existing;
  }
  const held = await getAccountFundingHolds({ account_id: payer, client });
  const committed =
    opts.lane === "prepaid"
      ? held.prepaid_held_usd
      : held.postpaid_committed_usd;
  if (toDecimal(committed).add(amount).gt(capacity)) {
    throw new ComputeFundingError(
      "insufficient_funding",
      "Not enough uncommitted funding remains for this allocation.",
    );
  }
  const {
    rows: [hold],
  } = await client.query<FundingHold>(
    `INSERT INTO account_funding_holds (id, payer_account_id, source_kind, source_id, lane, authorized_usd, remaining_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [randomUUID(), payer, opts.source_kind, source, opts.lane, amount],
  );
  return hold;
}

/** Consume or release backing only in the same transaction as its ledger/source
 * update. A zero remainder is retained to make replays unable to recreate a hold.
 */
export async function reduceAccountFundingBacking(
  client: PoolClient,
  opts: { payer_account_id: string; hold_id: string; amount_usd: string },
): Promise<void> {
  const accountId = fundingId(opts.payer_account_id, "Payer account");
  requireFundingAccountTransaction(client, accountId);
  const holdId = fundingId(opts.hold_id, "Funding hold");
  const amount = fundingAmount(opts.amount_usd);
  const result = await client.query(
    `UPDATE account_funding_holds SET remaining_usd=remaining_usd-$3, updated_at=clock_timestamp()
     WHERE id=$1 AND payer_account_id=$2 AND remaining_usd >= $3 RETURNING id`,
    [holdId, accountId, amount],
  );
  if (!result.rowCount)
    throw new ComputeFundingError(
      "funding_conflict",
      "Backing is missing or smaller than the requested reduction.",
    );
}
