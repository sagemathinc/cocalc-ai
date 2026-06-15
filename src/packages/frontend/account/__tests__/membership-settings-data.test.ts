/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
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
});
