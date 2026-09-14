/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  BILLING_AUTHORITY_ENABLE_ENV,
  isBillingAuthorityEnabled,
} from "./config";

describe("billing authority rollout configuration", () => {
  it("is fail-safe and default-off", () => {
    expect(isBillingAuthorityEnabled({})).toBe(false);
    expect(
      isBillingAuthorityEnabled({ [BILLING_AUTHORITY_ENABLE_ENV]: "0" }),
    ).toBe(false);
    expect(
      isBillingAuthorityEnabled({ [BILLING_AUTHORITY_ENABLE_ENV]: "invalid" }),
    ).toBe(false);
  });

  it.each(["1", "true", "TRUE", " yes "])(
    "accepts the explicit enabled value %p",
    (value) => {
      expect(
        isBillingAuthorityEnabled({ [BILLING_AUTHORITY_ENABLE_ENV]: value }),
      ).toBe(true);
    },
  );
});
