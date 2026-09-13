/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  enableStripeMutationAuthorityEnforcement,
  resetBillingAuthorityContextForTests,
  runInBillingAuthorityContext,
} from "@cocalc/server/purchases/billing-authority/context";
import { createAuthorityGuardedStripeHttpClient } from "./connection";

describe("authority-guarded Stripe HTTP client", () => {
  beforeEach(resetBillingAuthorityContextForTests);
  afterEach(resetBillingAuthorityContextForTests);

  function client() {
    const makeRequest = jest.fn(async () => ({ statusCode: 200, headers: {} }));
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
});
