/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  buildHostBaseMetadata,
  buildHostReportMetadata,
  type HostReportMetadataInput,
} from "./host-report-payload";

// The assembly as it was inline in master.ts before the extraction (076),
// verbatim except that the values come from `input`. The extracted builders
// must produce exactly the same object, key order included.
function inlineBefore(input: HostReportMetadataInput) {
  const basePayload = { metadata: input.base };
  const versions = input.software;
  return {
    ...(basePayload.metadata ?? {}),
    cloudflared_restart_supported: true,
    cloudflared_diagnostics_supported: true,
    cloudflared: input.cloudflared,
    host_uptime_s: input.host_uptime_s,
    ...(input.currentMetrics
      ? {
          metrics: {
            current: input.currentMetrics,
          },
        }
      : {}),
    ...(input.pressureState ? { pressure: input.pressureState } : {}),
    ...(input.placementSnapshot ? { placement: input.placementSnapshot } : {}),
    ...(input.bootstrapLifecycle
      ? {
          bootstrap_lifecycle: input.bootstrapLifecycle,
        }
      : {}),
    host_agent: input.host_agent,
    runtime_health: input.runtime_health,
    acp_worker_health: input.acp_worker_health,
    bees: input.bees,
    host_integrity: input.host_integrity,
    runtime_uid_mode: input.runtime_uid_mode,
    observed_components: input.observed_components,
    rootfs_scanner: input.rootfs_scanner,
    software: versions,
    software_inventory: input.software_inventory,
    agent_rpc_report: {
      version: input.agent_rpc_report_version,
      project_host: versions.project_host ?? null,
    },
    content_origin_domain: input.content_origin_domain ?? null,
  };
}

function baseInlineBefore() {
  return {
    runnerId: "runner-1",
    host_session_id: "session-1",
    host_boot_id: "boot-1",
    host_session_started_at: "2026-11-13T00:00:00.000Z",
    host_boot_started_at: "2026-11-12T00:00:00.000Z",
    host_cpu_count: 8,
    host_ram_gb: 32,
  };
}

function fullInput(): HostReportMetadataInput {
  return {
    base: buildHostBaseMetadata(baseInlineBefore()),
    cloudflared: { version: "2026.10.0" },
    host_uptime_s: 10,
    currentMetrics: { memory_used_percent: 72.2 },
    pressureState: { zone: "normal" },
    placementSnapshot: { cached_rootfs_images: ["a"] },
    bootstrapLifecycle: { phase: "ready" },
    host_agent: { status: "ok" },
    runtime_health: { ready: true },
    acp_worker_health: { ok: true },
    bees: { state: "running" },
    host_integrity: { ok: true },
    runtime_uid_mode: { mode: "keep-id" },
    observed_components: [{ component: "acp-worker" }],
    rootfs_scanner: { state: "ready" },
    software: { project_host: "v1", tools: "t1" },
    software_inventory: [{ artifact: "project-host" }],
    agent_rpc_report_version: 4,
    content_origin_domain: "content.example",
  };
}

const same = (a: object, b: object) => {
  expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  expect(Object.keys(a)).toEqual(Object.keys(b));
  expect(a).toEqual(b);
};

describe("host report metadata assembly (extracted from master.ts)", () => {
  it("builds the base metadata with the same keys and order", () => {
    same(buildHostBaseMetadata(baseInlineBefore()), baseInlineBefore());
  });

  it("matches the previous inline assembly with every input present", () => {
    const input = fullInput();
    same(buildHostReportMetadata(input), inlineBefore(input));
  });

  it("matches it with every optional input absent", () => {
    const input: HostReportMetadataInput = {
      ...fullInput(),
      base: undefined,
      cloudflared: undefined,
      currentMetrics: undefined,
      pressureState: undefined,
      placementSnapshot: undefined,
      bootstrapLifecycle: undefined,
      bees: undefined,
      software: {},
      content_origin_domain: undefined,
    };
    const built = buildHostReportMetadata(input);
    same(built, inlineBefore(input));
    expect(built).not.toHaveProperty("metrics");
    expect(built.agent_rpc_report).toEqual({ version: 4, project_host: null });
    expect(built.content_origin_domain).toBeNull();
  });

  it("matches it for each optional input present alone", () => {
    for (const key of [
      "currentMetrics",
      "pressureState",
      "placementSnapshot",
      "bootstrapLifecycle",
    ] as const) {
      const input: HostReportMetadataInput = {
        ...fullInput(),
        currentMetrics: undefined,
        pressureState: undefined,
        placementSnapshot: undefined,
        bootstrapLifecycle: undefined,
        [key]: fullInput()[key],
      };
      same(buildHostReportMetadata(input), inlineBefore(input));
    }
  });
});
