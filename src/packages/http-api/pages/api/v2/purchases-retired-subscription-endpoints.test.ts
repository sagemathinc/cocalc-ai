/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { RETIRED_SUBSCRIPTION_ENDPOINT_ERROR } from "@cocalc/http-api/lib/retired-subscription-endpoint";

const endpoints = [
  "./purchases/cancel-subscription",
  "./purchases/cost-to-resume-subscription",
  "./purchases/get-live-subscriptions",
  "./purchases/get-subscriptions",
  "./purchases/renew-subscription",
  "./purchases/resume-subscription",
  "./purchases/stripe/create-subscription-payment",
] as const;

describe("retired subscription endpoints", () => {
  it.each(endpoints)("returns an explicit Gone response from %s", async (path) => {
    const { default: handle } = await import(path);
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));

    handle({}, { status });

    expect(status).toHaveBeenCalledWith(410);
    expect(json).toHaveBeenCalledWith({
      error: RETIRED_SUBSCRIPTION_ENDPOINT_ERROR,
      code: "legacy_subscription_endpoint_retired",
    });
  });
});
