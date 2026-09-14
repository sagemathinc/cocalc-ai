/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  isBillingAuthorityHubApiCall,
  isBillingAuthorityHubApiRead,
  isBillingAuthorityHttpRead,
  isBillingAuthorityReadCommand,
} from "./classification";

describe("billing authority operation classification", () => {
  it("routes both financial Hub API groups", () => {
    expect(isBillingAuthorityHubApiCall("purchases.getBalance")).toBe(true);
    expect(isBillingAuthorityHubApiCall("commercialOrders.list")).toBe(true);
    expect(
      isBillingAuthorityHubApiCall("computeFunding.proposeAllocation"),
    ).toBe(true);
    expect(
      isBillingAuthorityHubApiRead("computeFunding.proposeAllocation"),
    ).toBe(false);
    expect(isBillingAuthorityHubApiCall("computeFunding.notARealMethod")).toBe(
      false,
    );
    expect(
      isBillingAuthorityHubApiCall(
        "adminCrm.createCommercialOrderFromOpportunity",
      ),
    ).toBe(true);
    expect(isBillingAuthorityHubApiCall("adminCrm.updateOrganization")).toBe(
      false,
    );
    expect(
      isBillingAuthorityHubApiCall("legacyMigration.applyFinancialMigration"),
    ).toBe(true);
    expect(
      isBillingAuthorityHubApiCall("legacyMigration.previewFinancialMigration"),
    ).toBe(false);
    expect(isBillingAuthorityHubApiCall("system.getCustomize")).toBe(false);
    expect(isBillingAuthorityHubApiCall("purchases.notARealMethod")).toBe(
      false,
    );
    expect(
      isBillingAuthorityHubApiCall("commercialOrders.notARealMethod"),
    ).toBe(false);
  });

  it("defaults new and side-effecting methods to serialized commands", () => {
    expect(isBillingAuthorityHubApiRead("purchases.getBalance")).toBe(true);
    expect(isBillingAuthorityHubApiRead("commercialOrders.quotePreview")).toBe(
      true,
    );
    expect(isBillingAuthorityHubApiRead("purchases.getMembershipDetails")).toBe(
      true,
    );
    expect(
      isBillingAuthorityHubApiRead("purchases.purchaseMembershipPackage"),
    ).toBe(false);
    expect(isBillingAuthorityHubApiRead("purchases.futureMethod")).toBe(false);
  });

  it("never accepts non-Hub commands on the concurrent read path", () => {
    expect(
      isBillingAuthorityReadCommand({
        kind: "hub-api",
        call: { name: "purchases.getBalance", args: [] },
      }),
    ).toBe(true);
    expect(
      isBillingAuthorityReadCommand({
        kind: "http",
        operation: "create-payment-intent",
        input: {},
      }),
    ).toBe(false);
    expect(isBillingAuthorityHttpRead("get-invoice")).toBe(false);
    expect(
      isBillingAuthorityReadCommand({
        kind: "http",
        operation: "get-invoice",
        input: {},
      }),
    ).toBe(false);
    expect(isBillingAuthorityHttpRead("get-payments")).toBe(false);
  });
});
