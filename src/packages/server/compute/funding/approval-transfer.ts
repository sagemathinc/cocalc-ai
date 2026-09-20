/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  CreditTransferTerms,
  CreditTransferApprovalStatus,
} from "@cocalc/util/credit-transfers";
import { normalizeCreditTransferTerms } from "@cocalc/util/credit-transfers";
import { moneyToDbString } from "@cocalc/util/money";
import {
  prepareCreditTransferApproval,
  withCreditTransferApprovalTransaction,
  transferableInTransaction,
  applyCreditTransferInTransaction,
} from "@cocalc/server/purchases/credit-transfers/core";
import {
  creditTransferTransport,
  registerCreditTransferApprovalService,
} from "@cocalc/server/purchases/credit-transfers/api";
import type {
  CourseFundingApprovals,
  FinancialApprovalResult,
  FundingApprovalExecutor,
  FundingIntent,
  FundingIntentStatus,
} from "./approvals";
import type { CourseFundingApprovalTerms } from "./approval-review";
import { requireCreditTransfersEnabled } from "@cocalc/server/purchases/credit-transfers/config";

export type CreditTransferApprovalTerms = CreditTransferTerms & {
  kind: "creditTransfer";
};
export interface CreditTransferApprovalReview {
  transferable_usd: string;
  remaining_transferable_usd: string;
}
export function normalizeTransferApprovalTerms(
  input: CreditTransferApprovalTerms,
): CreditTransferApprovalTerms {
  if (input.kind !== "creditTransfer")
    throw new Error("Invalid transfer approval kind");
  return { ...normalizeCreditTransferTerms(input), kind: "creditTransfer" };
}
export async function resolveTransferApprovalReview(
  payer_account_id: string,
  terms: CreditTransferApprovalTerms,
): Promise<CreditTransferApprovalReview> {
  await requireCreditTransfersEnabled();
  const prepared = await prepareCreditTransferApproval(
    { payer_account_id, terms },
    creditTransferTransport,
  );
  return await withCreditTransferApprovalTransaction(prepared, async (db) => {
    const { available } = await transferableInTransaction(db, prepared);
    if (available.lt(terms.amount_usd))
      throw new Error("Insufficient cleared transferable credit");
    return {
      transferable_usd: moneyToDbString(available),
      remaining_transferable_usd: moneyToDbString(
        available.minus(terms.amount_usd),
      ),
    };
  });
}

export async function prepareTransferApproval(
  intent: FundingIntent<CourseFundingApprovalTerms, FinancialApprovalResult>,
): Promise<
  | FundingApprovalExecutor<CourseFundingApprovalTerms, FinancialApprovalResult>
  | undefined
> {
  if (!("kind" in intent.terms) || intent.terms.kind !== "creditTransfer")
    return;
  await requireCreditTransfersEnabled();
  // Refresh payment evidence for every approval attempt, never from its stored review.
  const prepared = await prepareCreditTransferApproval(
    { payer_account_id: intent.payer_account_id, terms: intent.terms },
    creditTransferTransport,
  );
  return {
    withTransaction: (fn) =>
      withCreditTransferApprovalTransaction(prepared, fn),
    apply: async (locked) => {
      await requireCreditTransfersEnabled(locked.db);
      if (!("kind" in locked.terms) || locked.terms.kind !== "creditTransfer")
        throw new Error("Transfer intent kind changed");
      return {
        receipt: await applyCreditTransferInTransaction(
          { ...locked, terms: locked.terms },
          prepared,
        ),
      };
    },
  };
}

export function registerTransferApprovals(
  service: CourseFundingApprovals<
    CourseFundingApprovalTerms,
    FinancialApprovalResult
  >,
): () => void {
  const status = (
    value: FundingIntentStatus<FinancialApprovalResult>,
  ): CreditTransferApprovalStatus => ({
    operation_id: value.operation_id,
    state:
      value.status === "expired"
        ? "expired"
        : value.result && "receipt" in value.result
          ? value.result.receipt.state
          : "approval_required",
    approval_url: value.approval_url,
    ...(value.result && "receipt" in value.result
      ? { receipt: value.result.receipt }
      : {}),
  });
  return registerCreditTransferApprovalService({
    propose: async (opts) =>
      status(
        await service.propose({
          ...opts,
          terms: { ...opts.terms, kind: "creditTransfer" },
        }),
      ),
    status: async (opts) => {
      const value = await service.statusByOperation(opts);
      const intent = await service.retrieve({
        payer_account_id: opts.payer_account_id,
        intent_id: value.intent_id,
      });
      if (!("kind" in intent.terms) || intent.terms.kind !== "creditTransfer")
        throw new Error("Not a transfer intent");
      return status(value);
    },
  });
}
