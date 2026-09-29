/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  admitCollaborationScan,
  inspectCollaborationScan,
  startCollaborationScan,
  settleCollaborationScanDiscovery,
  readCollaborationScanStatus,
  claimCollaborationScanDispatch,
  releaseCollaborationScanDispatch,
  listCollaborationScanDispatchCandidates,
  adoptCollaborationScanPredecessor,
  retireExpiredQueuedCollaborationScan,
  listCollaborationScanRetirementCandidates,
  syncCollaborationScanSchema,
} from "./collaborators-scan";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const authority = { owning_bay_id: "scan-test" };
const host_id = randomUUID();
describeDb("owner scan admission prototype", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationScanSchema(getPool());
  }, 60_000);
  afterAll(async () => {
    await getPool().end();
  });
  beforeEach(async () => {
    await getPool().query(
      "TRUNCATE collaboration_scan_jobs,collaboration_scan_receipts,collaboration_scan_budget",
    );
    await getPool().query(
      "DELETE FROM collaboration_maintenance WHERE id LIKE 'scan-dispatch:%' OR id LIKE 'scan-retire:%'",
    );
  });
  async function fixture() {
    const request = {
      project_id: randomUUID(),
      account_id: randomUUID(),
      request_id: randomUUID(),
      mode: "reconcile" as const,
    };
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,users,host_id) VALUES($1,$2,$3::jsonb,$4)",
      [
        request.project_id,
        authority.owning_bay_id,
        JSON.stringify({ [request.account_id]: { group: "collaborator" } }),
        host_id,
      ],
    );
    return request;
  }
  test("retirement preserves live coalesced receipts and expired retry history", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const job = { project_id: request.project_id, job_id: receipt.job_id };
    const follow = { ...request, request_id: randomUUID() };
    await admitCollaborationScan(follow, authority);
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",
      [request.request_id],
    );
    expect(await retireExpiredQueuedCollaborationScan(job, authority)).toBe(
      false,
    );
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    await expect(
      retireExpiredQueuedCollaborationScan(job, { owning_bay_id: "wrong" }),
    ).rejects.toThrow();
    expect(await retireExpiredQueuedCollaborationScan(job, authority)).toBe(
      true,
    );
    expect(await retireExpiredQueuedCollaborationScan(job, authority)).toBe(
      false,
    );
    expect(
      (
        await getPool().query(
          "SELECT count(*)::integer AS n FROM collaboration_scan_receipts WHERE project_id=$1",
          [request.project_id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(await inspectCollaborationScan(request, authority)).toBeNull();
    await expect(admitCollaborationScan(request, authority)).rejects.toThrow(
      "expired",
    );
  });
  test("expired running work cannot be retired as an unstarted queue entry", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const job = { ...request, job_id: receipt.job_id };
    await startCollaborationScan(job, authority);
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(await retireExpiredQueuedCollaborationScan(job, authority)).toBe(
      false,
    );
    expect(
      (
        await getPool().query(
          "SELECT state FROM collaboration_scan_jobs WHERE job_id=$1",
          [receipt.job_id],
        )
      ).rows,
    ).toEqual([{ state: "running" }]);
  });
  test("retirement cursor examines bounded pages and wraps independently of dispatch", async () => {
    const jobs: string[] = [];
    for (let i = 0; i < 25; i++) {
      const request = await fixture();
      const receipt = await admitCollaborationScan(request, authority);
      if (!("job_id" in receipt)) throw Error("expected admission");
      jobs.push(receipt.job_id);
    }
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second'",
    );
    const first = await listCollaborationScanRetirementCandidates(authority);
    expect(first).toHaveLength(20);
    await listCollaborationScanDispatchCandidates(authority);
    const second = await listCollaborationScanRetirementCandidates(authority);
    expect(second).toHaveLength(5);
    expect([...first, ...second].map((job) => job.job_id).sort()).toEqual(
      jobs.sort(),
    );
    expect(
      (await listCollaborationScanRetirementCandidates(authority))
        .map((job) => job.job_id)
        .sort(),
    ).toEqual(first.map((job) => job.job_id).sort());
  });
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
  test("predecessor adoption is lease-fenced and cannot rewrite an established boundary", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const job = { ...request, job_id: receipt.job_id };
    await startCollaborationScan(job, authority);
    const token = (await claimCollaborationScanDispatch(job, authority))!;
    const opts = { ...job, token, predecessor: randomUUID() };
    const writer = { ...authority, host_id };
    expect(
      await adoptCollaborationScanPredecessor(
        { ...opts, token: randomUUID() },
        writer,
      ),
    ).toBe(false);
    expect(await adoptCollaborationScanPredecessor(opts, writer)).toBe(true);
    expect(await adoptCollaborationScanPredecessor(opts, writer)).toBe(true);
    expect(
      await adoptCollaborationScanPredecessor(
        { ...opts, predecessor: randomUUID() },
        writer,
      ),
    ).toBe(false);
    expect(await startCollaborationScan(job, authority)).toMatchObject({
      expected_run_id: opts.predecessor,
    });
  });
  test("cursor advances past a blocked page to eligible work and wraps", async () => {
    await getPool().query(
      "TRUNCATE collaboration_scan_jobs,collaboration_scan_receipts,collaboration_scan_budget",
    );
    await getPool().query("DELETE FROM collaboration_maintenance WHERE id=$1", [
      `scan-dispatch:${authority.owning_bay_id}`,
    ]);
    const requests: Array<
      Awaited<ReturnType<typeof fixture>> & { job_id: string }
    > = [];
    for (let n = 0; n < 25; n++) {
      const request = await fixture();
      const receipt = await admitCollaborationScan(request, authority);
      if (!("job_id" in receipt)) throw Error("expected admission");
      requests.push({ ...request, job_id: receipt.job_id });
    }
    requests.sort((a, b) => a.job_id.localeCompare(b.job_id));
    const eligible = requests[24];
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=ANY($1::uuid[])",
      [requests.slice(0, 24).map((r) => r.project_id)],
    );
    expect(await listCollaborationScanDispatchCandidates(authority)).toEqual(
      [],
    );
    expect(
      await listCollaborationScanDispatchCandidates(authority),
    ).toContainEqual({
      project_id: eligible.project_id,
      job_id: eligible.job_id,
      account_id: eligible.account_id,
      request_id: eligible.request_id,
    });
    expect(await listCollaborationScanDispatchCandidates(authority)).toEqual(
      [],
    );
  });
  test("queue selection respects owner, receipts, membership, and recent dispatch", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const candidate = {
      project_id: request.project_id,
      job_id: receipt.job_id,
      account_id: request.account_id,
      request_id: request.request_id,
    };
    expect(
      await listCollaborationScanDispatchCandidates(authority),
    ).toContainEqual(candidate);
    expect(
      await listCollaborationScanDispatchCandidates({ owning_bay_id: "other" }),
    ).not.toContainEqual(candidate);
    await startCollaborationScan(
      { ...request, job_id: receipt.job_id },
      authority,
    );
    const token = await claimCollaborationScanDispatch(candidate, authority);
    expect(
      await listCollaborationScanDispatchCandidates(authority),
    ).not.toContainEqual(candidate);
    await releaseCollaborationScanDispatch(
      { ...candidate, token: token! },
      authority,
    );
    expect(
      await listCollaborationScanDispatchCandidates(authority),
    ).not.toContainEqual(candidate);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET last_dispatch_at=clock_timestamp()-interval '6 seconds' WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      await listCollaborationScanDispatchCandidates(authority),
    ).toContainEqual(candidate);
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      await listCollaborationScanDispatchCandidates(authority),
    ).not.toContainEqual(candidate);
  });
  test("dispatch lease excludes concurrent workers and stale release cannot clear takeover", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const job = { ...request, job_id: receipt.job_id };
    expect(await claimCollaborationScanDispatch(job, authority)).toBeNull();
    await startCollaborationScan(job, authority);
    const claims = await Promise.all([
      claimCollaborationScanDispatch(job, authority),
      claimCollaborationScanDispatch(job, authority),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET dispatch_until=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    const second = await claimCollaborationScanDispatch(job, authority);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await releaseCollaborationScanDispatch({ ...job, token: first }, authority);
    expect(await claimCollaborationScanDispatch(job, authority)).toBeNull();
    await releaseCollaborationScanDispatch(
      { ...job, token: second! },
      authority,
    );
    expect(await claimCollaborationScanDispatch(job, authority)).not.toBeNull();
  });
  test("status follows discovery lifecycle without mutating receipts or budget", async () => {
    const request = await fixture();
    expect(
      await readCollaborationScanStatus(
        { ...request, job_id: randomUUID() },
        authority,
      ),
    ).toEqual({ state: "unknown" });
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const status = { ...request, job_id: receipt.job_id };
    const budget = (
      await getPool().query(
        "SELECT * FROM collaboration_scan_budget WHERE project_id=$1",
        [request.project_id],
      )
    ).rows;
    expect(await readCollaborationScanStatus(status, authority)).toEqual({
      state: "queued",
    });
    const started = await startCollaborationScan(status, authority);
    expect(await readCollaborationScanStatus(status, authority)).toEqual({
      state: "running",
      started_at: started?.started_at,
    });
    await settleCollaborationScanDiscovery(
      { ...status, state: "discovered" },
      { ...authority, host_id },
    );
    const result = await readCollaborationScanStatus(status, authority);
    expect(result).toEqual({
      state: "discovered",
      settled_at: expect.any(Number),
    });
    expect(await readCollaborationScanStatus(status, authority)).toEqual(
      result,
    );
    expect(await inspectCollaborationScan(request, authority)).toEqual(receipt);
    const after = (
      await getPool().query(
        "SELECT * FROM collaboration_scan_budget WHERE project_id=$1",
        [request.project_id],
      )
    ).rows;
    expect(after[0].tokens).toBe(budget[0].tokens);
    expect(after[0].updated_at).toEqual(budget[0].updated_at);
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(await readCollaborationScanStatus(status, authority)).toEqual({
      state: "unknown",
    });
  });
  test("status requires the caller's own receipt and current membership", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const other = randomUUID();
    await getPool().query(
      "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
      [
        request.project_id,
        JSON.stringify({ [other]: { group: "collaborator" } }),
      ],
    );
    expect(
      await readCollaborationScanStatus(
        { ...request, account_id: other, job_id: receipt.job_id },
        authority,
      ),
    ).toEqual({ state: "unknown" });
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    await expect(
      readCollaborationScanStatus(
        { ...request, job_id: receipt.job_id },
        authority,
      ),
    ).rejects.toThrow();
  });
  test("host discovery settlement preserves receipts and rejects conflicting or stale reports", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const report = {
      project_id: request.project_id,
      job_id: receipt.job_id,
      state: "discovered" as const,
    };
    const writer = { ...authority, host_id };
    expect(await settleCollaborationScanDiscovery(report, writer)).toBe(false);
    await startCollaborationScan(
      { ...request, job_id: receipt.job_id },
      authority,
    );
    await expect(
      settleCollaborationScanDiscovery(report, {
        ...writer,
        host_id: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await settleCollaborationScanDiscovery(report, writer)).toBe(true);
    expect(await settleCollaborationScanDiscovery(report, writer)).toBe(true);
    expect(
      await settleCollaborationScanDiscovery(
        { ...report, state: "failed" },
        writer,
      ),
    ).toBe(false);
    expect(await inspectCollaborationScan(request, authority)).toEqual(receipt);
    expect(await admitCollaborationScan(request, authority)).toEqual(receipt);
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_scan_jobs WHERE project_id=$1",
          [request.project_id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await getPool().query(
          "SELECT result FROM collaboration_scan_receipts WHERE project_id=$1",
          [request.project_id],
        )
      ).rows[0].result.state,
    ).toBe("discovered");
  });
  test("host replacement cannot settle or replay the old execution", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const start = { ...request, job_id: receipt.job_id };
    await startCollaborationScan(start, authority);
    const replacement = randomUUID();
    await getPool().query(
      "UPDATE projects SET host_id=$2 WHERE project_id=$1",
      [request.project_id, replacement],
    );
    await expect(startCollaborationScan(start, authority)).rejects.toThrow(
      "host changed",
    );
    expect(
      await settleCollaborationScanDiscovery(
        {
          project_id: request.project_id,
          job_id: receipt.job_id,
          state: "discovered",
        },
        { ...authority, host_id: replacement },
      ),
    ).toBe(false);
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
    expect(receipts.filter((r) => r.admission === "coalesced")).toHaveLength(1);
    expect(receipts.filter((r) => r.admission === "throttled")).toHaveLength(6);
    expect(
      new Set(receipts.flatMap((r) => ("job_id" in r ? [r.job_id] : []))).size,
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
  test("running work allows one immediate follow-up queue", async () => {
    const request = await fixture();
    await admitCollaborationScan(request, authority);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET state='running' WHERE project_id=$1",
      [request.project_id],
    );
    const next = { ...request, request_id: randomUUID() };
    expect((await admitCollaborationScan(next, authority)).admission).toBe(
      "accepted",
    );
    await getPool().query(
      "UPDATE collaboration_scan_budget SET updated_at=clock_timestamp()-interval '6 minutes' WHERE project_id=$1",
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
  test("shared project bucket refills while replay consumes no tokens", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    const other = randomUUID();
    await getPool().query(
      "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
      [
        request.project_id,
        JSON.stringify({ [other]: { group: "collaborator" } }),
      ],
    );
    await admitCollaborationScan(
      { ...request, account_id: other, request_id: randomUUID() },
      authority,
    );
    expect(await admitCollaborationScan(request, authority)).toEqual(receipt);
    const next = { ...request, request_id: randomUUID() };
    expect((await admitCollaborationScan(next, authority)).admission).toBe(
      "throttled",
    );
    await getPool().query(
      "UPDATE collaboration_scan_budget SET updated_at=clock_timestamp()-interval '61 seconds' WHERE project_id=$1",
      [request.project_id],
    );
    expect((await admitCollaborationScan(next, authority)).admission).toBe(
      "coalesced",
    );
    expect(
      (
        await admitCollaborationScan(
          { ...next, request_id: randomUUID() },
          authority,
        )
      ).admission,
    ).toBe("throttled");
  });
  test("backward clock does not refill a depleted bucket", async () => {
    const request = await fixture();
    await admitCollaborationScan(request, authority);
    await getPool().query(
      "UPDATE collaboration_scan_budget SET tokens=0,updated_at=clock_timestamp()+interval '5 minutes' WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      (
        await admitCollaborationScan(
          { ...request, request_id: randomUUID() },
          authority,
        )
      ).admission,
    ).toBe("throttled");
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
  test("execution boundary is stable and concurrent starts cannot create a second run", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const start = { ...request, job_id: receipt.job_id };
    const results = await Promise.all([
      startCollaborationScan(start, authority),
      startCollaborationScan(start, authority),
    ]);
    expect(results.filter((r) => r?.replayed === false)).toHaveLength(1);
    expect(results.filter((r) => r?.replayed === true)).toHaveLength(1);
    expect(results[0]?.started_at).toBe(results[1]?.started_at);
    await getPool().query(
      "UPDATE collaboration_scan_jobs SET started_at=clock_timestamp()-interval '6 minutes' WHERE project_id=$1",
      [request.project_id],
    );
    const follow = { ...request, request_id: randomUUID() };
    const followReceipt = await admitCollaborationScan(follow, authority);
    if (!("job_id" in followReceipt)) throw Error("expected follow-up");
    expect(followReceipt.job_id).not.toBe(receipt.job_id);
    expect(
      await startCollaborationScan(
        { ...follow, job_id: followReceipt.job_id },
        authority,
      ),
    ).toBeNull();
  });
  test("starting requires a live matching receipt and current membership", async () => {
    const request = await fixture();
    const receipt = await admitCollaborationScan(request, authority);
    if (!("job_id" in receipt)) throw Error("expected admission");
    const start = { ...request, job_id: receipt.job_id };
    expect(
      await startCollaborationScan(
        { ...start, request_id: randomUUID() },
        authority,
      ),
    ).toBeNull();
    expect(
      await startCollaborationScan(
        { ...start, job_id: randomUUID() },
        authority,
      ),
    ).toBeNull();
    await getPool().query(
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(await startCollaborationScan(start, authority)).toBeNull();
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    await expect(startCollaborationScan(start, authority)).rejects.toThrow();
    expect(
      (
        await getPool().query(
          "SELECT state FROM collaboration_scan_jobs WHERE project_id=$1",
          [request.project_id],
        )
      ).rows[0].state,
    ).toBe("queued");
  });
  test("execution cooldown survives active-job removal and slots alternate safely", async () => {
    const request = await fixture();
    const first = await admitCollaborationScan(request, authority);
    if (!("job_id" in first)) throw Error("expected admission");
    await startCollaborationScan(
      { ...request, job_id: first.job_id },
      authority,
    );
    const next = { ...request, request_id: randomUUID() };
    const second = await admitCollaborationScan(next, authority);
    if (!("job_id" in second)) throw Error("expected follow-up");
    // Simulate settlement; no dispatcher is wired yet.
    await getPool().query(
      "DELETE FROM collaboration_scan_jobs WHERE job_id=$1",
      [first.job_id],
    );
    expect(
      await startCollaborationScan(
        { ...next, job_id: second.job_id },
        authority,
      ),
    ).toBeNull();
    await getPool().query(
      "UPDATE collaboration_scan_budget SET last_started_at=clock_timestamp()-interval '6 minutes',updated_at=clock_timestamp()-interval '6 minutes' WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      await startCollaborationScan(
        { ...next, job_id: second.job_id },
        authority,
      ),
    ).toMatchObject({ replayed: false });
    const third = await admitCollaborationScan(
      { ...request, request_id: randomUUID() },
      authority,
    );
    expect(third.admission).toBe("accepted");
    const rows = (
      await getPool().query(
        "SELECT slot,state FROM collaboration_scan_jobs WHERE project_id=$1 ORDER BY slot",
        [request.project_id],
      )
    ).rows;
    expect(rows).toEqual([
      { slot: 0, state: "queued" },
      { slot: 1, state: "running" },
    ]);
  });
  test("new admissions reclaim at most 64 expired receipts without touching live retries", async () => {
    const request = await fixture();
    const live = await admitCollaborationScan(request, authority);
    const ids = Array.from({ length: 80 }, () => randomUUID());
    await getPool().query(
      `INSERT INTO collaboration_scan_receipts(project_id,account_id,request_id,mode,receipt,expires_at)
      SELECT $1,$2,id,'reconcile','{}'::jsonb,clock_timestamp()-interval '1 day'
      FROM unnest($3::uuid[]) id`,
      [request.project_id, request.account_id, ids],
    );
    const countExpired = async () =>
      (
        await getPool().query(
          "SELECT count(*)::integer AS n FROM collaboration_scan_receipts WHERE project_id=$1 AND expires_at<clock_timestamp()",
          [request.project_id],
        )
      ).rows[0].n;
    expect(
      await inspectCollaborationScan(
        { ...request, request_id: ids[0] },
        authority,
      ),
    ).toBeNull();
    expect(await admitCollaborationScan(request, authority)).toEqual(live);
    expect(await countExpired()).toBe(80);
    await admitCollaborationScan(
      { ...request, request_id: randomUUID() },
      authority,
    );
    expect(await countExpired()).toBe(16);
    expect(await inspectCollaborationScan(request, authority)).toEqual(live);
    // Depleted-budget calls cannot turn into an unbounded cleanup endpoint.
    expect(
      (
        await admitCollaborationScan(
          { ...request, request_id: randomUUID() },
          authority,
        )
      ).admission,
    ).toBe("throttled");
    expect(await countExpired()).toBe(16);
  });
});
