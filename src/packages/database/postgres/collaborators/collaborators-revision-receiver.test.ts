import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  syncCollaborationRevisionReceiverSchema,
  armCollaborationRevisionReceiver,
  receiveCollaborationRevisionWakeup,
  finishCollaborationRevisionWakeup,
  readCollaborationRevisionReceiverPage,
  pruneCollaborationRevisionReceivers,
  collaborationRevisionReceiverNeedsRenewal,
  readRevisionSchedulingState,
  advanceRevisionScheduling,
  readRevisionBootstrap,
  acknowledgeRevisionBootstrap,
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
  const identity = async (project_id: string) =>
    (
      await getPool().query(
        "SELECT receiver_id FROM collaboration_revision_receivers WHERE project_id=$1",
        [project_id],
      )
    ).rows[0].receiver_id as string;
  test("bootstrap identity survives renewal and acknowledgment is lease fenced", async () => {
    const opts = lease();
    expect(await readRevisionBootstrap(opts)).toBeNull();
    await arm(opts);
    const receiver_id = (await readRevisionBootstrap(opts))!;
    expect(receiver_id).toBeTruthy();
    const renewed = { ...opts, lease_id: randomUUID() };
    await arm(renewed, opts.lease_id);
    expect(await readRevisionBootstrap(renewed)).toBe(receiver_id);
    expect(await acknowledgeRevisionBootstrap({ ...opts, receiver_id })).toBe(
      false,
    );
    expect(
      await acknowledgeRevisionBootstrap({
        ...renewed,
        receiver_id: randomUUID(),
      }),
    ).toBe(false);
    expect(
      await acknowledgeRevisionBootstrap({ ...renewed, receiver_id }),
    ).toBe(true);
    expect(await readRevisionBootstrap(renewed)).toBeNull();
    const moved = {
      ...renewed,
      owner_bay_id: "new-owner",
      lease_id: randomUUID(),
    };
    await arm(moved, renewed.lease_id);
    expect(await readRevisionBootstrap(moved)).toBe(receiver_id);
    await getPool().query(
      "UPDATE collaboration_revision_receivers SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [opts.project_id],
    );
    expect(await readRevisionBootstrap(moved)).toBeNull();
    expect(await acknowledgeRevisionBootstrap({ ...moved, receiver_id })).toBe(
      false,
    );
  });
  test("scheduling progress is durable, CAS guarded, and separate from catch-up completion", async () => {
    const opts = lease();
    const read = () =>
      readRevisionSchedulingState(opts.project_id, opts.home_bay_id);
    expect(await read()).toBeNull();
    await arm(opts);
    const initial = (await read())!;
    expect(initial).toMatchObject({
      after: null,
      complete: false,
      dirty_seq: "1",
    });
    const after = {
      account_id: randomUUID(),
      grace_until: "2026-09-29 12:00:00.123456+00",
    };
    expect(await advanceRevisionScheduling(initial, after)).toBe(true);
    expect(await advanceRevisionScheduling(initial, null)).toBe(false);
    const next = (await read())!;
    expect(next.after).toEqual(after);
    expect(await advanceRevisionScheduling(next, null)).toBe(true);
    expect((await read())!.complete).toBe(true);
    expect(await advanceRevisionScheduling((await read())!, after)).toBe(false);
    const completed = (await read())!;
    await receiveCollaborationRevisionWakeup(opts);
    expect(await advanceRevisionScheduling(completed, null)).toBe(false);
    const dirty = (await read())!;
    expect(dirty).toMatchObject({
      dirty_seq: "2",
      after: null,
      complete: false,
    });
    await arm({ ...opts, lease_id: randomUUID() }, opts.lease_id);
    expect(await advanceRevisionScheduling(dirty, null)).toBe(false);
    expect(
      (
        await getPool().query(
          "SELECT applied_seq::text FROM collaboration_revision_receivers WHERE project_id=$1",
          [opts.project_id],
        )
      ).rows[0].applied_seq,
    ).toBe("0");
  });
  test("renewal is project-local and does not extend a lease on observation or retry", async () => {
    const opts = lease();
    const due = (home = opts.home_bay_id) =>
      collaborationRevisionReceiverNeedsRenewal(opts.project_id, home);
    expect(await due()).toBe(true);
    await arm(opts);
    expect(await due()).toBe(false);
    expect(await due("other-home")).toBe(true);
    await getPool().query(
      "UPDATE collaboration_revision_receivers SET renew_after=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [opts.project_id],
    );
    expect(await due()).toBe(true);
    await arm(opts, opts.lease_id);
    expect(await due()).toBe(true);
    const next = { ...opts, lease_id: randomUUID() };
    await arm(next, opts.lease_id);
    expect(await due()).toBe(false);
    await getPool().query(
      "UPDATE collaboration_revision_receivers SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [opts.project_id],
    );
    expect(await due()).toBe(true);
  });
  test("expiry cleanup is bounded and cannot let an old worker clear a recreated receiver", async () => {
    const opts = { ...lease(), home_bay_id: "cleanup-race" };
    await arm(opts);
    const oldIdentity = await identity(opts.project_id);
    await getPool().query(
      "UPDATE collaboration_revision_receivers SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [opts.project_id],
    );
    expect(await pruneCollaborationRevisionReceivers(opts.home_bay_id)).toBe(1);
    expect(await arm(opts)).toBe(true);
    const receiver_id = await identity(opts.project_id);
    expect(receiver_id).not.toBe(oldIdentity);
    expect(
      await finishCollaborationRevisionWakeup({
        ...opts,
        dirty_seq: "1",
        receiver_id: oldIdentity,
      }),
    ).toBe(false);
    expect(
      await finishCollaborationRevisionWakeup({
        ...opts,
        dirty_seq: "1",
        receiver_id,
      }),
    ).toBe(true);
    await getPool()
      .query(`INSERT INTO collaboration_revision_receivers(project_id,home_bay_id,owner_bay_id,lease_id,expires_at)
      SELECT gen_random_uuid(),'cleanup-batch','owner',gen_random_uuid(),clock_timestamp()-interval '1 second'
      FROM generate_series(1,105)`);
    expect(await pruneCollaborationRevisionReceivers("cleanup-batch")).toBe(
      100,
    );
    expect(await pruneCollaborationRevisionReceivers("cleanup-batch")).toBe(5);
    expect(await pruneCollaborationRevisionReceivers("cleanup-batch")).toBe(0);
    expect(await identity(opts.project_id)).toBe(receiver_id);
  });
  test("new registration requires catch-up and hints during catch-up cannot be cleared", async () => {
    const opts = lease();
    expect(await receiveCollaborationRevisionWakeup(opts)).toBeNull();
    expect(await arm(opts)).toBe(true);
    const receiver_id = await identity(opts.project_id);
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
    ).toContainEqual({ ...opts, dirty_seq: "1", receiver_id });
    const seq = await receiveCollaborationRevisionWakeup(opts);
    expect(seq).toBe("2");
    expect(
      await finishCollaborationRevisionWakeup({
        ...opts,
        dirty_seq: "1",
        receiver_id,
      }),
    ).toBe(false);
    expect(await receiveCollaborationRevisionWakeup(opts)).toBe("3");
    expect(
      await finishCollaborationRevisionWakeup({
        ...opts,
        dirty_seq: seq!,
        receiver_id,
      }),
    ).toBe(false);
    expect(
      await finishCollaborationRevisionWakeup({
        ...opts,
        dirty_seq: "3",
        receiver_id,
      }),
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
    const receiver_id = await identity(old.project_id);
    const next = { ...old, lease_id: randomUUID() };
    expect(await arm(next, old.lease_id)).toBe(true);
    expect(await arm(next, next.lease_id)).toBe(true);
    expect(await arm({ ...old, lease_id: randomUUID() }, old.lease_id)).toBe(
      false,
    );
    expect(await receiveCollaborationRevisionWakeup(old)).toBeNull();
    expect(
      await finishCollaborationRevisionWakeup({
        ...old,
        dirty_seq: "1",
        receiver_id,
      }),
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
      await finishCollaborationRevisionWakeup({
        ...next,
        dirty_seq: "3",
        receiver_id,
      }),
    ).toBe(false);
  });
});
