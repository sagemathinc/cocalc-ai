import { randomUUID } from "node:crypto";
import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { before, after, getPool } from "@cocalc/server/test";
import {
  acquireRelocationLease,
  assertProjectHostsNotUnderMaintenance,
  hostActivity,
  hostLifecycleFenced,
  hostOfflineFenced,
  normalizeHostMaintenanceNotice,
  quiesceHostActivity,
  releaseRelocationLease,
  setHostMaintenanceMetadata,
  setRelocationNotice,
  withTrackedHostWork,
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
    "SELECT maintenance AS m FROM project_hosts WHERE id=$1",
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
      `UPDATE project_hosts SET maintenance = $2::jsonb WHERE id=$1`,
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

  it("survives stale whole-metadata writes, and ends when an admin clears it", async () => {
    const host_id = await newHost();
    const lease_id = randomUUID();
    await acquireRelocationLease({ host_id, lease_id });
    await setRelocationNotice({
      host_id,
      lease_id,
      notice: { kind: "relocation", state: "in_progress" },
    });
    // A cloud work handler read the row in the window ...
    const {
      rows: [stale],
    } = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1",
      [host_id],
    );
    await setRelocationNotice({ host_id, lease_id, notice: null });
    // ... and writes its whole metadata object back after the window.
    await getPool().query("UPDATE project_hosts SET metadata=$2 WHERE id=$1", [
      host_id,
      stale.metadata,
    ]);
    expect(await maintenanceOf(host_id)).toBeNull();

    const second = randomUUID();
    await acquireRelocationLease({ host_id, lease_id: second });
    expect(
      await setHostMaintenanceMetadata(host_id, null, {
        expected: await maintenanceOf(host_id),
      }),
    ).toBe(true);
    await expect(
      setRelocationNotice({
        host_id,
        lease_id: second,
        notice: { kind: "relocation", state: "in_progress" },
      }),
    ).rejects.toThrow(/no longer holds/);
    expect(await maintenanceOf(host_id)).toBeNull();

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
    // Settling leaves the host's intent alone; relocation decides it from
    // the settled row.
    const host = await getPool().query(
      "SELECT metadata->>'desired_state' AS desired FROM project_hosts WHERE id=$1",
      [host_id],
    );
    expect(host.rows[0].desired).toBeNull();
  });

  it("counts project operations by the hosts they name, not only current placement", async () => {
    const host_id = await newHost();
    const elsewhere = await newHost();
    // A move that already pointed the project at its destination but still
    // cleans up the source.
    const moved = randomUUID();
    await getPool().query(
      "INSERT INTO projects (project_id, host_id) VALUES ($1, $2)",
      [moved, elsewhere],
    );
    const move = await createLro({
      kind: "project-move",
      scope_type: "project",
      scope_id: moved,
      status: "running",
      input: {
        project_id: moved,
        source_host_id: host_id,
        dest_host_id: elsewhere,
      },
    });
    // A hard delete is account-scoped and names its project in the input.
    const doomed = randomUUID();
    await getPool().query(
      "INSERT INTO projects (project_id, host_id, deleted) VALUES ($1, $2, true)",
      [doomed, host_id],
    );
    const hardDelete = await createLro({
      kind: "project-hard-delete",
      scope_type: "account",
      scope_id: randomUUID(),
      status: "queued",
      input: { project_id: doomed },
    });
    expect(await hostActivity({ host_id })).toMatchObject({
      project_operations: 2,
    });
    // The destination counts the move too.
    expect(await hostActivity({ host_id: elsewhere })).toMatchObject({
      project_operations: 1,
    });
    // A copy is scoped to its source project and names its destinations.
    const source = randomUUID();
    const dest = randomUUID();
    await getPool().query(
      "INSERT INTO projects (project_id, host_id) VALUES ($1, $2), ($3, $4)",
      [source, elsewhere, dest, host_id],
    );
    const copy = await createLro({
      kind: "copy-path-between-projects",
      scope_type: "project",
      scope_id: source,
      status: "running",
      input: {
        src: { project_id: source, path: "a" },
        dests: [{ project_id: dest, path: "b" }],
      },
    });
    // A RootFS publish pinned to the host.
    const publish = await createLro({
      kind: "project-rootfs-publish",
      scope_type: "project",
      scope_id: randomUUID(),
      status: "queued",
      input: { project_host_id: host_id },
    });
    expect(await hostActivity({ host_id })).toMatchObject({
      project_operations: 4,
    });
    await updateLro({ op_id: copy.op_id, status: "succeeded" });
    await updateLro({ op_id: publish.op_id, status: "succeeded" });
    await updateLro({ op_id: move.op_id, status: "succeeded" });
    await updateLro({ op_id: hardDelete.op_id, status: "succeeded" });
    expect(await hostActivity({ host_id })).toMatchObject({
      project_operations: 0,
    });
  });
});

describe("project operations during a window", () => {
  it("refuses operations on a project whose host, or the host they target, is down", async () => {
    const host_id = await newHost();
    const other = await newHost();
    const project_id = randomUUID();
    await getPool().query(
      "INSERT INTO projects (project_id, host_id) VALUES ($1, $2)",
      [project_id, other],
    );
    const lease_id = randomUUID();
    await acquireRelocationLease({ host_id, lease_id });
    // Preparing: the relocation's own backups still run.
    await expect(
      assertProjectHostsNotUnderMaintenance({
        project_ids: [project_id],
        host_ids: [host_id],
      }),
    ).resolves.toBeUndefined();
    await setRelocationNotice({
      host_id,
      lease_id,
      notice: { kind: "relocation", state: "in_progress" },
    });
    // A move onto the host being relocated.
    await expect(
      assertProjectHostsNotUnderMaintenance({
        project_ids: [project_id],
        host_ids: [host_id],
      }),
    ).rejects.toMatchObject({ code: "host_maintenance_in_progress" });
    await expect(
      assertProjectHostsNotUnderMaintenance({ project_ids: [project_id] }),
    ).resolves.toBeUndefined();
    // A backup of a project on it.
    await getPool().query(
      "UPDATE projects SET host_id=$2 WHERE project_id=$1",
      [project_id, host_id],
    );
    await expect(
      assertProjectHostsNotUnderMaintenance({ project_ids: [project_id] }),
    ).rejects.toMatchObject({ code: "host_maintenance_in_progress" });
  });
});

describe("tracked host work", () => {
  it("registers before checking the fence, and is refused once a relocation holds the host", async () => {
    const host_id = await newHost();
    let seen: any;
    await expect(
      withTrackedHostWork({
        host_id,
        kind: "host-auto-grow-disk",
        refused: () => "refused",
        run: async () => {
          seen = await hostActivity({ host_id });
          return "ran";
        },
      }),
    ).resolves.toBe("ran");
    // A relocation quiescing now would wait for it.
    expect(seen).toMatchObject({ host_operations: 1 });
    expect(await hostActivity({ host_id })).toMatchObject({
      host_operations: 0,
    });

    await acquireRelocationLease({ host_id, lease_id: randomUUID() });
    const run = jest.fn(async () => "ran");
    await expect(
      withTrackedHostWork({
        host_id,
        kind: "host-auto-grow-disk",
        refused: () => "refused",
        run,
      }),
    ).resolves.toBe("refused");
    expect(run).not.toHaveBeenCalled();
    expect(await hostActivity({ host_id })).toMatchObject({
      host_operations: 0,
    });
  });
});

describe("admin notice writes", () => {
  it("do not overwrite a lease taken after they read the notice", async () => {
    const host_id = await newHost();
    const read = await maintenanceOf(host_id);
    const lease_id = randomUUID();
    await acquireRelocationLease({ host_id, lease_id });
    expect(
      await setHostMaintenanceMetadata(host_id, null, { expected: read }),
    ).toBe(false);
    expect(await maintenanceOf(host_id)).toMatchObject({
      state: "preparing",
      lease_id,
    });
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
