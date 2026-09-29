import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  syncCollaborationRevisionReceiverSchema,
  armCollaborationRevisionReceiver,
  receiveCollaborationRevisionWakeup,
  finishCollaborationRevisionWakeup,
  readCollaborationRevisionReceiverPage,
} from "./collaborators-revision-receiver";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
describeDb("shared home revision receiver", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationRevisionReceiverSchema(getPool());
  }, 60000);
  afterAll(async () => {
    await getPool().end();
  });
  const lease = () => ({
    project_id: randomUUID(),
    home_bay_id: "home",
    owner_bay_id: "owner",
    lease_id: randomUUID(),
  });
  const arm = (
    opts: ReturnType<typeof lease>,
    expected_lease_id: string | null = null,
  ) =>
    armCollaborationRevisionReceiver({
      ...opts,
      expected_lease_id,
      ttl_ms: 120000,
    });
  test("new registration requires catch-up and hints during catch-up cannot be cleared", async () => {
    const opts = lease();
    expect(await receiveCollaborationRevisionWakeup(opts)).toBeNull();
    expect(await arm(opts)).toBe(true);
    expect(await arm({ ...opts, lease_id: randomUUID() })).toBe(false);
    const read = async () =>
      (
        await getPool().query(
          "SELECT dirty_seq::text,applied_seq::text FROM collaboration_revision_receivers WHERE project_id=$1",
          [opts.project_id],
        )
      ).rows[0];
    expect(await read()).toEqual({ dirty_seq: "1", applied_seq: "0" });
    expect(
      (
        await readCollaborationRevisionReceiverPage({
          home_bay_id: opts.home_bay_id,
        })
      ).pending,
    ).toContainEqual({ ...opts, dirty_seq: "1" });
    const seq = await receiveCollaborationRevisionWakeup(opts);
    expect(seq).toBe("2");
    expect(
      await finishCollaborationRevisionWakeup({ ...opts, dirty_seq: "1" }),
    ).toBe(false);
    expect(await receiveCollaborationRevisionWakeup(opts)).toBe("3");
    expect(
      await finishCollaborationRevisionWakeup({ ...opts, dirty_seq: seq! }),
    ).toBe(false);
    expect(
      await finishCollaborationRevisionWakeup({ ...opts, dirty_seq: "3" }),
    ).toBe(true);
    expect(await read()).toEqual({ dirty_seq: "3", applied_seq: "3" });
    expect(
      (
        await readCollaborationRevisionReceiverPage({
          home_bay_id: opts.home_bay_id,
        })
      ).pending.find((row) => row.project_id === opts.project_id),
    ).toBeUndefined();
  });
  test("lease replacement fences delayed hints, catch-up and registration responses", async () => {
    const old = lease();
    await arm(old);
    const next = { ...old, lease_id: randomUUID() };
    expect(await arm(next, old.lease_id)).toBe(true);
    expect(await arm({ ...old, lease_id: randomUUID() }, old.lease_id)).toBe(
      false,
    );
    expect(await receiveCollaborationRevisionWakeup(old)).toBeNull();
    expect(
      await finishCollaborationRevisionWakeup({ ...old, dirty_seq: "1" }),
    ).toBe(false);
    expect(
      await receiveCollaborationRevisionWakeup({
        ...next,
        owner_bay_id: "wrong",
      }),
    ).toBeNull();
    expect(
      await receiveCollaborationRevisionWakeup({
        ...next,
        home_bay_id: "wrong",
      }),
    ).toBeNull();
    expect(await receiveCollaborationRevisionWakeup(next)).toBe("3");
    await getPool().query(
      "UPDATE collaboration_revision_receivers SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [old.project_id],
    );
    expect(await receiveCollaborationRevisionWakeup(next)).toBeNull();
    expect(
      await finishCollaborationRevisionWakeup({ ...next, dirty_seq: "3" }),
    ).toBe(false);
  });
});
