/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details.
 */
export interface MonthlyCollectionConsent {
  enabled: boolean;
  version: number;
  updated_at?: string;
  terms_version: 1;
}
export interface MonthlyCollectionTerms {
  kind: "monthlyCollection";
  enabled: boolean;
  expected_version: number;
  terms_version: 1;
}
export interface MonthlyCollectionApproval {
  intent_id: string;
  approval_url: string;
  status: "pending" | "applied" | "expired";
}
export interface MonthlyCollectionApi {
  getMonthlyCollection(opts?: { account_id?: string }): Promise<{
    consent: MonthlyCollectionConsent;
    available: boolean;
    legacy_enabled: boolean;
    pending: MonthlyCollectionApproval[];
    attention_statement_ids?: number[];
  }>;
  proposeMonthlyCollection(opts: {
    account_id?: string;
    operation_id: string;
    terms: MonthlyCollectionTerms;
  }): Promise<MonthlyCollectionApproval>;
}
export function normalizeMonthlyCollectionTerms(
  input: MonthlyCollectionTerms,
): MonthlyCollectionTerms {
  if (
    input?.kind !== "monthlyCollection" ||
    typeof input.enabled !== "boolean" ||
    input.terms_version !== 1 ||
    !Number.isSafeInteger(input.expected_version) ||
    input.expected_version < 0
  )
    throw Error(
      "Invalid monthly collection consent. Refresh and review the terms again.",
    );
  return {
    kind: "monthlyCollection",
    enabled: input.enabled,
    expected_version: input.expected_version,
    terms_version: 1,
  };
}
export const MONTHLY_COLLECTION_TERMS =
  "Charge my saved payment method for unpaid monthly account statements in USD, including my sponsored compute charges and applicable taxes. This does not increase my membership spending limits or enable automatic deposits. I can disable future automatic collection; payments already started and amounts owed are not cancelled. Small balances may roll over to the next statement.";
