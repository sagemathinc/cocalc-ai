import {
  estimateRelocationWindowMs,
  planRelocation,
  relocateHost,
  relocationSnapshotName,
  type RelocationDeps,
} from "./relocate";
import {
  hostLifecycleFenced,
  hostOfflineFenced,
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

function fakeDeps(
  opts: {
    status?: string;
    failStart?: number;
    deprovisionFailsAfterDelete?: number;
    restoreFails?: boolean;
    updateFailsAfterSetMachineType?: boolean;
    fenceFails?: boolean;
    desiredState?: "running" | "stopped";
    sourceDiskDeleteFails?: boolean;
    rollbackRestoreFails?: boolean;
    // Work admitted before the fence that finishes while the host settles.
    duringFirstQuiesce?: (row: any) => any;
  } = {},
) {
  const calls: string[] = [];
  let row: any = hostRow({ status: opts.status ?? "running" });
  if (opts.desiredState) {
    row.metadata = { ...row.metadata, desired_state: opts.desiredState };
  }
  // Cloud work a start queued (verification), which later writes back the
  // whole row it read. Quiescing waits it out; anything left lands late.
  const pendingWork: Array<() => void> = [];
  const flushCloudWork = () => {
    for (const write of pendingWork.splice(0)) write();
  };
  let quiesces = 0;
  let starts = 0;
  let deprovisions = 0;
  let updates = 0;
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
      calls.push(`restore:${args.zone}${args.reuse_existing ? ":reuse" : ""}`);
      if (opts.restoreFails && !args.reuse_existing) {
        // Ambiguous: the disk was created but the response was lost.
        throw new Error("socket hang up");
      }
      if (opts.rollbackRestoreFails && args.reuse_existing) {
        throw new Error("quota exceeded");
      }
      return "created";
    }),
    deleteDataDisk: jest.fn(async (args) => {
      calls.push(`delete-disk:${args.zone}`);
      if (opts.sourceDiskDeleteFails && args.zone === "us-south1-c") {
        throw new Error("disk is in use");
      }
    }),
    deleteSnapshot: jest.fn(async (name: string) => {
      calls.push(
        `delete-snapshot:${name.endsWith("-warm") ? "warm" : "final"}`,
      );
    }),
    setMachineType: jest.fn(async (_runtime, type: string) => {
      calls.push(`set-machine-type:${type}`);
    }),
  };
  const deps: RelocationDeps = {
    loadHost: async () => row,
    updateHost: async ({ metadata, region }) => {
      updates += 1;
      if (opts.updateFailsAfterSetMachineType && updates === 1) {
        throw new Error("database connection lost");
      }
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
    setDesiredState: async (state) => {
      calls.push(`desired:${state}`);
      row = { ...row, metadata: { ...row.metadata, desired_state: state } };
    },
    quiesceCloudWork: async () => {
      calls.push("quiesce");
      quiesces += 1;
      if (quiesces === 1 && opts.duringFirstQuiesce) {
        row = opts.duringFirstQuiesce(row);
      }
      flushCloudWork();
      if (opts.fenceFails) {
        // A start raced in before the fence and is still running.
        row = { ...row, status: "starting" };
        throw new Error("cloud work did not settle");
      }
    },
    deprovisionHost: async () => {
      deprovisions += 1;
      calls.push("deprovision");
      if (deprovisions <= (opts.deprovisionFailsAfterDelete ?? 0)) {
        // The provider deleted the VM and disk; the bookkeeping failed.
        row = { ...row, status: "error" };
        throw new Error("cloudflare tunnel delete failed");
      }
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
      const stale = {
        ...row,
        metadata: { ...row.metadata, desired_state: "running" },
      };
      pendingWork.push(() => {
        row = { ...stale };
      });
    },
    progress: async () => {},
    shouldCancel: async () => false,
    alert: jest.fn(async () => {}),
  };
  return {
    deps,
    calls,
    provider,
    maintenance,
    flushCloudWork,
    getRow: () => row,
  };
}

describe("relocateHost", () => {
  it("fences the window and moves the data disk across zones", async () => {
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
      // The notice is the fence; work admitted before it settles first.
      "maintenance:in_progress",
      "quiesce",
      // Relocation's own stop is not an interruption to recover from.
      "desired:stopped",
      "stop",
      "snapshot:final",
      "deprovision",
      "update:us-west2:us-west2-a",
      // Never reuse a leftover target disk: only the final snapshot is current.
      "delete-disk:us-west2-a",
      "restore:us-west2-a",
      "start:us-west2-a",
      "desired:running",
      // The old disk is removed explicitly, not left to deprovision.
      "delete-disk:us-south1-c",
      "maintenance:cleared",
      "delete-snapshot:warm",
      "delete-snapshot:final",
    ]);
    expect(maintenance[0]).toMatchObject({
      kind: "relocation",
      state: "in_progress",
      op_id: "op-1",
    });
    expect(maintenance[0].expected_duration_ms).toBe(result.expected_window_ms);
    expect(getRow().metadata.spot_recovery_state).toEqual({
      phase: "idle",
      active_machine_type: "t2d-standard-16",
    });
    expect(result.snapshots_kept).toEqual([]);
  });

  it("rolls back when the target start fails, restoring the original machine", async () => {
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
      "desired:stopped",
      "quiesce",
      "deprovision",
      "delete-disk:us-west2-a",
      "update:us-south1:us-south1-c",
      "restore:us-south1-c:reuse",
      "start:us-south1-c",
      "desired:running",
      "maintenance:cleared",
    ]);
    expect(getRow().region).toBe("us-south1");
    expect(getRow().metadata.machine).toEqual(hostRow().metadata.machine);
    expect(provider.deleteSnapshot).not.toHaveBeenCalled();
    expect(deps.alert).toHaveBeenCalled();
  });

  it("restores from the snapshot when deprovision deleted the VM but then failed", async () => {
    // Before: the rollback trusted a flag set only after deprovision
    // returned, and started the deleted VM instead of restoring the disk.
    const { deps, calls, getRow } = fakeDeps({
      deprovisionFailsAfterDelete: 1,
    });
    await expect(
      relocateHost({ host_id: HOST_ID, input: { zone: "us-west2-a" }, deps }),
    ).rejects.toThrow(/rolled back to us-south1-c/);
    expect(calls.slice(calls.indexOf("deprovision"))).toEqual([
      "deprovision",
      "desired:stopped",
      "quiesce",
      "deprovision",
      "delete-disk:us-west2-a",
      "update:us-south1:us-south1-c",
      "restore:us-south1-c:reuse",
      "start:us-south1-c",
      "desired:running",
      "maintenance:cleared",
    ]);
    expect(getRow().status).toBe("running");
  });

  it("removes a target disk whose creation result was lost", async () => {
    const { deps, calls } = fakeDeps({ restoreFails: true });
    await expect(
      relocateHost({ host_id: HOST_ID, input: { zone: "us-west2-a" }, deps }),
    ).rejects.toThrow(/rolled back/);
    expect(calls.slice(calls.indexOf("restore:us-west2-a"))).toEqual([
      "restore:us-west2-a",
      "desired:stopped",
      "quiesce",
      "deprovision",
      "delete-disk:us-west2-a",
      "update:us-south1:us-south1-c",
      "restore:us-south1-c:reuse",
      "start:us-south1-c",
      "desired:running",
      "maintenance:cleared",
    ]);
  });

  it("keeps the host fenced when the rollback itself fails", async () => {
    const { deps, calls, maintenance } = fakeDeps({
      restoreFails: true,
      rollbackRestoreFails: true,
    });
    await expect(
      relocateHost({ host_id: HOST_ID, input: { zone: "us-west2-a" }, deps }),
    ).rejects.toThrow(/rollback failed: .*quota exceeded .*-final kept/);
    // Nothing may start or schedule work on a host whose disk is not back.
    expect(calls).not.toContain("maintenance:cleared");
    expect(calls.filter((call) => call.startsWith("maintenance:")).pop()).toBe(
      "maintenance:failed",
    );
    const last = maintenance[maintenance.length - 1];
    expect(hostLifecycleFenced(last)).toBe(true);
    expect(hostOfflineFenced(last)).toBe(true);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.stringMatching(/relocation failed/),
      expect.stringMatching(/Rollback failed: .*quota exceeded/),
    );
  });

  it("changes the machine type in place without snapshots", async () => {
    const { deps, calls, getRow } = fakeDeps();
    await relocateHost({
      host_id: HOST_ID,
      input: { machine_type: "n2-standard-32", skip_backups: true },
      deps,
    });
    expect(calls).toEqual([
      "maintenance:in_progress",
      "quiesce",
      "desired:stopped",
      "stop",
      "set-machine-type:n2-standard-32",
      "update:us-south1:us-south1-c",
      "start:us-south1-c",
      "desired:running",
      "maintenance:cleared",
    ]);
    expect(getRow().metadata.runtime.metadata.machine_type).toBe(
      "n2-standard-32",
    );
  });

  it("resets the provider type even when the database never recorded the change", async () => {
    const { deps, calls, getRow } = fakeDeps({
      updateFailsAfterSetMachineType: true,
    });
    await expect(
      relocateHost({
        host_id: HOST_ID,
        input: { machine_type: "n2-standard-32", skip_backups: true },
        deps,
      }),
    ).rejects.toThrow(/rolled back/);
    expect(
      calls.slice(calls.indexOf("set-machine-type:n2-standard-32")),
    ).toEqual([
      "set-machine-type:n2-standard-32",
      "desired:stopped",
      "quiesce",
      "set-machine-type:t2d-standard-16",
      "update:us-south1:us-south1-c",
      "start:us-south1-c",
      "desired:running",
      "maintenance:cleared",
    ]);
    expect(getRow().metadata.machine.machine_type).toBe("t2d-standard-16");
  });

  it("leaves the host untouched when the fence cannot be established", async () => {
    // Quiesce timed out because a start is still in flight: the rollback
    // must not start or stop anything on top of it.
    const { deps, calls, getRow } = fakeDeps({
      fenceFails: true,
      desiredState: "running",
    });
    await expect(
      relocateHost({ host_id: HOST_ID, input: { zone: "us-west2-a" }, deps }),
    ).rejects.toThrow(/did not settle/);
    expect(calls).not.toContain("stop");
    expect(calls).not.toContain("deprovision");
    expect(calls.filter((call) => call.startsWith("start:"))).toEqual([]);
    // Its intent is left alone too: nothing here changed it.
    expect(calls.filter((call) => call.startsWith("desired:"))).toEqual([]);
    expect(calls.slice(-2)).toEqual(["quiesce", "maintenance:cleared"]);
    expect(getRow().status).toBe("starting");
    expect(getRow().metadata.desired_state).toBe("running");
  });

  it("moves a stopped host and leaves it stopped", async () => {
    const { deps, calls, getRow } = fakeDeps({ status: "off" });
    await relocateHost({
      host_id: HOST_ID,
      input: { zone: "us-west2-a" },
      deps,
    });
    expect(calls).toEqual([
      "maintenance:in_progress",
      "quiesce",
      "desired:stopped",
      "snapshot:final",
      "deprovision",
      "update:us-west2:us-west2-a",
      "delete-disk:us-west2-a",
      "restore:us-west2-a",
      // Started once to prove the moved disk works, then stopped again.
      "start:us-west2-a",
      // Its verification work settles before it is stopped again.
      "quiesce",
      "stop",
      "desired:stopped",
      "delete-disk:us-south1-c",
      "maintenance:cleared",
      "delete-snapshot:final",
    ]);
    expect(getRow().status).toBe("off");
  });

  it("acts on a start that finished while the host settled", async () => {
    // Read as stopped; a start admitted before the fence then completed.
    const { deps, calls, getRow, flushCloudWork } = fakeDeps({
      status: "off",
      desiredState: "stopped",
      duringFirstQuiesce: (row) => ({
        ...row,
        status: "running",
        metadata: { ...row.metadata, desired_state: "running" },
      }),
    });
    await relocateHost({
      host_id: HOST_ID,
      input: { zone: "us-west2-a" },
      deps,
    });
    flushCloudWork();
    // Stopped before the final snapshot, and kept running afterwards.
    expect(calls.indexOf("stop")).toBeLessThan(calls.indexOf("snapshot:final"));
    expect(calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(getRow().status).toBe("running");
    expect(getRow().metadata.desired_state).toBe("running");
  });

  it("acts on a stop that finished while the host settled", async () => {
    const { deps, calls, getRow, flushCloudWork } = fakeDeps({
      desiredState: "running",
      duringFirstQuiesce: (row) => ({
        ...row,
        status: "off",
        metadata: { ...row.metadata, desired_state: "stopped" },
      }),
    });
    await relocateHost({
      host_id: HOST_ID,
      input: { zone: "us-west2-a" },
      deps,
    });
    flushCloudWork();
    // Already off at the snapshot; started once to verify, then stopped.
    expect(calls.indexOf("stop")).toBeGreaterThan(
      calls.indexOf("start:us-west2-a"),
    );
    expect(getRow().status).toBe("off");
    expect(getRow().metadata.desired_state).toBe("stopped");
  });

  it("moves nothing if the host was changed while it settled", async () => {
    const { deps, calls, getRow } = fakeDeps({
      duringFirstQuiesce: (row) => ({
        ...row,
        metadata: {
          ...row.metadata,
          machine: { ...row.metadata.machine, machine_type: "n2-standard-8" },
        },
      }),
    });
    await expect(
      relocateHost({ host_id: HOST_ID, input: { zone: "us-west2-a" }, deps }),
    ).rejects.toThrow(/host changed while other work finished.*rolled back/);
    expect(calls).toEqual([
      "backup",
      "snapshot:warm",
      "maintenance:in_progress",
      "quiesce",
      "maintenance:cleared",
    ]);
    expect(getRow().status).toBe("running");
  });

  it("is not undone by verification work that writes back the row late", async () => {
    // The start's verification read the row while the host ran; if it
    // landed after the host was stopped again, a stopped host would be
    // recorded as running and wanted running.
    const { deps, getRow, flushCloudWork } = fakeDeps({ status: "off" });
    await relocateHost({
      host_id: HOST_ID,
      input: { zone: "us-west2-a" },
      deps,
    });
    flushCloudWork();
    expect(getRow().status).toBe("off");
    expect(getRow().metadata.desired_state).toBe("stopped");
    expect(getRow().region).toBe("us-west2");
    expect(getRow().metadata.machine).toMatchObject({
      zone: "us-west2-a",
      machine_type: "t2d-standard-16",
    });
  });

  it("keeps the exact desired state when it disagrees with the status", async () => {
    // A stopped Spot host being recovered (desired running) stays wanted
    // running; a running host with a pending stop keeps that stop.
    const recovering = fakeDeps({ status: "off", desiredState: "running" });
    await relocateHost({
      host_id: HOST_ID,
      input: { zone: "us-west2-a" },
      deps: recovering.deps,
    });
    expect(recovering.getRow().metadata.desired_state).toBe("running");
    expect(recovering.getRow().status).toBe("off");

    const stopping = fakeDeps({ desiredState: "stopped" });
    await relocateHost({
      host_id: HOST_ID,
      input: { machine_type: "n2-standard-32", skip_backups: true },
      deps: stopping.deps,
    });
    stopping.flushCloudWork();
    expect(stopping.getRow().metadata.desired_state).toBe("stopped");

    const rollingBack = fakeDeps({ desiredState: "stopped", failStart: 1 });
    await expect(
      relocateHost({
        host_id: HOST_ID,
        input: { zone: "us-west2-a" },
        deps: rollingBack.deps,
      }),
    ).rejects.toThrow(/rolled back/);
    expect(rollingBack.getRow().metadata.desired_state).toBe("stopped");
  });

  it("reports and keeps the snapshot when the old data disk cannot be deleted", async () => {
    const { deps, provider } = fakeDeps({ sourceDiskDeleteFails: true });
    const result = await relocateHost({
      host_id: HOST_ID,
      input: { zone: "us-west2-a" },
      deps,
    });
    expect(result.cleanup_warnings).toEqual([
      expect.stringMatching(
        /could not delete the old data disk .* us-south1-c/,
      ),
    ]);
    expect(result.snapshots_kept).toEqual([expect.stringMatching(/-final$/)]);
    expect(provider.deleteSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.stringMatching(/left data behind/),
      expect.any(String),
    );
  });

  it("changes the type of a stopped host without starting it", async () => {
    const { deps, calls } = fakeDeps({ status: "off" });
    await relocateHost({
      host_id: HOST_ID,
      input: { machine_type: "n2-standard-32" },
      deps,
    });
    expect(calls).not.toContain("start:us-south1-c");
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
