/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";
import {
  CONTROL_PLANE_EGRESS_WARNING_THRESHOLD,
  MANAGED_EGRESS_SEVERE_THRESHOLD,
  MANAGED_EGRESS_WARNING_THRESHOLD,
  getManagedEgressWindowWarnings,
  managedEgressUpgradeHelps,
} from "./managed-egress-warning";

function makeDetails({
  limit5h = 0,
  limit7d = 0,
  used5h = 0,
  used7d = 0,
}: {
  limit5h?: number;
  limit7d?: number;
  used5h?: number;
  used7d?: number;
}): MembershipDetails {
  return {
    selected: {
      class: "member",
      source: "subscription",
      entitlements: {
        usage_limits: {
          egress_5h_bytes: limit5h,
          egress_7d_bytes: limit7d,
        },
      },
    },
    candidates: [],
    usage_status: {
      collected_at: new Date().toISOString(),
      owned_project_count: 0,
      sampled_project_count: 0,
      unsampled_project_count: 0,
      total_storage_bytes: 0,
      managed_egress_5h_bytes: used5h,
      managed_egress_7d_bytes: used7d,
    },
  };
}

describe("getManagedEgressWindowWarnings", () => {
  it("returns no warning below the threshold", () => {
    const details = makeDetails({
      limit5h: 1000,
      used5h: Math.floor(1000 * (MANAGED_EGRESS_WARNING_THRESHOLD - 0.01)),
    });
    expect(getManagedEgressWindowWarnings(details)).toEqual([]);
  });

  it("returns warnings at or above the threshold", () => {
    const details = makeDetails({
      limit5h: 1000,
      used5h: Math.ceil(1000 * MANAGED_EGRESS_WARNING_THRESHOLD),
      limit7d: 5000,
      used7d: Math.ceil(5000 * MANAGED_EGRESS_SEVERE_THRESHOLD),
    });
    expect(getManagedEgressWindowWarnings(details)).toEqual([
      expect.objectContaining({
        window: "7d",
        over: false,
        percent: 90,
        severity: "severe",
      }),
      expect.objectContaining({
        window: "5h",
        over: false,
        percent: 75,
        severity: "warning",
      }),
    ]);
  });

  it("prefers over-limit windows before near-limit windows", () => {
    const details = makeDetails({
      limit5h: 1000,
      used5h: 980,
      limit7d: 5000,
      used7d: 5100,
    });
    const warnings = getManagedEgressWindowWarnings(details);
    expect(warnings[0]).toEqual(
      expect.objectContaining({
        window: "7d",
        over: true,
        severity: "blocked",
      }),
    );
    expect(warnings[1]).toEqual(
      expect.objectContaining({
        window: "5h",
        over: false,
        severity: "severe",
      }),
    );
  });

  it("warns about browser control traffic only from 90%, separately from the shared pool", () => {
    const details = makeDetails({});
    details.usage_status = {
      ...details.usage_status!,
      managed_control_plane_egress_5h_bytes: 1_000_000_000,
      managed_control_plane_egress_7d_bytes: 89_000_000_000,
      managed_control_plane_egress_5h_limit_bytes: 10_000_000_000,
      managed_control_plane_egress_7d_limit_bytes: 100_000_000_000,
    };
    // 89% is above the shared-pool threshold but below the control-plane one
    expect(getManagedEgressWindowWarnings(details)).toEqual([]);
    details.usage_status.managed_control_plane_egress_7d_bytes =
      CONTROL_PLANE_EGRESS_WARNING_THRESHOLD * 100_000_000_000;
    expect(getManagedEgressWindowWarnings(details)).toEqual([
      expect.objectContaining({
        pool: "control-plane",
        window: "7d",
        percent: 90,
        severity: "severe",
        over: false,
      }),
    ]);
    details.usage_status.managed_control_plane_egress_7d_bytes = 108_000_000_000;
    expect(getManagedEgressWindowWarnings(details)[0]).toMatchObject({
      pool: "control-plane",
      severity: "blocked",
      over: true,
    });
  });

  it("shows a block under a 0 limit (no Infinity), and is not blocked exactly at the limit", () => {
    const details = makeDetails({ limit5h: 1000, used5h: 1000 });
    expect(getManagedEgressWindowWarnings(details)).toEqual([
      expect.objectContaining({
        pool: "shared",
        window: "5h",
        over: false,
        percent: 100,
        severity: "severe",
      }),
    ]);
    details.usage_status = {
      ...details.usage_status!,
      managed_egress_5h_bytes: 0,
      managed_control_plane_egress_7d_bytes: 5_000_000,
      managed_control_plane_egress_7d_limit_bytes: 0,
    };
    const [blocked, ...rest] = getManagedEgressWindowWarnings(details);
    expect(rest).toEqual([]);
    expect(blocked).toMatchObject({
      pool: "control-plane",
      window: "7d",
      over: true,
      severity: "blocked",
      percent: 100,
      limit: 0,
    });
    expect(Number.isFinite(blocked.ratio)).toBe(true);
    // 0 limit, no traffic: nothing to show
    details.usage_status.managed_control_plane_egress_7d_bytes = 0;
    expect(getManagedEgressWindowWarnings(details)).toEqual([]);
  });

  it("offers the upgrade whenever a shared-pool warning is shown, even behind a control-plane one", () => {
    const details = makeDetails({ limit7d: 1000, used7d: 900 });
    details.usage_status = {
      ...details.usage_status!,
      managed_control_plane_egress_7d_bytes: 95_000_000_000,
      managed_control_plane_egress_7d_limit_bytes: 100_000_000_000,
    };
    const warnings = getManagedEgressWindowWarnings(details);
    expect(warnings.map((w) => w.pool)).toEqual(["control-plane", "shared"]);
    expect(managedEgressUpgradeHelps(warnings)).toBe(true);
    expect(managedEgressUpgradeHelps(warnings.slice(0, 1))).toBe(false);
  });
});
