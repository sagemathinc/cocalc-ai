import {
  enqueueCloudVmWork,
  claimCloudVmWork,
  markCloudVmWorkDone,
  markCloudVmWorkFailed,
  refreshCloudVmWorkLease,
  requeueStaleCloudVmWork,
} from "@cocalc/server/cloud";
import {
  enqueueCloudVmFollowUpWork,
  enqueueCloudVmWorkOnce,
} from "@cocalc/server/cloud/db";
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

  it("dedups follow-up work atomically under concurrent enqueues", async () => {
    // The handler's own item is in_progress and must not count as a duplicate.
    const running = await enqueueCloudVmWork({
      vm_id: "vm-1",
      action: "start",
    });
    await claimCloudVmWork({ worker_id: "worker-a", limit: 1 });

    const at = (s: number) => new Date(Date.now() + s * 1000);
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        enqueueCloudVmFollowUpWork({
          vm_id: "vm-1",
          action: "start",
          payload: { i },
          not_before: at(60 + i),
        }),
      ),
    );
    expect(ids.filter(Boolean)).toHaveLength(1);

    const later = at(600);
    await expect(
      enqueueCloudVmFollowUpWork({
        vm_id: "vm-1",
        action: "start",
        payload: { last: true },
        not_before: later,
      }),
    ).resolves.toBeUndefined();

    const { rows } = await getPool().query(
      "SELECT id, state, payload, not_before FROM cloud_vm_work ORDER BY created_at",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: running, state: "in_progress" });
    expect(rows[1]).toMatchObject({ state: "queued", payload: { last: true } });
    expect(new Date(rows[1].not_before).getTime()).toBe(later.getTime());
  });

  it("enqueues once against queued or in-progress work, keeping the earliest time", async () => {
    const at = (s: number) => new Date(Date.now() + s * 1000);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueueCloudVmWorkOnce({
          vm_id: "vm-1",
          action: "start",
          not_before: at(300),
        }),
      ),
    );
    expect(ids.filter(Boolean)).toHaveLength(1);

    const earlier = at(30);
    await enqueueCloudVmWorkOnce({
      vm_id: "vm-1",
      action: "start",
      not_before: earlier,
    });
    await enqueueCloudVmWorkOnce({
      vm_id: "vm-1",
      action: "start",
      not_before: at(900),
    });
    let { rows } = await getPool().query(
      "SELECT state, not_before FROM cloud_vm_work",
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].not_before).getTime()).toBe(earlier.getTime());

    await getPool().query(
      "UPDATE cloud_vm_work SET state='in_progress', not_before=NULL",
    );
    await expect(
      enqueueCloudVmWorkOnce({ vm_id: "vm-1", action: "start" }),
    ).resolves.toBeUndefined();
    ({ rows } = await getPool().query("SELECT state FROM cloud_vm_work"));
    expect(rows).toEqual([{ state: "in_progress" }]);
  });
});

describe("per-VM serialization of lifecycle work", () => {
  it("runs one lifecycle item per VM at a time, in order, beside other work", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const start = await enqueueCloudVmWork({ vm_id: "vm-s", action: "start" });
    await tick();
    const verify = await enqueueCloudVmWork({
      vm_id: "vm-s",
      action: "verify_host_ready",
    });
    const prepull = await enqueueCloudVmWork({
      vm_id: "vm-s",
      action: "prepull_rootfs",
    });
    const other = await enqueueCloudVmWork({ vm_id: "vm-t", action: "stop" });

    // One batch never takes two lifecycle items for one VM.
    const first = await claimCloudVmWork({ worker_id: "worker-a", limit: 10 });
    expect(first.map((row) => row.id).sort()).toEqual(
      [start, prepull, other].sort(),
    );

    // While the start runs, the VM's next lifecycle item waits, whichever
    // worker asks.
    expect(
      await claimCloudVmWork({ worker_id: "worker-b", limit: 10 }),
    ).toEqual([]);

    await markCloudVmWorkDone(start);
    const next = await claimCloudVmWork({ worker_id: "worker-b", limit: 10 });
    expect(next.map((row) => row.id)).toEqual([verify]);
  });

  it("drops starts queued before a stop or delete", async () => {
    await enqueueCloudVmWork({ vm_id: "vm-u", action: "start" });
    await enqueueCloudVmWorkOnce({ vm_id: "vm-u", action: "restart" });
    await enqueueCloudVmWork({ vm_id: "vm-u", action: "probe_spot" });
    // A delayed Spot retry for another VM, dropped by its own delete.
    await enqueueCloudVmFollowUpWork({
      vm_id: "vm-v",
      action: "start",
      not_before: new Date(Date.now() + 600_000),
    });
    await enqueueCloudVmWork({ vm_id: "vm-u", action: "stop" });
    await enqueueCloudVmWork({ vm_id: "vm-v", action: "delete" });
    const states = async () =>
      (
        await getPool().query(
          `SELECT vm_id || ':' || action AS item, state, COALESCE(error, '') AS error
             FROM cloud_vm_work ORDER BY created_at`,
        )
      ).rows
        .map((row) => `${row.item} ${row.state} ${row.error}`.trim())
        .sort();
    expect(await states()).toEqual([
      "vm-u:probe_spot queued",
      "vm-u:restart failed superseded by a later stop",
      "vm-u:start failed superseded by a later stop",
      "vm-u:stop queued",
      "vm-v:delete queued",
      "vm-v:start failed superseded by a later delete",
    ]);

    // A start requested after the stop stays; a repeated (deduplicated)
    // stop request still drops it.
    await enqueueCloudVmWork({ vm_id: "vm-u", action: "start" });
    expect(await states()).toContain("vm-u:start queued");
    await enqueueCloudVmWorkOnce({ vm_id: "vm-u", action: "stop" });
    expect(await states()).not.toContain("vm-u:start queued");
  });
});

describe("claim fairness and intent-aware supersession", () => {
  it("does not let one VM's lifecycle backlog crowd out other VMs", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    for (let i = 0; i < 12; i++) {
      await enqueueCloudVmWork({
        vm_id: "vm-busy",
        action: i % 2 ? "verify_host_ready" : "refresh_runtime",
      });
      await tick();
    }
    await enqueueCloudVmWork({ vm_id: "vm-a", action: "start" });
    await tick();
    await enqueueCloudVmWork({ vm_id: "vm-b", action: "stop" });
    const batch = await claimCloudVmWork({ worker_id: "worker-a", limit: 3 });
    expect(batch.map((row) => row.vm_id).sort()).toEqual([
      "vm-a",
      "vm-b",
      "vm-busy",
    ]);
  });

  it("drops only starts from the stop's own or older intents", async () => {
    await enqueueCloudVmWork({
      vm_id: "vm-g",
      action: "start",
      payload: { intent_generation: 3 },
    });
    await enqueueCloudVmWork({
      vm_id: "vm-g",
      action: "restart",
      payload: { intent_generation: 7 },
    });
    await enqueueCloudVmWork({
      vm_id: "vm-g",
      action: "stop",
      payload: { intent_generation: 5 },
    });
    const { rows } = await getPool().query(
      `SELECT action, state FROM cloud_vm_work WHERE vm_id='vm-g' ORDER BY action`,
    );
    expect(rows).toEqual([
      // Requested after the stop's intent: kept, and wins.
      { action: "restart", state: "queued" },
      { action: "start", state: "failed" },
      { action: "stop", state: "queued" },
    ]);
  });
});

describe("deduplication never loses a newer intent", () => {
  const items = async (vm_id: string) =>
    (
      await getPool().query(
        `SELECT state, payload->>'intent_generation' AS generation,
                not_before IS NOT NULL AS delayed
           FROM cloud_vm_work WHERE vm_id=$1 ORDER BY created_at`,
        [vm_id],
      )
    ).rows;
  const later = () => new Date(Date.now() + 600_000);

  it("a newer start advances an older queued one", async () => {
    await enqueueCloudVmWorkOnce({
      vm_id: "vm-1",
      action: "start",
      payload: { intent_generation: 4 },
      not_before: later(),
    });
    await enqueueCloudVmWorkOnce({
      vm_id: "vm-1",
      action: "start",
      payload: { intent_generation: 5 },
    });
    expect(await items("vm-1")).toEqual([
      { state: "queued", generation: "5", delayed: false },
    ]);
    // An older or unversioned request does not take it back.
    await enqueueCloudVmWorkOnce({
      vm_id: "vm-1",
      action: "start",
      payload: { intent_generation: 4 },
    });
    await enqueueCloudVmWorkOnce({ vm_id: "vm-1", action: "start" });
    expect(await items("vm-1")).toEqual([
      { state: "queued", generation: "5", delayed: false },
    ]);
  });

  it("a newer start queues behind an older or unversioned one already running", async () => {
    for (const running of [{ intent_generation: 4 }, {}]) {
      await getPool().query("DELETE FROM cloud_vm_work");
      await enqueueCloudVmWork({
        vm_id: "vm-2",
        action: "start",
        payload: running,
      });
      await claimCloudVmWork({ worker_id: "w", limit: 1 });
      await enqueueCloudVmWorkOnce({
        vm_id: "vm-2",
        action: "start",
        payload: { intent_generation: 5 },
      });
      expect((await items("vm-2")).map((row) => row.state)).toEqual([
        "in_progress",
        "queued",
      ]);
      // The same or an older intent is still a duplicate.
      await enqueueCloudVmWorkOnce({
        vm_id: "vm-2",
        action: "start",
        payload: running,
      });
      expect(await items("vm-2")).toHaveLength(2);
    }
  });

  it("a versioned start advances an unversioned queued one", async () => {
    await enqueueCloudVmWorkOnce({ vm_id: "vm-3", action: "start" });
    await enqueueCloudVmWorkOnce({
      vm_id: "vm-3",
      action: "start",
      payload: { intent_generation: 2 },
    });
    expect(await items("vm-3")).toEqual([
      { state: "queued", generation: "2", delayed: false },
    ]);
  });

  it("an older start's retry never overwrites a newer queued start", async () => {
    await enqueueCloudVmWork({
      vm_id: "vm-4",
      action: "start",
      payload: { intent_generation: 5 },
    });
    // An older running start schedules its retry; so does legacy code.
    await enqueueCloudVmFollowUpWork({
      vm_id: "vm-4",
      action: "start",
      not_before: later(),
      payload: { intent_generation: 4, source: "fallback_ladder_retry" },
    });
    await enqueueCloudVmFollowUpWork({
      vm_id: "vm-4",
      action: "start",
      not_before: later(),
      payload: { source: "fallback_ladder_retry" },
    });
    expect(await items("vm-4")).toEqual([
      { state: "queued", generation: "5", delayed: false },
    ]);
    // The same intent's own retry still moves it, as before.
    await enqueueCloudVmFollowUpWork({
      vm_id: "vm-4",
      action: "start",
      not_before: later(),
      payload: { intent_generation: 5 },
    });
    expect(await items("vm-4")).toEqual([
      { state: "queued", generation: "5", delayed: true },
    ]);
  });

  it("a versioned retry advances an unversioned queued start", async () => {
    await enqueueCloudVmWork({ vm_id: "vm-5", action: "start" });
    await enqueueCloudVmFollowUpWork({
      vm_id: "vm-5",
      action: "start",
      not_before: later(),
      payload: { intent_generation: 3 },
    });
    expect(await items("vm-5")).toEqual([
      { state: "queued", generation: "3", delayed: true },
    ]);
  });
});
