import {
  enqueueCloudVmWork,
  processCloudVmWorkOnce,
} from "@cocalc/server/cloud";
import { before, after, getPool } from "@cocalc/server/test";
import { delay } from "awaiting";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM cloud_vm_work");
});

describe("cloud vm worker loop", () => {
  it("processes queued items with handlers", async () => {
    const handled: string[] = [];
    await enqueueCloudVmWork({ vm_id: "vm-1", action: "start" });
    await enqueueCloudVmWork({ vm_id: "vm-2", action: "stop" });

    const handlers = {
      start: async (row) => {
        handled.push(`start:${row.vm_id}`);
      },
      stop: async (row) => {
        handled.push(`stop:${row.vm_id}`);
      },
    };

    const count = await processCloudVmWorkOnce({
      worker_id: "worker-test",
      handlers,
    });

    expect(count).toBe(2);
    expect(handled.sort()).toEqual(["start:vm-1", "stop:vm-2"]);
    const { rows } = await getPool().query(
      "SELECT state FROM cloud_vm_work ORDER BY vm_id",
    );
    expect(rows.map((r) => r.state)).toEqual(["done", "done"]);
  });

  it("marks missing handlers as failed", async () => {
    await enqueueCloudVmWork({ vm_id: "vm-1", action: "resize" });
    await processCloudVmWorkOnce({
      worker_id: "worker-test",
      handlers: {},
    });
    const { rows } = await getPool().query(
      "SELECT state, error FROM cloud_vm_work",
    );
    expect(rows[0].state).toBe("failed");
    expect(rows[0].error).toContain("no handler for resize");
  });

  it("retries stale in-progress items before claiming new work", async () => {
    const id = await enqueueCloudVmWork({
      vm_id: "vm-stale",
      action: "probe_spot",
    });
    await getPool().query(
      `
        UPDATE cloud_vm_work
        SET state='in_progress',
            locked_by='dead-worker',
            locked_at=NOW() - interval '2 hours'
        WHERE id=$1
      `,
      [id],
    );

    const handled: string[] = [];
    const processed = await processCloudVmWorkOnce({
      worker_id: "worker-retry",
      stale_in_progress_ms: 60 * 60 * 1000,
      handlers: {
        probe_spot: async (row) => {
          handled.push(row.id);
        },
      },
    });

    expect(processed).toBe(1);
    expect(handled).toEqual([id]);
    const { rows } = await getPool().query(
      "SELECT state, locked_by, locked_at FROM cloud_vm_work WHERE id=$1",
      [id],
    );
    expect(rows[0]).toEqual({
      state: "done",
      locked_by: null,
      locked_at: null,
    });
  });

  it("enforces global and per-provider concurrency caps", async () => {
    const total = 12;
    for (let i = 0; i < total; i++) {
      await enqueueCloudVmWork({
        vm_id: `vm-${i}`,
        action: "start",
        payload: { provider: i % 2 === 0 ? "gcp" : "hyperstack" },
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const perProvider = new Map<string, number>();
    let maxPerProvider = 0;

    const handlers = {
      start: async (row) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const provider = (row.payload?.provider as string) ?? "default";
        perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
        maxPerProvider = Math.max(
          maxPerProvider,
          perProvider.get(provider) ?? 0,
        );
        await delay(50);
        perProvider.set(provider, (perProvider.get(provider) ?? 1) - 1);
        inFlight -= 1;
      },
    };

    const processed = await processCloudVmWorkOnce({
      worker_id: "worker-cap",
      handlers,
      max_concurrency: 4,
      max_per_provider: 2,
    });

    expect(processed).toBe(total);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxPerProvider).toBeLessThanOrEqual(2);

    const { rows } = await getPool().query("SELECT state FROM cloud_vm_work");
    expect(rows.every((r) => r.state === "done")).toBe(true);
  });

  it("supports provider-specific cap overrides", async () => {
    for (let i = 0; i < 6; i++) {
      await enqueueCloudVmWork({
        vm_id: `vm-${i}`,
        action: "start",
        payload: { provider: i < 3 ? "gcp" : "hyperstack" },
      });
    }

    const perProvider = new Map<string, number>();
    let maxGcp = 0;
    let maxHyperstack = 0;

    const handlers = {
      start: async (row) => {
        const provider = (row.payload?.provider as string) ?? "default";
        perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
        maxGcp = Math.max(maxGcp, perProvider.get("gcp") ?? 0);
        maxHyperstack = Math.max(
          maxHyperstack,
          perProvider.get("hyperstack") ?? 0,
        );
        await delay(50);
        perProvider.set(provider, (perProvider.get(provider) ?? 1) - 1);
      },
    };

    const processed = await processCloudVmWorkOnce({
      worker_id: "worker-provider-caps",
      handlers,
      max_concurrency: 3,
      max_per_provider: 3,
      max_per_provider_by_provider: new Map([
        ["gcp", 1],
        ["hyperstack", 2],
      ]),
    });

    expect(processed).toBe(6);
    expect(maxGcp).toBeLessThanOrEqual(1);
    expect(maxHyperstack).toBeLessThanOrEqual(2);
  });
});
