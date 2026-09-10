/** @jest-environment node */

import { commercialTaxPolicy, assertCommercialAutomaticTax } from "./tax";
import { assertInvoiceTermsSnapshot } from "./state";

const invoice = {
  automatic_tax: true,
  tax_code: "txcd_10103000",
  billing_address: { country: "GB" },
};

describe("reviewed commercial automatic tax", () => {
  it("preserves untaxed orders unless explicitly enabled", () => {
    expect(commercialTaxPolicy()).toEqual({ enabled: false });
    expect(commercialTaxPolicy({ invoice: { automatic_tax: false } })).toEqual({
      enabled: false,
    });
    expect(commercialTaxPolicy({ invoice })).toEqual({
      enabled: true,
      taxCode: invoice.tax_code,
    });
  });

  it.each([
    [{ automatic_tax: "true" }, "boolean"],
    [{ ...invoice, tax_code: undefined }, "tax_code"],
    [{ ...invoice, tax_code: "invalid" }, "tax_code"],
    [{ ...invoice, billing_address: undefined }, "billing country"],
    [
      { ...invoice, billing_address: { country: "United Kingdom" } },
      "billing country",
    ],
  ])(
    "rejects incomplete or malformed approved tax terms %j",
    (value, message) => {
      expect(() => assertInvoiceTermsSnapshot({ invoice: value })).toThrow(
        message as string,
      );
    },
  );

  it.each([null, "failed", "requires_location_inputs"])(
    "blocks incomplete Stripe tax calculation %s",
    (status) => {
      expect(() =>
        assertCommercialAutomaticTax(
          { automatic_tax: { enabled: true, status } },
          { terms_snapshot: { invoice } },
        ),
      ).toThrow("not complete");
    },
  );

  it("requires the provider to match the reviewed choice", () => {
    expect(() =>
      assertCommercialAutomaticTax(
        { automatic_tax: { enabled: false } },
        { terms_snapshot: { invoice } },
      ),
    ).toThrow("tax configuration");
    expect(() =>
      assertCommercialAutomaticTax(
        { automatic_tax: { enabled: true, status: "complete" } },
        { terms_snapshot: {} },
      ),
    ).toThrow("tax configuration");
    // A completed calculation may legitimately be zero; no fixed VAT rate is assumed.
    expect(() =>
      assertCommercialAutomaticTax(
        { automatic_tax: { enabled: true, status: "complete" } },
        { terms_snapshot: { invoice } },
      ),
    ).not.toThrow();
  });
});
