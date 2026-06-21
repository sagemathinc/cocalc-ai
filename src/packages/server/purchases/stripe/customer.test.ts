/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { customerHasUsableBillingDetails } from "./customer";

describe("customerHasUsableBillingDetails", () => {
  it("accepts Stripe billing details with name, country, and postal code", () => {
    expect(
      customerHasUsableBillingDetails({
        name: "Ada Lovelace",
        address: {
          country: "US",
          postal_code: "94105",
        },
      }),
    ).toBe(true);
  });

  it("rejects missing name or location", () => {
    expect(
      customerHasUsableBillingDetails({
        name: "",
        address: {
          country: "US",
          postal_code: "94105",
        },
      }),
    ).toBe(false);
    expect(
      customerHasUsableBillingDetails({
        name: "Ada Lovelace",
        address: {
          country: "US",
        },
      }),
    ).toBe(false);
  });
});
