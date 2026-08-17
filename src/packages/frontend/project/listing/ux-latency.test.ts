const mockTraceInstances: any[] = [];
const mockRecordSignedInSurfaceReady = jest.fn();

jest.mock("@cocalc/frontend/app/bootstrap-ux-latency", () => ({
  recordSignedInSurfaceReady: (...args: any[]) =>
    mockRecordSignedInSurfaceReady(...args),
}));

jest.mock("@cocalc/frontend/monitoring/ux-latency-trace", () => ({
  UxLatencyTrace: class MockUxLatencyTrace {
    id = `trace-${mockTraceInstances.length + 1}`;
    marks: Record<string, number> = { intent: 0 };
    records: Array<{ endpoint: string; options: any }> = [];
    emitted = new Set<string>();

    constructor(public options: any) {
      mockTraceInstances.push(this);
    }

    mark(phase: string) {
      this.marks[phase] = Object.keys(this.marks).length;
    }

    record(endpoint: string, options: any) {
      if (this.emitted.has(endpoint)) return false;
      this.emitted.add(endpoint);
      this.records.push({ endpoint, options });
      return true;
    }
  },
}));

import {
  cancelProjectDirectoryOpenTrace,
  claimDirectoryListingTrace,
  directoryListingTelemetry,
  recordProjectDirectoryOpenIncomplete,
  recordDirectoryListingPaint,
  startDirectoryNavigationTrace,
  startProjectDirectoryOpenTrace,
} from "./ux-latency";

describe("directory listing UX traces", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRecordSignedInSurfaceReady.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("keeps project-open ownership when path selection follows", () => {
    const project_id = "project-open-1";
    startProjectDirectoryOpenTrace({ project_id, surface_visible: true });
    startDirectoryNavigationTrace({ project_id, path: "/home/user" });
    const entry = claimDirectoryListingTrace({
      project_id,
      path: "/home/user",
      surface_visible: true,
    });
    const telemetry = directoryListingTelemetry({
      entry,
      revision: 1,
      data_source: "snapshot",
      authoritative: true,
      cache_hit: false,
      entries: 4,
      truncated: false,
      attempts: 1,
    })!;

    recordDirectoryListingPaint({
      project_id,
      path: "/home/user",
      telemetry,
      rendered_entries: 4,
      surface_visible: true,
    });

    expect(
      (entry.trace as any).records.map(({ endpoint }) => endpoint),
    ).toEqual([
      "project_directory_first_paint_v2",
      "directory_authoritative_paint_v2",
    ]);
    expect(mockRecordSignedInSurfaceReady).toHaveBeenCalledWith(
      "project-directory",
    );
  });

  it("records retained content separately from authoritative content", () => {
    const project_id = "navigation-1";
    startDirectoryNavigationTrace({ project_id, path: "/work" });
    const entry = claimDirectoryListingTrace({
      project_id,
      path: "/work",
      surface_visible: true,
    });
    const cached = directoryListingTelemetry({
      entry,
      revision: 0,
      data_source: "cache",
      authoritative: false,
      cache_hit: true,
      entries: 3,
      truncated: false,
    })!;
    recordDirectoryListingPaint({
      project_id,
      path: "/work",
      telemetry: cached,
      rendered_entries: 3,
      surface_visible: true,
    });

    const snapshot = directoryListingTelemetry({
      entry,
      revision: 1,
      data_source: "snapshot",
      authoritative: true,
      cache_hit: true,
      entries: 4,
      truncated: false,
      attempts: 1,
    })!;
    recordDirectoryListingPaint({
      project_id,
      path: "/work",
      telemetry: snapshot,
      rendered_entries: 4,
      surface_visible: true,
    });

    expect(
      (entry.trace as any).records.map(({ endpoint }) => endpoint),
    ).toEqual([
      "directory_navigation_first_paint_v2",
      "directory_authoritative_paint_v2",
    ]);
    expect((entry.trace as any).records[0].options.details.data_source).toBe(
      "cache",
    );
    expect((entry.trace as any).records[1].options.details.data_source).toBe(
      "snapshot",
    );
  });

  it("records routing failures immediately and clears the trace", () => {
    const project_id = "project-routing-failure";
    startProjectDirectoryOpenTrace({ project_id, surface_visible: true });
    const original = claimDirectoryListingTrace({
      project_id,
      path: "/home/user",
      surface_visible: true,
    });

    recordProjectDirectoryOpenIncomplete({
      project_id,
      reason: "host_routing_failed",
    });

    expect((original.trace as any).records).toEqual([
      expect.objectContaining({
        endpoint: "directory_listing_incomplete_v2",
        options: expect.objectContaining({
          details: expect.objectContaining({ reason: "host_routing_failed" }),
        }),
      }),
    ]);
    const replacement = claimDirectoryListingTrace({
      project_id,
      path: "/home/user",
      surface_visible: true,
    });
    expect(replacement.trace.id).not.toBe(original.trace.id);
  });

  it("cancels a project-open trace when target resolution selects a file", () => {
    const project_id = "project-file-target";
    startProjectDirectoryOpenTrace({ project_id, surface_visible: true });
    const original = claimDirectoryListingTrace({
      project_id,
      path: "/home/user",
      surface_visible: true,
    });
    cancelProjectDirectoryOpenTrace(project_id);
    const replacement = claimDirectoryListingTrace({
      project_id,
      path: "/home/user",
      surface_visible: true,
    });
    expect((original.trace as any).records).toEqual([]);
    expect(replacement.trace.id).not.toBe(original.trace.id);
  });
});
