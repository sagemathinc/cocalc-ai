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
import { runScanRecoveryPass } from "./scan-recovery";
import {
  claimScanRecoveries,
  finishScanRecovery,
} from "@cocalc/database/postgres/collaborators/collaborators-scan-recovery";
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
  test("a late authorization rejection still charges the durable account cooldown", async () => {
    const ids = Array.from({ length: 10000 }, () => randomUUID()).sort();
    const authorize = jest.fn(async (id: string) =>
      id === ids[ids.length - 1] ? null : { project_id: id, title: "Fixture" },
    );
    const submit = () =>
      scanProjectsAtHome(
        {
          action: "start",
          account_id,
          request_id: randomUUID(),
          project_ids: ids,
        },
        authorize,
      );
    await expect(submit()).rejects.toThrow("no longer accessible");
    expect(authorize).toHaveBeenCalledTimes(10000);
    expect(
      (await scanProjectsAtHome({ action: "status", account_id }, authorize))
        .next_eligible_at,
    ).toBeGreaterThan(Date.now());
    const repeated = await submit();
    expect(repeated.next_eligible_at).toBeGreaterThan(Date.now());
    expect(repeated.operation).toBeUndefined();
    expect(authorize).toHaveBeenCalledTimes(10000);
    expect(
      (await getPool().query("SELECT op_id FROM long_running_operations")).rows,
    ).toEqual([]);
  });
  test("a pending authorization charges once and a later replay observes its winner", async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const authorize = jest.fn(async (id: string) => {
      entered();
      await held;
      return { project_id: id, title: "Fixture" };
    });
    const firstRequest = randomUUID(),
      secondRequest = randomUUID();
    const submit = (request_id: string) =>
      scanProjectsAtHome(
        { action: "start", account_id, request_id, project_ids: [project_id] },
        authorize,
      );
    const first = submit(firstRequest);
    await ready;
    try {
      const pending = await submit(secondRequest);
      expect(pending.operation).toBeUndefined();
      expect(pending.next_eligible_at).toBeGreaterThan(Date.now());
      expect(authorize).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    const admitted = await first;
    const replay = await submit(secondRequest);
    expect(replay.operation?.op_id).toBe(admitted.operation?.op_id);
    expect(authorize).toHaveBeenCalledTimes(1);
    const before = (
      await getPool().query(
        "SELECT next_eligible_at FROM collaboration_scan_batch_accounts WHERE account_id=$1",
        [account_id],
      )
    ).rows;
    await submit(firstRequest);
    expect(
      (
        await getPool().query(
          "SELECT next_eligible_at FROM collaboration_scan_batch_accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows,
    ).toEqual(before);
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
  test("lost host acknowledgement releases the batch but retains project admission until stopped", async () => {
    const result = await start();
    admit.mockRejectedValue(Error("timeout"));
    await runScanBatchPass(step);
    const final = (await api({ action: "status" })).operation!;
    expect(final.status).toBe("failed");
    expect(final.children[0]).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("stop was not confirmed"),
    });
    expect(
      (
        await getPool().query(
          "SELECT cancel_requested,recovery_pending FROM collaboration_scan_jobs",
        )
      ).rows,
    ).toEqual([{ cancel_requested: true, recovery_pending: true }]);
    cancel.mockRejectedValueOnce(Error("unreachable"));
    expect(await runScanRecoveryPass()).toMatchObject({
      attempted: 1,
      unknown: 1,
    });
    expect(await runScanRecoveryPass()).toMatchObject({ attempted: 0 });
    await getPool().query(
      "UPDATE collaboration_scan_batch_accounts SET next_eligible_at=now()-interval '1 minute'",
    );
    const retry = await start();
    expect(retry.operation?.op_id).not.toBe(result.operation?.op_id);
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.children[0].state).toBe(
      "deferred",
    );
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET recovery_after=now()-interval '1 second',recovery_until=NULL",
    );
    mockEnabled = false;
    expect(await runScanRecoveryPass()).toMatchObject({
      attempted: 1,
      stopped: 1,
    });
    expect(
      (await getPool().query("SELECT 1 FROM collaboration_scan_jobs")).rows,
    ).toHaveLength(0);
    expect(
      (await api({ action: "status", op_id: result.operation!.op_id }))
        .operation?.children[0].state,
    ).toBe("unavailable");
    expect(admit).toHaveBeenCalledTimes(1);
  });
  test.each(["before-submit", "submit", "running", "cancel"])(
    "temporary owner ingestion pressure preserves the exact scan (%s)",
    async (phase) => {
      const operation = (await start()).operation!;
      const run_id = operation.children[0].request_id;
      const busy = Error(
        "calling remote function 'getCollaborationReconciliationStatus': collaboration ingestion busy; retry later - callHub: name='collaborators.discoveryForHost', code='unknown'",
      );
      if (phase === "running" || phase === "cancel") {
        await runScanBatchPass(step);
        status.mockResolvedValue({ state: "indexing", run_id, entries: 12 });
      }
      if (phase === "cancel") {
        await api({ action: "cancel", op_id: operation.op_id });
        cancel.mockRejectedValue(busy);
      } else if (phase === "submit") {
        admit.mockRejectedValue(busy);
      } else {
        status.mockRejectedValue(busy);
      }
      await due();
      await runScanBatchPass(step);
      const pending = (await api({ action: "status" })).operation!;
      expect(pending.status).toBe("running");
      expect(pending.processed).toBe(0);
      expect(pending.children[0].request_id).toBe(run_id);
      expect(
        (
          await getPool().query(
            "SELECT job_id,cancel_requested,recovery_pending FROM collaboration_scan_jobs",
          )
        ).rows,
      ).toEqual([
        {
          job_id: run_id,
          cancel_requested: phase === "cancel",
          recovery_pending: false,
        },
      ]);
      if (phase !== "cancel") expect(cancel).not.toHaveBeenCalled();

      // Clearing pressure continues the retained request, never a replacement.
      const completed = { state: "discovered", run_id, pending_candidates: 0 };
      if (phase === "before-submit" || phase === "submit") {
        status.mockResolvedValue({ state: "unknown" });
        admit.mockImplementation(async (scan) => {
          status.mockResolvedValue(completed);
          return { admission: "accepted", run_id: scan.run_id };
        });
        // Advance only the isolated fixture's dispatch backoff.
        await getPool().query(
          "UPDATE collaboration_scan_jobs SET dispatch_until=now()-interval '1 second',last_dispatch_at=now()-interval '2 minutes'",
        );
      } else {
        status.mockResolvedValue(completed);
      }
      cancel.mockImplementation(async (scan) => ({
        state: "cancelled",
        run_id: scan.run_id,
      }));
      await due();
      await runScanBatchPass(step);
      const final = (await api({ action: "status" })).operation!;
      expect(final.op_id).toBe(operation.op_id);
      expect(final.children[0].request_id).toBe(run_id);
      expect(final.status).toBe(phase === "cancel" ? "canceled" : "succeeded");
      expect(admit).toHaveBeenCalledTimes(phase === "submit" ? 2 : 1);
      for (const [request] of admit.mock.calls)
        expect(request.run_id).toBe(run_id);
    },
  );
  test.each(["before-submit", "running", "cancel"])(
    "sustained busy responses release the account without inventing a stop (%s)",
    async (phase) => {
      const operation = (await start()).operation!;
      const request_id = operation.children[0].request_id;
      const busy = Error("collaboration ingestion busy; retry later");
      if (phase !== "before-submit") await runScanBatchPass(step);
      if (phase === "cancel") {
        await api({ action: "cancel", op_id: operation.op_id });
        cancel.mockRejectedValue(busy);
      } else status.mockRejectedValue(busy);
      await due();
      await runScanBatchPass(step);
      expect((await api({ action: "status" })).operation?.status).toBe(
        "running",
      );
      expect(
        (
          await getPool().query(
            "SELECT busy_since FROM collaboration_scan_jobs",
          )
        ).rows[0].busy_since,
      ).toBeInstanceOf(Date);
      await getPool().query(
        "UPDATE collaboration_scan_jobs SET busy_since=now()-interval '2 minutes'",
      );
      // Mere inspection does not reset the persisted pressure window.
      await step({
        account_id,
        project_id,
        request_id,
        batch_id: operation.op_id,
        action: "inspect",
      });
      await due();
      await runScanBatchPass(step);
      const final = (await api({ action: "status" })).operation!;
      expect(final.status).toBe("failed");
      expect(final.children[0]).toMatchObject({
        request_id,
        state: "unavailable",
        message: expect.stringContaining("busy"),
      });
      const jobs = (
        await getPool().query(
          "SELECT job_id,cancel_requested,recovery_pending FROM collaboration_scan_jobs",
        )
      ).rows;
      expect(jobs).toEqual(
        phase === "before-submit"
          ? []
          : [
              {
                job_id: request_id,
                cancel_requested: true,
                recovery_pending: true,
              },
            ],
      );
      if (phase !== "cancel") expect(cancel).not.toHaveBeenCalled();
    },
  );
  test("a successful host observation resets the durable busy window", async () => {
    const operation = (await start()).operation!;
    const run_id = operation.children[0].request_id;
    await runScanBatchPass(step);
    status.mockRejectedValue(
      Error("collaboration ingestion busy; retry later"),
    );
    await due();
    await runScanBatchPass(step);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET busy_since=now()-interval '2 minutes'",
    );
    status.mockResolvedValue({ state: "indexing", run_id, entries: 7 });
    await due();
    await runScanBatchPass(step);
    expect(
      (await getPool().query("SELECT busy_since FROM collaboration_scan_jobs"))
        .rows,
    ).toEqual([{ busy_since: null }]);
    status.mockRejectedValue(
      Error("collaboration ingestion busy; retry later"),
    );
    await due();
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.status).toBe("running");
    expect(cancel).not.toHaveBeenCalled();
  });
  test.each(["prior-frontier", "empty-frontier"])(
    "new admission reconciles its predecessor after a rejected earlier request (%s)",
    async (kind) => {
      const previous = randomUUID();
      const current = kind === "prior-frontier" ? randomUUID() : undefined;
      await getPool().query(
        "INSERT INTO collaboration_scan_budget(project_id,tokens,updated_at,last_job_id,last_started_at) VALUES($1,0,now(),$2,now()-interval '10 minutes')",
        [project_id, previous],
      );
      status.mockResolvedValue({ state: "unknown", current_run_id: current });
      admit.mockImplementation(async (request) => {
        if (request.expected_run_id !== current)
          throw Error("census replacement requires the current run id");
        return { admission: "accepted", run_id: request.run_id };
      });
      await start();
      await runScanBatchPass(step);
      expect(
        (await api({ action: "status" })).operation?.children[0].state,
      ).toBe("running");
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({ expected_run_id: current }),
      );
    },
  );
  test("cancel with an unreachable host ends unavailable and never reports stopped", async () => {
    const operation = (await start()).operation!;
    await runScanBatchPass(step);
    await api({ action: "cancel", op_id: operation.op_id });
    cancel.mockRejectedValue(Error("host deprovisioned"));
    await due();
    await runScanBatchPass(step);
    const final = (await api({ action: "status" })).operation!;
    expect(final.status).toBe("failed");
    expect(final.cancelling).toBe(false);
    expect(final.counts).toEqual({ unavailable: 1 });
    expect(
      (
        await getPool().query(
          "SELECT job_id,cancel_requested,recovery_pending FROM collaboration_scan_jobs",
        )
      ).rows,
    ).toEqual([
      {
        job_id: operation.children[0].request_id,
        cancel_requested: true,
        recovery_pending: true,
      },
    ]);
    // A malformed acknowledgment is not a stop, even if it says cancelled.
    cancel.mockResolvedValue({ state: "cancelled", run_id: randomUUID() });
    expect(await runScanRecoveryPass()).toMatchObject({
      unknown: 1,
      stopped: 0,
    });
    expect(
      (await getPool().query("SELECT 1 FROM collaboration_scan_jobs")).rows,
    ).toHaveLength(1);
    expect(admit).toHaveBeenCalledTimes(1);
  });
  test("a submitted empty predecessor cannot be rewritten after host state loss", async () => {
    await start();
    await runScanBatchPass(step);
    expect(admit).toHaveBeenCalledTimes(1);
    status.mockResolvedValue({
      state: "unknown",
      current_run_id: randomUUID(),
    });
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET last_dispatch_at=now()-interval '1 minute'",
    );
    await due();
    await runScanBatchPass(step);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(
      (
        await getPool().query(
          "SELECT expected_run_id FROM collaboration_scan_jobs",
        )
      ).rows,
    ).toEqual([{ expected_run_id: null }]);
  });
  test("recovery leases fence stale workers and survive loss of project membership", async () => {
    await start();
    admit.mockRejectedValue(Error("lost start acknowledgment"));
    await runScanBatchPass(step);
    const first = (await claimScanRecoveries(authority))[0];
    expect(first).toBeDefined();
    expect(await claimScanRecoveries(authority)).toHaveLength(0);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET recovery_until=now()-interval '1 second',recovery_after=now()-interval '1 second'",
    );
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [project_id],
    );
    const second = (await claimScanRecoveries(authority))[0];
    expect(second.token).not.toBe(first.token);
    expect(await finishScanRecovery(first, authority)).toBe(false);
    expect(await finishScanRecovery(second, authority)).toBe(true);
    expect(
      (
        await getPool().query(
          "SELECT result FROM collaboration_scan_receipts WHERE request_id=$1",
          [first.job_id],
        )
      ).rows[0].result.state,
    ).toBe("unavailable");
  });
  test("retained unavailable hosts do not exhaust active bay capacity for healthy hosts", async () => {
    for (let i = 0; i < 8; i++) {
      const id = randomUUID(),
        host = randomUUID();
      await getPool().query(
        "INSERT INTO projects(project_id,owning_bay_id,host_id) VALUES($1,$2,$3)",
        [id, authority.owning_bay_id, host],
      );
      await getPool().query(
        "INSERT INTO collaboration_scan_jobs(project_id,slot,job_id,state,created_at,started_at,host_id,cancel_requested,recovery_pending) VALUES($1,0,$2,'running',now(),now(),$3,true,true)",
        [id, randomUUID(), host],
      );
    }
    await start();
    await runScanBatchPass(step);
    expect(admit).toHaveBeenCalledTimes(1);
    expect((await api({ action: "status" })).operation?.children[0].state).toBe(
      "running",
    );
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM collaboration_scan_jobs WHERE recovery_pending",
        )
      ).rows,
    ).toHaveLength(8);
  });
  test("unreachable storage before submission ends unavailable and fences replay", async () => {
    const result = await start();
    const request: ScanChildRequest = {
      account_id,
      project_id,
      batch_id: result.operation!.op_id,
      request_id: result.operation!.children[0].request_id,
      action: "start",
    };
    status.mockRejectedValue(Error("retired host is unreachable"));
    await runScanBatchPass(step);
    const final = (await api({ action: "status" })).operation!;
    expect(final.processed).toBe(1);
    expect(final.counts.unavailable).toBe(1);
    expect(final.status).toBe("failed");
    expect(final.children[0].message).toContain("before scan submission");
    expect(admit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect((await step(request)).state).toBe("unavailable");
    expect(
      (await getPool().query("SELECT * FROM collaboration_scan_jobs")).rows,
    ).toEqual([]);
    expect((await start()).next_eligible_at).toBeGreaterThan(Date.now());
  });
  test("cancel during a delayed read probe fences the stale worker without a host RPC", async () => {
    const result = await start();
    const request: ScanChildRequest = {
      account_id,
      project_id,
      batch_id: result.operation!.op_id,
      request_id: result.operation!.children[0].request_id,
      action: "start",
    };
    let resume!: () => void;
    let probing!: () => void;
    const entered = new Promise<void>((resolve) => {
      probing = resolve;
    });
    status.mockImplementationOnce(async () => {
      probing();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return { state: "unknown" };
    });
    const running = step(request);
    await entered;
    try {
      expect((await step({ ...request, action: "cancel" })).state).toBe(
        "cancelled",
      );
    } finally {
      resume();
    }
    expect((await running).state).toBe("cancelled");
    expect(admit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect((await step(request)).state).toBe("cancelled");
  });
  test("legacy ambiguous execution cannot be cleared by a failed read probe", async () => {
    const result = await start();
    const request: ScanChildRequest = {
      account_id,
      project_id,
      batch_id: result.operation!.op_id,
      request_id: result.operation!.children[0].request_id,
      action: "start",
    };
    await prepareScanChild(request, authority);
    // The schema default is conservative for pre-boundary writers and migrated jobs.
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET host_request_started=DEFAULT",
    );
    status.mockRejectedValue(Error("unknown remote state"));
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.status).toBe("failed");
    expect(
      (
        await getPool().query(
          "SELECT host_request_started FROM collaboration_scan_jobs",
        )
      ).rows[0].host_request_started,
    ).toBe(true);
    await api({ action: "cancel", op_id: result.operation!.op_id });
    cancel.mockRejectedValue(Error("no acknowledgment"));
    await due();
    await runScanBatchPass(step);
    expect((await api({ action: "status" })).operation?.children[0].state).toBe(
      "unavailable",
    );
    expect(
      (
        await getPool().query(
          "SELECT recovery_pending FROM collaboration_scan_jobs",
        )
      ).rows[0].recovery_pending,
    ).toBe(true);
    expect(admit).not.toHaveBeenCalled();
  });
  test("an older dispatch writer makes a new job ambiguous before it can send", async () => {
    const result = await start();
    const request: ScanChildRequest = {
      account_id,
      project_id,
      batch_id: result.operation!.op_id,
      request_id: result.operation!.children[0].request_id,
      action: "start",
    };
    await prepareScanChild(request, authority);
    // Pre-boundary workers only write dispatch_token. The database protects a
    // mixed-version deployment even though that code cannot set the new flag.
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET dispatch_token=$1,dispatch_until=now()+interval '90 seconds'",
      [randomUUID()],
    );
    expect(
      (
        await getPool().query(
          "SELECT host_request_started FROM collaboration_scan_jobs",
        )
      ).rows[0].host_request_started,
    ).toBe(true);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET host_request_started=false",
    );
    expect(
      (
        await getPool().query(
          "SELECT host_request_started FROM collaboration_scan_jobs",
        )
      ).rows[0].host_request_started,
    ).toBe(true);
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
        "failed",
      );
      // Observing a terminal foreground receipt is not permission to release
      // the retained execution. A separate exact host acknowledgment is needed.
      await finishScanChild(
        {
          account_id,
          project_id,
          request_id: run_id,
          batch_id: result.operation!.op_id,
          action: "start",
        },
        authority,
        { project_id, request_id: run_id, state: "successful" },
      );
      expect(
        (await getPool().query("SELECT 1 FROM collaboration_scan_jobs")).rows,
      ).toHaveLength(1);
      expect(await runScanRecoveryPass()).toMatchObject({ stopped: 1 });
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
