/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { PROJECT_DISK_QUOTA_EXCEEDED_CODE } from "@cocalc/util/project-start-errors";
import { ONBOARDING_METRICS as ONBOARDING } from "@cocalc/util/onboarding-metrics";
import type {
  UxLatencyMetricSummary,
  UxLatencySummary,
} from "@cocalc/conat/hub/api/system";
import { UX_LATENCY_HEALTH_METRICS } from "@cocalc/conat/hub/api/system";
import {
  alertCandidates,
  classifyLatencyP95Health,
  classifyProjectStartQuotaTelemetry,
  DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
} from "./ux-latency";

describe("latency health sample requirements", () => {
  it.each([
    ONBOARDING.failed,
    ONBOARDING.stalled,
    ONBOARDING.incomplete,
    ONBOARDING.abandoned,
  ])("alerts on even one onboarding %s", (name) => {
    const result = alertCandidates(
      summary({ aggregate: metric({ name, count: 1, p95_ms: 120000 }) }),
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
    );
    expect(result.some((item) => item.subject.includes("onboarding"))).toBe(
      true,
    );
  });

  it("alerts on repeated slow first output with only three onboarding samples", () => {
    const result = alertCandidates(
      summary({
        aggregate: metric({
          name: ONBOARDING.visible,
          count: 3,
          p95_ms: 15000,
        }),
      }),
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
    );
    expect(
      result.some(
        (item) => item.subject === "onboarding first response is slow",
      ),
    ).toBe(true);
  });
  it("does not warn on a P95 computed from too few project starts", () => {
    expect(
      classifyLatencyP95Health({
        p95: 12_000,
        sample_count: 6,
        min_samples: 10,
        warning_ms: 7_000,
        critical_ms: 14_000,
      }),
    ).toBe("unknown");
    expect(
      classifyLatencyP95Health({
        p95: 12_000,
        sample_count: 10,
        min_samples: 10,
        warning_ms: 7_000,
        critical_ms: 14_000,
      }),
    ).toBe("warning");
  });
});

const event = {
  event_type: "project_start",
  metric: "project_start_running_stuck",
  duration_ms: 60_000,
  details: { op_id: "00000000-0000-4000-8000-000000000001" },
};

describe("project start quota telemetry", () => {
  it("reclassifies a stale stuck event after a quota-blocked LRO fails", () => {
    const classified = classifyProjectStartQuotaTelemetry({
      event,
      lro: {
        status: "failed",
        error: "Project disk quota exceeded",
        result: {
          project_start_failure: {
            code: PROJECT_DISK_QUOTA_EXCEEDED_CODE,
          },
        },
      },
    });
    expect(classified.metric).toBe("project_start_running_blocked");
    expect(classified.details).toEqual(
      expect.objectContaining({
        original_metric: "project_start_running_stuck",
        op_status: "failed",
      }),
    );
  });

  it("preserves genuine stalls and unrelated failures", () => {
    expect(
      classifyProjectStartQuotaTelemetry({
        event,
        lro: { status: "running", error: null, result: null },
      }),
    ).toBe(event);
    expect(
      classifyProjectStartQuotaTelemetry({
        event,
        lro: {
          status: "failed",
          error: "host unavailable",
          result: null,
        },
      }),
    ).toBe(event);
  });
});

function metric({
  name = "project_exec_ready",
  segment,
  count = 30,
  p95_ms,
}: {
  name?: string;
  segment?: string;
  count?: number;
  p95_ms: number;
}): UxLatencyMetricSummary {
  return {
    metric: name,
    event_type: "project_ready",
    segment,
    count,
    account_count: count,
    project_count: count,
    avg_ms: p95_ms,
    p50_ms: 0,
    p95_ms,
    p99_ms: p95_ms,
    max_ms: p95_ms,
  };
}

function summary({
  aggregate,
  warm,
  autostart,
}: {
  aggregate: UxLatencyMetricSummary;
  warm?: UxLatencyMetricSummary;
  autostart?: UxLatencyMetricSummary;
}): UxLatencySummary {
  const recent_slow_events = Array.from({ length: 3 }, (_, index) => ({
    received_at: `2026-07-15T22:30:0${index}.000Z`,
    event_type: "project_ready",
    metric: aggregate.metric,
    segment: warm?.segment ?? autostart?.segment,
    duration_ms: warm?.p95_ms ?? autostart?.p95_ms ?? aggregate.p95_ms,
  }));
  return {
    checked_at: "2026-07-15T22:31:00.000Z",
    window_minutes: 15,
    since: "2026-07-15T22:16:00.000Z",
    metrics: [aggregate],
    segments: [warm, autostart].filter(
      (row): row is UxLatencyMetricSummary => row != null,
    ),
    recent_slow_events,
  };
}

describe("project exec readiness alerts", () => {
  const sla = {
    ...DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
    project_exec_ready_p95_ms: 15_000,
  };

  it("does not page on stale autostart streams", () => {
    const autostart = metric({ segment: "autostart", p95_ms: 24_017_000 });
    const alerts = alertCandidates(
      summary({ aggregate: metric({ p95_ms: 11_855_000 }), autostart }),
      sla,
    );
    expect(alerts).toEqual([]);
  });

  it("pages when already-running project execs violate the SLA", () => {
    const warm = metric({ segment: "warm", p95_ms: 20_000 });
    const alerts = alertCandidates(
      summary({ aggregate: metric({ p95_ms: 20_000 }), warm }),
      sla,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual(
      expect.objectContaining({
        subject: "project exec ready latency is high",
      }),
    );
    expect(alerts[0].body).toContain("Segment: warm");
  });
});

describe("file-open latency alerts", () => {
  it("uses foreground v2 content paint instead of the legacy visible metric", () => {
    const v2 = metric({
      name: UX_LATENCY_HEALTH_METRICS.fileVisible,
      count: 50,
      p95_ms: 12_000,
    });
    expect(
      alertCandidates(summary({ aggregate: v2 }), {
        ...DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
        file_open_visible_p95_ms: 10_000,
      }).map(({ subject }) => subject),
    ).toContain("file content paint latency is high");

    const legacy = metric({
      name: "file_open_visible",
      count: 50,
      p95_ms: 12_000,
    });
    expect(
      alertCandidates(
        summary({ aggregate: legacy }),
        DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
      ),
    ).toEqual([]);
  });

  it("uses foreground v2 SyncDoc readiness instead of the legacy sync metric", () => {
    const v2 = metric({
      name: UX_LATENCY_HEALTH_METRICS.fileSyncReady,
      count: 50,
      p95_ms: 7000,
    });
    expect(
      alertCandidates(
        summary({ aggregate: v2 }),
        DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
      ).map(({ subject }) => subject),
    ).toContain("file open sync-ready latency is high");

    const legacy = metric({
      name: "file_open_sync_ready",
      count: 50,
      p95_ms: 7000,
    });
    expect(
      alertCandidates(
        summary({ aggregate: legacy }),
        DEFAULT_UX_LATENCY_SLA_THRESHOLDS,
      ),
    ).toEqual([]);
  });
});
