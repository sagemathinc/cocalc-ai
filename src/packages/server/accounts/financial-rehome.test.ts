/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { remapFinancialRow } from "./financial-rehome";

const maps = {
  purchases: { "1": 101, "2": 102, "3": 103 },
  subscriptions: { "1": 201 },
  statements: { "1": 301 },
};

describe("financial rehome typed local references", () => {
  it("preserves monthly collection identity when a statement moves", () => {
    const monthly_collection = {
      attempt_id: "stable-attempt",
      state: "issued",
      consent_version: 2,
    };
    expect(
      remapFinancialRow(
        "statements",
        {
          id: 1,
          paid_purchase_id: 2,
          automatic_payment_intent_id: "pi_stable",
          monthly_collection,
        },
        maps,
      ),
    ).toEqual({
      id: 301,
      paid_purchase_id: 102,
      automatic_payment_intent_id: "pi_stable",
      monthly_collection,
    });
  });
  it("remaps ledger links without recursively changing arbitrary metadata", () => {
    const original = {
      id: 1,
      day_statement_id: 1,
      description: {
        purchase_id: 2,
        refund_purchase_id: 3,
        subscription_id: 1,
        metadata: { purchase_id: 999 },
      },
    };
    expect(remapFinancialRow("purchases", original, maps)).toEqual({
      id: 101,
      day_statement_id: 301,
      description: {
        purchase_id: 102,
        refund_purchase_id: 103,
        subscription_id: 201,
        metadata: { purchase_id: 999 },
      },
    });
    expect(original.id).toBe(1);
    expect(() => remapFinancialRow("purchases", { id: 4 }, maps)).toThrow(
      "Missing financial purchases reference",
    );
  });

  it("preserves provider replay identity and clears only worker leases", () => {
    const request = { subscription_id: "1" };
    expect(
      remapFinancialRow(
        "payment_fulfillments",
        {
          credit_id: 1,
          request,
          result: { purchase_id: 2, subscription_id: 1 },
        },
        maps,
      ),
    ).toEqual({
      credit_id: 101,
      request,
      result: { purchase_id: 102, subscription_id: 201 },
    });
    const provider_request = {
      metadata: { purchase_id: 1 },
      charge: "ch_original",
      amount: 100,
    };
    expect(
      remapFinancialRow(
        "provider_refund_attempts",
        {
          purchase_id: 1,
          refund_purchase_id: null,
          provider_request,
          reconcile_token: "old-token",
          reconcile_lease_expires_at: "old-lease",
        },
        maps,
      ),
    ).toEqual({
      purchase_id: 101,
      refund_purchase_id: null,
      provider_request,
      reconcile_token: null,
      reconcile_lease_expires_at: null,
    });
  });

  it("expires pending approvals without transferring authenticated sessions", () => {
    const row = remapFinancialRow(
      "course_funding_approval_intents",
      {
        created_at: "2026-09-12",
        expires_at: "2026-09-13",
        applied_at: null,
        approved_session_hash: "old",
        result: null,
      },
      maps,
    );
    expect(row.expires_at).toBe(row.created_at);
    expect(row.approved_session_hash).toBeNull();
    expect(
      remapFinancialRow(
        "course_funding_approval_intents",
        { applied_at: "2026-09-12", result: { receipt: { purchase_id: 1 } } },
        maps,
      ).result.receipt.purchase_id,
    ).toBe(101);
    expect(
      remapFinancialRow(
        "compute_vm_personal_consents",
        { state: "pending", created_at: "2026-09-12" },
        maps,
      ).state,
    ).toBe("expired");
    expect(
      remapFinancialRow(
        "compute_vm_personal_consents",
        { state: "active", committed_usd: "1.0000000000" },
        maps,
      ),
    ).toEqual({ state: "active", committed_usd: "1.0000000000" });
  });
});
