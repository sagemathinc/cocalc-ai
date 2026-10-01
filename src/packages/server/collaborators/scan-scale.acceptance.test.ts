import {
  scanDispatchCandidatesSql,
  scanDispatchPageSql,
  scanRetirementCandidatesSql,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { MultibayAcceptance } from "./acceptance/harness";
import { randomUUID } from "node:crypto";
const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("scan blocked backlog query cost", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    await env.worker("owner").call("installScan");
    await env.worker("a").call("installScan");
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  test("actor budget serializes retries and competing projects in PostgreSQL", async () => {
    const request = {
      account_id: env.accounts[0],
      project_id: randomUUID(),
      request_id: randomUUID(),
      mode: "check",
    };
    const reserve = (value: object) =>
      env.worker("a").call("scanActorRace", { request: value });
    const retries = await Promise.all(
      Array.from({ length: 12 }, () => reserve(request)),
    );
    expect(retries[0].reserved).toBe(true);
    for (const result of retries) expect(result).toEqual(retries[0]);
    const competing = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserve({ ...request, project_id: randomUUID() }),
      ),
    );
    expect(competing.filter((result) => result.reserved)).toHaveLength(1);
    const throttled = competing.filter((result) => !result.reserved);
    expect(throttled).toHaveLength(11);
    for (const result of throttled)
      expect(result.retry_after_ms).toBeGreaterThan(0);
    expect(await reserve(request)).toEqual(retries[0]);
    expect(
      await env.sql(
        "a",
        "SELECT count(*)::integer AS n FROM collaboration_scan_actor_receipts WHERE account_id=$1",
        [request.account_id],
      ),
    ).toEqual([{ n: 2 }]);
    for (const table of [
      "collaboration_scan_actor_receipts",
      "collaboration_scan_actor_budget",
    ])
      await env.sql("a", `DELETE FROM ${table} WHERE account_id=$1`, [
        request.account_id,
      ]);
  }, 120000);
  test("real PostgreSQL serializes admission and lease races", async () => {
    const request = {
      project_id: env.project,
      account_id: env.accounts[0],
      request_id: randomUUID(),
      mode: "reconcile",
    };
    const call = (operation: string, value: object) =>
      env.worker("owner").call("scanRace", { operation, request: value });
    const retries = await Promise.all(
      Array.from({ length: 12 }, () => call("admit", request)),
    );
    expect(
      retries.every(
        (result) => JSON.stringify(result) === JSON.stringify(retries[0]),
      ),
    ).toBe(true);
    expect(retries[0].admission).toBe("accepted");
    const distinct = await Promise.all(
      Array.from({ length: 12 }, () =>
        call("admit", { ...request, request_id: randomUUID() }),
      ),
    );
    expect(
      distinct.filter((result) => result.admission === "coalesced"),
    ).toHaveLength(1);
    expect(
      distinct.filter((result) => result.admission === "throttled"),
    ).toHaveLength(11);
    const job = { ...request, job_id: retries[0].job_id };
    await call("start", job);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => call("claim", job)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean);
    await env.sql(
      "owner",
      "UPDATE collaboration_scan_jobs SET dispatch_until=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [env.project],
    );
    const next = await call("claim", job);
    expect(next).not.toBeNull();
    expect(next).not.toBe(first);
    await call("release", { ...job, token: first });
    expect(await call("claim", job)).toBeNull();
    for (const table of [
      "collaboration_scan_jobs",
      "collaboration_scan_receipts",
      "collaboration_scan_budget",
    ])
      await env.sql("owner", `DELETE FROM ${table} WHERE project_id=$1`, [
        env.project,
      ]);
  }, 120000);
  test("retirement racing admission and execution preserves live work", async () => {
    const call = (operation: string, request: object) =>
      env.worker("owner").call("scanRace", { operation, request });
    for (let iteration = 0; iteration < 8; iteration++) {
      const request = {
        project_id: env.project,
        account_id: env.accounts[0],
        request_id: randomUUID(),
        mode: "check",
      };
      const old = await call("admit", request);
      await env.sql(
        "owner",
        "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 day' WHERE project_id=$1",
        [env.project],
      );
      const fresh = { ...request, request_id: randomUUID() };
      const oldJob = { project_id: env.project, job_id: old.job_id };
      const [retired, receipt] = await Promise.all([
        call("retire", oldJob),
        call("admit", fresh),
      ]);
      expect(receipt.admission).toBe(retired ? "accepted" : "coalesced");
      if (retired) expect(receipt.job_id).not.toBe(old.job_id);
      else expect(receipt.job_id).toBe(old.job_id);
      expect(
        await env.sql(
          "owner",
          "SELECT job_id,state FROM collaboration_scan_jobs WHERE project_id=$1",
          [env.project],
        ),
      ).toEqual([{ job_id: receipt.job_id, state: "queued" }]);
      const job = { ...fresh, job_id: receipt.job_id };
      const [started, ...retirements] = await Promise.all([
        call("start", job),
        ...Array.from({ length: 8 }, () => call("retire", job)),
      ]);
      expect(started).toMatchObject({
        job_id: receipt.job_id,
        replayed: false,
      });
      expect(retirements).toEqual(Array(8).fill(false));
      expect(
        await env.sql(
          "owner",
          "SELECT state FROM collaboration_scan_jobs WHERE job_id=$1",
          [receipt.job_id],
        ),
      ).toEqual([{ state: "running" }]);
      for (const table of [
        "collaboration_scan_jobs",
        "collaboration_scan_receipts",
        "collaboration_scan_budget",
      ])
        await env.sql("owner", `DELETE FROM ${table} WHERE project_id=$1`, [
          env.project,
        ]);
    }
  }, 120000);
  test("retirement lock timeout leaves queued work intact and retryable", async () => {
    const request = {
      project_id: env.project,
      account_id: env.accounts[0],
      request_id: randomUUID(),
      mode: "check",
    };
    const call = (operation: string, value: object) =>
      env.worker("owner").call("scanRace", { operation, request: value });
    const receipt = await call("admit", request);
    const job = { project_id: env.project, job_id: receipt.job_id };
    await env.sql(
      "owner",
      "UPDATE collaboration_scan_receipts SET expires_at=clock_timestamp()-interval '1 day' WHERE project_id=$1",
      [env.project],
    );
    await env.worker("owner").call("scanProjectLock");
    try {
      await expect(call("retire", job)).rejects.toThrow("lock timeout");
      expect(
        await env.sql(
          "owner",
          "SELECT state FROM collaboration_scan_jobs WHERE job_id=$1",
          [job.job_id],
        ),
      ).toEqual([{ state: "queued" }]);
    } finally {
      await env.worker("owner").call("scanProjectLock", { release: true });
    }
    expect(await call("retire", job)).toBe(true);
    for (const table of [
      "collaboration_scan_receipts",
      "collaboration_scan_budget",
    ])
      await env.sql("owner", `DELETE FROM ${table} WHERE project_id=$1`, [
        env.project,
      ]);
  }, 120000);
  test("public Scan traverses home and owner without resubmitting inspection", async () => {
    const request = {
      project_id: env.project,
      account_id: randomUUID(),
      request_id: randomUUID(),
      mode: "check",
      route: { bay_id: "forged" },
    };
    const invoke = (method: string, value: object, agent = false) =>
      env.worker("b").call("scanPublic", { method, request: value, agent });
    try {
      await expect(invoke("requestScan", request, true)).rejects.toThrow(
        "signed in",
      );
      const receipt = await invoke("requestScan", request);
      expect(receipt.admission).toBe("accepted");
      expect(await invoke("requestScan", request)).toEqual(receipt);
      expect(await invoke("inspectScan", request)).toEqual({
        allowed: true,
        value: receipt,
        poll_after_ms: 1000,
      });
      const status = { project_id: env.project, job_id: receipt.job_id };
      expect(await invoke("getScanStatus", status)).toEqual({
        allowed: true,
        value: { state: "queued" },
        poll_after_ms: 1000,
      });
      expect(
        await invoke("inspectScan", { ...request, request_id: randomUUID() }),
      ).toEqual({ allowed: true, value: null, poll_after_ms: 1000 });
      await env.sql(
        "a",
        "UPDATE collaboration_scan_actor_budget SET read_tokens=0,read_updated_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1",
        [env.accounts[0]],
      );
      const denied = await invoke("getScanStatus", status);
      expect(denied.allowed).toBe(false);
      expect(denied.retry_after_ms).toBeGreaterThan(3500000);
      expect(
        await env.sql(
          "owner",
          "SELECT account_id,count(*)::integer AS n FROM collaboration_scan_receipts WHERE project_id=$1 GROUP BY account_id",
          [env.project],
        ),
      ).toEqual([{ account_id: env.accounts[0], n: 1 }]);
      expect(
        await env.sql(
          "a",
          "SELECT count(*)::integer AS n FROM collaboration_scan_actor_receipts WHERE account_id=$1",
          [env.accounts[0]],
        ),
      ).toEqual([{ n: 1 }]);
    } finally {
      for (const table of [
        "collaboration_scan_jobs",
        "collaboration_scan_receipts",
        "collaboration_scan_budget",
      ])
        await env.sql("owner", `DELETE FROM ${table} WHERE project_id=$1`, [
          env.project,
        ]);
      for (const table of [
        "collaboration_scan_actor_receipts",
        "collaboration_scan_actor_budget",
      ])
        await env.sql("a", `DELETE FROM ${table} WHERE account_id=$1`, [
          env.accounts[0],
        ]);
    }
  }, 120000);
  test("authenticated fabric routes actor reservation at home to the project owner", async () => {
    const request = {
      project_id: env.project,
      account_id: env.accounts[0],
      request_id: randomUUID(),
      mode: "check",
    };
    const invoke = (value: object, bay_id = env.bays[1]) =>
      env.worker("b").call("scanHome", { request: value, bay_id });
    const receipt = await invoke(request);
    expect(receipt.admission).toBe("accepted");
    expect(await invoke(request)).toEqual(receipt);
    expect(
      await env.sql(
        "a",
        "SELECT count(*)::integer AS n FROM collaboration_scan_actor_receipts WHERE account_id=$1",
        [request.account_id],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_scan_receipts WHERE project_id=$1",
        [env.project],
      ),
    ).toEqual([{ n: 1 }]);
    await expect(invoke(request, env.bays[0])).rejects.toThrow("stale");
    await expect(invoke({ ...request, mode: "reconcile" })).rejects.toThrow(
      "different arguments",
    );
    await env.sql(
      "owner",
      "UPDATE projects SET users=users-$2 WHERE project_id=$1",
      [env.project, request.account_id],
    );
    await expect(invoke(request)).rejects.toThrow("access denied");
    for (const table of [
      "collaboration_scan_jobs",
      "collaboration_scan_receipts",
      "collaboration_scan_budget",
    ])
      await env.sql("owner", `DELETE FROM ${table} WHERE project_id=$1`, [
        env.project,
      ]);
  }, 120000);
  test("measures 10000 blocked active jobs", async () => {
    await env.sql(
      "owner",
      `INSERT INTO projects(project_id,owning_bay_id,host_id,users)
      SELECT md5('scan-scale-'||n)::uuid,$1,$2,'{}'::jsonb FROM generate_series(1,10000) n`,
      [env.bays[0], env.host],
    );
    await env.sql(
      "owner",
      `INSERT INTO collaboration_scan_budget(project_id,tokens,updated_at)
      SELECT md5('scan-scale-'||n)::uuid,2,now() FROM generate_series(1,10000) n`,
    );
    await env.sql(
      "owner",
      `INSERT INTO collaboration_scan_jobs(project_id,slot,job_id,state,created_at)
      SELECT md5('scan-scale-'||n)::uuid,0,md5('scan-job-'||n)::uuid,'queued',now() FROM generate_series(1,10000) n`,
    );
    for (const table of [
      "projects",
      "collaboration_scan_jobs",
      "collaboration_scan_budget",
      "collaboration_scan_receipts",
    ])
      await env.sql("owner", `ANALYZE ${table}`);
    const page = await env.sql("owner", scanDispatchPageSql, [
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(page).toHaveLength(20);
    const rows = await env.sql(
      "owner",
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${scanDispatchCandidatesSql}`,
      [env.bays[0], page.map((row) => row.job_id)],
    );
    const explain = rows[0]["QUERY PLAN"][0];
    process.stdout.write(
      JSON.stringify({ scenario: "10000-no-live-receipt", explain }) + "\n",
    );
    expect(explain.Plan["Actual Rows"]).toBe(0);
    expect(
      (explain.Plan["Shared Hit Blocks"] ?? 0) +
        (explain.Plan["Shared Read Blocks"] ?? 0),
    ).toBeLessThan(2000);
    const measureRetirement = async (
      scenario: string,
      expectedRows: number,
    ) => {
      const rows = await env.sql(
        "owner",
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${scanRetirementCandidatesSql}`,
        [env.bays[0], page.map((row) => row.job_id)],
      );
      const explain = rows[0]["QUERY PLAN"][0];
      process.stdout.write(JSON.stringify({ scenario, explain }) + "\n");
      expect(explain.Plan["Actual Rows"]).toBe(expectedRows);
      expect(
        (explain.Plan["Shared Hit Blocks"] ?? 0) +
          (explain.Plan["Shared Read Blocks"] ?? 0),
      ).toBeLessThan(2000);
    };
    await measureRetirement("retirement-10000-no-receipts", 20);
    await env.sql(
      "owner",
      `INSERT INTO collaboration_scan_receipts(project_id,account_id,request_id,mode,receipt,expires_at)
      SELECT md5('scan-scale-'||n)::uuid,$1,md5('receipt-'||n||'-'||r)::uuid,'check',
        jsonb_build_object('job_id',md5('scan-job-'||n)::uuid),now()+interval '1 day'
      FROM generate_series(1,10000) n CROSS JOIN generate_series(1,10) r`,
      [env.accounts[0]],
    );
    await env.sql("owner", "ANALYZE collaboration_scan_receipts");
    await measureRetirement("retirement-10000-jobs-100000-live-receipts", 0);
    await env.sql(
      "owner",
      "UPDATE collaboration_scan_receipts SET expires_at=now()-interval '1 day'",
    );
    await measureRetirement("retirement-100000-expired-stale-statistics", 20);
    await env.sql("owner", "ANALYZE collaboration_scan_receipts");
    await measureRetirement("retirement-100000-expired-fresh-statistics", 20);
  }, 120000);
});
