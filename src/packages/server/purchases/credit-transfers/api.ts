/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { fundingId } from "@cocalc/util/compute-funding";
import { normalizeCreditTransferTerms } from "@cocalc/util/credit-transfers";
import type {
  CreditTransferApi,
  CreditTransferApprovalStatus,
  CreditTransferTerms,
  CreditTransferReceipt,
  CreditTransferPendingApproval,
} from "@cocalc/util/credit-transfers";
import type { CreditTransferTransport } from "./core";
import {
  getCreditTransferRecipientLocal,
  prepareCreditTransferApproval,
  withCreditTransferApprovalTransaction,
  transferableInTransaction,
  getOutgoingCreditTransferLocal,
  deliverCreditTransferLocal,
} from "./core";
import { verifyPaymentPurchase } from "./payment-verification";
import { moneyToDbString } from "@cocalc/util/money";
import { isBillingAuthorityEnabled } from "../billing-authority/config";
import {
  creditTransfersEnabled,
  requireCreditTransfersEnabled,
} from "./config";

const remote = (bay: string) =>
  createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay,
  });
export const creditTransferTransport: CreditTransferTransport = {
  recipient: (bay, account_id) =>
    remote(bay).creditTransferRecipient({ account_id }),
  verifyRoot: (bay, account_id, purchase_id, root_id) =>
    remote(bay).creditTransferVerifyRoot({ account_id, purchase_id, root_id }),
  outgoing: (bay, account_id, transfer_id) =>
    remote(bay).creditTransferOutgoing({ account_id, transfer_id }),
  deliver: (bay, manifest) => {
    const opts = {
      sender_home_bay_id: manifest.sender_home_bay_id,
      sender_account_id: manifest.sender_account_id,
      transfer_id: manifest.transfer_id,
    };
    return bay === getConfiguredBayId()
      ? deliverCreditTransferLocal(opts, creditTransferTransport)
      : remote(bay).creditTransferDeliver(opts);
  },
};

export interface CreditTransferApprovalService {
  propose(opts: {
    payer_account_id: string;
    operation_id: string;
    terms: CreditTransferTerms;
  }): Promise<CreditTransferApprovalStatus>;
  status(opts: {
    payer_account_id: string;
    operation_id: string;
  }): Promise<CreditTransferApprovalStatus>;
}
let approvals: CreditTransferApprovalService | undefined;

/** Called by the shared isolated approval listener only after its transfer
 * handler, preflight and sorted transaction wrapper have been installed.
 */
export function registerCreditTransferApprovalService(
  service: CreditTransferApprovalService,
): () => void {
  if (approvals)
    throw Error("Credit transfer approval service already installed");
  approvals = service;
  return () => {
    if (approvals === service) approvals = undefined;
  };
}

async function requireEnabled() {
  if (approvals == null)
    throw Error(
      "Credit transfers are not enabled with trusted financial approval on this bay",
    );
  await requireCreditTransfersEnabled();
}
async function actorHome(value?: string) {
  const account_id = fundingId(value, "Signed-in account");
  if (isBillingAuthorityEnabled()) {
    return { account_id, client: undefined };
  }
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  return {
    account_id,
    client:
      home_bay_id === getConfiguredBayId() ? undefined : remote(home_bay_id),
  };
}

export const previewCreditTransfer: CreditTransferApi["previewCreditTransfer"] =
  async (opts) => {
    const { account_id, client } = await actorHome(opts.account_id);
    if (client) return client.previewCreditTransfer({ ...opts, account_id });
    await requireEnabled();
    const recipient_account_id = fundingId(
      opts.recipient_account_id,
      "Recipient",
    );
    const { home_bay_id } = await resolveAccountHomeBay({
      account_id: recipient_account_id,
    });
    const recipient =
      home_bay_id === getConfiguredBayId()
        ? await getCreditTransferRecipientLocal(recipient_account_id)
        : await creditTransferTransport.recipient(
            home_bay_id,
            recipient_account_id,
          );
    const terms = normalizeCreditTransferTerms({
      recipient,
      amount_usd: opts.amount_usd,
      currency: "USD",
    });
    const prepared = await prepareCreditTransferApproval(
      { payer_account_id: account_id, terms },
      creditTransferTransport,
    );
    return withCreditTransferApprovalTransaction(prepared, async (db) => {
      const { available } = await transferableInTransaction(db, prepared);
      if (available.lt(terms.amount_usd))
        throw Error("Insufficient cleared, unencumbered payment credit");
      return {
        terms,
        transferable_usd: moneyToDbString(available),
        remaining_transferable_usd: moneyToDbString(
          available.minus(terms.amount_usd),
        ),
      };
    });
  };

export const proposeCreditTransfer: CreditTransferApi["proposeCreditTransfer"] =
  async (opts) => {
    const { account_id, client } = await actorHome(opts.account_id);
    if (client) return client.proposeCreditTransfer({ ...opts, account_id });
    await requireEnabled();
    const operation_id = fundingId(opts.operation_id, "Transfer operation");
    const terms = normalizeCreditTransferTerms(opts.terms);
    // This creates only an intent. Approval preflight revalidates every term and payment root.
    return approvals!.propose({
      payer_account_id: account_id,
      operation_id,
      terms,
    });
  };

export const getCreditTransferStatus: CreditTransferApi["getCreditTransferStatus"] =
  async (opts) => {
    const { account_id, client } = await actorHome(opts.account_id);
    if (client) return client.getCreditTransferStatus({ ...opts, account_id });
    const operation_id = fundingId(opts.operation_id, "Transfer operation");
    const {
      rows: [row],
    } = await getPool().query<{
      state: CreditTransferReceipt["state"];
      receipt: CreditTransferReceipt;
    }>(
      `SELECT t.state,e.receipt FROM credit_transfers t JOIN credit_transfer_entries e
    ON e.transfer_id=t.transfer_id AND e.leg='debit' WHERE t.sender_account_id=$1 AND t.operation_id=$2`,
      [account_id, operation_id],
    );
    if (row)
      return {
        operation_id,
        state: row.state,
        receipt: { ...row.receipt, state: row.state },
      };
    if (!approvals)
      throw Error("Credit transfer approval status is unavailable");
    return approvals.status({ payer_account_id: account_id, operation_id });
  };

export const listCreditTransfers: CreditTransferApi["listCreditTransfers"] =
  async (opts = {}) => {
    const { account_id, client } = await actorHome(opts.account_id);
    if (client) return client.listCreditTransfers({ account_id });
    const { rows } = await getPool().query<{ receipt: CreditTransferReceipt }>(
      "SELECT receipt FROM credit_transfer_entries WHERE account_id=$1 ORDER BY purchase_id DESC LIMIT 50",
      [account_id],
    );
    const pending_approvals: CreditTransferPendingApproval[] = [];
    const administratorEnabled = await creditTransfersEnabled();
    const transfersEnabled = approvals != null && administratorEnabled;
    if (transfersEnabled) {
      const { rows: pending } = await getPool().query(
        `SELECT operation_id,terms,review FROM course_funding_approval_intents
         WHERE payer_account_id=$1 AND terms->>'kind'='creditTransfer'
           AND applied_at IS NULL AND expires_at>clock_timestamp()
         ORDER BY created_at DESC LIMIT 30`,
        [account_id],
      );
      for (const intent of pending) {
        const status = await approvals!.status({
          payer_account_id: account_id,
          operation_id: intent.operation_id,
        });
        if (status.state !== "approval_required" || !status.approval_url)
          continue;
        pending_approvals.push({
          operation_id: intent.operation_id,
          approval_url: status.approval_url,
          terms: normalizeCreditTransferTerms(intent.terms),
          transferable_usd: intent.review.credit_transfer.transferable_usd,
          remaining_transferable_usd:
            intent.review.credit_transfer.remaining_transferable_usd,
        });
      }
    }
    return {
      enabled: transfersEnabled,
      ...(!transfersEnabled
        ? {
            unavailable_reason:
              approvals == null
                ? "Credit transfers require secure financial authorization, which is not ready on this site."
                : "Credit transfers have been disabled by the site administrator.",
          }
        : {}),
      receipts: rows.map(({ receipt }) => receipt),
      pending_approvals,
    };
  };

// These four methods are registered only on authenticated inter-bay subjects.
export const creditTransferRecipient = ({
  account_id,
}: {
  account_id: string;
}) => getCreditTransferRecipientLocal(account_id);
export const creditTransferVerifyRoot = ({
  account_id,
  purchase_id,
  root_id,
}: {
  account_id: string;
  purchase_id: number;
  root_id?: string;
}) => verifyPaymentPurchase(account_id, purchase_id, root_id);
export const creditTransferOutgoing = ({
  account_id,
  transfer_id,
}: {
  account_id: string;
  transfer_id: string;
}) => getOutgoingCreditTransferLocal(account_id, transfer_id);
export const creditTransferDeliver = (
  opts: Parameters<typeof deliverCreditTransferLocal>[0],
) => deliverCreditTransferLocal(opts, creditTransferTransport);
