/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  admitCollaborationScan,
  inspectCollaborationScan,
  readCollaborationScanStatus,
  syncCollaborationScanSchema,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { runCollaborationScanPass } from "./scan-worker";
jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "scan-worker-test",
}));
const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const authority = { owning_bay_id: "scan-worker-test" };
describeDb("scan worker with durable owner store", () => {
  const prior = process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  const status = jest.fn(),
    admit = jest.fn();
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationScanSchema(getPool());
  }, 60000);
  afterAll(async () => {
    if (prior === undefined)
      delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
    else process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = prior;
    await getPool().end();
  });
  beforeEach(async () => {
    await getPool().query(
      "TRUNCATE collaboration_scan_jobs,collaboration_scan_receipts,collaboration_scan_budget",
    );
    jest.resetAllMocks();
    process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = "1";
    (getRoutedHostControlClient as jest.Mock).mockResolvedValue({
      getCollaborationReconciliationStatus: status,
      requestCollaborationReconciliation: admit,
    });
    status.mockResolvedValue({ state: "unknown" });
    admit.mockImplementation(async (scan) => ({
      admission: "accepted",
      run_id: scan.run_id,
    }));
  });
  async function fixture() {
    const request = {
      project_id: randomUUID(),
      account_id: randomUUID(),
      request_id: randomUUID(),
      mode: "reconcile" as const,
    };
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,host_id,users) VALUES($1,$2,$3,$4::jsonb)",
      [
        request.project_id,
        authority.owning_bay_id,
        randomUUID(),
        JSON.stringify({ [request.account_id]: { group: "collaborator" } }),
      ],
    );
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    return { request, receipt };
  }
  async function makeDue(project_id: string) {
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET last_dispatch_at=clock_timestamp()-interval '6 seconds',dispatch_until=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [project_id],
    );
  }
  test("admission dispatch discovery and receipt replay integrate", async () => {
    const { request, receipt } = await fixture();
    expect((await runCollaborationScanPass()).pending).toBe(1);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: request.project_id,
        run_id: receipt.job_id,
      }),
    );
    expect((await runCollaborationScanPass()).attempted).toBe(0);
    status.mockResolvedValue({
      state: "discovered",
      run_id: receipt.job_id,
      pending_candidates: 0,
    });
    await makeDue(request.project_id);
    expect((await runCollaborationScanPass()).discovered).toBe(1);
    expect(
      await readCollaborationScanStatus(
        { ...request, job_id: receipt.job_id },
        authority,
      ),
    ).toMatchObject({ state: "discovered" });
    expect(await inspectCollaborationScan(request, authority)).toEqual(receipt);
    expect(await admitCollaborationScan(request, authority)).toEqual(receipt);
    expect((await runCollaborationScanPass()).attempted).toBe(0);
    expect(admit).toHaveBeenCalledTimes(1);
    const follow = await admitCollaborationScan(
      { ...request, request_id: randomUUID() },
      authority,
    );
    if (!("job_id" in follow)) throw Error("expected follow-up");
    expect((await runCollaborationScanPass()).attempted).toBe(0);
    await getPool().query(
      "UPDATE collaboration_scan_budget SET last_started_at=clock_timestamp()-interval '6 minutes' WHERE project_id=$1",
      [request.project_id],
    );
    status.mockResolvedValue({ state: "unknown" });
    expect((await runCollaborationScanPass()).pending).toBe(1);
    expect(admit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        run_id: follow.job_id,
        expected_run_id: receipt.job_id,
      }),
    );
  });
  test("ambiguous admission waits for lease then inspects the same host run", async () => {
    const { request, receipt } = await fixture();
    admit.mockRejectedValue(Error("response lost after acceptance"));
    expect((await runCollaborationScanPass()).unknown).toBe(1);
    expect((await runCollaborationScanPass()).attempted).toBe(0);
    status.mockResolvedValue({
      state: "indexing",
      run_id: receipt.job_id,
      pending_candidates: 2,
    });
    await makeDue(request.project_id);
    expect((await runCollaborationScanPass()).pending).toBe(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ run_id: receipt.job_id }),
    );
  });
  test("revocation before worker pass prevents transport", async () => {
    const { request } = await fixture();
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    expect((await runCollaborationScanPass()).attempted).toBe(0);
    expect(getRoutedHostControlClient).not.toHaveBeenCalled();
  });
});
