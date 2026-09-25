/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import {
  storageFundingAccountId,
  storageServiceClassFromMembership,
} from "./storage-service-class";

describe("storage service class", () => {
  const membership = (
    membershipClass: string,
    source: MembershipResolution["source"],
  ) => ({ class: membershipClass, source }) as MembershipResolution;

  it("prioritizes every non-free tier, including admin-assigned membership", () => {
    expect(
      storageServiceClassFromMembership(membership("admin", "admin")),
    ).toBe("paying");
    expect(
      storageServiceClassFromMembership(membership("member", "subscription")),
    ).toBe("paying");
    expect(
      storageServiceClassFromMembership(membership("student", "grant")),
    ).toBe("paying");
  });

  it("keeps the free tier in the free class regardless of source", () => {
    expect(storageServiceClassFromMembership(membership("free", "free"))).toBe(
      "free",
    );
    expect(storageServiceClassFromMembership(membership("free", "admin"))).toBe(
      "free",
    );
    expect(storageServiceClassFromMembership(membership("", "free"))).toBe(
      "free",
    );
  });
});

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
