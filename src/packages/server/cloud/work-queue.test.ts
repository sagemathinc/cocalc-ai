import {
  enqueueCloudVmWork,
  claimCloudVmWork,
  markCloudVmWorkDone,
  markCloudVmWorkFailed,
  refreshCloudVmWorkLease,
  requeueStaleCloudVmWork,
} from "@cocalc/server/cloud";
import { before, after, getPool } from "@cocalc/server/test";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM cloud_vm_work");
});

describe("cloud vm work queue", () => {
  it("enqueues and claims work with SKIP LOCKED semantics", async () => {
    const id1 = await enqueueCloudVmWork({
      vm_id: "vm-1",
      action: "start",
      payload: { foo: 1 },
    });
    const id2 = await enqueueCloudVmWork({
      vm_id: "vm-2",
      action: "stop",
      payload: { foo: 2 },
    });

    const batch1 = await claimCloudVmWork({
      worker_id: "worker-a",
      limit: 1,
    });
    expect(batch1).toHaveLength(1);
    expect(batch1[0].id).toBe(id1);

    const batch2 = await claimCloudVmWork({
      worker_id: "worker-b",
      limit: 1,
    });
    expect(batch2).toHaveLength(1);
    expect(batch2[0].id).toBe(id2);

    const { rows } = await getPool().query(
      "SELECT id, state, locked_by FROM cloud_vm_work ORDER BY created_at",
    );
    expect(rows).toEqual([
      { id: id1, state: "in_progress", locked_by: "worker-a" },
      { id: id2, state: "in_progress", locked_by: "worker-b" },
    ]);
  });

  it("marks work done and failed", async () => {
    const id1 = await enqueueCloudVmWork({
      vm_id: "vm-1",
      action: "create",
    });
    const id2 = await enqueueCloudVmWork({
      vm_id: "vm-2",
      action: "delete",
    });

    await claimCloudVmWork({ worker_id: "worker-a", limit: 2 });
    await markCloudVmWorkDone(id1);
    await markCloudVmWorkFailed(id2, "boom");

    const { rows } = await getPool().query(
      "SELECT id, state, error FROM cloud_vm_work ORDER BY created_at",
    );
    expect(rows).toEqual([
      { id: id1, state: "done", error: null },
      { id: id2, state: "failed", error: "boom" },
    ]);
  });

  it("does not claim work before not_before", async () => {
    const future = new Date(Date.now() + 60_000);
    await enqueueCloudVmWork({
      vm_id: "vm-future",
      action: "start",
      not_before: future,
    });
    await enqueueCloudVmWork({
      vm_id: "vm-now",
      action: "start",
    });

    const batch = await claimCloudVmWork({
      worker_id: "worker-a",
      limit: 5,
    });

    expect(batch).toHaveLength(1);
    expect(batch[0].vm_id).toBe("vm-now");
    const { rows } = await getPool().query(
      "SELECT vm_id, state FROM cloud_vm_work ORDER BY vm_id",
    );
    expect(rows).toEqual([
      { vm_id: "vm-future", state: "queued" },
      { vm_id: "vm-now", state: "in_progress" },
    ]);
  });

  it("requeues stale in-progress work", async () => {
    const id = await enqueueCloudVmWork({
      vm_id: "vm-stale",
      action: "probe_spot",
    });
    await claimCloudVmWork({ worker_id: "worker-a", limit: 1 });
    await getPool().query(
      `
        UPDATE cloud_vm_work
        SET locked_at=NOW() - interval '2 hours'
        WHERE id=$1
      `,
      [id],
    );

    const requeued = await requeueStaleCloudVmWork({
      older_than_ms: 60 * 60 * 1000,
    });

    expect(requeued).toBe(1);
    const { rows } = await getPool().query(
      "SELECT state, locked_by, locked_at, attempt, error FROM cloud_vm_work WHERE id=$1",
      [id],
    );
    expect(rows[0]).toEqual({
      state: "queued",
      locked_by: null,
      locked_at: null,
      attempt: 1,
      error: "requeued stale in-progress cloud work",
    });

    const batch = await claimCloudVmWork({
      worker_id: "worker-b",
      limit: 1,
    });
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe(id);
  });

  it("uses action-specific stale thresholds by default", async () => {
    const previousEnv = process.env.COCALC_CLOUD_VM_WORK_STALE_IN_PROGRESS_MS;
    delete process.env.COCALC_CLOUD_VM_WORK_STALE_IN_PROGRESS_MS;
    try {
      const startId = await enqueueCloudVmWork({
        vm_id: "vm-start",
        action: "start",
      });
      const probeId = await enqueueCloudVmWork({
        vm_id: "vm-probe",
        action: "probe_spot",
      });
      const provisionId = await enqueueCloudVmWork({
        vm_id: "vm-provision",
        action: "provision",
      });
      await claimCloudVmWork({ worker_id: "worker-a", limit: 3 });
      await getPool().query(
        `
          UPDATE cloud_vm_work
          SET locked_at = CASE
            WHEN id=$1 THEN NOW() - interval '4 minutes'
            WHEN id=$2 THEN NOW() - interval '4 minutes'
            WHEN id=$3 THEN NOW() - interval '20 minutes'
            ELSE locked_at
          END
          WHERE id IN ($1,$2,$3)
        `,
        [startId, probeId, provisionId],
      );

      const requeued = await requeueStaleCloudVmWork();

      expect(requeued).toBe(1);
      const { rows } = await getPool().query(
        "SELECT id, state FROM cloud_vm_work WHERE id=ANY($1) ORDER BY id",
        [[startId, probeId, provisionId]],
      );
      expect(
        Object.fromEntries(rows.map((row) => [row.id, row.state])),
      ).toEqual({
        [startId]: "queued",
        [probeId]: "in_progress",
        [provisionId]: "in_progress",
      });
    } finally {
      if (previousEnv === undefined) {
        delete process.env.COCALC_CLOUD_VM_WORK_STALE_IN_PROGRESS_MS;
      } else {
        process.env.COCALC_CLOUD_VM_WORK_STALE_IN_PROGRESS_MS = previousEnv;
      }
    }
  });

  it("refreshes an in-progress work lease for the owning worker", async () => {
    const id = await enqueueCloudVmWork({
      vm_id: "vm-refresh-lease",
      action: "start",
    });
    await claimCloudVmWork({ worker_id: "worker-a", limit: 1 });
    await getPool().query(
      `
        UPDATE cloud_vm_work
        SET locked_at=NOW() - interval '2 minutes'
        WHERE id=$1
      `,
      [id],
    );

    await expect(
      refreshCloudVmWorkLease({ id, worker_id: "worker-b" }),
    ).resolves.toBe(false);
    await expect(
      refreshCloudVmWorkLease({ id, worker_id: "worker-a" }),
    ).resolves.toBe(true);

    const { rows } = await getPool().query(
      `
        SELECT locked_by, locked_at > NOW() - interval '10 seconds' AS fresh
        FROM cloud_vm_work
        WHERE id=$1
      `,
      [id],
    );
    expect(rows[0]).toEqual({
      locked_by: "worker-a",
      fresh: true,
    });
  });
});
