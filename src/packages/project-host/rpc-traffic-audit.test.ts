/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  estimateProjectHostRpcRequestBytes,
  estimateProjectHostRpcResponseBytes,
  ProjectHostRpcTrafficAudit,
} from "./rpc-traffic-audit";

describe("project-host rpc traffic audit", () => {
  it("estimates typed service request and response sizes", () => {
    expect(
      estimateProjectHostRpcRequestBytes({
        method: "heartbeat",
        args: [{ host_id: "h1", metadata: { pressure: "normal" } }],
      }),
    ).toBeGreaterThan(0);
    expect(
      estimateProjectHostRpcResponseBytes({
        rows: [{ project_id: "p1" }],
        has_more: false,
      }),
    ).toBeGreaterThan(0);
  });

  it("aggregates per-method traffic and stats", () => {
    const audit = new ProjectHostRpcTrafficAudit();
    audit.record({
      channel: "registry",
      method: "heartbeat",
      args: [{ host_id: "h1" }],
      duration_ms: 20,
    });
    audit.record({
      channel: "registry",
      method: "listProjectUserDeltas",
      args: [{ host_id: "h1", since_ms: 0, limit: 500 }],
      result: {
        rows: [{ project_id: "p1" }, { project_id: "p2" }],
        next_since_ms: 10,
        has_more: false,
      },
      duration_ms: 45,
      stats: { rows: 2 },
    });
    audit.record({
      channel: "registry",
      method: "listProjectUserDeltas",
      args: [{ host_id: "h1", since_ms: 10, limit: 500 }],
      error: true,
      duration_ms: 30,
    });

    const summary = audit.flushSummary({ now: Date.now() + 60_000 });
    expect(summary).toBeDefined();
    expect(summary?.total_calls).toBe(3);
    expect(summary?.total_errors).toBe(1);
    expect(summary?.top_methods[0].method).toBe("listProjectUserDeltas");
    expect(summary?.top_methods[0].calls).toBe(2);
    expect(summary?.top_methods[0].errors).toBe(1);
    expect(summary?.top_methods[0].stats).toEqual({ rows: 2 });
    expect(summary?.total_request_bytes).toBeGreaterThan(0);
  });
});
