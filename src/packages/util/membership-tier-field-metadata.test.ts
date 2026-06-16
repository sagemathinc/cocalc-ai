/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  MEMBERSHIP_TIER_FIELDS,
  getMembershipTierField,
  membershipTierDisplayToStoredValue,
  membershipTierFieldDisplayUnit,
  membershipTierFieldPath,
  membershipTierFieldsByStatus,
  membershipTierFieldsForCard,
  membershipTierStoredToDisplayValue,
} from "./membership-tier-field-metadata";

describe("membership tier field metadata", () => {
  it("has stable unique ids and paths", () => {
    const ids = new Set<string>();
    for (const field of MEMBERSHIP_TIER_FIELDS) {
      expect(field.id).toBeTruthy();
      expect(ids.has(field.id)).toBe(false);
      ids.add(field.id);
      expect(field.path.length).toBeGreaterThan(0);
    }
  });

  it("classifies cocalc-ai runtime product fields as primary", () => {
    expect(getMembershipTierField("features.project_host_tier")).toMatchObject({
      card: "runtime",
      status: "primary",
      public: true,
    });
    expect(
      getMembershipTierField("usage_limits.shared_compute_priority"),
    ).toMatchObject({
      card: "runtime",
      status: "primary",
    });
    expect(
      getMembershipTierField("usage_limits.max_sponsored_running_projects"),
    ).toMatchObject({
      card: "runtime",
      status: "primary",
      public: true,
    });
  });

  it("does not register eliminated legacy project quota fields", () => {
    for (const id of [
      "project_defaults.cores",
      "project_defaults.cpu_shares",
      "project_defaults.mintime",
      "project_defaults.network",
      "project_defaults.member_host",
      "project_defaults.always_running",
      "project_defaults.ephemeral_state",
      "project_defaults.ephemeral_disk",
    ]) {
      expect(getMembershipTierField(id)).toBeUndefined();
    }
    expect(membershipTierFieldsByStatus("compatibility-only")).toEqual([]);
    expect(membershipTierFieldsByStatus("deprecated")).toEqual([]);
  });

  it("converts stored accounting units to editor display units", () => {
    expect(
      membershipTierStoredToDisplayValue("usage_limits.cpu_7d_seconds", 72_000),
    ).toBe(20);
    expect(
      membershipTierDisplayToStoredValue("usage_limits.cpu_7d_seconds", 20),
    ).toBe(72_000);
    expect(
      membershipTierStoredToDisplayValue(
        "usage_limits.egress_7d_bytes",
        3_500_000_000,
      ),
    ).toBe(3.5);
    expect(
      membershipTierDisplayToStoredValue("usage_limits.egress_7d_bytes", 3.5),
    ).toBe(3_500_000_000);
  });

  it("exposes paths and display units for form builders", () => {
    expect(membershipTierFieldPath("project_defaults.memory")).toEqual([
      "project_defaults",
      "memory",
    ]);
    expect(membershipTierFieldDisplayUnit("usage_limits.cpu_5h_seconds")).toBe(
      "CPU-hours",
    );
    expect(membershipTierFieldDisplayUnit("price_monthly")).toBe("USD");
  });

  it("keeps primary runtime cards free of compatibility-only fields by default", () => {
    const runtimeIds = membershipTierFieldsForCard("runtime").map((f) => f.id);
    expect(runtimeIds).toContain("project_defaults.memory");
    expect(runtimeIds).toContain("features.project_host_tier");
    expect(runtimeIds).not.toContain("project_defaults.cores");
    expect(runtimeIds).not.toContain("project_defaults.member_host");
  });
});
