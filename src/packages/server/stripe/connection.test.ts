/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import Stripe from "stripe";

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

  it("keeps one anonymous key across a Stripe-directed DELETE retry", async () => {
    enableStripeMutationAuthorityEnforcement();
    const responses = [
      {
        status: 400,
        headers: { "stripe-should-retry": "true" },
        body: { error: { type: "api_error", message: "retry requested" } },
      },
      {
        status: 200,
        headers: {},
        body: { id: "sub_retry", object: "subscription", status: "canceled" },
      },
    ];
    const makeRequest = jest.fn(async () => {
      const response = responses.shift()!;
      return {
        getStatusCode: () => response.status,
        getHeaders: () => response.headers,
        getRawResponse: () => ({}),
        toStream: () => {
          throw new Error("unexpected streaming response");
        },
        toJSON: async () => response.body,
      };
    });
    const guarded = createAuthorityGuardedStripeHttpClient({
      getClientName: () => "test",
      makeRequest,
    } as any);
    const stripe = new Stripe("sk_test_authority_retry", {
      apiVersion: "2026-04-22.dahlia",
      httpClient: guarded,
      maxNetworkRetries: 1,
      telemetry: false,
    });
    // Exercise RequestSender's real response-directed retry without waiting for
    // its randomized production backoff.
    (stripe as any)._requestSender._getSleepTimeInMS = () => 0;
    const tracker = createBillingAuthorityProviderMutationTracker();

    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "55555555-5555-4555-8555-555555555555",
      provider_tracker: tracker,
      fn: async () => await stripe.subscriptions.cancel("sub_retry"),
    });

    expect(makeRequest).toHaveBeenCalledTimes(2);
    const keys = makeRequest.mock.calls.map(
      (call) => call[4]["Idempotency-Key"],
    );
    expect(keys[0]).toMatch(/^cocalc-ba-v2-/);
    expect(keys[1]).toBe(keys[0]);
    expect(getBillingAuthorityProviderMutationOutcome(tracker)).toEqual({
      started: true,
      successful: true,
      ambiguous: false,
    });
  });

  it("resolves a response-directed ambiguity with a definitive failure", async () => {
    enableStripeMutationAuthorityEnforcement();
    const statuses = [
      { status: 400, retry: true },
      { status: 402, retry: false },
    ];
    const makeRequest = jest.fn(async () => {
      const response = statuses.shift()!;
      return {
        getStatusCode: () => response.status,
        getHeaders: () =>
          response.retry ? { "stripe-should-retry": "true" } : {},
        getRawResponse: () => ({}),
        toStream: () => {
          throw new Error("unexpected streaming response");
        },
        toJSON: async () => ({
          error: { type: "card_error", message: "card declined" },
        }),
      };
    });
    const guarded = createAuthorityGuardedStripeHttpClient({
      getClientName: () => "test",
      makeRequest,
    } as any);
    const stripe = new Stripe("sk_test_authority_retry", {
      apiVersion: "2026-04-22.dahlia",
      httpClient: guarded,
      maxNetworkRetries: 1,
      telemetry: false,
    });
    (stripe as any)._requestSender._getSleepTimeInMS = () => 0;
    const tracker = createBillingAuthorityProviderMutationTracker();

    await expect(
      runInBillingAuthorityContext({
        operation: "test",
        request_id: "66666666-6666-4666-8666-666666666666",
        provider_tracker: tracker,
        fn: async () => await stripe.subscriptions.cancel("sub_retry"),
      }),
    ).rejects.toThrow("card declined");
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(makeRequest.mock.calls[1][4]["Idempotency-Key"]).toBe(
      makeRequest.mock.calls[0][4]["Idempotency-Key"],
    );
    expect(getBillingAuthorityProviderMutationOutcome(tracker)).toEqual({
      started: true,
      successful: false,
      ambiguous: false,
    });
  });

  it.each([
    ["a lost response", "transport"],
    ["a server error", "server"],
  ] as const)(
    "preserves genuine ambiguity after %s followed by a definitive failure",
    async (_description, firstFailure) => {
      enableStripeMutationAuthorityEnforcement();
      let attempt = 0;
      const makeRequest = jest.fn(async () => {
        attempt += 1;
        if (attempt === 1 && firstFailure === "transport") {
          throw Object.assign(new Error("socket closed after request write"), {
            code: "ECONNRESET",
          });
        }
        const status = attempt === 1 ? 500 : 401;
        return {
          getStatusCode: () => status,
          getHeaders: () => ({}),
          getRawResponse: () => ({}),
          toStream: () => {
            throw new Error("unexpected streaming response");
          },
          toJSON: async () => ({
            error: {
              type: "invalid_request_error",
              message: "authentication failed",
            },
          }),
        };
      });
      const guarded = createAuthorityGuardedStripeHttpClient({
        getClientName: () => "test",
        makeRequest,
      } as any);
      const stripe = new Stripe("sk_test_authority_retry", {
        apiVersion: "2026-04-22.dahlia",
        httpClient: guarded,
        maxNetworkRetries: 1,
        telemetry: false,
      });
      (stripe as any)._requestSender._getSleepTimeInMS = () => 0;
      const tracker = createBillingAuthorityProviderMutationTracker();

      await expect(
        runInBillingAuthorityContext({
          operation: "test",
          request_id:
            firstFailure === "transport"
              ? "77777777-7777-4777-8777-777777777777"
              : "88888888-8888-4888-8888-888888888888",
          provider_tracker: tracker,
          fn: async () => await stripe.subscriptions.cancel("sub_retry"),
        }),
      ).rejects.toThrow("authentication failed");
      expect(makeRequest).toHaveBeenCalledTimes(2);
      expect(makeRequest.mock.calls[1][4]["Idempotency-Key"]).toBe(
        makeRequest.mock.calls[0][4]["Idempotency-Key"],
      );
      expect(getBillingAuthorityProviderMutationOutcome(tracker)).toEqual({
        started: true,
        successful: false,
        ambiguous: true,
      });
    },
  );

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
