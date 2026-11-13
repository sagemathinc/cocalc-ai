/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  HOST_REPORT_METADATA_LIMITS,
  HOST_REPORTED_METADATA_KEYS,
  getHostReportMetadataDropCounts,
  pickHostReportedMetadata,
  resetHostReportMetadataDropCountsForTests,
} from "./host-report-metadata";
import {
  BAY_OWNED_METADATA_KEYS,
  hostReportFixture,
} from "./__tests__/host-report-metadata-fixtures";

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}

describe("pickHostReportedMetadata", () => {
  beforeEach(() => resetHostReportMetadataDropCountsForTests());

  it("passes a real report through unchanged", () => {
    const report = hostReportFixture();
    expect(Object.keys(report).sort()).toEqual(
      [...HOST_REPORTED_METADATA_KEYS].sort(),
    );
    expect(pickHostReportedMetadata(report)).toEqual(report);
    expect(getHostReportMetadataDropCounts()).toEqual({});
  });

  it("allows no bay-owned key", () => {
    for (const key of BAY_OWNED_METADATA_KEYS) {
      expect(HOST_REPORTED_METADATA_KEYS).not.toContain(key);
    }
  });

  it("drops every bay-owned key and counts it under one fixed label", () => {
    const report: Record<string, unknown> = { host_session_id: "s" };
    for (const key of BAY_OWNED_METADATA_KEYS) {
      report[key] = { quarantined: false, state: "ok" };
    }
    expect(pickHostReportedMetadata(report)).toEqual({ host_session_id: "s" });
    expect(getHostReportMetadataDropCounts()).toEqual({
      unknown_key: BAY_OWNED_METADATA_KEYS.length,
    });
  });

  it("never makes a host-chosen key name a counter label", () => {
    pickHostReportedMetadata({ ["x".repeat(10_000)]: 1, "a\nb": 2 });
    expect(getHostReportMetadataDropCounts()).toEqual({ unknown_key: 2 });
  });

  it("does not mutate the report", () => {
    const report = { ...hostReportFixture(), billing: { funding_mode: "x" } };
    pickHostReportedMetadata(report);
    expect(report).toHaveProperty("billing");
  });

  it("keeps nothing from a container that is not a plain object", () => {
    for (const value of [null, [], [1], "s", 1, true, new Date(), new Map()]) {
      resetHostReportMetadataDropCountsForTests();
      expect(pickHostReportedMetadata(value)).toEqual({});
      expect(getHostReportMetadataDropCounts()).toEqual({ not_object: 1 });
    }
    expect(pickHostReportedMetadata(undefined)).toEqual({});
  });

  it("keeps nothing from a report with too many top-level keys", () => {
    const report: Record<string, unknown> = { host_session_id: "s" };
    for (let i = 0; i < 10_000; i++) report[`k${i}`] = i;
    expect(pickHostReportedMetadata(report)).toEqual({});
    expect(getHostReportMetadataDropCounts()).toEqual({ too_many_keys: 1 });
  });

  it("drops a value of the wrong kind under its own key's label", () => {
    const picked = pickHostReportedMetadata({
      host_session_id: { not: "a string" },
      host_cpu_count: "8",
      cloudflared_restart_supported: 1,
      software: ["v1"],
      observed_components: {},
      host_ram_gb: Number.NaN,
      host_uptime_s: Number.POSITIVE_INFINITY,
      runnerId: "runner-1",
    });
    expect(picked).toEqual({ runnerId: "runner-1" });
    expect(getHostReportMetadataDropCounts()).toEqual({
      "invalid_value:host_session_id": 1,
      "invalid_value:host_cpu_count": 1,
      "invalid_value:cloudflared_restart_supported": 1,
      "invalid_value:software": 1,
      "invalid_value:observed_components": 1,
      "invalid_value:host_ram_gb": 1,
      "invalid_value:host_uptime_s": 1,
    });
  });

  it("keeps null for any host-owned key", () => {
    expect(
      pickHostReportedMetadata({ content_origin_domain: null, bees: null }),
    ).toEqual({ content_origin_domain: null, bees: null });
  });

  it("drops a value that is too deep, has a long string or key, or is not plain JSON", () => {
    const { maxDepth, maxStringLength, maxKeyLength } =
      HOST_REPORT_METADATA_LIMITS;
    const picked = pickHostReportedMetadata({
      metrics: nested(maxDepth + 1),
      pressure: { zone: "x".repeat(maxStringLength + 1) },
      placement: { ["k".repeat(maxKeyLength + 1)]: 1 },
      host_agent: { when: new Date() },
      runtime_health: { f: () => 1 },
      bees: { n: Number.NaN },
      host_integrity: nested(maxDepth - 1),
    });
    expect(picked).toEqual({ host_integrity: nested(maxDepth - 1) });
    expect(getHostReportMetadataDropCounts()).toEqual({
      "invalid_value:metrics": 1,
      "invalid_value:pressure": 1,
      "invalid_value:placement": 1,
      "invalid_value:host_agent": 1,
      "invalid_value:runtime_health": 1,
      "invalid_value:bees": 1,
    });
  });

  it("keeps nothing from a report over the node or byte budget", () => {
    const { maxNodes, maxBytes, maxStringLength } = HOST_REPORT_METADATA_LIMITS;
    expect(
      pickHostReportedMetadata({
        host_session_id: "s",
        software_inventory: new Array(maxNodes + 1).fill(0),
      }),
    ).toEqual({});
    const chunk = "x".repeat(maxStringLength);
    const many = new Array(Math.ceil(maxBytes / maxStringLength) + 1).fill(
      chunk,
    );
    expect(
      pickHostReportedMetadata({
        host_session_id: "s",
        observed_components: many,
      }),
    ).toEqual({});
    expect(getHostReportMetadataDropCounts()).toEqual({ over_budget: 2 });
  });
});
