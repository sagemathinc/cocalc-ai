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
  REVIEWED_METADATA_WRITE_TEMPLATES,
  SHARED_HOST_OWNED_METADATA_KEYS,
  masterUsesReportBuilders,
  hostReportFixture,
  metadataKeysWrittenIn,
  metadataWriteTemplateIds,
  metadataWriteTemplates,
  metadataWriteTemplatesIn,
  writtenProjectHostMetadataKeys,
} from "./__tests__/host-report-metadata-fixtures";

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}

describe("pickHostReportedMetadata", () => {
  beforeEach(() => resetHostReportMetadataDropCountsForTests());

  it("allows exactly the keys the real project-host assembly sends", () => {
    // master.ts builds the report with the pure builders, and the fixture is
    // their output with every optional input present.
    expect(masterUsesReportBuilders()).toBe(true);
    expect([...HOST_REPORTED_METADATA_KEYS].sort()).toEqual(
      Object.keys(hostReportFixture()).sort(),
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

  it("pins every SQL template that writes project_hosts.metadata (fails on a new or changed one)", () => {
    // Each entry is file#sha256 of the whole whitespace-normalized template.
    expect(metadataWriteTemplateIds()).toEqual(
      [...REVIEWED_METADATA_WRITE_TEMPLATES].sort(),
    );
  });

  // security-audit's 9 bypass forms and review's 2: each carries a detected
  // literal key AND a part that could write any top-level key. Each must be
  // extracted as a metadata write whose hash is not reviewed, so it fails the
  // pin above until someone reviews it.
  it("extracts every bypass form as an unreviewed metadata write", () => {
    const forms = [
      "jsonb_set(metadata,'{billing}',$2) || jsonb_build_object($3::text, $4)",
      "jsonb_set(metadata,'{billing}',$2) || to_jsonb($3)",
      "jsonb_set(metadata,'{billing}',$2) || ($3)::jsonb",
      "jsonb_set(jsonb_set(metadata,'{billing}',$2), $3::text[], $4)",
      "jsonb_set(jsonb_set(metadata,'{billing}',$2), string_to_array($3, ','), $4)",
      "jsonb_set($2::jsonb, '{billing}', $3)",
      "jsonb_set(metadata,'{billing}',$2) || ${extra}",
      "jsonb_set(metadata,'{billing}',$2) || (SELECT m FROM t WHERE t.id = $3)",
      "jsonb_concat(jsonb_set(metadata,'{billing}',$2), $3::jsonb)",
      "jsonb_set(metadata,'{billing}',$2) || unreviewed_metadata_function($3)",
      "jsonb_set(metadata,'{billing}',$2) || '{\"review_future\": 1}'::jsonb",
    ];
    const reviewed = new Set(REVIEWED_METADATA_WRITE_TEMPLATES);
    for (const form of forms) {
      const source = [
        "const extra = '';",
        "pool().query(",
        "  `UPDATE project_hosts",
        `      SET metadata = ${form.replace(/`/g, "\\`")},`,
        "          updated = NOW()",
        "    WHERE id = $1 AND deleted IS NULL`,",
        ");",
      ].join("\n");
      const found = metadataWriteTemplatesIn("server/probe.ts", source);
      expect(found).toHaveLength(1);
      // the whole template, past the subquery's inner WHERE
      expect(found[0].text).toMatch(/updated = NOW\(\) WHERE id = \$1/);
      expect(reviewed.has(`${found[0].file}#${found[0].sha256}`)).toBe(false);
    }
  });

  it("hashes whole templates, including INSERT VALUES and ON CONFLICT parts", () => {
    const upsert = metadataWriteTemplates().find(
      ({ file, text }) =>
        file === "database/postgres/project-hosts.ts" &&
        /^INSERT INTO project_hosts/.test(text),
    );
    expect(upsert?.text).toMatch(/VALUES/);
    expect(upsert?.text).toMatch(/ON CONFLICT/);
    expect(upsert?.text).toMatch(/EXCLUDED\.metadata/);
  });

  it("passes a real report at the code-bound sizes through unchanged", () => {
    const report = hostReportFixture();
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

  it("drops only the value over its budget share and keeps the rest", () => {
    const { maxNodesPerKey, maxBytesPerKey, maxStringLength } =
      HOST_REPORT_METADATA_LIMITS;
    const report = hostReportFixture();
    const overNodes = {
      ...report,
      software_inventory: new Array(maxNodesPerKey + 1).fill(0),
    };
    const kept = pickHostReportedMetadata(overNodes);
    expect(kept).not.toHaveProperty("software_inventory");
    const { software_inventory: _dropped, ...rest } = report;
    expect(kept).toEqual(rest);
    const chunk = "x".repeat(maxStringLength);
    const overBytes = {
      ...report,
      metrics: {
        current: new Array(
          Math.ceil(maxBytesPerKey / maxStringLength) + 1,
        ).fill(chunk),
      },
    };
    const kept2 = pickHostReportedMetadata(overBytes);
    expect(kept2).not.toHaveProperty("metrics");
    expect(kept2.host_session_id).toBe(report.host_session_id);
    expect(getHostReportMetadataDropCounts()).toEqual({
      "over_budget:software_inventory": 1,
      "over_budget:metrics": 1,
    });
  });

  it("keeps identity keys whatever the report's key order and blob sizes", () => {
    const { maxStringLength } = HOST_REPORT_METADATA_LIMITS;
    const chunk = "x".repeat(maxStringLength);
    const blob = () => new Array(40).fill(chunk);
    // Big blobs first in the report's own order, identity keys last.
    const hostile: Record<string, unknown> = {
      metrics: { current: blob() },
      cloudflared: { lines: blob() },
      placement: { images: blob() },
      software_inventory: blob(),
      observed_components: blob(),
      host_agent: { log: blob() },
      runnerId: "runner-1",
      host_session_id: "session-1",
      host_boot_id: "boot-1",
      host_session_started_at: "2026-11-13T00:00:00.000Z",
      host_boot_started_at: "2026-11-12T00:00:00.000Z",
    };
    const kept = pickHostReportedMetadata(hostile);
    for (const key of [
      "runnerId",
      "host_session_id",
      "host_boot_id",
      "host_session_started_at",
      "host_boot_started_at",
    ]) {
      expect(kept[key]).toBe(hostile[key]);
    }
  });

  it("keeps the total work bounded when every allowed key is large and of a valid kind", () => {
    const { maxNodes } = HOST_REPORT_METADATA_LIMITS;
    let reads = 0;
    const big = () =>
      new Proxy(new Array(100_000).fill(0), {
        get(obj, key, receiver) {
          if (typeof key === "string" && key !== "length") reads += 1;
          return Reflect.get(obj, key, receiver);
        },
      });
    // A valid kind for every key: arrays where an array is allowed, an
    // object holding a huge array where an object is allowed. Scalar keys
    // cost one read each.
    const report = hostReportFixture();
    let large = 0;
    for (const key of HOST_REPORTED_METADATA_KEYS) {
      const value = report[key];
      if (Array.isArray(value)) {
        report[key] = big();
        large += 1;
      } else if (value != null && typeof value === "object") {
        report[key] = { items: big() };
        large += 1;
      }
    }
    expect(large).toBeGreaterThanOrEqual(16);
    const kept = pickHostReportedMetadata(report);
    // Every value read, kept or dropped, is charged to the one node budget.
    expect(reads).toBeLessThanOrEqual(
      maxNodes + HOST_REPORTED_METADATA_KEYS.length,
    );
    // Identity keys come first and are kept.
    expect(kept.host_session_id).toBe(report.host_session_id);
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
