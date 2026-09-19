/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Explicit allowlist: legacy billing and other notices retain their policy.
export const FINANCIAL_RECEIPT_NOTICE_TYPES = [
  "billing_course_funding_receipt",
  "billing_monthly_collection",
  "billing_credit_transfer_receipt",
  "billing_personal_funding_receipt",
];

export const FINANCIAL_RECEIPT_MAX_ATTEMPTS = 12;
export const FINANCIAL_RECEIPT_RETRY_BASE_MS = 60_000;
export const FINANCIAL_RECEIPT_RETRY_CAP_MS = 3_600_000;

export function financialReceiptRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error("Invalid financial receipt attempt");
  return Math.min(
    FINANCIAL_RECEIPT_RETRY_CAP_MS,
    FINANCIAL_RECEIPT_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 6),
  );
}

export function isFinancialReceipt(
  summary: Record<string, any> | undefined,
): boolean {
  return FINANCIAL_RECEIPT_NOTICE_TYPES.includes(summary?.notice_type);
}

export function verifiedFinancialReceiptEmail(
  account:
    | {
        email_address: string | null;
        email_address_verified: Record<string, any> | null;
        banned?: boolean | null;
        deleted?: boolean | null;
      }
    | undefined,
): string | null {
  const email = account?.email_address?.trim();
  if (!email || account?.banned || account?.deleted) return null;
  const verified = account?.email_address_verified;
  return verified &&
    Object.prototype.hasOwnProperty.call(verified, email) &&
    verified[email]
    ? email
    : null;
}
