/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));
jest.mock("./util", () => ({
  getStripeCustomerId: jest.fn(async () => "cus_1"),
}));
jest.mock("@cocalc/server/accounts/get-name", () => ({
  __esModule: true,
  default: jest.fn(async () => "Ada"),
}));

import { getCustomer, setCustomer } from "./customer";

describe("customer VAT ID", () => {
  const stripe = {
    customers: {
      update: jest.fn(),
      retrieve: jest.fn(),
      listTaxIds: jest.fn(),
      createTaxId: jest.fn(),
      deleteTaxId: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConn.mockResolvedValue(stripe);
    stripe.customers.update.mockResolvedValue({ address: { country: "DE" } });
    stripe.customers.listTaxIds.mockResolvedValue({ data: [] });
    stripe.customers.createTaxId.mockResolvedValue({});
    stripe.customers.deleteTaxId.mockResolvedValue({});
  });

  it("adds an eu_vat for an EU address, normalizing the number", async () => {
    await setCustomer("acct", {
      address: { country: "DE" },
      vat_id: " de 123 456 789 ",
    });
    expect(stripe.customers.createTaxId).toHaveBeenCalledWith("cus_1", {
      type: "eu_vat",
      value: "DE123456789",
    });
  });

  it("adds a gb_vat for a UK address", async () => {
    stripe.customers.update.mockResolvedValue({ address: { country: "GB" } });
    await setCustomer("acct", { vat_id: "GB123456789" });
    expect(stripe.customers.createTaxId).toHaveBeenCalledWith("cus_1", {
      type: "gb_vat",
      value: "GB123456789",
    });
  });

  it("replaces an old VAT ID only after the new one is accepted", async () => {
    stripe.customers.listTaxIds.mockResolvedValue({
      data: [{ id: "txi_old", type: "eu_vat", value: "DE999" }],
    });
    stripe.customers.createTaxId.mockRejectedValueOnce(
      new Error("Invalid value for eu_vat"),
    );
    await expect(
      setCustomer("acct", { address: { country: "DE" }, vat_id: "DE1" }),
    ).rejects.toThrow("Invalid value");
    expect(stripe.customers.deleteTaxId).not.toHaveBeenCalled();

    await setCustomer("acct", { address: { country: "DE" }, vat_id: "DE2" });
    expect(stripe.customers.createTaxId).toHaveBeenLastCalledWith("cus_1", {
      type: "eu_vat",
      value: "DE2",
    });
    expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith(
      "cus_1",
      "txi_old",
    );
  });

  it("keeps an unchanged VAT ID (and its verification)", async () => {
    stripe.customers.listTaxIds.mockResolvedValue({
      data: [{ id: "txi_1", type: "eu_vat", value: "DE123456789" }],
    });
    await setCustomer("acct", {
      address: { country: "DE" },
      vat_id: "DE 123456789",
    });
    expect(stripe.customers.createTaxId).not.toHaveBeenCalled();
    expect(stripe.customers.deleteTaxId).not.toHaveBeenCalled();
  });

  it("removes the VAT ID when cleared, and leaves it alone when not given", async () => {
    stripe.customers.listTaxIds.mockResolvedValue({
      data: [{ id: "txi_1", type: "eu_vat", value: "DE1" }],
    });
    await setCustomer("acct", { address: { country: "DE" } });
    expect(stripe.customers.listTaxIds).not.toHaveBeenCalled();
    await setCustomer("acct", { address: { country: "DE" }, vat_id: "" });
    expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith("cus_1", "txi_1");
  });

  it("refuses a VAT number for a billing address outside the EU and UK", async () => {
    stripe.customers.update.mockResolvedValue({ address: { country: "US" } });
    await expect(setCustomer("acct", { vat_id: "DE123" })).rejects.toThrow(
      "only be added for a billing address in the EU or the UK",
    );
    expect(stripe.customers.createTaxId).not.toHaveBeenCalled();
  });

  it("returns the VAT ID and its verification status", async () => {
    stripe.customers.retrieve.mockResolvedValue({
      name: "Uni",
      address: { country: "DE" },
      tax_ids: {
        data: [
          {
            type: "eu_vat",
            value: "DE1",
            verification: { status: "pending" },
          },
        ],
      },
    });
    expect(await getCustomer("acct")).toMatchObject({
      vat_id: { value: "DE1", type: "eu_vat", status: "pending" },
    });
    expect(stripe.customers.retrieve).toHaveBeenCalledWith("cus_1", {
      expand: ["tax_ids"],
    });
  });
});
