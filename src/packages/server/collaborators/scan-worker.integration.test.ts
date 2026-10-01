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
    admit = jest.fn(),
    cancel = jest.fn();
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
      cancelCollaborationReconciliation: cancel,
    });
    status.mockResolvedValue({ state: "unknown" });
    admit.mockImplementation(async (scan) => ({
      admission: "accepted",
      run_id: scan.run_id,
    }));
    cancel.mockImplementation(async (scan) => ({
      state: "cancelled",
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
  test.each(["cancelled", "partial"])(
    "retained legacy %s outcome releases the job while preserving receipt replay",
    async (state) => {
      const { request, receipt } = await fixture();
      await runCollaborationScanPass();
      status.mockResolvedValue({
        state,
        run_id: receipt.job_id,
        traversal_complete: true,
        pending_candidates: 0,
      });
      if (state === "partial") {
        cancel.mockRejectedValueOnce(Error("lost stop acknowledgment"));
        await makeDue(request.project_id);
        expect((await runCollaborationScanPass()).unknown).toBe(1);
        expect(
          (await getPool().query("SELECT job_id FROM collaboration_scan_jobs"))
            .rows,
        ).toEqual([{ job_id: receipt.job_id }]);
      }
      await makeDue(request.project_id);
      expect((await runCollaborationScanPass()).failed).toBe(1);
      expect(
        await readCollaborationScanStatus(
          { ...request, job_id: receipt.job_id },
          authority,
        ),
      ).toMatchObject({ state: "failed" });
      expect(
        (await getPool().query("SELECT job_id FROM collaboration_scan_jobs"))
          .rows,
      ).toEqual([]);
      expect(await inspectCollaborationScan(request, authority)).toEqual(
        receipt,
      );
      expect(await admitCollaborationScan(request, authority)).toEqual(receipt);
      expect((await runCollaborationScanPass()).attempted).toBe(0);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(state === "cancelled" ? 0 : 2);
      for (const [scan] of cancel.mock.calls)
        expect(scan.run_id).toBe(receipt.job_id);
    },
  );
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
    // A new run is unknown, but the host retains the completed predecessor.
    status.mockResolvedValue({
      state: "unknown",
      current_run_id: receipt.job_id,
    });
    expect((await runCollaborationScanPass()).pending).toBe(1);
    expect(admit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        run_id: follow.job_id,
        expected_run_id: receipt.job_id,
      }),
    );
  });
  test("host cooldown persists through release and prevents another dispatch", async () => {
    const { request, receipt } = await fixture();
    admit.mockResolvedValue({
      admission: "throttled",
      run_id: receipt.job_id,
      retry_after_ms: 120000,
    });
    expect((await runCollaborationScanPass()).deferred).toBe(1);
    expect(
      await readCollaborationScanStatus(
        { ...request, job_id: receipt.job_id },
        authority,
      ),
    ).toMatchObject({
      state: "running",
      deferred: { reason: "host_throttled" },
    });
    await makeDue(request.project_id);
    expect((await runCollaborationScanPass()).attempted).toBe(0);
    expect(admit).toHaveBeenCalledTimes(1);
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
  test("worker retires expired unstarted work without contacting a host", async () => {
    const { request, receipt } = await fixture();
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(await runCollaborationScanPass()).toMatchObject({
      attempted: 0,
      retired: 1,
    });
    expect(getRoutedHostControlClient).not.toHaveBeenCalled();
    expect(
      (
        await getPool().query(
          "SELECT job_id FROM collaboration_scan_jobs WHERE job_id=$1",
          [receipt.job_id],
        )
      ).rows,
    ).toEqual([]);
    await expect(admitCollaborationScan(request, authority)).rejects.toThrow(
      "expired",
    );
    expect((await runCollaborationScanPass()).retired).toBe(0);
  });
});
