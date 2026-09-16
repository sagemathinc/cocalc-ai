/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { __test__ } from "./store";

describe("CRM mutation identity", () => {
  it("distinguishes identical changes to different records", () => {
    const proposed = { lifecycle_stage: "customer" };
    expect(
      __test__.mutationPayloadHash({
        action: "organization.update",
        target: "organization:first",
        proposed,
      }),
    ).not.toBe(
      __test__.mutationPayloadHash({
        action: "organization.update",
        target: "organization:second",
        proposed,
      }),
    );
  });
});

describe("CRM website normalization", () => {
  it("normalizes bare hostnames and preserves HTTPS URLs", () => {
    expect(__test__.normalizeWebsite("example.com/customer")).toBe(
      "https://example.com/customer",
    );
    expect(__test__.normalizeWebsite("https://example.com/customer")).toBe(
      "https://example.com/customer",
    );
    expect(__test__.normalizeWebsite("example.com:8443/customer")).toBe(
      "https://example.com:8443/customer",
    );
  });

  it("rejects active-content schemes and embedded credentials", () => {
    expect(() => __test__.normalizeWebsite("javascript:alert(1)")).toThrow(
      "website must use HTTP or HTTPS",
    );
    expect(() =>
      __test__.normalizeWebsite("https://user:secret@example.com"),
    ).toThrow("without credentials");
  });
});

describe("CRM opportunity to commercial order linkage", () => {
  type LinkOpportunity = Parameters<
    typeof __test__.opportunityOrderLinkProblems
  >[0];
  type LinkOrder = Parameters<typeof __test__.opportunityOrderLinkProblems>[1];
  const opportunity: LinkOpportunity = {
    organization_id: "org-1",
    commercial_order_id: null,
    stage: "won",
    expected_value: "1000.0000000000",
    currency: "usd",
  };
  const order: LinkOrder = {
    crm_organization_id: "org-1",
    workflow_state: "complete",
    cancelled_at: null,
    agreed_total: "1000.0000000000",
    currency: "usd",
  };
  const link = (
    o: Partial<LinkOpportunity> = {},
    r: Partial<LinkOrder> = {},
    linkedElsewhere = false,
  ) =>
    __test__.opportunityOrderLinkProblems(
      { ...opportunity, ...o },
      { ...order, ...r },
      linkedElsewhere,
    );

  it("accepts a settled order whose organization and amount match", () => {
    expect(link()).toEqual({ blocking: [], warnings: [] });
  });

  it("refuses to move a link that is already set", () => {
    expect(link({ commercial_order_id: "other-order" }).blocking).toContain(
      "opportunity already has a commercial order; unlink it before linking another",
    );
  });

  it("refuses an order belonging to a different organization", () => {
    expect(link({}, { crm_organization_id: "org-2" }).blocking).toContain(
      "commercial order belongs to a different organization than the opportunity",
    );
  });

  it("refuses an order that is not linked to any organization", () => {
    expect(link({}, { crm_organization_id: null }).blocking).toContain(
      "commercial order is not linked to a CRM organization; link the order to its organization first",
    );
  });

  it("refuses an order already linked to another opportunity", () => {
    expect(link({}, {}, true).blocking).toContain(
      "commercial order is already linked to another opportunity",
    );
  });

  it("refuses a cancelled order", () => {
    expect(
      link({}, { cancelled_at: "2026-09-01T00:00:00.000Z" }).blocking,
    ).toContain("a cancelled commercial order cannot be linked");
    expect(link({}, { workflow_state: "cancelled" }).blocking).toContain(
      "a cancelled commercial order cannot be linked",
    );
  });

  it("refuses a currency mismatch rather than warning about it", () => {
    const result = link({}, { currency: "eur" });
    expect(result.blocking).toContain(
      "commercial order currency eur does not match opportunity currency usd",
    );
    expect(result.warnings).toEqual([]);
  });

  it("warns without blocking when the amounts differ", () => {
    const result = link({}, { agreed_total: "900.0000000000" });
    expect(result.blocking).toEqual([]);
    expect(result.warnings).toContain(
      "commercial order total 900.0000000000 differs from the opportunity expected value 1000.0000000000",
    );
  });

  it("compares amounts as decimals, not as formatted strings", () => {
    expect(
      link({ expected_value: "1000" }, { agreed_total: "1000.00" }),
    ).toEqual({ blocking: [], warnings: [] });
  });

  it("refuses to link an order to a lost opportunity", () => {
    const result = link({ stage: "lost" });
    expect(result.blocking).toContain(
      "a lost opportunity cannot be linked to a commercial order",
    );
    expect(result.warnings).toEqual([]);
  });

  it("warns that linking an order leaves the stage alone", () => {
    const result = link({ stage: "procurement" });
    expect(result.blocking).toEqual([]);
    expect(result.warnings).toContain(
      "opportunity stage is procurement; linking an order does not change the stage",
    );
  });
});
