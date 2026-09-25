/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fundingAmount, fundingId } from "./compute-funding";
import { toDecimal } from "./money";

export const CREDIT_TRANSFER_MAX_USD = "1000.00";
export const CREDIT_TRANSFER_DAILY_MAX_USD = "2500.00";

export interface PaymentRoot {
  root_id: string;
  home_bay_id: string;
  account_id: string;
  purchase_id: number;
  payment_intent_id: string;
  amount_usd: string;
}

export interface CreditFragment {
  root: PaymentRoot;
  source_purchase_id: number;
  amount_usd: string;
}

export interface CreditTransferManifest {
  version: 1;
  approval_intent_id: string;
  transfer_id: string;
  operation_id: string;
  sender_account_id: string;
  sender_home_bay_id: string;
  sender_authority_epoch: string;
  terms: CreditTransferTerms;
  fragments: CreditFragment[];
  created_at: string;
}

export interface CreditTransferDelivery {
  transfer_id: string;
  manifest_hash: string;
  state: "received" | "rejected";
}

export interface CreditTransferRecipient {
  account_id: string;
  home_bay_id: string;
  authority_epoch: string;
  email_address: string;
  display_name: string;
}

export interface CreditTransferTerms {
  recipient: CreditTransferRecipient;
  currency: "USD";
  amount_usd: string;
}

export type CreditTransferState =
  | "pending"
  | "received"
  | "rejected"
  | "compensated";

export interface CreditTransferReceipt {
  transfer_id: string;
  operation_id: string;
  sender_account_id: string;
  recipient_account_id: string;
  amount_usd: string;
  currency: "USD";
  state: CreditTransferState;
  created_at: string;
  updated_at: string;
  purchase_id: number;
  direction: "sent" | "received" | "returned";
  counterpart_account_id: string;
}

export interface CreditTransferPreview {
  terms: CreditTransferTerms;
  transferable_usd: string;
  remaining_transferable_usd: string;
}

export interface CreditTransferApprovalStatus {
  operation_id: string;
  state: "approval_required" | "expired" | CreditTransferState;
  approval_url?: string;
  receipt?: CreditTransferReceipt;
}

export interface CreditTransferList {
  enabled: boolean;
  unavailable_reason?: string;
  receipts: CreditTransferReceipt[];
  pending_approvals?: CreditTransferPendingApproval[];
}

export interface CreditTransferPendingApproval extends CreditTransferPreview {
  operation_id: string;
  approval_url: string;
}

export interface CreditTransferApi {
  previewCreditTransfer: (opts: {
    account_id?: string;
    recipient_account_id: string;
    amount_usd: string;
  }) => Promise<CreditTransferPreview>;
  proposeCreditTransfer: (opts: {
    account_id?: string;
    operation_id: string;
    terms: CreditTransferTerms;
  }) => Promise<CreditTransferApprovalStatus>;
  getCreditTransferStatus: (opts: {
    account_id?: string;
    operation_id: string;
  }) => Promise<CreditTransferApprovalStatus>;
  listCreditTransfers: (opts?: {
    account_id?: string;
  }) => Promise<CreditTransferList>;
}

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Credit transfer terms must be an object");
  }
  return value as Record<string, unknown>;
}

export function normalizeCreditTransferTerms(
  value: unknown,
): CreditTransferTerms {
  const input = object(value);
  const recipient = object(input.recipient);
  if (input.currency !== "USD") throw Error("Credit transfers require USD");
  const amount_usd = fundingAmount(input.amount_usd, { cents: true });
  if (
    toDecimal(amount_usd).lte(0) ||
    toDecimal(amount_usd).gt(CREDIT_TRANSFER_MAX_USD)
  ) {
    throw Error(
      `Transfer amount must be positive and at most ${CREDIT_TRANSFER_MAX_USD} USD`,
    );
  }
  const boundedText = (
    value: unknown,
    field: string,
    limit: number,
  ): string => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > limit ||
      /[\x00-\x1f\x7f]/.test(value)
    ) {
      throw Error(`Invalid ${field}`);
    }
    return value.trim();
  };
  return {
    currency: "USD",
    amount_usd,
    recipient: {
      account_id: fundingId(recipient.account_id, "Recipient account"),
      home_bay_id: boundedText(
        recipient.home_bay_id,
        "recipient home bay",
        128,
      ),
      authority_epoch: fundingId(
        recipient.authority_epoch,
        "Recipient authority epoch",
      ),
      email_address: boundedText(
        recipient.email_address,
        "recipient email",
        254,
      ),
      display_name: boundedText(recipient.display_name, "recipient name", 256),
    },
  };
}
