/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { storageFundingAccountId } from "./storage-service-class";

describe("storage funding account", () => {
  it("uses explicit usage attribution even when the payer is not a collaborator", () => {
    expect(
      storageFundingAccountId({
        owner_account_id: "owner",
        usage_account_id: "institution-payer",
        course: { type: "student", account_id: "course-sponsor" },
      }),
    ).toBe("institution-payer");
  });

  it("uses the student course account when there is no explicit usage account", () => {
    expect(
      storageFundingAccountId({
        owner_account_id: "owner",
        usage_account_id: null,
        course: { type: "student", account_id: "course-sponsor" },
      }),
    ).toBe("course-sponsor");
  });

  it("uses the owner for unrelated courses and missing payer fields", () => {
    expect(
      storageFundingAccountId({
        owner_account_id: "owner",
        usage_account_id: null,
        course: { type: "shared", account_id: "course-sponsor" },
      }),
    ).toBe("owner");
  });
});
