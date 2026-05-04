/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  MANAGED_BOUNDARY_CLASSIFIED_CATEGORIES,
  ManagedProjectEgressResidualTracker,
} from "./managed-egress-residual";

describe("managed project egress residual tracker", () => {
  it("subtracts classified boundary bytes from container boundary bytes", () => {
    const tracker = new ManagedProjectEgressResidualTracker({
      bucketMs: 1000,
      graceMs: 1000,
    });

    tracker.noteBoundaryBytes({
      project_id: "11111111-1111-4111-8111-111111111111",
      bytes: 1500,
      at: 1500,
      metadata: { interface_name: "ens4", pid: 1234 },
    });
    tracker.noteBoundaryClassifiedBytes({
      project_id: "11111111-1111-4111-8111-111111111111",
      category: "http-proxy",
      bytes: 400,
      at: 1600,
    });
    tracker.noteBoundaryClassifiedBytes({
      project_id: "11111111-1111-4111-8111-111111111111",
      category: "ws-proxy",
      bytes: 100,
      at: 1700,
    });

    expect(tracker.flush({ now: 2500 })).toEqual([]);
    expect(tracker.flush({ now: 3000 })).toEqual([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        bytes: 1000,
        bucket_start: 1000,
        bucket_ms: 1000,
        boundary_bytes: 1500,
        classified_boundary_bytes: 500,
        classified_categories: {
          "http-proxy": 400,
          "ws-proxy": 100,
        },
        metadata: { interface_name: "ens4", pid: 1234 },
      },
    ]);
  });

  it("never emits negative residuals", () => {
    const tracker = new ManagedProjectEgressResidualTracker({
      bucketMs: 1000,
      graceMs: 1000,
    });

    tracker.noteBoundaryBytes({
      project_id: "11111111-1111-4111-8111-111111111111",
      bytes: 200,
      at: 1500,
    });
    tracker.noteBoundaryClassifiedBytes({
      project_id: "11111111-1111-4111-8111-111111111111",
      category: "ssh",
      bytes: 500,
      at: 1600,
    });

    expect(tracker.flush({ now: 3000 })).toEqual([]);
  });

  it("tracks projects independently", () => {
    const tracker = new ManagedProjectEgressResidualTracker({
      bucketMs: 1000,
      graceMs: 1000,
    });

    tracker.noteBoundaryBytes({
      project_id: "11111111-1111-4111-8111-111111111111",
      bytes: 900,
      at: 1500,
    });
    tracker.noteBoundaryBytes({
      project_id: "22222222-2222-4222-8222-222222222222",
      bytes: 600,
      at: 1500,
    });
    tracker.noteBoundaryClassifiedBytes({
      project_id: "22222222-2222-4222-8222-222222222222",
      category: "http-proxy",
      bytes: 100,
      at: 1600,
    });

    expect(tracker.flush({ now: 3000 })).toEqual([
      expect.objectContaining({
        project_id: "11111111-1111-4111-8111-111111111111",
        bytes: 900,
      }),
      expect.objectContaining({
        project_id: "22222222-2222-4222-8222-222222222222",
        bytes: 500,
      }),
    ]);
  });

  it("exports the classified categories used by residual accounting", () => {
    expect(MANAGED_BOUNDARY_CLASSIFIED_CATEGORIES).toEqual(
      new Set(["http-proxy", "ws-proxy", "ssh"]),
    );
  });
});
