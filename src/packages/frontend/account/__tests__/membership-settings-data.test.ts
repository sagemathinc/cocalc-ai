/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipCandidate } from "@cocalc/conat/hub/api/purchases";

import {
  shouldDisplayMembershipCandidate,
  sortMembershipCandidateRows,
  type MembershipCandidateRow,
} from "../membership-settings-data";

function row(
  key: string,
  priority: number,
  sourceKind: MembershipCandidateRow["sourceKind"],
): MembershipCandidateRow {
  return {
    class: key,
    key,
    membership: key,
    note: "No scheduled end",
    priority,
    selected: false,
    source: key,
    sourceKind,
    state: "Active",
  };
}

function candidate(
  overrides: Partial<MembershipCandidate>,
): MembershipCandidate {
  return {
    class: "standard",
    entitlements: {} as MembershipCandidate["entitlements"],
    priority: 10,
    source: "subscription",
    ...overrides,
  } as MembershipCandidate;
}

describe("membership-settings-data", () => {
  it("sorts membership rows by descending tier priority first", () => {
    const rows = [
      row("personal-standard", 20, "subscription"),
      row("admin-basic", 10, "admin"),
      row("site-pro", 30, "grant"),
    ];

    expect(sortMembershipCandidateRows(rows).map(({ key }) => key)).toEqual([
      "site-pro",
      "personal-standard",
      "admin-basic",
    ]);
  });

  it("hides canceled personal memberships that have not started", () => {
    expect(
      shouldDisplayMembershipCandidate(
        candidate({
          starts: new Date("2999-06-20T12:00:00Z"),
          subscription_status: "canceled",
        }),
      ),
    ).toBe(false);
  });

  it("keeps paid-through canceled personal memberships visible", () => {
    expect(
      shouldDisplayMembershipCandidate(
        candidate({
          expires: new Date("2999-06-20T12:00:00Z"),
          subscription_status: "canceled",
        }),
      ),
    ).toBe(true);
  });
});
