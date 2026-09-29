/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { syncCollaborationScanSchema } from "@cocalc/database/postgres/collaborators/collaborators-scan";
import {
  prepareScanChild,
  finishScanChild,
} from "@cocalc/database/postgres/collaborators/collaborators-scan-child";
import {
  ensureScanBatchSchema,
  scanProjectsAtHome,
  runScanBatchPass,
  readScanBatch,
} from "./scan-batch";
import { stepScanChild } from "./scan-child";
import { expireDueLros } from "@cocalc/server/lro/lro-db";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import type { ScanChildRequest } from "@cocalc/util/collaboration-scan-batch";
jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: jest.fn(),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    collaborators_enabled: true,
    people_scan_enabled: mockEnabled,
  }),
}));
jest.mock("@cocalc/server/lro/stream", () => ({
  publishLroSummary: jest.fn(),
}));
let mockEnabled = true;
const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("manual scan LRO durability", () => {
  const authority = { owning_bay_id: process.env.COCALC_BAY_ID ?? "bay-0" };
  const admit = jest.fn(),
    status = jest.fn(),
    cancel = jest.fn();
  let account_id: string, project_id: string;
  const eligible = async (project_id: string) => ({
    project_id,
    title: "Fixture",
  });
  const api = (opts: any) =>
    scanProjectsAtHome({ account_id, ...opts }, eligible);
  const step = (opts: ScanChildRequest) => stepScanChild(opts, authority);
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationScanSchema(getPool());
    await ensureScanBatchSchema();
  }, 60000);
  afterAll(async () => {
    await getPool().end();
  });
  beforeEach(async () => {
    mockEnabled = true;
    process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = "1";
    // PGlite's multi-table TRUNCATE can invalidate the shared LRO indexes.
    for (const table of [
      "collaboration_scan_batch_children",
      "collaboration_scan_batch_requests",
      "collaboration_scan_batch_accounts",
      "long_running_operations",
      "collaboration_scan_jobs",
      "collaboration_scan_receipts",
      "collaboration_scan_budget",
    ])
      await getPool().query(`DELETE FROM ${table}`);
    account_id = randomUUID();
    project_id = randomUUID();
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)",
      [account_id, authority.owning_bay_id],
    );
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,host_id,users) VALUES($1,$2,$3,$4::jsonb)",
      [
        project_id,
        authority.owning_bay_id,
        randomUUID(),
        JSON.stringify({ [account_id]: { group: "owner" } }),
      ],
    );
    await getPool().query(
      "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary) VALUES($1,$2,$3,$4::jsonb)",
      [
        account_id,
        project_id,
        authority.owning_bay_id,
        JSON.stringify({ [account_id]: { group: "owner" } }),
      ],
    );
    jest.clearAllMocks();
    status.mockResolvedValue({ state: "unknown" });
    admit.mockImplementation(async (scan) => ({
      admission: "accepted",
      run_id: scan.run_id,
      replayed: false,
    }));
    cancel.mockImplementation(async (scan) => ({
      state: "cancelled",
      run_id: scan.run_id,
    }));
    (getRoutedHostControlClient as jest.Mock).mockResolvedValue({
      requestCollaborationReconciliation: admit,
      getCollaborationReconciliationStatus: status,
      cancelCollaborationReconciliation: cancel,
    });
  });
  const start = (
    project_ids: string[] | "all" = [project_id],
    request_id = randomUUID(),
  ) => api({ action: "start", project_ids, request_id });
  const due = () =>
    getPool().query(
      "UPDATE long_running_operations SET heartbeat_at=now()-interval '2 minutes'",
    );
  test("racing tabs return one LRO and never extend its fixed selection", async () => {
    const [first, other] = await Promise.all([start(), start([project_id])]);
    expect(other.operation?.op_id).toBe(first.operation?.op_id);
    expect(other.operation?.children.map((c) => c.project_id)).toEqual([
      project_id,
    ]);
    expect(
      (await getPool().query("SELECT * FROM long_running_operations")).rows,
    ).toHaveLength(1);
  });
  test("all captures every page and later projects are not included", async () => {
    const ids = Array.from({ length: 30 }, () => randomUUID());
    for (const id of ids)
      await getPool().query(
        "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary) VALUES($1,$2,$3,$4::jsonb)",
        [
          account_id,
          id,
          authority.owning_bay_id,
          JSON.stringify({ [account_id]: { group: "collaborator" } }),
        ],
      );
    const result = await start("all");
    expect(result.operation?.total).toBe(31);
    expect(result.operation?.children).toHaveLength(25);
    const next = await api({
      action: "status",
      op_id: result.operation?.op_id,
      after: result.operation?.next,
    });
    expect(next.operation?.children).toHaveLength(6);
    await getPool().query(
      "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary) VALUES($1,$2,$3,$4::jsonb)",
      [
        account_id,
        randomUUID(),
        authority.owning_bay_id,
        JSON.stringify({ [account_id]: { group: "owner" } }),
      ],
    );
    expect((await api({ action: "status" })).operation?.total).toBe(31);
    expect(admit).not.toHaveBeenCalled();
  });
  test("cancel before dispatch is durable and frequency-limited across new IDs", async () => {
    const request = randomUUID();
    const result = await start([project_id], request);
    await api({ action: "cancel", op_id: result.operation?.op_id });
    expect((await api({ action: "status" })).operation?.cancelling).toBe(true);
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.status).toBe(
      "canceled",
    );
    expect(admit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect((await start([project_id], request)).operation?.op_id).toBe(
      result.operation?.op_id,
    );
    expect((await start()).next_eligible_at).toBeGreaterThan(Date.now());
  });
  test("lost host acknowledgement and cancel timeout retain admission until stopped", async () => {
    const result = await start();
    admit.mockRejectedValue(Error("timeout"));
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.status).toBe("running");
    await api({ action: "cancel", op_id: result.operation?.op_id });
    cancel.mockRejectedValueOnce(Error("unreachable"));
    await due();
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.cancelling).toBe(true);
    expect((await api({ action: "status" })).operation?.children[0].state).toBe(
      "cancelling",
    );
    expect((await start()).operation?.op_id).toBe(result.operation?.op_id);
    await due();
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.status).toBe(
      "canceled",
    );
    expect(admit).toHaveBeenCalledTimes(1);
  });
  test("disabled admission preserves status/cancel and no generic expiry loses receipts", async () => {
    const result = await start();
    mockEnabled = false;
    expect((await api({ action: "status" })).enabled).toBe(false);
    await getPool().query(
      "UPDATE long_running_operations SET expires_at=now()-interval '1 day'",
    );
    expect(await expireDueLros()).toEqual([]);
    await api({ action: "cancel", op_id: result.operation?.op_id });
    // Scan LROs use non-expiring execution identity, including legacy bad expiry metadata.
    await getPool().query(
      "UPDATE long_running_operations SET expires_at='infinity'",
    );
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.status).toBe(
      "canceled",
    );
    await expect(start()).rejects.toThrow("disabled");
  });
  test("terminal child cancellation fences a delayed start; project conflict is deferred", async () => {
    const request = {
      account_id,
      project_id,
      request_id: randomUUID(),
      batch_id: randomUUID(),
      action: "cancel" as const,
    };
    expect((await prepareScanChild(request, authority)).state).toBe(
      "cancelled",
    );
    expect(
      (await prepareScanChild({ ...request, action: "start" }, authority))
        .state,
    ).toBe("cancelled");
    const live = {
      ...request,
      request_id: randomUUID(),
      action: "start" as const,
    };
    expect((await prepareScanChild(live, authority)).state).toBe("queued");
    expect(
      (
        await prepareScanChild(
          { ...live, request_id: randomUUID(), batch_id: randomUUID() },
          authority,
        )
      ).state,
    ).toBe("deferred");
  });
  test("successful completion is processed count, and foreign accounts cannot inspect/cancel", async () => {
    const result = await start();
    await runScanBatchPass(step);
    const run = result.operation!.children[0].request_id;
    status.mockResolvedValue({
      state: "discovered",
      run_id: run,
      pending_candidates: 0,
      entries: 21,
      candidates: 2,
    });
    await due();
    await runScanBatchPass(step);
    const final = (await api({ action: "status" })).operation!;
    expect(final.status).toBe("succeeded");
    expect(final.counts.successful).toBe(1);
    expect(final.children[0].entries).toBe(21);
    const stranger = randomUUID();
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)",
      [stranger, authority.owning_bay_id],
    );
    expect(await readScanBatch(stranger, final.op_id)).toBeUndefined();
    expect(
      (
        await scanProjectsAtHome(
          { account_id: stranger, action: "cancel", op_id: final.op_id },
          eligible,
        )
      ).operation,
    ).toBeUndefined();
  });
  test("revoked membership cancels running work before releasing project admission", async () => {
    await start();
    await runScanBatchPass(step);
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [project_id],
    );
    await due();
    await runScanBatchPass(step);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await api({ action: "status" })).operation?.counts.cancelled).toBe(
      1,
    );
  });
  test("a stale worker cannot publish after another worker takes over", async () => {
    await start();
    let release!: (value: any) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stale = runScanBatchPass(async (_request) => {
      entered();
      return await new Promise((resolve) => {
        release = resolve;
      });
    });
    await started;
    await due();
    await runScanBatchPass(async (request) => ({
      ...request,
      state: "successful",
    }));
    release({ project_id, request_id: randomUUID(), state: "failed" });
    await stale;
    expect((await api({ action: "status" })).operation?.status).toBe(
      "succeeded",
    );
  });
  test("truncated traversal is fenced and shown separately from success", async () => {
    const result = await start();
    await runScanBatchPass(step);
    status.mockResolvedValue({
      state: "partial",
      run_id: result.operation!.children[0].request_id,
      traversal_complete: false,
      blocked_reason: "entry_limit",
      entries: 100,
      candidates: 1,
    });
    await due();
    await runScanBatchPass(step);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await api({ action: "status" })).operation?.counts.truncated).toBe(
      1,
    );
  });
  test("project cooldown survives cancel before host dispatch", async () => {
    const request = {
      account_id,
      project_id,
      request_id: randomUUID(),
      batch_id: randomUUID(),
      action: "start" as const,
    };
    await prepareScanChild(request, authority);
    await prepareScanChild({ ...request, action: "cancel" }, authority);
    const next = await prepareScanChild(
      { ...request, request_id: randomUUID() },
      authority,
    );
    expect(next.state).toBe("deferred");
    expect(next.next_eligible_at).toBeGreaterThan(Date.now());
  });
  test("explicit host deferral fences the new identity and ends without sharing the predecessor", async () => {
    status.mockResolvedValue({
      state: "unknown",
      current_run_id: randomUUID(),
    });
    admit.mockImplementation(async () => ({
      admission: "deferred",
      reason: "BUSY",
      run_id: randomUUID(),
    }));
    cancel.mockImplementation(async ({ run_id }) => ({
      state: "cancelled",
      run_id,
    }));
    const started = await api({
      action: "start",
      request_id: randomUUID(),
      project_ids: [project_id],
    });
    await runScanBatchPass(step);
    const result = await readScanBatch(account_id, started.operation!.op_id);
    expect(result?.counts).toEqual({ deferred: 1 });
    expect(result?.status).toBe("failed");
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: result!.children[0].request_id }),
    );
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM collaboration_scan_jobs WHERE project_id=$1",
          [project_id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  test.each(["entry_limit", "retry_limit"])(
    "lost terminal-fence acknowledgment preserves %s outcome and counters",
    async (reason) => {
      const result = await start();
      await runScanBatchPass(step);
      const run_id = result.operation!.children[0].request_id;
      status.mockResolvedValue({
        state: "partial",
        run_id,
        blocked_reason: reason,
        entries: 100,
        candidates: 3,
      });
      cancel.mockImplementationOnce(async () => {
        status.mockResolvedValue({ state: "cancelled", run_id });
        throw Error("acknowledgment lost after host stopped");
      });
      await due();
      await runScanBatchPass(step);
      expect((await api({ action: "status" })).operation?.status).toBe(
        "running",
      );
      expect((await start()).operation?.op_id).toBe(result.operation!.op_id);
      await expect(
        finishScanChild(
          {
            account_id,
            project_id,
            request_id: run_id,
            batch_id: result.operation!.op_id,
            action: "start",
          },
          authority,
          { project_id, request_id: run_id, state: "successful" },
        ),
      ).rejects.toThrow("fence not acknowledged");
      await due();
      await runScanBatchPass(step);
      const final = (await api({ action: "status" })).operation!;
      expect(final.status).toBe("failed");
      expect(final.children[0]).toMatchObject({
        state: reason === "retry_limit" ? "failed" : "truncated",
        entries: 100,
        candidates: 3,
      });
      expect(cancel).toHaveBeenCalledTimes(2);
    },
  );
});
