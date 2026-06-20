import { computeRootfsPublishDiagnostics } from "./rootfs-publish-worker";

describe("rootfs publish worker diagnostics", () => {
  it("includes host identity, disk type, and publish throughput", () => {
    const diagnostics = computeRootfsPublishDiagnostics({
      hostDiagnostics: {
        host_id: "host-1",
        host: {
          name: "host3",
          cloud: "gcp",
          region: "us-south1",
          zone: "us-south1-a",
          machine_type: "t2d-standard-4",
          disk_type: "standard",
          disk_gb: 100,
        },
      },
      artifact: {
        size_bytes: 6_000_000_000,
        phase_timings_ms: { upload_rustic: 120_000 },
      },
      uploadResult: {
        artifact_bytes: 3_000_000_000,
        phase_timings_ms: {},
      },
      phase_timings_ms: { publish: 180_000 },
    });

    expect(diagnostics.host_id).toBe("host-1");
    expect(diagnostics.host?.disk_type).toBe("standard");
    expect(diagnostics.artifact_bytes).toBe(3_000_000_000);
    expect(diagnostics.source_bytes).toBe(6_000_000_000);
    expect(diagnostics.upload_ms).toBe(120_000);
    expect(diagnostics.upload_artifact_bytes_per_second).toBe(25_000_000);
    expect(diagnostics.upload_source_bytes_per_second).toBe(50_000_000);
  });

  it("falls back to outer upload timings when project-host timings are absent", () => {
    const diagnostics = computeRootfsPublishDiagnostics({
      hostDiagnostics: { host_id: "host-2" },
      artifact: { size_bytes: 1000 },
      uploadResult: { artifact_bytes: 500 },
      phase_timings_ms: { upload: 250 },
    });

    expect(diagnostics.upload_ms).toBe(250);
    expect(diagnostics.upload_artifact_bytes_per_second).toBe(2000);
    expect(diagnostics.upload_source_bytes_per_second).toBe(4000);
  });
});
