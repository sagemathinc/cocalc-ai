import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  reserveCollaborationScanActor,
  reserveCollaborationScanRead,
  syncCollaborationScanActorSchema,
} from "./collaborators-scan-actor";
const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
describeDb("actor-wide Scan reservations", () => {
  const prior = process.env.COCALC_BAY_ID;
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "scan-home";
    await initEphemeralDatabase();
    await syncCollaborationScanActorSchema(getPool());
  }, 60000);
  afterAll(async () => {
    if (prior === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = prior;
    await getPool().end();
  });
  async function fixture() {
    const request = {
      account_id: randomUUID(),
      project_id: randomUUID(),
      request_id: randomUUID(),
      mode: "check" as const,
    };
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'scan-home')",
      [request.account_id],
    );
    return request;
  }
  test("polling is independent of admission and denied polling writes nothing", async () => {
    const request = await fixture();
    const account_id = request.account_id;
    for (let i = 0; i < 10; i++)
      expect((await reserveCollaborationScanRead(account_id)).allowed).toBe(
        true,
      );
    await getPool().query(
      "UPDATE collaboration_scan_actor_budget SET read_tokens=0,read_updated_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1",
      [account_id],
    );
    const read = async () =>
      (
        await getPool().query(
          "SELECT * FROM collaboration_scan_actor_budget WHERE account_id=$1",
          [account_id],
        )
      ).rows[0];
    const before = await read();
    const denied = await reserveCollaborationScanRead(account_id);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retry_after_ms).toBeGreaterThan(3500000);
    expect(await read()).toEqual(before);
    expect((await reserveCollaborationScanActor(request)).reserved).toBe(true);
    expect((await read()).read_updated_at).toEqual(before.read_updated_at);
    expect((await read()).read_tokens).toBe(0);
    await getPool().query(
      "UPDATE collaboration_scan_actor_budget SET read_updated_at=clock_timestamp()-interval '1 day' WHERE account_id=$1",
      [account_id],
    );
    const admission = await read();
    expect((await reserveCollaborationScanRead(account_id)).allowed).toBe(true);
    const after = await read();
    expect(after.read_tokens).toBe(9);
    expect(after.tokens).toBe(admission.tokens);
    expect(after.updated_at).toEqual(admission.updated_at);
  });
  test("polling rejects wrong-home, banned and deleted actors", async () => {
    const { account_id } = await fixture();
    await getPool().query(
      "UPDATE accounts SET home_bay_id='elsewhere' WHERE account_id=$1",
      [account_id],
    );
    await expect(reserveCollaborationScanRead(account_id)).rejects.toThrow();
    await getPool().query(
      "UPDATE accounts SET home_bay_id='scan-home',banned=true WHERE account_id=$1",
      [account_id],
    );
    await expect(reserveCollaborationScanRead(account_id)).rejects.toThrow(
      "unavailable",
    );
    await getPool().query(
      "UPDATE accounts SET banned=false,deleted=true WHERE account_id=$1",
      [account_id],
    );
    await expect(reserveCollaborationScanRead(account_id)).rejects.toThrow(
      "not found",
    );
  });
  test("projects share actor burst and replay is free", async () => {
    const request = await fixture();
    const receipt = await reserveCollaborationScanActor(request);
    expect(receipt.reserved).toBe(true);
    expect(
      (
        await reserveCollaborationScanActor({
          ...request,
          project_id: randomUUID(),
        })
      ).reserved,
    ).toBe(true);
    expect(
      (
        await reserveCollaborationScanActor({
          ...request,
          project_id: randomUUID(),
        })
      ).reserved,
    ).toBe(false);
    expect(await reserveCollaborationScanActor(request)).toEqual(receipt);
    await expect(
      reserveCollaborationScanActor({ ...request, mode: "reconcile" }),
    ).rejects.toThrow("different arguments");
  });
  test("refill is capped and a future budget clock does not mint tokens", async () => {
    const request = await fixture();
    const reserve = () =>
      reserveCollaborationScanActor({ ...request, request_id: randomUUID() });
    await reserve();
    await getPool().query(
      `UPDATE collaboration_scan_actor_budget SET tokens=0,
       updated_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1`,
      [request.account_id],
    );
    const denied = await reserve();
    expect(denied.reserved).toBe(false);
    if (!denied.reserved)
      expect(denied.retry_after_ms).toBeGreaterThan(3500000);
    await getPool().query(
      `UPDATE collaboration_scan_actor_budget SET tokens=0,
       updated_at=clock_timestamp()-interval '1 day' WHERE account_id=$1`,
      [request.account_id],
    );
    expect((await reserve()).reserved).toBe(true);
    expect((await reserve()).reserved).toBe(true);
    expect((await reserve()).reserved).toBe(false);
  });
  test("retained expired retries fail without charging or cleaning", async () => {
    const request = await fixture();
    await reserveCollaborationScanActor(request);
    await getPool().query(
      `UPDATE collaboration_scan_actor_receipts SET expires_at=clock_timestamp()-interval '1 day'
       WHERE account_id=$1`,
      [request.account_id],
    );
    const budget = async () =>
      (
        await getPool().query(
          "SELECT * FROM collaboration_scan_actor_budget WHERE account_id=$1",
          [request.account_id],
        )
      ).rows;
    const before = await budget();
    await expect(reserveCollaborationScanActor(request)).rejects.toThrow(
      "reservation expired",
    );
    expect(await budget()).toEqual(before);
    expect(
      (
        await getPool().query(
          "SELECT count(*)::integer AS n FROM collaboration_scan_actor_receipts WHERE account_id=$1",
          [request.account_id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  test("cleanup removes at most 64 expired receipts only on admitted work", async () => {
    const request = await fixture();
    await reserveCollaborationScanActor(request);
    await getPool().query(
      `INSERT INTO collaboration_scan_actor_receipts
       SELECT $1, $2, md5('expired-' || n)::uuid, 'check', clock_timestamp()-interval '1 day'
       FROM generate_series(1,70) n`,
      [request.account_id, request.project_id],
    );
    const count = async () =>
      (
        await getPool().query(
          "SELECT count(*)::integer AS n FROM collaboration_scan_actor_receipts WHERE account_id=$1",
          [request.account_id],
        )
      ).rows[0].n;
    await getPool().query(
      `UPDATE collaboration_scan_actor_budget SET tokens=0,
       updated_at=clock_timestamp() WHERE account_id=$1`,
      [request.account_id],
    );
    const reserve = () =>
      reserveCollaborationScanActor({ ...request, request_id: randomUUID() });
    expect((await reserve()).reserved).toBe(false);
    expect(await count()).toBe(71);
    await reserveCollaborationScanActor(request);
    expect(await count()).toBe(71);
    await getPool().query(
      "UPDATE collaboration_scan_actor_budget SET tokens=2 WHERE account_id=$1",
      [request.account_id],
    );
    expect((await reserve()).reserved).toBe(true);
    expect(await count()).toBe(8);
  });
  test("wrong home and banned accounts fail even on replay", async () => {
    const request = await fixture();
    await reserveCollaborationScanActor(request);
    await getPool().query(
      "UPDATE accounts SET home_bay_id='elsewhere' WHERE account_id=$1",
      [request.account_id],
    );
    await expect(reserveCollaborationScanActor(request)).rejects.toThrow();
    await getPool().query(
      "UPDATE accounts SET home_bay_id='scan-home',banned=true WHERE account_id=$1",
      [request.account_id],
    );
    await expect(reserveCollaborationScanActor(request)).rejects.toThrow(
      "unavailable",
    );
  });
});
