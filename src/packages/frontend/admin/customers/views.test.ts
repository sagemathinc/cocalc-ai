/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  emptyViewDescription,
  queueFilterRequest,
  viewDescription,
  viewRequest,
} from "./views";

describe("CRM customer queue views", () => {
  it("uses open opportunity kinds for pipeline views", () => {
    expect(viewRequest("pipeline")).toMatchObject({
      opportunity_kinds: expect.arrayContaining([
        "adoption_pilot",
        "new_site_license",
        "renewal",
        "expansion",
      ]),
    });
    expect(viewRequest("pilots")).toEqual({
      opportunity_kinds: ["adoption_pilot", "new_site_license"],
      include_won_active_site_license_offers: true,
    });
    expect(viewRequest("renewals")).toEqual({
      opportunity_kinds: ["renewal"],
    });
  });

  it("explains pipeline filters and empty states", () => {
    expect(viewDescription("pilots")).toContain(
      "accepted Site license offers backed by a current license",
    );
    expect(emptyViewDescription("pilots", false)).toBe(
      "There are no Adoption pilot or current Site license offers.",
    );
    expect(emptyViewDescription("pilots", true)).toBe(
      "No search results match this view.",
    );
  });

  it("combines a saved view with a relationship-owner filter", () => {
    const owner = "00000000-0000-4000-8000-000000000003";
    expect(queueFilterRequest("pilots", owner)).toEqual({
      opportunity_kinds: ["adoption_pilot", "new_site_license"],
      include_won_active_site_license_offers: true,
      owner_account_id: owner,
    });
    expect(queueFilterRequest("active")).toEqual({ statuses: ["active"] });
    expect(queueFilterRequest("unassigned", owner)).toEqual({
      unassigned: true,
    });
  });
});
