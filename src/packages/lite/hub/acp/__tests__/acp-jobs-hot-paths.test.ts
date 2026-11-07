/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The per-delivery and per-sweep acp_jobs lookups: they use their indexes,
// tolerate malformed request_json, and return what the earlier queries did.

import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  __acpJobsHotPathSqlForTests as SQL,
  acpThreadJobSummary,
  ensureAcpJobsHotPathIndexes,
  listAcpJobsForAgentRpcAttempt,
} from "../../sqlite/acp-jobs";

const P = "11111111-1111-4111-8111-111111111111";
const PATH = "a.chat";
const THREAD = "thread-1";
const thread = { project_id: P, path: PATH, thread_id: THREAD };
let seq = 0;

function insertJob(
  db: ReturnType<typeof getAcpDatabase>,
  {
    account_id = "acct-a",
    thread_id = THREAD,
    state = "completed",
    finished_at = null as number | null,
    started_at = null as number | null,
    request_json = "{}",
    created_at,
  }: {
    account_id?: string | null;
    thread_id?: string;
    state?: string;
    finished_at?: number | null;
    started_at?: number | null;
    request_json?: string;
    created_at?: number;
  } = {},
): string {
  seq += 1;
  const op_id = `op-${seq}`;
  db.prepare(
    `INSERT INTO acp_jobs (op_id, project_id, account_id, path, thread_id,
       user_message_id, assistant_message_id, assistant_message_date, state,
       request_json, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    op_id,
    P,
    account_id,
    PATH,
    thread_id,
    `user-${seq}`,
    `assistant-${seq}`,
    `2026-11-05T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    state,
    request_json,
    created_at ?? seq,
    created_at ?? seq,
    started_at,
    finished_at,
  );
  return op_id;
}

const rpc = (attempt_id: string) =>
  JSON.stringify({ chat: { agent_rpc_execution: { attempt_id } } });

// The queries acpThreadJobSummary ran before (for equivalence).
function oldSummary(db: ReturnType<typeof getAcpDatabase>) {
  const args = [P, PATH, THREAD];
  const counts = db
    .prepare(
      `SELECT SUM(state = 'running') AS running, SUM(state = 'queued') AS queued,
              MIN(CASE WHEN state = 'running' THEN started_at END) AS running_since
       FROM acp_jobs WHERE project_id = ? AND path = ? AND thread_id = ?`,
    )
    .get(...args) as any;
  const last = db
    .prepare(
      `SELECT * FROM acp_jobs
       WHERE project_id = ? AND path = ? AND thread_id = ?
         AND state IN ('completed', 'error', 'canceled', 'interrupted')
         AND finished_at IS NOT NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...args);
  const lastByAccount: Record<string, any> = {};
  for (const row of db
    .prepare(
      `SELECT *, MAX(finished_at) AS latest_finished_at FROM acp_jobs
       WHERE project_id = ? AND path = ? AND thread_id = ?
         AND state IN ('completed', 'error', 'canceled', 'interrupted')
         AND finished_at IS NOT NULL AND account_id IS NOT NULL
       GROUP BY account_id LIMIT 100`,
    )
    .all(...args) as any[]) {
    const { latest_finished_at: _l, ...job } = row;
    lastByAccount[`${job.account_id}`] = job;
  }
  const runningByAccount: Record<string, number> = {};
  for (const row of db
    .prepare(
      `SELECT account_id, COUNT(*) AS n FROM acp_jobs
       WHERE project_id = ? AND path = ? AND thread_id = ?
         AND state = 'running' AND account_id IS NOT NULL
       GROUP BY account_id`,
    )
    .all(...args) as any[])
    runningByAccount[row.account_id] = Number(row.n);
  return {
    running: Number(counts?.running ?? 0),
    queued: Number(counts?.queued ?? 0),
    ...(last ? { last } : {}),
    lastByAccount,
    runningByAccount,
    ...(counts?.running_since ? { runningSince: counts.running_since } : {}),
  };
}

function plan(sql: string, ...args: unknown[]): string {
  return (
    getAcpDatabase()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args) as { detail: string }[]
  )
    .map((row) => row.detail)
    .join(" | ");
}

describe("acp_jobs hot paths", () => {
  beforeAll(() => {
    closeAcpDatabase();
    initAcpDatabase({ filename: ":memory:" });
    // Creates the table and its indexes.
    listAcpJobsForAgentRpcAttempt({ attempt_id: "x", account_id: "y" });
  });

  afterEach(() => {
    getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
  });

  afterAll(() => closeAcpDatabase());

  describe("query plans", () => {
    it("the attempt lookup uses its partial expression index", () => {
      expect(plan(SQL.attemptLookup, "acct-a", "attempt-1")).toContain(
        "USING INDEX acp_jobs_agent_rpc_attempt_idx",
      );
    });

    it("the thread's running/queued counts read only those rows", () => {
      expect(plan(SQL.threadActiveCounts, P, PATH, THREAD)).toContain(
        "acp_jobs_thread_state_idx (project_id=? AND path=? AND thread_id=? AND state=?)",
      );
    });

    it("the thread's latest finished job uses the finished-jobs index", () => {
      expect(plan(SQL.threadLastFinished, P, PATH, THREAD)).toContain(
        "acp_jobs_thread_finished_idx",
      );
    });

    it("each account's latest finished time is read from the index alone", () => {
      expect(
        plan(SQL.threadLatestFinishedByAccount, P, PATH, THREAD),
      ).toContain("USING COVERING INDEX acp_jobs_thread_finished_account_idx");
      expect(
        plan(SQL.threadAccountLastFinished, P, PATH, THREAD, "acct-a", 1),
      ).toContain("acp_jobs_thread_finished_account_idx");
    });
  });

  describe("the attempt lookup", () => {
    it("returns that account's jobs for the attempt, oldest first; another account's never", () => {
      const db = getAcpDatabase();
      const second = insertJob(db, {
        request_json: rpc("attempt-1"),
        created_at: 20,
      });
      const first = insertJob(db, {
        request_json: rpc("attempt-1"),
        created_at: 10,
      });
      insertJob(db, { request_json: rpc("attempt-2") });
      insertJob(db, { account_id: "acct-b", request_json: rpc("attempt-1") });
      insertJob(db, { request_json: "{}" });
      expect(
        listAcpJobsForAgentRpcAttempt({
          attempt_id: "attempt-1",
          account_id: "acct-a",
        }).map((job) => job.op_id),
      ).toEqual([first, second]);
    });

    it("rows with malformed request_json do not break the lookup", () => {
      const db = getAcpDatabase();
      insertJob(db, { request_json: "{not json" });
      const ok = insertJob(db, { request_json: rpc("attempt-1") });
      expect(
        listAcpJobsForAgentRpcAttempt({
          attempt_id: "attempt-1",
          account_id: "acct-a",
        }).map((job) => job.op_id),
      ).toEqual([ok]);
    });

    it("the index can be built over a table that already has malformed rows", () => {
      const db = getAcpDatabase();
      db.exec("DROP INDEX acp_jobs_agent_rpc_attempt_idx");
      insertJob(db, { request_json: "{not json" });
      const ok = insertJob(db, { request_json: rpc("attempt-1") });
      expect(() => ensureAcpJobsHotPathIndexes(db)).not.toThrow();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          )
          .get("acp_jobs_agent_rpc_attempt_idx"),
      ).toBeTruthy();
      expect(
        listAcpJobsForAgentRpcAttempt({
          attempt_id: "attempt-1",
          account_id: "acct-a",
        }).map((job) => job.op_id),
      ).toEqual([ok]);
    });
  });

  describe("the thread summary", () => {
    it("an empty thread", () => {
      expect(acpThreadJobSummary(thread)).toEqual({
        running: 0,
        queued: 0,
        lastByAccount: {},
        runningByAccount: {},
      });
      expect(acpThreadJobSummary(thread)).toEqual(oldSummary(getAcpDatabase()));
    });

    it("matches the earlier queries on a mixed thread", () => {
      const db = getAcpDatabase();
      const states = ["completed", "error", "canceled", "interrupted"];
      let t = 1_000;
      for (let i = 0; i < 40; i++) {
        insertJob(db, {
          account_id: `acct-${i % 7}`,
          state: states[i % 4],
          finished_at: (t += 10),
        });
      }
      insertJob(db, { account_id: "acct-1", state: "running", started_at: 50 });
      insertJob(db, { account_id: "acct-2", state: "running", started_at: 40 });
      insertJob(db, { account_id: "acct-2", state: "queued" });
      insertJob(db, { account_id: "acct-3", state: "queued" });
      // Finished state without finished_at, and another thread: never counted.
      insertJob(db, { account_id: "acct-4", state: "completed" });
      insertJob(db, {
        account_id: "acct-9",
        thread_id: "other",
        finished_at: 99_999,
      });
      const summary = acpThreadJobSummary(thread);
      expect(summary).toEqual(oldSummary(db));
      expect(summary).toMatchObject({
        running: 2,
        queued: 2,
        runningSince: 40,
        runningByAccount: { "acct-1": 1, "acct-2": 1 },
      });
      expect(Object.keys(summary.lastByAccount).sort()).toEqual(
        Array.from({ length: 7 }, (_, i) => `acct-${i}`),
      );
    });

    it("a tie on finished_at picks the newest row, for last and per account", () => {
      const db = getAcpDatabase();
      insertJob(db, { account_id: "acct-a", finished_at: 500 });
      const newer = insertJob(db, { account_id: "acct-a", finished_at: 500 });
      const summary = acpThreadJobSummary(thread);
      expect(summary.last?.op_id).toBe(newer);
      expect(summary.lastByAccount["acct-a"].op_id).toBe(newer);
    });

    it("more than 100 accounts: the first 100 by account id, as before", () => {
      const db = getAcpDatabase();
      for (let i = 0; i < 120; i++) {
        insertJob(db, {
          account_id: `acct-${String(i).padStart(3, "0")}`,
          finished_at: 1_000 + i,
        });
      }
      const summary = acpThreadJobSummary(thread);
      expect(Object.keys(summary.lastByAccount)).toHaveLength(100);
      expect(Object.keys(summary.lastByAccount).sort()).toEqual(
        Object.keys(oldSummary(db).lastByAccount).sort(),
      );
      expect(summary).toEqual(oldSummary(db));
    });
  });
});

describe("a table from before account_id was required", () => {
  it("rows without an account are left out of the per-account parts, as before", () => {
    jest.isolateModules(() => {
      const database = require("../../sqlite/acp-database");
      const jobs = require("../../sqlite/acp-jobs");
      database.closeAcpDatabase();
      database.initAcpDatabase({ filename: ":memory:" });
      const db = database.getAcpDatabase();
      // The original shape: account_id is added later, nullable.
      db.exec(`CREATE TABLE acp_jobs (
        op_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
        thread_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL, assistant_message_date TEXT NOT NULL,
        session_id TEXT, state TEXT NOT NULL, send_mode TEXT,
        priority INTEGER NOT NULL DEFAULT 0, request_json TEXT NOT NULL,
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        started_at INTEGER, finished_at INTEGER,
        UNIQUE(project_id, path, user_message_id))`);
      jobs.listAcpJobsForAgentRpcAttempt({ attempt_id: "x", account_id: "y" });
      const withAccount = insertJob(db, {
        account_id: "acct-a",
        finished_at: 100,
      });
      const withoutAccount = insertJob(db, {
        account_id: null,
        finished_at: 200,
      });
      insertJob(db, { account_id: null, state: "running", started_at: 5 });
      const summary = jobs.acpThreadJobSummary(thread);
      expect(summary.last.op_id).toBe(withoutAccount);
      expect(Object.keys(summary.lastByAccount)).toEqual(["acct-a"]);
      expect(summary.lastByAccount["acct-a"].op_id).toBe(withAccount);
      expect(summary.runningByAccount).toEqual({});
      expect(summary.running).toBe(1);
      expect(summary).toEqual(oldSummary(db));
      database.closeAcpDatabase();
    });
  });
});
