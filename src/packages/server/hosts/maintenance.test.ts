import { randomUUID } from "node:crypto";
import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { before, after, getPool } from "@cocalc/server/test";
import {
  acquireRelocationLease,
  hostLifecycleFenced,
  hostOfflineFenced,
  normalizeHostMaintenanceNotice,
  quiesceHostActivity,
  releaseRelocationLease,
  setRelocationNotice,
} from "./maintenance";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

async function newHost(metadata: Record<string, any> = {}): Promise<string> {
  const id = randomUUID();
  await upsertProjectHost({
    id,
    name: `relocation-lease-${id.slice(0, 8)}`,
    region: "us-south1",
    status: "running",
    metadata: { owner: "acct-owner", machine: { cloud: "gcp" }, ...metadata },
  });
  return id;
}

async function maintenanceOf(host_id: string) {
  const { rows } = await getPool().query(
    "SELECT metadata->'maintenance' AS m FROM project_hosts WHERE id=$1",
    [host_id],
  );
  return rows[0]?.m;
}

describe("relocation lease", () => {
  it("lets exactly one of many concurrent relocations claim a host", async () => {
    const host_id = await newHost();
    const leases = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.all(
      leases.map((lease_id) => acquireRelocationLease({ host_id, lease_id })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = leases[results.indexOf(true)];
    expect(await maintenanceOf(host_id)).toMatchObject({
      kind: "relocation",
      state: "preparing",
      lease_id: winner,
    });
  });

  it("keeps a scheduled announcement and refuses while fenced", async () => {
    const host_id = await newHost();
    await getPool().query(
      `UPDATE project_hosts SET metadata = jsonb_set(metadata, '{maintenance}', $2::jsonb) WHERE id=$1`,
      [
        host_id,
        JSON.stringify({
          kind: "maintenance",
          state: "scheduled",
          scheduled_for: "2030-01-02T03:00:00.000Z",
          message: "Moving to a faster server.",
        }),
      ],
    );
    const lease_id = randomUUID();
    expect(await acquireRelocationLease({ host_id, lease_id })).toBe(true);
    expect(await maintenanceOf(host_id)).toMatchObject({
      state: "preparing",
      scheduled_for: "2030-01-02T03:00:00.000Z",
      message: "Moving to a faster server.",
    });

    // In the window, and after a failed rollback: still fenced.
    for (const state of ["in_progress", "failed"] as const) {
      await setRelocationNotice({
        host_id,
        lease_id,
        notice: { kind: "relocation", state },
      });
      expect(
        await acquireRelocationLease({ host_id, lease_id: randomUUID() }),
      ).toBe(false);
    }

    await releaseRelocationLease({ host_id, lease_id });
    expect(await maintenanceOf(host_id)).toBeNull();
  });

  it("re-establishes a lease dropped by a stale metadata write, but not one held by another relocation", async () => {
    const host_id = await newHost();
    const lease_id = randomUUID();
    await acquireRelocationLease({ host_id, lease_id });
    // A handler that read the row before the lease writes it back.
    await getPool().query(
      "UPDATE project_hosts SET metadata = metadata - 'maintenance' WHERE id=$1",
      [host_id],
    );
    await setRelocationNotice({
      host_id,
      lease_id,
      notice: { kind: "relocation", state: "in_progress" },
    });
    expect(await maintenanceOf(host_id)).toMatchObject({
      state: "in_progress",
      lease_id,
    });

    const other = await newHost();
    await acquireRelocationLease({ host_id: other, lease_id: randomUUID() });
    await expect(
      setRelocationNotice({
        host_id: other,
        lease_id,
        notice: { kind: "relocation", state: "in_progress" },
      }),
    ).rejects.toThrow(/no longer holds/);
  });

  it("fences lifecycle changes from preparing on, and the host offline from the window on", () => {
    expect(hostLifecycleFenced({ state: "scheduled" })).toBe(false);
    expect(hostLifecycleFenced({ state: "preparing" })).toBe(true);
    expect(hostLifecycleFenced({ state: "failed" })).toBe(true);
    expect(hostOfflineFenced({ state: "preparing" })).toBe(false);
    expect(hostOfflineFenced({ state: "in_progress" })).toBe(true);
    expect(hostOfflineFenced({ state: "failed" })).toBe(true);
    // Users see a preparing relocation as upcoming maintenance.
    expect(
      normalizeHostMaintenanceNotice(
        {
          kind: "relocation",
          state: "preparing",
          lease_id: "secret-ish",
          updated_at: "2030-01-02T03:00:00Z",
        },
        Date.parse("2030-01-02T03:01:00Z"),
      ),
    ).toEqual({
      kind: "relocation",
      state: "scheduled",
      scheduled_for: "2030-01-02T03:00:00.000Z",
      updated_at: "2030-01-02T03:00:00.000Z",
    });
  });
});

describe("quiesceHostActivity", () => {
  it("waits for a project start on the host, and cancels queued cloud work", async () => {
    const host_id = await newHost();
    const project_id = randomUUID();
    await getPool().query(
      "INSERT INTO projects (project_id, host_id) VALUES ($1, $2)",
      [project_id, host_id],
    );
    // A project start admitted just before the fence.
    const start = await createLro({
      kind: "project-start",
      scope_type: "project",
      scope_id: project_id,
      status: "running",
    });
    await getPool().query(
      `INSERT INTO cloud_vm_work (id, vm_id, action, payload, state, created_at, updated_at)
       VALUES ($1, $2, 'start', '{}'::jsonb, 'queued', NOW(), NOW())`,
      [randomUUID(), host_id],
    );
    let settled = false;
    const waits: any[] = [];
    const quiesce = quiesceHostActivity({
      host_id,
      pollMs: 30,
      timeoutMs: 10_000,
      onWait: async (activity) => {
        waits.push(activity);
      },
    }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(waits.at(-1)).toMatchObject({
      project_operations: 1,
      cloud_work: 0,
    });
    await updateLro({ op_id: start.op_id, status: "succeeded" });
    await quiesce;
    expect(settled).toBe(true);
    const { rows } = await getPool().query(
      "SELECT state, error FROM cloud_vm_work WHERE vm_id=$1",
      [host_id],
    );
    expect(rows).toEqual([
      { state: "failed", error: "canceled by a host relocation" },
    ]);
    const host = await getPool().query(
      "SELECT metadata->>'desired_state' AS desired FROM project_hosts WHERE id=$1",
      [host_id],
    );
    expect(host.rows[0].desired).toBe("stopped");
  });

  it("ignores its own operation but waits for other host operations", async () => {
    const host_id = await newHost();
    const own = await createLro({
      kind: "host-relocate",
      scope_type: "host",
      scope_id: host_id,
      status: "running",
    });
    await expect(
      quiesceHostActivity({
        host_id,
        own_op_id: own.op_id,
        pollMs: 10,
        timeoutMs: 2_000,
      }),
    ).resolves.toBeUndefined();

    await createLro({
      kind: "host-upgrade-software",
      scope_type: "host",
      scope_id: host_id,
      status: "running",
    });
    await expect(
      quiesceHostActivity({
        host_id,
        own_op_id: own.op_id,
        pollMs: 10,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/host operations 1/);
  });
});
