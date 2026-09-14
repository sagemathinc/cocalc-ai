/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  createBillingAuthorityProviderMutationTracker,
  enableStripeMutationAuthorityEnforcement,
  getBillingAuthorityProviderMutationOutcome,
  resetBillingAuthorityContextForTests,
  runInBillingAuthorityContext,
} from "@cocalc/server/purchases/billing-authority/context";
import { createAuthorityGuardedStripeHttpClient } from "./connection";

describe("authority-guarded Stripe HTTP client", () => {
  beforeEach(resetBillingAuthorityContextForTests);
  afterEach(resetBillingAuthorityContextForTests);

  function client() {
    const makeRequest = jest.fn(async () => ({
      getStatusCode: () => 200,
      headers: {},
    }));
    const delegate = {
      getClientName: () => "test",
      makeRequest,
    } as any;
    return {
      guarded: createAuthorityGuardedStripeHttpClient(delegate),
      makeRequest,
    };
  }

  it("allows Stripe reads outside the authority", async () => {
    enableStripeMutationAuthorityEnforcement();
    const { guarded, makeRequest } = client();
    await (guarded.makeRequest as any)(
      "api.stripe.com",
      "443",
      "/v1/customers/cus_1",
      "GET",
    );
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it("leaves legacy writes and idempotency keys untouched while disabled", async () => {
    const { guarded, makeRequest } = client();
    const headers = { "idempotency-key": "legacy-package-invoice" };
    await (guarded.makeRequest as any)(
      "api.stripe.com",
      "443",
      "/v1/invoices",
      "POST",
      headers,
      "customer=cus_1",
    );
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest.mock.calls[0][4]).toBe(headers);
    expect(makeRequest.mock.calls[0][4]).toEqual({
      "idempotency-key": "legacy-package-invoice",
    });
  });

  it("blocks Stripe writes before network I/O", async () => {
    enableStripeMutationAuthorityEnforcement();
    const { guarded, makeRequest } = client();
    await expect(
      (guarded.makeRequest as any)(
        "api.stripe.com",
        "443",
        "/v1/invoices",
        "POST",
      ),
    ).rejects.toThrow("must run through the billing authority");
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it("allows Stripe writes from an authority command", async () => {
    enableStripeMutationAuthorityEnforcement();
    const { guarded, makeRequest } = client();
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-1",
      fn: async () => {
        await (guarded.makeRequest as any)(
          "api.stripe.com",
          "443",
          "/v1/invoices",
          "POST",
        );
      },
    });
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it("does not contact Stripe unless the provider boundary is durable", async () => {
    enableStripeMutationAuthorityEnforcement();
    const { guarded, makeRequest } = client();
    await expect(
      runInBillingAuthorityContext({
        operation: "test",
        request_id: "request-provider-boundary-failure",
        record_provider_start: async () => {
          throw new Error("provider boundary was not durable");
        },
        fn: async () =>
          await (guarded.makeRequest as any)(
            "api.stripe.com",
            "443",
            "/v1/invoices",
            "POST",
          ),
      }),
    ).rejects.toThrow("provider boundary was not durable");
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it("preserves an explicit key across activation and transport retries", async () => {
    const { guarded, makeRequest } = client();
    const callerKey = "stripe-node-retry-fixed";
    await (guarded.makeRequest as any)(
      "api.stripe.com",
      "443",
      "/v1/invoices",
      "POST",
      { "Idempotency-Key": callerKey },
      "customer=cus_1",
    );

    enableStripeMutationAuthorityEnforcement();
    const tracker = createBillingAuthorityProviderMutationTracker();
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "11111111-1111-4111-8111-111111111111",
      provider_tracker: tracker,
      fn: async () => {
        for (let retry = 0; retry < 2; retry++) {
          await (guarded.makeRequest as any)(
            "api.stripe.com",
            "443",
            "/v1/invoices",
            "POST",
            { "Idempotency-Key": callerKey },
            "customer=cus_1",
          );
        }
      },
    });
    const keys = makeRequest.mock.calls.map(
      (call) => call[4]["Idempotency-Key"],
    );
    expect(keys).toEqual([callerKey, callerKey, callerKey]);
    expect(getBillingAuthorityProviderMutationOutcome(tracker)).toEqual({
      started: true,
      successful: true,
      ambiguous: false,
    });
  });

  it("reuses an anonymous key only while a transport outcome is unresolved", async () => {
    enableStripeMutationAuthorityEnforcement();
    const statuses = [500, 200, 200];
    const makeRequest = jest.fn(async () => ({
      getStatusCode: () => statuses.shift(),
    }));
    const guarded = createAuthorityGuardedStripeHttpClient({
      getClientName: () => "test",
      makeRequest,
    } as any);
    const tracker = createBillingAuthorityProviderMutationTracker();
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "44444444-4444-4444-8444-444444444444",
      provider_tracker: tracker,
      fn: async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await (guarded.makeRequest as any)(
            "api.stripe.com",
            "443",
            "/v1/customers/cus_1",
            "DELETE",
            {},
            "",
          );
        }
      },
    });
    const keys = makeRequest.mock.calls.map(
      (call) => call[4]["Idempotency-Key"],
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("records a lost Stripe response as ambiguous", async () => {
    enableStripeMutationAuthorityEnforcement();
    const makeRequest = jest.fn(async () => {
      throw new Error("socket closed after request write");
    });
    const guarded = createAuthorityGuardedStripeHttpClient({
      getClientName: () => "test",
      makeRequest,
    } as any);
    const tracker = createBillingAuthorityProviderMutationTracker();
    await expect(
      runInBillingAuthorityContext({
        operation: "test",
        request_id: "22222222-2222-4222-8222-222222222222",
        provider_tracker: tracker,
        fn: async () =>
          await (guarded.makeRequest as any)(
            "api.stripe.com",
            "443",
            "/v1/payment_intents",
            "POST",
            {},
            "amount=1000",
          ),
      }),
    ).rejects.toThrow("socket closed");
    expect(getBillingAuthorityProviderMutationOutcome(tracker)).toEqual({
      started: true,
      successful: false,
      ambiguous: true,
    });
  });

  it("treats a Stripe server error as an ambiguous mutation", async () => {
    enableStripeMutationAuthorityEnforcement();
    const guarded = createAuthorityGuardedStripeHttpClient({
      getClientName: () => "test",
      makeRequest: jest.fn(async () => ({ getStatusCode: () => 500 })),
    } as any);
    const tracker = createBillingAuthorityProviderMutationTracker();
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "33333333-3333-4333-8333-333333333333",
      provider_tracker: tracker,
      fn: async () => {
        await (guarded.makeRequest as any)(
          "api.stripe.com",
          "443",
          "/v1/invoices",
          "POST",
          {},
          "customer=cus_1",
        );
      },
    });
    expect(getBillingAuthorityProviderMutationOutcome(tracker).ambiguous).toBe(
      true,
    );
  });
});
