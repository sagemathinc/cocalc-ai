import { randomUUID } from "node:crypto";
import { after, before, getPool } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getComputeVmById } from "./db";
import { ensureComputeScheduledStopSchema } from "./schema";
import {
  createStopSchedule,
  startStopSchedule,
  requestScheduledVmState,
  enqueueScheduledComputeStops,
  scheduledStopLockKey,
} from "./scheduled-stop";
import type { ComputeVmRow } from "./types";
import type { ComputeWorkRow } from "./types";
import { handleComputeWork } from "./worker";
import { stopProviderComputeVm, deleteProviderComputeVm } from "./provider";

jest.mock("./provider", () => ({
  ...jest.requireActual("./provider"),
  inspectProviderComputeVm: jest.fn(async () => ({
    status: "running",
    instance: { public_ip: "192.0.2.1" },
  })),
  stopProviderComputeVm: jest.fn(async () => {}),
  deleteProviderComputeVm: jest.fn(async () => {}),
  detachNebiusComputeVmForIntentionalStop: jest.fn(async () => {}),
  releaseProviderComputePublicAddress: jest.fn(async () => {}),
}));
jest.mock("@cocalc/server/cloud/dns", () => ({
  ...jest.requireActual("@cocalc/server/cloud/dns"),
  deleteHostDns: jest.fn(async () => {}),
}));
jest.mock("@cocalc/server/project-host/spend", () => ({
  ...jest.requireActual("@cocalc/server/project-host/spend"),
  reconcileDedicatedHostPurchaseSessionForAccount: jest.fn(async () => {}),
}));

describe("scheduled stop policy", () => {
  const now = 1_000_000;
  it("defaults new VMs to six hours and preserves an explicit opt-out", () => {
    expect(createStopSchedule(undefined, false, now)).toEqual({
      stop_after_minutes: 360,
      stop_at: new Date(now + 360 * 60000),
      stop_generation: 1,
    });
    expect(createStopSchedule(null, false, now).stop_at).toBeNull();
  });
  it.each([0, -1, 0.5, NaN, Infinity, 525601, "60"])(
    "rejects invalid duration %s",
    (value) => {
      expect(() => createStopSchedule(value as number)).toThrow(
        "stop_after_minutes",
      );
    },
  );
  it("does not authorize an agent to create an untimed or longer VM", () => {
    expect(() => createStopSchedule(null, true)).toThrow("owner approval");
    expect(() => createStopSchedule(361, true)).toThrow("owner approval");
    expect(createStopSchedule(60, true).stop_after_minutes).toBe(60);
  });
  it("reuses the saved choice on owner restart, but never refreshes a running timer implicitly", () => {
    const vm = {
      ...createStopSchedule(60, false, now),
      desired_state: "stopped",
    } as ComputeVmRow;
    expect(startStopSchedule(vm, undefined, false, now + 1000).stop_at).toEqual(
      new Date(now + 1000 + 60 * 60000),
    );
    vm.desired_state = "running";
    expect(startStopSchedule(vm, undefined, false, now + 1000).stop_at).toEqual(
      vm.stop_at,
    );
  });
  it("preserves legacy no-timer starts and an agent's existing deadline", () => {
    expect(
      startStopSchedule(
        { desired_state: "stopped" } as ComputeVmRow,
        undefined,
        false,
        now,
      ).stop_at,
    ).toBeNull();
    const vm = {
      ...createStopSchedule(60, false, now),
      desired_state: "stopped",
    } as ComputeVmRow;
    expect(startStopSchedule(vm, undefined, true, now + 1000).stop_at).toEqual(
      vm.stop_at,
    );
    expect(() => startStopSchedule(vm, 60, true, now + 1000)).toThrow(
      "owner approval",
    );
    expect(() => startStopSchedule(vm, null, true, now + 1000)).toThrow(
      "owner approval",
    );
    expect(() =>
      startStopSchedule(vm, undefined, true, now + 60 * 60000),
    ).toThrow("owner approval");
    expect(startStopSchedule(vm, 1, true, now + 1000).stop_after_minutes).toBe(
      1,
    );
  });
});

describe("durable scheduled stops", () => {
  const postgresIt = process.env.COCALC_TEST_USE_PGLITE ? it.skip : it;
  beforeAll(async () => {
    await before({ noConat: true });
    await ensureComputeScheduledStopSchema();
  }, 30000);
  afterAll(after);
  beforeEach(async () => {
    jest.clearAllMocks();
    await getPool().query("DELETE FROM compute_resource_work");
    await getPool().query("DELETE FROM compute_resource_events");
    await getPool().query("DELETE FROM compute_vms");
  });
  async function vm(
    bay = getConfiguredBayId(),
    deadline: Date | null = new Date(Date.now() - 60000),
  ) {
    const { rows } = await getPool().query<ComputeVmRow>(
      `INSERT INTO compute_vms (id,owner_account_id,owning_bay_id,name,public_hostname,bootstrap_revision,funding_mode,state,desired_state,stop_at,stop_after_minutes,stop_generation,boot_disk_id)
       VALUES ($1::uuid,$2,$3,'timer-test',$1::uuid::text || '.example',2,'account-prepaid','ready','running',$4,360,1,'retained-disk') RETURNING *`,
      [randomUUID(), randomUUID(), bay, deadline],
    );
    return rows[0];
  }
  it("atomically queues a stop, not deletion, and is retry-safe and bay-local", async () => {
    const due = await vm();
    const remote = await vm("other-bay");
    const legacy = await vm(getConfiguredBayId(), null);
    expect(await enqueueScheduledComputeStops()).toBe(1);
    expect(await enqueueScheduledComputeStops()).toBe(0);
    expect(await getComputeVmById(due.id)).toMatchObject({
      desired_state: "stopped",
      state: "stopping",
      boot_disk_id: "retained-disk",
      deleted_at: null,
    });
    expect((await getComputeVmById(remote.id))!.desired_state).toBe("running");
    expect((await getComputeVmById(legacy.id))!.desired_state).toBe("running");
    expect(
      (await getPool().query("SELECT action FROM compute_resource_work")).rows,
    ).toEqual([{ action: "reconcile" }]);
  });
  it("owner restart establishes a new generation and repeated request cannot slide it", async () => {
    const due = await vm();
    await enqueueScheduledComputeStops();
    const stopped = (await getComputeVmById(due.id))!;
    const opts = {
      vm: stopped,
      desired_state: "running" as const,
      actor_kind: "human",
      idempotency_key: randomUUID(),
    };
    const started = await requestScheduledVmState(opts);
    expect(started.stop_generation).toBe(2);
    expect(started.stop_at!.valueOf()).toBeGreaterThan(Date.now());
    expect((await requestScheduledVmState(opts)).stop_at).toEqual(
      started.stop_at,
    );
    expect(await enqueueScheduledComputeStops()).toBe(0);
    expect(
      (
        await getPool().query("SELECT action FROM compute_resource_work")
      ).rows.every(({ action }) => action === "reconcile"),
    ).toBe(true);
  });
  it("rejects an expired agent restart without changing durable state", async () => {
    const due = await vm();
    await enqueueScheduledComputeStops();
    const stopped = (await getComputeVmById(due.id))!;
    await expect(
      requestScheduledVmState({
        vm: stopped,
        desired_state: "running",
        actor_kind: "agent",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow("owner approval");
    expect((await getComputeVmById(due.id))!.desired_state).toBe("stopped");
  });
  it("retains deadline on an early stop and persists explicit disable across owner restart", async () => {
    const running = await vm(
      getConfiguredBayId(),
      new Date(Date.now() + 3600000),
    );
    const stopped = await requestScheduledVmState({
      vm: running,
      desired_state: "stopped",
      actor_kind: "human",
      idempotency_key: randomUUID(),
    });
    expect(stopped.stop_at).toEqual(running.stop_at);
    const started = await requestScheduledVmState({
      vm: stopped,
      desired_state: "running",
      stop_after_minutes: null,
      actor_kind: "human",
      idempotency_key: randomUUID(),
    });
    expect(started.stop_at).toBeNull();
    expect(started.stop_after_minutes).toBeNull();
  });
  it("fences authorization against concurrent schedule changes", async () => {
    const running = await vm();
    await requestScheduledVmState({
      vm: running,
      desired_state: "running",
      stop_after_minutes: 30,
      actor_kind: "human",
      idempotency_key: randomUUID(),
    });
    await expect(
      requestScheduledVmState({
        vm: running,
        desired_state: "running",
        stop_after_minutes: 60,
        actor_kind: "human",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow("changed");
  });
  it("enforces a deadline in the real work handler by stopping, never deleting disks", async () => {
    const due = await vm();
    await getPool().query("UPDATE compute_vms SET metadata=$2 WHERE id=$1", [
      due.id,
      {
        billing: {
          stopped_rate: { hourly_cost_usd: "0.01", pricing_snapshot: {} },
        },
      },
    ]);
    await handleComputeWork({
      resource_kind: "vm",
      resource_id: due.id,
      action: "start",
    } as ComputeWorkRow);
    expect(stopProviderComputeVm).toHaveBeenCalledTimes(1);
    expect(deleteProviderComputeVm).not.toHaveBeenCalled();
    expect(await getComputeVmById(due.id)).toMatchObject({
      desired_state: "stopped",
      state: "stopped",
      boot_disk_id: "retained-disk",
      deleted_at: null,
    });
  });
  it("does not execute an old queued scheduled stop after owner renewal", async () => {
    const due = await vm();
    await enqueueScheduledComputeStops();
    const stopped = (await getComputeVmById(due.id))!;
    await requestScheduledVmState({
      vm: stopped,
      desired_state: "running",
      actor_kind: "human",
      idempotency_key: randomUUID(),
    });
    // An already-ready provider makes reconciliation a no-op, as in normal use.
    await getPool().query(
      "UPDATE compute_vms SET state='ready', ready_at=NOW(), public_ip='192.0.2.1', dns_state='ready', metadata=$2 WHERE id=$1",
      [due.id, { runtime: { public_ip: "192.0.2.1" } }],
    );
    const work = (
      await getPool().query<ComputeWorkRow>(
        "SELECT * FROM compute_resource_work WHERE resource_id=$1 ORDER BY queue_order",
        [due.id],
      )
    ).rows[0];
    await handleComputeWork(work);
    expect(stopProviderComputeVm).not.toHaveBeenCalled();
    expect(deleteProviderComputeVm).not.toHaveBeenCalled();
  });
  it("keeps a failed provider stop durable and retries without deletion", async () => {
    const due = await vm();
    await getPool().query("UPDATE compute_vms SET metadata=$2 WHERE id=$1", [
      due.id,
      {
        billing: {
          stopped_rate: { hourly_cost_usd: "0.01", pricing_snapshot: {} },
        },
      },
    ]);
    (stopProviderComputeVm as jest.Mock).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    const work = {
      resource_kind: "vm",
      resource_id: due.id,
      action: "reconcile",
    } as ComputeWorkRow;
    await expect(handleComputeWork(work)).rejects.toThrow(
      "provider unavailable",
    );
    expect((await getComputeVmById(due.id))!.desired_state).toBe("stopped");
    await handleComputeWork(work);
    expect((await getComputeVmById(due.id))!.state).toBe("stopped");
    expect(deleteProviderComputeVm).not.toHaveBeenCalled();
  });
  postgresIt(
    "serializes duplicate starts without sliding the deadline or duplicating work",
    async () => {
      const due = await vm();
      await enqueueScheduledComputeStops();
      const stopped = (await getComputeVmById(due.id))!;
      const opts = {
        vm: stopped,
        desired_state: "running" as const,
        actor_kind: "human",
        idempotency_key: randomUUID(),
      };
      const [a, b] = await Promise.all([
        requestScheduledVmState(opts),
        requestScheduledVmState(opts),
      ]);
      expect(a.stop_at).toEqual(b.stop_at);
      expect(a.stop_generation).toBe(2);
      expect(
        (
          await getPool().query(
            "SELECT * FROM compute_resource_events WHERE idempotency_key=$1",
            [opts.idempotency_key],
          )
        ).rows,
      ).toHaveLength(1);
    },
  );
  postgresIt(
    "waits for an in-flight scheduled provider stop before approving a later generation",
    async () => {
      const due = await vm();
      await enqueueScheduledComputeStops();
      const stopped = (await getComputeVmById(due.id))!;
      const client = await getPool().connect();
      const key = scheduledStopLockKey(due.id);
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      let finished = false;
      const start = requestScheduledVmState({
        vm: stopped,
        desired_state: "running",
        actor_kind: "human",
        idempotency_key: randomUUID(),
      }).then((result) => {
        finished = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(finished).toBe(false);
        expect(
          (
            await client.query(
              "SELECT stop_generation FROM compute_vms WHERE id=$1",
              [due.id],
            )
          ).rows[0].stop_generation,
        ).toBe(1);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
        client.release();
      }
      expect((await start).stop_generation).toBe(2);
    },
  );
});
