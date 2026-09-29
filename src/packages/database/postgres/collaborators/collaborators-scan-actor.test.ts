import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  reserveCollaborationScanActor,
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
