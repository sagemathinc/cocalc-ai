/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  businessTaxIdStatus,
  businessTaxIdType,
  requiresBusinessTaxId,
} from "./business-tax-id";

function customer(country: string | undefined, ids: any[] = []) {
  return {
    address: country == null ? null : { country },
    tax_ids: { data: ids },
  };
}

function vat(type: string, status: string, value = "DE123456789") {
  return { type, value, verification: { status } };
}

describe("requiresBusinessTaxId", () => {
  it.each([
    ["DE", true],
    ["fr", true],
    ["IE", true],
    ["GB", true],
    ["US", false],
    ["CH", false],
    ["NO", false],
    ["", false],
    [undefined, false],
  ])("%s -> %s", (country, expected) => {
    expect(requiresBusinessTaxId(country)).toBe(expected);
  });

  it("asks for the right Stripe tax ID type", () => {
    expect(businessTaxIdType("ES")).toBe("eu_vat");
    expect(businessTaxIdType("GB")).toBe("gb_vat");
    expect(businessTaxIdType("US")).toBeUndefined();
  });
});

describe("businessTaxIdStatus", () => {
  it("does not require a VAT ID outside the EU and UK, or without a country", () => {
    expect(businessTaxIdStatus(customer("US"))).toEqual({
      required: false,
      country: "US",
    });
    expect(businessTaxIdStatus(customer(undefined)).required).toBe(false);
    expect(businessTaxIdStatus(null).required).toBe(false);
  });

  it("refuses an EU or UK customer without a VAT ID", () => {
    expect(businessTaxIdStatus(customer("DE"))).toEqual({
      required: true,
      ok: false,
      country: "DE",
      reason: "missing",
    });
    expect(businessTaxIdStatus(customer("GB"))).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });

  it("accepts a verified eu_vat, and a pending or unavailable one", () => {
    expect(
      businessTaxIdStatus(customer("DE", [vat("eu_vat", "verified")])),
    ).toMatchObject({ ok: true, verification: "verified" });
    expect(
      businessTaxIdStatus(customer("DE", [vat("eu_vat", "pending")])),
    ).toMatchObject({ ok: true, verification: "pending" });
    expect(
      businessTaxIdStatus(customer("DE", [vat("eu_vat", "unavailable")])),
    ).toMatchObject({ ok: true, verification: "unavailable" });
  });

  it("refuses an unverified VAT ID", () => {
    expect(
      businessTaxIdStatus(customer("DE", [vat("eu_vat", "unverified")])),
    ).toMatchObject({ ok: false, reason: "unverified" });
  });

  it("prefers a verified ID when there are several", () => {
    expect(
      businessTaxIdStatus(
        customer("DE", [vat("eu_vat", "unverified"), vat("eu_vat", "verified")]),
      ),
    ).toMatchObject({ ok: true, verification: "verified" });
  });

  it("accepts gb_vat for GB, but not a tax ID of another type", () => {
    expect(
      businessTaxIdStatus(customer("GB", [vat("gb_vat", "verified", "GB1")])),
    ).toMatchObject({ ok: true });
    expect(
      businessTaxIdStatus(customer("GB", [vat("ch_vat", "verified", "CHE1")])),
    ).toMatchObject({ ok: false, reason: "missing" });
    expect(
      businessTaxIdStatus(customer("GB", [vat("eu_vat", "verified")])),
    ).toMatchObject({ ok: false, reason: "missing" });
    expect(
      businessTaxIdStatus(customer("FR", [vat("gb_vat", "verified", "GB1")])),
    ).toMatchObject({ ok: false, reason: "missing" });
  });

  it("ignores an ID with an empty value and accepts tax_ids as a plain array", () => {
    expect(
      businessTaxIdStatus(customer("DE", [vat("eu_vat", "verified", " ")])),
    ).toMatchObject({ ok: false, reason: "missing" });
    expect(
      businessTaxIdStatus({
        address: { country: "DE" },
        tax_ids: [vat("eu_vat", "verified")],
      }),
    ).toMatchObject({ ok: true });
  });
});
