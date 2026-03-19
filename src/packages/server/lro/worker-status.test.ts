import {
  parallelOpsLroKindToWorkerKind,
  parallelOpsWorkerRegistry,
  parallelOpsWorkerRegistryByKind,
} from "./worker-registry";
import {
  summarizeMoveRoleWorkerStatus,
  summarizeCloudVmWorkStatus,
  summarizeHostLocalBackupStatus,
  summarizeLroWorkerStatus,
} from "./worker-status";

describe("parallel ops worker registry", () => {
  it("has unique worker kinds", () => {
    expect(parallelOpsWorkerRegistryByKind.size).toBe(
      parallelOpsWorkerRegistry.length,
    );
  });

  it("maps all registered lro kinds back to a worker", () => {
    for (const entry of parallelOpsWorkerRegistry) {
      for (const kind of entry.lro_kinds ?? []) {
        expect(parallelOpsLroKindToWorkerKind.get(kind)).toBe(
          entry.worker_kind,
        );
      }
    }
  });

  it("reads the current env-driven backup limit", () => {
    const prev = process.env.COCALC_BACKUP_LRO_MAX_PARALLEL;
    process.env.COCALC_BACKUP_LRO_MAX_PARALLEL = "17";
    try {
      const worker = parallelOpsWorkerRegistryByKind.get("project-backup");
      expect(worker?.getLimitSnapshot().effective_limit).toBe(17);
      expect(worker?.getLimitSnapshot().config_source).toBe("env-legacy");
    } finally {
      if (prev == null) {
        delete process.env.COCALC_BACKUP_LRO_MAX_PARALLEL;
      } else {
        process.env.COCALC_BACKUP_LRO_MAX_PARALLEL = prev;
      }
    }
  });
});

describe("summarizeLroWorkerStatus", () => {
  it("computes queued, running, stale, and owner counts", () => {
    const worker = parallelOpsWorkerRegistryByKind.get("project-move");
    expect(worker).toBeDefined();
    const nowMs = Date.parse("2026-03-18T20:00:00.000Z");
    const status = summarizeLroWorkerStatus({
      worker: worker!,
      nowMs,
      rows: [
        {
          kind: "project-move",
          status: "queued",
          owner_id: null,
          heartbeat_at: null,
          created_at: new Date("2026-03-18T19:58:00.000Z"),
        },
        {
          kind: "project-move",
          status: "running",
          owner_id: "worker-a",
          heartbeat_at: new Date("2026-03-18T19:59:30.000Z"),
          created_at: new Date("2026-03-18T19:57:00.000Z"),
        },
        {
          kind: "project-move",
          status: "running",
          owner_id: "worker-b",
          heartbeat_at: new Date("2026-03-18T19:57:00.000Z"),
          created_at: new Date("2026-03-18T19:56:00.000Z"),
        },
      ],
    });

    expect(status.queued_count).toBe(1);
    expect(status.running_count).toBe(2);
    expect(status.stale_running_count).toBe(1);
    expect(status.oldest_queued_ms).toBe(120000);
    expect(status.worker_instances).toBe(2);
    expect(status.owners).toEqual([
      { owner_id: "worker-a", active_count: 1, stale_count: 0 },
      { owner_id: "worker-b", active_count: 1, stale_count: 1 },
    ]);
  });
});

describe("summarizeCloudVmWorkStatus", () => {
  it("computes queued and running counts with provider breakdown", () => {
    const worker = parallelOpsWorkerRegistryByKind.get("cloud-vm-work");
    expect(worker).toBeDefined();
    const nowMs = Date.parse("2026-03-18T20:00:00.000Z");
    const status = summarizeCloudVmWorkStatus({
      worker: worker!,
      nowMs,
      providerLimits: new Map([
        ["gcp", { value: 4, source: "db-override" as const }],
        ["nebius", { value: 10, source: "default" as const }],
      ]),
      rows: [
        {
          state: "queued",
          locked_by: null,
          locked_at: null,
          created_at: new Date("2026-03-18T19:59:00.000Z"),
          payload: { provider: "gcp" },
        },
        {
          state: "queued",
          locked_by: null,
          locked_at: null,
          created_at: new Date("2026-03-18T19:58:00.000Z"),
          payload: { provider: "nebius" },
        },
        {
          state: "in_progress",
          locked_by: "cloud-worker-a",
          locked_at: new Date("2026-03-18T19:59:30.000Z"),
          created_at: new Date("2026-03-18T19:57:00.000Z"),
          payload: { provider: "gcp" },
        },
      ],
    });

    expect(status.queued_count).toBe(2);
    expect(status.running_count).toBe(1);
    expect(status.stale_running_count).toBeNull();
    expect(status.oldest_queued_ms).toBe(120000);
    expect(status.worker_instances).toBe(1);
    expect(status.config_source).toBe("db-override");
    expect(status.breakdown).toEqual([
      { key: "gcp", queued_count: 1, running_count: 1, limit: 4 },
      { key: "nebius", queued_count: 1, running_count: 0, limit: 10 },
    ]);
  });
});

describe("summarizeHostLocalBackupStatus", () => {
  it("aggregates per-host backup slot usage and waiters", () => {
    const worker = parallelOpsWorkerRegistryByKind.get(
      "project-host-backup-execution",
    );
    expect(worker).toBeDefined();
    const status = summarizeHostLocalBackupStatus({
      worker: worker!,
      unreachable_hosts: 1,
      rows: [
        {
          host_id: "host-a",
          max_parallel: 10,
          in_flight: 3,
          queued: 2,
          project_lock_count: 4,
        },
        {
          host_id: "host-b",
          max_parallel: 10,
          in_flight: 1,
          queued: 0,
          project_lock_count: 1,
        },
      ],
    });

    expect(status.category).toBe("host-local");
    expect(status.queued_count).toBe(2);
    expect(status.running_count).toBe(4);
    expect(status.stale_running_count).toBeNull();
    expect(status.worker_instances).toBe(2);
    expect(status.effective_limit).toBe(10);
    expect(status.breakdown).toEqual([
      {
        key: "host-a",
        queued_count: 2,
        running_count: 3,
        limit: 10,
        extra: { project_lock_count: 4 },
      },
      {
        key: "host-b",
        queued_count: 0,
        running_count: 1,
        limit: 10,
        extra: { project_lock_count: 1 },
      },
    ]);
    expect(status.notes).toContain(
      "1 recent running project-hosts did not answer backup execution status requests.",
    );
  });
});

describe("summarizeMoveRoleWorkerStatus", () => {
  it("reports source-host move admission usage and stale owners", () => {
    const worker = parallelOpsWorkerRegistryByKind.get(
      "project-move-source-host",
    );
    expect(worker).toBeDefined();
    const nowMs = Date.parse("2026-03-18T20:00:00.000Z");
    const status = summarizeMoveRoleWorkerStatus({
      worker: worker!,
      role: "source",
      nowMs,
      limitByHost: new Map([
        ["host-a", { value: 1, source: "default" as const }],
        ["host-b", { value: 2, source: "db-override" as const }],
      ]),
      rows: [
        {
          status: "queued",
          owner_id: null,
          heartbeat_at: null,
          created_at: new Date("2026-03-18T19:58:00.000Z"),
          source_host_id: "host-a",
          dest_host_id: "host-c",
        },
        {
          status: "running",
          owner_id: "worker-a",
          heartbeat_at: new Date("2026-03-18T19:59:30.000Z"),
          created_at: new Date("2026-03-18T19:57:00.000Z"),
          source_host_id: "host-b",
          dest_host_id: "host-d",
        },
        {
          status: "running",
          owner_id: "worker-b",
          heartbeat_at: new Date("2026-03-18T19:57:00.000Z"),
          created_at: new Date("2026-03-18T19:56:00.000Z"),
          source_host_id: "host-b",
          dest_host_id: "host-e",
        },
      ],
    });

    expect(status.queued_count).toBe(1);
    expect(status.running_count).toBe(2);
    expect(status.stale_running_count).toBe(1);
    expect(status.worker_instances).toBe(2);
    expect(status.config_source).toBe("db-override");
    expect(status.breakdown).toEqual([
      { key: "host-a", queued_count: 1, running_count: 0, limit: 1 },
      { key: "host-b", queued_count: 0, running_count: 2, limit: 2 },
    ]);
  });

  it("tracks queued destination-less moves under an unassigned bucket", () => {
    const worker = parallelOpsWorkerRegistryByKind.get(
      "project-move-destination-host",
    );
    expect(worker).toBeDefined();
    const status = summarizeMoveRoleWorkerStatus({
      worker: worker!,
      role: "destination",
      nowMs: Date.parse("2026-03-18T20:00:00.000Z"),
      limitByHost: new Map([
        ["host-b", { value: 1, source: "default" as const }],
      ]),
      rows: [
        {
          status: "queued",
          owner_id: null,
          heartbeat_at: null,
          created_at: new Date("2026-03-18T19:59:00.000Z"),
          source_host_id: "host-a",
          dest_host_id: null,
        },
        {
          status: "running",
          owner_id: "worker-a",
          heartbeat_at: new Date("2026-03-18T19:59:40.000Z"),
          created_at: new Date("2026-03-18T19:58:00.000Z"),
          source_host_id: "host-c",
          dest_host_id: "host-b",
        },
      ],
    });

    expect(status.breakdown).toEqual([
      { key: "host-b", queued_count: 0, running_count: 1, limit: 1 },
      { key: "unassigned", queued_count: 1, running_count: 0, limit: null },
    ]);
    expect(status.notes).toContain(
      "Queued moves without a selected destination are tracked under the 'unassigned' breakdown key.",
    );
  });
});
