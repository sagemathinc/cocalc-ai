import {
  classifyCloudOrphanInstances,
  hasPendingRestoreBlockingWork,
  runReconcileOnce,
} from "@cocalc/server/cloud";
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
