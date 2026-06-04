/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sortMembershipTiersByDisplayOrder } from "./membership-tier-order";

describe("membership tier display order", () => {
  it("sorts by configured priority before label", () => {
    const ordered = sortMembershipTiersByDisplayOrder([
      { id: "standard", label: "Standard", priority: 20 },
      { id: "basic", label: "Basic", priority: 10 },
      { id: "pro", label: "Pro", priority: 30 },
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(["basic", "standard", "pro"]);
  });

  it("uses monthly-equivalent price when priority is missing", () => {
    const ordered = sortMembershipTiersByDisplayOrder([
      { id: "yearly", label: "Yearly", price_yearly: 120 },
      { id: "monthly", label: "Monthly", price_monthly: 8 },
      { id: "unknown", label: "Unknown" },
    ]);

    expect(ordered.map(({ id }) => id)).toEqual([
      "monthly",
      "yearly",
      "unknown",
    ]);
  });
});
