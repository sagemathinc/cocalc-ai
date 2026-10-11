import {
  classifyCloudOrphanInstances,
  closeStaleObservedSpotRecovery,
  ensureHostReadyVerificationWork,
  hasPendingRestoreBlockingWork,
  runtimeSshServerForProviderReconcile,
  runReconcileOnce,
} from "@cocalc/server/cloud";
import { updateHostFromProviderSnapshot } from "./reconcile";
import { before, after, getPool } from "@cocalc/server/test";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM cloud_reconcile_state");
  await getPool().query("DELETE FROM cloud_vm_work");
});

describe("cloud reconcile state gating", () => {
  const provider = "gcp";

  it("skips when next_run_at is in the future", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const future = new Date(now.getTime() + 60_000);
    await getPool().query(
      `
        INSERT INTO cloud_reconcile_state (provider, next_run_at, updated_at)
        VALUES ($1, $2, NOW())
      `,
      [provider, future],
    );

    const reconcile = jest.fn(async () => {});
    const count = jest.fn(async () => ({ total: 0, running: 0 }));
    const result = await runReconcileOnce(provider, {
      now: () => now,
      intervals: { running_ms: 1, idle_ms: 2, empty_ms: 3 },
      reconcile,
      count,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(result?.ran).toBe(false);
    expect(result?.skipped).toBe("not_due");
    expect(result?.next_at?.getTime()).toBe(future.getTime());
  });

  it("runs when due and updates state row", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const reconcile = jest.fn(async () => {});
    const count = jest.fn(async () => ({ total: 0, running: 0 }));
    const intervals = { running_ms: 10, idle_ms: 20, empty_ms: 30 };

    const result = await runReconcileOnce(provider, {
      now: () => now,
      intervals,
      reconcile,
      count,
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(result?.ran).toBe(true);

    const { rows } = await getPool().query(
      `SELECT last_run_at, next_run_at, last_error FROM cloud_reconcile_state WHERE provider=$1`,
      [provider],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.last_error).toBeNull();
    expect(new Date(row.last_run_at).getTime()).toBe(now.getTime());
    const expectedNext = now.getTime() + intervals.empty_ms;
    expect(new Date(row.next_run_at).getTime()).toBe(expectedNext);
  });

  it("returns undefined when advisory lock is held", async () => {
    const lockKey = `cloud_reconcile:${provider}`;
    const client = await getPool().connect();
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    try {
      const reconcile = jest.fn(async () => {});
      const result = await runReconcileOnce(provider, { reconcile });
      expect(result).toBeUndefined();
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      client.release();
    }
  });

  it("records last_error when reconcile fails", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const reconcile = jest.fn(async () => {
      throw new Error("boom");
    });
    const intervals = { running_ms: 10, idle_ms: 20, empty_ms: 30 };

    await expect(
      runReconcileOnce(provider, {
        now: () => now,
        intervals,
        reconcile,
      }),
    ).rejects.toThrow("boom");

    const { rows } = await getPool().query(
      `SELECT last_error, next_run_at FROM cloud_reconcile_state WHERE provider=$1`,
      [provider],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].last_error).toContain("boom");
    expect(rows[0].next_run_at).not.toBeNull();
  });

  it("records last_error when count fails after reconcile", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const reconcile = jest.fn(async () => {});
    const count = jest.fn(async () => {
      throw new Error("count boom");
    });
    const intervals = { running_ms: 10, idle_ms: 20, empty_ms: 30 };

    await expect(
      runReconcileOnce(provider, {
        now: () => now,
        intervals,
        reconcile,
        count,
      }),
    ).rejects.toThrow("count boom");

    const { rows } = await getPool().query(
      `SELECT last_error, last_run_at, next_run_at FROM cloud_reconcile_state WHERE provider=$1`,
      [provider],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].last_error).toContain("count boom");
    expect(new Date(rows[0].last_run_at).getTime()).toBe(now.getTime());
    expect(new Date(rows[0].next_run_at).getTime()).toBe(
      now.getTime() + intervals.idle_ms,
    );
  });
});

describe("cloud runtime endpoint reconciliation", () => {
  it("keeps a GCP SSH endpoint aligned with the observed public IP", () => {
    expect(
      runtimeSshServerForProviderReconcile(
        { metadata: { machine: { cloud: "gcp" } } },
        { public_ip: "34.106.236.181" },
      ),
    ).toBe("34.106.236.181:2222");
  });

  it("does not invent endpoints for missing IPs or other providers", () => {
    expect(
      runtimeSshServerForProviderReconcile(
        { metadata: { machine: { cloud: "gcp" } } },
        { public_ip: undefined },
      ),
    ).toBeUndefined();
    expect(
      runtimeSshServerForProviderReconcile(
        { metadata: { machine: { cloud: "nebius" } } },
        { public_ip: "203.0.113.10" },
      ),
    ).toBeUndefined();
  });
});

describe("cloud provider snapshot concurrency", () => {
  const hostId = "ed8f9cb0-80d6-4fd2-9dd8-ad5ef2c8eca4";

  beforeEach(async () => {
    await getPool().query("DELETE FROM project_hosts WHERE id=$1", [hostId]);
  });

  afterEach(async () => {
    await getPool().query("DELETE FROM project_hosts WHERE id=$1", [hostId]);
  });

  it("does not resurrect a stale runtime after delete or reprovision", async () => {
    await getPool().query(
      `INSERT INTO project_hosts (id, name, status, metadata, created, updated)
       VALUES ($1, 'Concurrency guard', 'deprovisioned', $2, NOW(), NOW())`,
      [
        hostId,
        {
          machine: { cloud: "nebius" },
          desired_state: "stopped",
        },
      ],
    );

    await expect(
      updateHostFromProviderSnapshot(
        {
          id: hostId,
          status: "running",
          metadata: {
            machine: { cloud: "nebius" },
            runtime: { instance_id: "stale-instance" },
          },
        },
        {
          status: "error",
          runtime: {
            instance_id: "stale-instance",
            provider_status: "missing",
          },
        },
      ),
    ).resolves.toBe(false);

    const { rows } = await getPool().query(
      "SELECT status, metadata->'runtime' AS runtime FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(rows).toEqual([{ status: "deprovisioned", runtime: null }]);
  });

  it("records no availability from a snapshot write that rolls back", async () => {
    const id = "6f3c2b1a-0d9e-4c8b-a7f6-5e4d3c2b1a09";
    await getPool().query(
      `INSERT INTO project_hosts (id, name, status, metadata, created, updated)
       VALUES ($1, 'Rolled back restore', 'off', $2, NOW(), NOW())`,
      [id, { machine: { cloud: "gcp" }, runtime: { instance_id: "i-1" } }],
    );
    const before = await getPool().query(
      "SELECT count(*)::int AS n FROM project_host_availability_events WHERE host_id=$1",
      [id],
    );
    // A Spot restore writes inside its recovery transaction, which then fails.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await updateHostFromProviderSnapshot(
        {
          id,
          status: "off",
          metadata: {
            machine: { cloud: "gcp" },
            runtime: { instance_id: "i-1" },
          },
        },
        { status: "starting" },
        { db: client },
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const after = await getPool().query(
      "SELECT count(*)::int AS n FROM project_host_availability_events WHERE host_id=$1",
      [id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows } = await getPool().query(
      "SELECT status FROM project_hosts WHERE id=$1",
      [id],
    );
    expect(rows[0].status).toBe("off");
  });
});

describe("stale spot recovery reconciliation", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  const row = {
    id: "host-1",
    status: "running",
    last_seen: "2026-08-12T11:59:30.000Z",
    metadata: {
      pricing_model: "spot",
      effective_pricing_model: "spot",
      desired_pricing_model: "spot",
      interruption_restore_policy: "immediate",
      spot_recovery_state: {
        phase: "retrying_spot",
        outage_started_at: "2026-08-12T10:00:00.000Z",
        last_preempted_at: "2026-08-12T10:00:00.000Z",
      },
    },
  };

  it("closes an old active phase when provider and heartbeat prove recovery", () => {
    expect(
      closeStaleObservedSpotRecovery({
        row,
        provider_status: "running",
        now,
      }),
    ).toMatchObject({
      phase: "idle",
      outage_started_at: "2026-08-12T10:00:00.000Z",
      last_recovered_at: now.toISOString(),
    });
  });

  it("does not close recent or unconfirmed recovery", () => {
    expect(
      closeStaleObservedSpotRecovery({
        row: {
          ...row,
          metadata: {
            ...row.metadata,
            spot_recovery_state: {
              phase: "retrying_spot",
              outage_started_at: "2026-08-12T11:55:00.000Z",
            },
          },
        },
        provider_status: "running",
        now,
      }),
    ).toBeUndefined();
    expect(
      closeStaleObservedSpotRecovery({
        row: { ...row, last_seen: "2026-08-12T11:00:00.000Z" },
        provider_status: "running",
        now,
      }),
    ).toBeUndefined();
  });
});

describe("restore-blocking cloud work", () => {
  it("does not let auxiliary work block spot restore", async () => {
    const hostId = "7f79055e-bd4d-4c6e-af83-93cfd8d97d3c";
    await getPool().query(
      `
        INSERT INTO cloud_vm_work (id, vm_id, action, payload, state, locked_at, created_at, updated_at)
        VALUES
          ('b0e08d76-f315-4d80-a154-f3e8b86e74bf', $1, 'prepull_rootfs', '{}', 'in_progress', NOW(), NOW(), NOW()),
          ('d258a2d5-f630-47d8-b211-2615bad7b3a7', $1, 'verify_host_ready', '{}', 'queued', NULL, NOW(), NOW()),
          ('f0b1a011-205d-469d-89ec-c69c20ebf3e3', $1, 'refresh_runtime', '{}', 'queued', NULL, NOW(), NOW())
      `,
      [hostId],
    );

    await expect(hasPendingRestoreBlockingWork(hostId)).resolves.toBe(false);
  });

  it("blocks restore while provider lifecycle work is pending", async () => {
    const hostId = "82efad1f-9dca-4ca7-b431-f28a3f0f8f7b";
    await getPool().query(
      `
        INSERT INTO cloud_vm_work (id, vm_id, action, payload, state, created_at, updated_at)
        VALUES ('b0a6f3ff-bf15-4396-8068-9216b3fedca5', $1, 'start', '{}', 'queued', NOW(), NOW())
      `,
      [hostId],
    );

    await expect(hasPendingRestoreBlockingWork(hostId)).resolves.toBe(true);
  });
});

describe("host readiness verification recovery", () => {
  const hostId = "d89ad12b-85ac-45c6-a87f-e9bad590370c";
  const startedAt = "2026-07-26T18:15:15.484Z";
  const deadlineAt = "2026-07-26T18:25:15.484Z";
  const row = {
    id: hostId,
    status: "running",
    metadata: {
      spot_recovery_state: {
        phase: "retrying_spot",
        verification_started_at: startedAt,
        verification_deadline_at: deadlineAt,
      },
    },
  };

  it("restores missing verification work for a running provider VM", async () => {
    await expect(
      ensureHostReadyVerificationWork({
        provider: "gcp",
        row,
        provider_status: "running",
      }),
    ).resolves.toBe(true);

    const { rows } = await getPool().query(
      `
        SELECT action, state, payload
        FROM cloud_vm_work
        WHERE vm_id=$1
      `,
      [hostId],
    );
    expect(rows).toEqual([
      {
        action: "verify_host_ready",
        state: "queued",
        payload: {
          provider: "gcp",
          started_at: startedAt,
          deadline_at: deadlineAt,
        },
      },
    ]);
  });

  it("does not duplicate pending verification work", async () => {
    const opts = {
      provider: "gcp" as const,
      row,
      provider_status: "running",
    };
    await expect(ensureHostReadyVerificationWork(opts)).resolves.toBe(true);
    await expect(ensureHostReadyVerificationWork(opts)).resolves.toBe(false);

    const { rows } = await getPool().query(
      "SELECT id FROM cloud_vm_work WHERE vm_id=$1",
      [hostId],
    );
    expect(rows).toHaveLength(1);
  });

  it("ignores inactive recovery state and non-running provider VMs", async () => {
    await expect(
      ensureHostReadyVerificationWork({
        provider: "gcp",
        row: {
          ...row,
          metadata: {
            spot_recovery_state: {
              ...row.metadata.spot_recovery_state,
              phase: "idle",
            },
          },
        },
        provider_status: "running",
      }),
    ).resolves.toBe(false);
    await expect(
      ensureHostReadyVerificationWork({
        provider: "gcp",
        row,
        provider_status: "off",
      }),
    ).resolves.toBe(false);

    const { rows } = await getPool().query(
      "SELECT id FROM cloud_vm_work WHERE vm_id=$1",
      [hostId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("cloud orphan classification", () => {
  it("reports provider instances without an active host owner", () => {
    const result = classifyCloudOrphanInstances({
      provider: "gcp",
      instances: [
        { instance_id: "vm-active", name: "active" },
        { instance_id: "vm-deleted", name: "deleted" },
        { instance_id: "vm-deprovisioned", name: "deprovisioned" },
        { instance_id: "vm-untracked", name: "untracked" },
      ],
      hosts: [
        {
          id: "host-active",
          name: "active-host",
          status: "running",
          deleted: null,
          metadata: { runtime: { instance_id: "vm-active" } },
        },
        {
          id: "host-deleted",
          name: "deleted-host",
          status: "deprovisioning",
          deleted: "2026-05-12T12:00:00Z",
          metadata: { runtime: { instance_id: "vm-deleted" } },
        },
        {
          id: "host-deprovisioned",
          name: "deprovisioned-host",
          status: "deprovisioned",
          deleted: null,
          metadata: { runtime: { instance_id: "vm-deprovisioned" } },
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        category: "deleted-host",
        instance_id: "vm-deleted",
        matched_host_id: "host-deleted",
      }),
      expect.objectContaining({
        category: "deprovisioned-host",
        instance_id: "vm-deprovisioned",
        matched_host_id: "host-deprovisioned",
      }),
      expect.objectContaining({
        category: "untracked",
        instance_id: "vm-untracked",
        matched_host_id: undefined,
      }),
    ]);
  });
});
