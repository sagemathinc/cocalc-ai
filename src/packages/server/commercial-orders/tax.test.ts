/** @jest-environment node */

import {
  commercialTaxPolicy,
  assertCommercialAutomaticTax,
  assertCommercialInvoiceLineTax,
} from "./tax";
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

describe("invoice-line tax references in the pinned Stripe response", () => {
  const line: Parameters<typeof assertCommercialInvoiceLineTax>[1] = {
    pricing: {
      type: "price_details",
      unit_amount_decimal: "390000",
      price_details: { price: "price_1", product: "prod_1" },
    },
  };
  const order = { terms_snapshot: { invoice } };
  const retrievePrice = jest.fn();
  const retrieveProduct = jest.fn();
  const stripe = {
    prices: { retrieve: retrievePrice },
    products: { retrieve: retrieveProduct },
  } as unknown as Parameters<typeof assertCommercialInvoiceLineTax>[0];

  beforeEach(() => {
    jest.resetAllMocks();
    retrievePrice.mockResolvedValue({
      id: "price_1",
      tax_behavior: "exclusive",
      product: { id: "prod_1", tax_code: invoice.tax_code },
    });
    retrieveProduct.mockResolvedValue({
      id: "prod_1",
      tax_code: invoice.tax_code,
    });
  });

  it("retrieves the referenced price and expands its product", async () => {
    await assertCommercialInvoiceLineTax(stripe, line, order);
    expect(retrievePrice).toHaveBeenCalledWith("price_1", {
      expand: ["product"],
    });
    expect(retrieveProduct).not.toHaveBeenCalled();
  });

  it("retrieves an unexpanded product and accepts an expanded tax code", async () => {
    retrievePrice.mockResolvedValue({
      id: "price_1",
      tax_behavior: "exclusive",
      product: "prod_1",
    });
    retrieveProduct.mockResolvedValue({
      id: "prod_1",
      tax_code: { id: invoice.tax_code },
    });
    await assertCommercialInvoiceLineTax(stripe, line, order);
    expect(retrieveProduct).toHaveBeenCalledWith("prod_1");
  });

  it.each([
    { id: "prod_other", tax_code: invoice.tax_code },
    { id: "prod_1", deleted: true },
    { id: "prod_1", tax_code: null },
  ])("rejects an unverifiable product %j", async (product) => {
    retrievePrice.mockResolvedValue({
      id: "price_1",
      tax_behavior: "exclusive",
      product,
    });
    await expect(
      assertCommercialInvoiceLineTax(stripe, line, order),
    ).rejects.toThrow("line tax settings");
  });

  it("does not trust invented top-level line tax fields", async () => {
    const unverified = {
      pricing: null,
      tax_code: invoice.tax_code,
      tax_behavior: "exclusive",
    };
    await expect(
      assertCommercialInvoiceLineTax(stripe, unverified, order),
    ).rejects.toThrow("cannot be verified");
    expect(retrievePrice).not.toHaveBeenCalled();
  });

  it("fails closed when price retrieval fails", async () => {
    retrievePrice.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(
      assertCommercialInvoiceLineTax(stripe, line, order),
    ).rejects.toThrow("Stripe unavailable");
  });

  it("preserves legacy untaxed invoices without pricing details", async () => {
    await assertCommercialInvoiceLineTax(
      stripe,
      { pricing: null },
      { terms_snapshot: {} },
    );
    expect(retrievePrice).not.toHaveBeenCalled();
  });
});
