/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";
import { getAccountStorageWarning } from "./account-storage-warning";

function makeDetails({
  used = 0,
  soft,
  hard,
  unsampled = 0,
  errors = 0,
}: {
  used?: number;
  soft?: number;
  hard?: number;
  unsampled?: number;
  errors?: number;
}): MembershipDetails {
  return {
    selected: {
      class: "member",
      source: "subscription",
      entitlements: {
        usage_limits: {
          total_storage_soft_bytes: soft,
          total_storage_hard_bytes: hard,
        },
      },
    },
    candidates: [],
    usage_status: {
      collected_at: new Date().toISOString(),
      owned_project_count: 0,
      sampled_project_count: 0,
      unsampled_project_count: unsampled,
      measurement_error_count: errors,
      total_storage_bytes: used,
    },
  };
}

describe("getAccountStorageWarning", () => {
  it("returns no warning when there are no storage caps", () => {
    expect(getAccountStorageWarning(makeDetails({ used: 10 }))).toBeUndefined();
  });

  it("warns near the soft cap before reaching it", () => {
    expect(
      getAccountStorageWarning(makeDetails({ used: 80, soft: 100, hard: 200 })),
    ).toEqual(
      expect.objectContaining({
        compare_label: "soft cap",
        severity: "warning",
        percent: 80,
        over_soft: false,
        over_hard: false,
      }),
    );
  });

  it("treats the soft cap as severe once it is reached", () => {
    expect(
      getAccountStorageWarning(
        makeDetails({ used: 120, soft: 100, hard: 200 }),
      ),
    ).toEqual(
      expect.objectContaining({
        compare_label: "soft cap",
        severity: "severe",
        over_soft: true,
        over_hard: false,
      }),
    );
  });

  it("treats the hard cap as blocked once it is reached", () => {
    expect(
      getAccountStorageWarning(
        makeDetails({ used: 220, soft: 100, hard: 200 }),
      ),
    ).toEqual(
      expect.objectContaining({
        compare_label: "hard cap",
        severity: "blocked",
        over_soft: true,
        over_hard: true,
      }),
    );
  });

  it("marks partial measurements", () => {
    expect(
      getAccountStorageWarning(
        makeDetails({ used: 80, soft: 100, unsampled: 1, errors: 1 }),
      ),
    ).toEqual(
      expect.objectContaining({
        partial_measurement: true,
      }),
    );
  });
});
