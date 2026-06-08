/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hasStripeBillingConfiguration } from "./billing";

describe("hasStripeBillingConfiguration", () => {
  it("requires both Stripe keys", () => {
    expect(hasStripeBillingConfiguration({})).toBe(false);
    expect(
      hasStripeBillingConfiguration({
        stripe_publishable_key: "pk_test_123",
      }),
    ).toBe(false);
    expect(
      hasStripeBillingConfiguration({
        stripe_secret_key: "sk_test_123",
      }),
    ).toBe(false);
    expect(
      hasStripeBillingConfiguration({
        stripe_publishable_key: " pk_test_123 ",
        stripe_secret_key: " sk_test_123 ",
      }),
    ).toBe(true);
  });
});
