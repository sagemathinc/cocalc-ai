import { randomUUID } from "node:crypto";
import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
import { enqueueCloudVmWork } from "@cocalc/server/cloud/db";
import { before, after, getPool } from "@cocalc/server/test";
import {
  intentSuperseded,
  recoverHostToRunning,
  setHostDesiredState,
} from "./desired-state";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

async function newHost(metadata: Record<string, any> = {}): Promise<string> {
  const id = randomUUID();
  await upsertProjectHost({
    id,
    name: `desired-state-${id.slice(0, 8)}`,
    region: "us-west4",
    status: "running",
    metadata: { owner: "acct-owner", machine: { cloud: "gcp" }, ...metadata },
  });
  return id;
}

async function hostRow(id: string) {
  const { rows } = await getPool().query(
    "SELECT status, metadata, desired_state_generation FROM project_hosts WHERE id=$1",
    [id],
  );
  return rows[0];
}

describe("desired state guard", () => {
  it("reverts a desired_state change that does not bump the generation", async () => {
    const id = await newHost({ desired_state: "running" });
    const generation = await setHostDesiredState({
      host_id: id,
      state: "stopped",
    });
    expect(generation).toBeGreaterThan(0);

    // A writer saving back the whole metadata object it read earlier.
    const stale = {
      owner: "acct-owner",
      machine: { cloud: "gcp" },
      desired_state: "running",
      billing: { note: "kept" },
    };
    await getPool().query("UPDATE project_hosts SET metadata=$2 WHERE id=$1", [
      id,
      stale,
    ]);
    let row = await hostRow(id);
    expect(row.metadata.desired_state).toBe("stopped");
    // Its other changes still apply.
    expect(row.metadata.billing).toEqual({ note: "kept" });
    expect(Number(row.desired_state_generation)).toBe(generation);

    // An intentional change goes through.
    const next = await setHostDesiredState({ host_id: id, state: "running" });
    row = await hostRow(id);
    expect(row.metadata.desired_state).toBe("running");
    expect(next).toBe(generation! + 1);
    expect(intentSuperseded(row, { intent_generation: generation })).toBe(true);
    expect(intentSuperseded(row, { intent_generation: next })).toBe(false);
    expect(intentSuperseded(row, {})).toBe(false);
  });
});

describe("automatic recovery", () => {
  it("never overrides a stop recorded after it read the host", async () => {
    // Reconcile loaded the host while it was wanted running ...
    const id = await newHost({ desired_state: "running" });
    await setHostDesiredState({ host_id: id, state: "running" });
    // ... then billing enforcement stops it ...
    const stopGeneration = await setHostDesiredState({
      host_id: id,
      state: "stopped",
    });
    await enqueueCloudVmWork({
      vm_id: id,
      action: "stop",
      payload: { intent_generation: stopGeneration },
    });
    // ... and reconcile resumes its restore.
    const enqueue = jest.fn(async () => undefined);
    const write = jest.fn(async () => undefined);
    await expect(
      recoverHostToRunning({ host_id: id, write, enqueue }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const row = await hostRow(id);
    expect(row.metadata.desired_state).toBe("stopped");
    // The stop is still current and runs.
    const { rows } = await getPool().query(
      "SELECT payload FROM cloud_vm_work WHERE vm_id=$1 AND action='stop' AND state='queued'",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(intentSuperseded(row, rows[0].payload)).toBe(false);
  });

  it("marks a host wanted running and queues under that intent", async () => {
    const id = await newHost();
    let queuedUnder: number | undefined;
    await expect(
      recoverHostToRunning({
        host_id: id,
        enqueue: async (_client, generation) => {
          queuedUnder = generation;
        },
      }),
    ).resolves.toBe(true);
    const row = await hostRow(id);
    expect(row.metadata.desired_state).toBe("running");
    expect(queuedUnder).toBe(Number(row.desired_state_generation));
    // Already wanted running: no new intent.
    await recoverHostToRunning({ host_id: id, enqueue: async () => {} });
    expect(Number((await hostRow(id)).desired_state_generation)).toBe(
      queuedUnder,
    );
  });
});
