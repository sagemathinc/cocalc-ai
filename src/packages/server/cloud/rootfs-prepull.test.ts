import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
import { after, before, getPool } from "@cocalc/server/test";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM cloud_vm_work");
  await getPool().query("DELETE FROM project_hosts");
});

describe("rootfs pre-pull queueing", () => {
  it("queues pre-pull work for running and active hosts", async () => {
    await upsertProjectHost({
      id: "1292ec5b-d4a2-4ab0-a4fd-cff4792007ef",
      name: "running host",
      region: "us-west1",
      status: "running",
      last_seen: new Date() as any,
      metadata: {
        machine: {
          cloud: "gcp",
        },
      },
    });
    await upsertProjectHost({
      id: "e34d31ea-a704-4102-a5c1-fcc29ef4e160",
      name: "active host",
      region: "us-west1",
      status: "active",
      last_seen: new Date() as any,
      metadata: {
        machine: {
          cloud: "nebius",
        },
      },
    });
    await upsertProjectHost({
      id: "6aee0677-e627-4461-b6b4-87965a042638",
      name: "off host",
      region: "us-west1",
      status: "off",
      metadata: {},
    });

    const { enqueueRootfsPrepullForRunningHosts } =
      await import("./rootfs-prepull");
    const result = await enqueueRootfsPrepullForRunningHosts({
      source: "test",
      reason: "catalog-update",
    });

    expect(result).toEqual({ considered: 2, enqueued: 2 });
    const { rows } = await getPool().query(
      `
        SELECT vm_id, action, state, payload
        FROM cloud_vm_work
        ORDER BY vm_id
      `,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.vm_id).sort()).toEqual([
      "1292ec5b-d4a2-4ab0-a4fd-cff4792007ef",
      "e34d31ea-a704-4102-a5c1-fcc29ef4e160",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        action: "prepull_rootfs",
        state: "queued",
      });
      expect(row.payload).toMatchObject({
        source: "test",
        reason: "catalog-update",
      });
    }
  });
});
