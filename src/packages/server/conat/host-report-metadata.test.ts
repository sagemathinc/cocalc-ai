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
  NOT_METADATA_KEY_MATCHES,
  REVIEWED_UNCLASSIFIED_METADATA_STATEMENTS,
  REVIEWED_WHOLE_METADATA_WRITERS,
  SHARED_HOST_OWNED_METADATA_KEYS,
  hostReportedKeysFromSource,
  hostReportFixture,
  metadataKeysWrittenIn,
  unclassifiedMetadataStatements,
  wholeMetadataWriterFiles,
  writtenProjectHostMetadataKeys,
} from "./__tests__/host-report-metadata-fixtures";

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}

describe("pickHostReportedMetadata", () => {
  beforeEach(() => resetHostReportMetadataDropCountsForTests());

  it("allows exactly the keys project-host/master.ts sends", () => {
    expect([...HOST_REPORTED_METADATA_KEYS].sort()).toEqual(
      hostReportedKeysFromSource(),
    );
  });

  it("lists every metadata key the bay writes in the detected SQL forms (fails on a new unlisted one)", () => {
    const listed = new Set<string>([
      ...BAY_OWNED_METADATA_KEYS,
      ...SHARED_HOST_OWNED_METADATA_KEYS,
      ...NOT_METADATA_KEY_MATCHES,
    ]);
    const written = writtenProjectHostMetadataKeys();
    expect(written.size).toBeGreaterThan(10);
    expect([...written].filter((key) => !listed.has(key))).toEqual([]);
  });

  it("detects each supported SQL write form (positive controls)", () => {
    const forms = [
      "UPDATE project_hosts SET metadata=jsonb_set(metadata,'{probe_a}',$2)",
      "UPDATE project_hosts SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{probe_b}',$2)",
      "UPDATE project_hosts SET metadata = jsonb_set(\n  COALESCE(metadata, '{}'::jsonb),\n  '{probe_c,quarantined}', $2)",
      "UPDATE project_hosts SET metadata = metadata || jsonb_build_object('probe_d', $2, 'probe_e', $3)",
      "UPDATE project_hosts SET metadata = metadata - 'probe_f'",
      "UPDATE project_hosts SET metadata = metadata #- '{probe_h,sent_at}'",
      "metadata.probe_g = value;",
    ];
    const found = metadataKeysWrittenIn(forms.join("\n"));
    for (const key of [
      "probe_a",
      "probe_b",
      "probe_c",
      "probe_d",
      "probe_e",
      "probe_f",
      "probe_g",
      "probe_h",
    ]) {
      expect(found.has(key)).toBe(true);
    }
  });

  it("fails closed on a metadata statement the scanner cannot classify", () => {
    expect(unclassifiedMetadataStatements()).toEqual(
      [...REVIEWED_UNCLASSIFIED_METADATA_STATEMENTS].sort(),
    );
  });

  it("fails closed on a new file that writes the whole metadata object", () => {
    expect(wholeMetadataWriterFiles()).toEqual([
      ...REVIEWED_WHOLE_METADATA_WRITERS,
    ]);
  });

  it("passes a real report through unchanged", () => {
    const report = hostReportFixture();
    expect(Object.keys(report).sort()).toEqual(hostReportedKeysFromSource());
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

  // A transparent proxy counts the property reads the walk makes: they must
  // stay within the node budget however wide the value is. (It counts get
  // traps, not the engine's key enumeration, which is linear in the width.)
  function counted<T extends object>(
    target: T,
  ): { value: T; reads: () => number } {
    let reads = 0;
    const value = new Proxy(target, {
      get(obj, key, receiver) {
        if (typeof key === "string" && key !== "length") reads += 1;
        return Reflect.get(obj, key, receiver);
      },
    });
    return { value, reads: () => reads };
  }

  it("reads a bounded number of elements of a huge array", () => {
    const { maxNodes } = HOST_REPORT_METADATA_LIMITS;
    const wide = counted(new Array(200_000).fill(0));
    expect(
      pickHostReportedMetadata({ software_inventory: wide.value }),
    ).toEqual({});
    expect(wide.reads()).toBeLessThanOrEqual(maxNodes + 1);
  });

  it("reads a bounded number of entries of a huge object", () => {
    const { maxNodes } = HOST_REPORT_METADATA_LIMITS;
    const target: Record<string, number> = {};
    for (let i = 0; i < 200_000; i++) target[`k${i}`] = i;
    const wide = counted(target);
    expect(pickHostReportedMetadata({ metrics: wide.value })).toEqual({});
    expect(wide.reads()).toBeLessThanOrEqual(maxNodes + 1);
  });

  it("keeps the walk stack bounded for a deep value", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(pickHostReportedMetadata({ software_inventory: deep })).toEqual({});
    expect(getHostReportMetadataDropCounts()).toEqual({
      "invalid_value:software_inventory": 1,
    });
  });
});
