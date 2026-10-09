import {
  estimateRelocationWindowMs,
  planRelocation,
  relocateHost,
  relocationSnapshotName,
  type RelocationDeps,
} from "./relocate";
import {
  normalizeHostMaintenanceNotice,
  scheduledMaintenanceNotice,
} from "./maintenance";

const HOST_ID = "4a9c7c19-5c5f-45f9-a48b-5f04196666d4";

function hostRow(overrides: Record<string, any> = {}) {
  return {
    id: HOST_ID,
    status: "running",
    region: "us-south1",
    metadata: {
      size: "t2d-standard-16",
      machine: {
        cloud: "gcp",
        zone: "us-south1-c",
        machine_type: "t2d-standard-16",
        storage_mode: "persistent",
        metadata: { cpu: 16, ram_gb: 64 },
      },
      runtime: {
        zone: "us-south1-c",
        instance_id: `cocalc-prod-${HOST_ID}`,
      },
    },
    ...overrides,
  };
}

describe("planRelocation", () => {
  it("plans a cross-zone move within one backup region", () => {
    const plan = planRelocation(hostRow(), { zone: "us-west2-a" });
    expect(plan).toMatchObject({
      cross_zone: true,
      source: { zone: "us-south1-c", region: "us-south1" },
      target: {
        zone: "us-west2-a",
        region: "us-west2",
        machine_type: "t2d-standard-16",
      },
      data_disk_name: `cocalc-prod-${HOST_ID}-data`,
    });
  });

  it("refuses moves across backup regions, no-ops and unsupported hosts", () => {
    expect(() =>
      planRelocation(hostRow(), { zone: "northamerica-northeast2-a" }),
    ).toThrow(/different backup regions/);
    expect(() => planRelocation(hostRow(), {})).toThrow(/nothing to do/);
    expect(() =>
      planRelocation(hostRow({ status: "deprovisioned" }), {
        zone: "us-west2-a",
      }),
    ).toThrow(/running or stopped/);
    const selfHost = hostRow();
    selfHost.metadata.machine.cloud = "self-host";
    expect(() => planRelocation(selfHost, { zone: "us-west2-a" })).toThrow(
      /only supported for GCP/,
    );
    expect(() => planRelocation(hostRow(), { zone: "us-west2" })).toThrow(
      /invalid zone/,
    );
  });

  it("plans a machine type change within the zone", () => {
    const plan = planRelocation(hostRow(), {
      machine_type: "n2-standard-32",
    });
    expect(plan.cross_zone).toBe(false);
    expect(plan.target.machine_type).toBe("n2-standard-32");
  });
});

describe("estimateRelocationWindowMs", () => {
  it("matches the measured staging2 move and rounds up to minutes", () => {
    // 112 GB measured at 12 minutes including a 2.6 minute pre-stop backup.
    const ms = estimateRelocationWindowMs({
      cross_zone: true,
      data_bytes: 112e9,
      running: true,
    });
    expect(ms / 60_000).toBeGreaterThanOrEqual(10);
    expect(ms / 60_000).toBeLessThanOrEqual(13);
    expect(ms % 60_000).toBe(0);
    expect(
      estimateRelocationWindowMs({ cross_zone: false, running: true }) / 60_000,
    ).toBeLessThanOrEqual(6);
    // Restore time grows with the data.
    expect(
      estimateRelocationWindowMs({
        cross_zone: true,
        data_bytes: 500e9,
        running: true,
      }),
    ).toBeGreaterThan(ms);
  });
});

it("names snapshots within GCP limits", () => {
  const name = relocationSnapshotName(
    HOST_ID,
    "final",
    new Date("2026-10-09T03:04:05Z"),
  );
  expect(name).toBe("reloc-4a9c7c195c5f-202610090304-final");
  expect(name).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
});

function fakeDeps(opts: { failStart?: number } = {}) {
  const calls: string[] = [];
  let row: any = hostRow();
  let starts = 0;
  const maintenance: any[] = [];
  const provider = {
    snapshotDataDisk: jest.fn(async (_runtime, name: string) => {
      calls.push(`snapshot:${name.endsWith("-warm") ? "warm" : "final"}`);
      return {
        name,
        disk_name: `cocalc-prod-${HOST_ID}-data`,
        disk_type: "pd-balanced",
        disk_size_gb: 300,
        storage_bytes: 112e9,
      };
    }),
    createDataDiskFromSnapshot: jest.fn(async (args) => {
      calls.push(`restore:${args.zone}`);
    }),
    deleteDataDisk: jest.fn(async (args) => {
      calls.push(`delete-disk:${args.zone}`);
    }),
    deleteSnapshot: jest.fn(async (name: string) => {
      calls.push(`delete-snapshot:${name.endsWith("-warm") ? "warm" : "final"}`);
    }),
    setMachineType: jest.fn(async (_runtime, type: string) => {
      calls.push(`set-machine-type:${type}`);
    }),
  };
  const deps: RelocationDeps = {
    loadHost: async () => row,
    updateHost: async ({ metadata, region }) => {
      calls.push(`update:${region ?? row.region}:${metadata.machine.zone}`);
      row = { ...row, metadata, region: region ?? row.region };
    },
    setMaintenance: async (notice) => {
      maintenance.push(notice);
      calls.push(`maintenance:${notice?.state ?? "cleared"}`);
    },
    provider: async () => ({ provider, creds: {} }),
    machineTypeShape: async () => ({ cpu: 16, ram_gb: 64 }),
    backupProjects: async () => {
      calls.push("backup");
    },
    stopHost: async () => {
      calls.push("stop");
      row = { ...row, status: "off" };
    },
    loadProvisionedProjectIds: async () => {
      calls.push("load-provisioned");
      return ["p1", "p2"];
    },
    markProjectsProvisioned: async (ids) => {
      calls.push(`mark-provisioned:${ids.length}`);
    },
    quiesceCloudWork: async () => {
      calls.push("quiesce");
    },
    deprovisionHost: async () => {
      calls.push("deprovision");
      row = { ...row, status: "deprovisioned" };
    },
    startHost: async () => {
      starts += 1;
      calls.push(`start:${row.metadata.machine.zone}`);
      if (opts.failStart != null && starts <= opts.failStart) {
        row = { ...row, status: "error" };
        throw new Error("ZONE_RESOURCE_POOL_EXHAUSTED");
      }
      row = { ...row, status: "running" };
    },
    progress: async () => {},
    shouldCancel: async () => false,
    alert: jest.fn(async () => {}),
  };
  return { deps, calls, provider, maintenance, getRow: () => row };
}

describe("relocateHost", () => {
  it("moves the data disk across zones with a short announced window", async () => {
    const { deps, calls, maintenance, getRow } = fakeDeps();
    const result = await relocateHost({
      host_id: HOST_ID,
      op_id: "op-1",
      input: { zone: "us-west2-a" },
      deps,
    });
    expect(calls).toEqual([
      "backup",
      "snapshot:warm",
      "maintenance:in_progress",
      "stop",
      "snapshot:final",
      "load-provisioned",
      "deprovision",
      "mark-provisioned:2",
      "update:us-west2:us-west2-a",
      "restore:us-west2-a",
      "start:us-west2-a",
      "maintenance:cleared",
      "delete-snapshot:warm",
      "delete-snapshot:final",
    ]);
    expect(maintenance[0]).toMatchObject({
      kind: "relocation",
      state: "in_progress",
      op_id: "op-1",
    });
    // The estimate uses the data size measured by the warm snapshot.
    expect(maintenance[0].expected_duration_ms).toBe(result.expected_window_ms);
    expect(getRow().metadata.spot_recovery_state).toEqual({
      phase: "idle",
      active_machine_type: "t2d-standard-16",
    });
    expect(result.snapshots_kept).toEqual([]);
  });

  it("rolls back to the source zone from the final snapshot when the move fails", async () => {
    const { deps, calls, provider, getRow } = fakeDeps({ failStart: 1 });
    await expect(
      relocateHost({
        host_id: HOST_ID,
        input: { zone: "us-west2-a", machine_type: "c3d-standard-30" },
        deps,
      }),
    ).rejects.toThrow(/rolled back to us-south1-c/);
    expect(calls.slice(calls.indexOf("start:us-west2-a"))).toEqual([
      "start:us-west2-a",
      // The abandoned start must not race the rollback.
      "quiesce",
      "deprovision",
      "mark-provisioned:2",
      "delete-disk:us-west2-a",
      "update:us-south1:us-south1-c",
      "restore:us-south1-c",
      "start:us-south1-c",
      // Back in service: no maintenance banner left behind.
      "maintenance:cleared",
    ]);
    expect(getRow().region).toBe("us-south1");
    expect(getRow().metadata.machine.machine_type).toBe("t2d-standard-16");
    // Snapshots are kept for investigation after a failure.
    expect(provider.deleteSnapshot).not.toHaveBeenCalled();
    expect(deps.alert).toHaveBeenCalled();
  });

  it("changes the machine type in place without snapshots", async () => {
    const { deps, calls } = fakeDeps();
    await relocateHost({
      host_id: HOST_ID,
      input: { machine_type: "n2-standard-32", skip_backups: true },
      deps,
    });
    expect(calls).toEqual([
      "maintenance:in_progress",
      "stop",
      "set-machine-type:n2-standard-32",
      "update:us-south1:us-south1-c",
      "start:us-south1-c",
      "maintenance:cleared",
    ]);
  });

  it("updates the runtime's machine type and re-applies a clobbered placement", async () => {
    const { deps, getRow } = fakeDeps();
    const start = deps.startHost;
    deps.startHost = async (opts) => {
      await start(opts);
      // A stale full-metadata write from a concurrent handler.
      const row = getRow();
      row.metadata = {
        ...row.metadata,
        machine: { ...row.metadata.machine, machine_type: "t2d-standard-16" },
      };
    };
    await relocateHost({
      host_id: HOST_ID,
      input: { machine_type: "n2-standard-32", skip_backups: true },
      deps,
    });
    expect(getRow().metadata.machine.machine_type).toBe("n2-standard-32");
    expect(getRow().metadata.runtime.metadata.machine_type).toBe(
      "n2-standard-32",
    );
  });

  it("runs the preflight before touching anything", async () => {
    const { deps, calls } = fakeDeps();
    deps.preflight = async () => {
      throw new Error("no price for n2-standard-32 in asia-south2");
    };
    await expect(
      relocateHost({
        host_id: HOST_ID,
        input: { machine_type: "n2-standard-32" },
        deps,
      }),
    ).rejects.toThrow(/no price/);
    expect(calls).toEqual([]);
  });

  it("refuses a machine type the target zone does not offer", async () => {
    const { deps, calls } = fakeDeps();
    deps.machineTypeShape = async () => undefined;
    await expect(
      relocateHost({
        host_id: HOST_ID,
        input: { zone: "us-west2-a", machine_type: "c4d-standard-32" },
        deps,
      }),
    ).rejects.toThrow(/not offered in us-west2-a/);
    expect(calls).toEqual([]);
  });
});

describe("maintenance notices", () => {
  const now = Date.parse("2026-10-09T01:00:00Z");

  it("shows scheduled and in-progress windows, hides completed and stale ones", () => {
    const scheduled = scheduledMaintenanceNotice({
      scheduled_for: "2026-10-09T07:00:00Z",
      expected_minutes: 15,
      message: "Moving to a faster server.",
      now,
    });
    expect(scheduled).toMatchObject({
      state: "scheduled",
      expected_duration_ms: 15 * 60_000,
      expected_end_at: "2026-10-09T07:15:00.000Z",
    });
    expect(normalizeHostMaintenanceNotice(scheduled, now)).toMatchObject({
      state: "scheduled",
      message: "Moving to a faster server.",
    });
    expect(
      normalizeHostMaintenanceNotice({ ...scheduled, state: "completed" }, now),
    ).toBeUndefined();
    expect(
      normalizeHostMaintenanceNotice(
        { ...scheduled, scheduled_for: "2026-10-08T12:00:00Z" },
        now,
      ),
    ).toBeUndefined();
    expect(
      normalizeHostMaintenanceNotice(
        {
          kind: "relocation",
          state: "in_progress",
          started_at: "2026-10-08T12:00:00Z",
          expected_duration_ms: 600_000,
        },
        now,
      ),
    ).toMatchObject({ kind: "relocation", state: "in_progress" });
    expect(normalizeHostMaintenanceNotice("bogus", now)).toBeUndefined();
  });

  it("validates announcements", () => {
    expect(() =>
      scheduledMaintenanceNotice({
        scheduled_for: "2026-10-08T00:00:00Z",
        expected_minutes: 10,
        now,
      }),
    ).toThrow(/past/);
    expect(() =>
      scheduledMaintenanceNotice({
        scheduled_for: "2026-10-09T07:00:00Z",
        expected_minutes: 0,
        now,
      }),
    ).toThrow(/expected minutes/);
  });
});
