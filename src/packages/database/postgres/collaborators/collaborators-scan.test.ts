/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  admitCollaborationScan,
  inspectCollaborationScan,
  syncCollaborationScanSchema,
} from "./collaborators-scan";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const authority = { owning_bay_id: "scan-test" };
describeDb("owner scan admission prototype", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationScanSchema(getPool());
  }, 60_000);
  afterAll(async () => {
    await getPool().end();
  });
  async function fixture() {
    const request = {
      project_id: randomUUID(),
      account_id: randomUUID(),
      request_id: randomUUID(),
      mode: "reconcile" as const,
    };
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,users) VALUES($1,$2,$3::jsonb)",
      [
        request.project_id,
        authority.owning_bay_id,
        JSON.stringify({ [request.account_id]: { group: "collaborator" } }),
      ],
    );
    return request;
  }
  test("stable retry and changed-argument rejection", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    expect(receipt.admission).toBe("accepted");
    expect(await admitCollaborationScan(request, authority)).toEqual(receipt);
    expect(await inspectCollaborationScan(request, authority)).toEqual(receipt);
    await expect(
      admitCollaborationScan({ ...request, mode: "check" }, authority),
    ).rejects.toThrow("different arguments");
  });
  test("concurrent requests coalesce into one queued job", async () => {
    const request = await fixture();
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () =>
        admitCollaborationScan(
          { ...request, request_id: randomUUID() },
          authority,
        ),
      ),
    );
    expect(receipts.filter((r) => r.admission === "accepted")).toHaveLength(1);
    expect(
      new Set(receipts.map((r) => ("job_id" in r ? r.job_id : null))).size,
    ).toBe(1);
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_scan_jobs WHERE project_id=$1",
          [request.project_id],
        )
      ).rows,
    ).toHaveLength(1);
  });
  test("running work is throttled before one follow-up can be queued", async () => {
    const request = await fixture();
    await admitCollaborationScan(request, authority);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET state='running' WHERE project_id=$1",
      [request.project_id],
    );
    const next = { ...request, request_id: randomUUID() };
    expect(await admitCollaborationScan(next, authority)).toMatchObject({
      admission: "throttled",
      retry_after_ms: expect.any(Number),
    });
    expect(await inspectCollaborationScan(next, authority)).toBeNull();
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET created_at=clock_timestamp()-interval '6 minutes' WHERE project_id=$1",
      [request.project_id],
    );
    expect((await admitCollaborationScan(next, authority)).admission).toBe(
      "accepted",
    );
    expect(
      (
        await admitCollaborationScan(
          { ...next, request_id: randomUUID() },
          authority,
        )
      ).admission,
    ).toBe("coalesced");
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_scan_jobs WHERE project_id=$1",
          [request.project_id],
        )
      ).rows,
    ).toHaveLength(2);
  });
  test("unknown and expired inspection never launches work", async () => {
    const request = await fixture();
    expect(await inspectCollaborationScan(request, authority)).toBeNull();
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_scan_jobs WHERE project_id=$1",
          [request.project_id],
        )
      ).rows,
    ).toHaveLength(0);
    await admitCollaborationScan(request, authority);
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(await inspectCollaborationScan(request, authority)).toBeNull();
    await expect(admitCollaborationScan(request, authority)).rejects.toThrow(
      "expired",
    );
  });
  test("replay and inspection require current project membership and owner", async () => {
    const request = await fixture();
    await admitCollaborationScan(request, authority);
    await expect(
      admitCollaborationScan(request, { owning_bay_id: "wrong" }),
    ).rejects.toThrow();
    await expect(
      inspectCollaborationScan(
        { ...request, account_id: randomUUID() },
        authority,
      ),
    ).rejects.toThrow();
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    await expect(admitCollaborationScan(request, authority)).rejects.toThrow();
    await expect(
      inspectCollaborationScan(request, authority),
    ).rejects.toThrow();
  });
});
