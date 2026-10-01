/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CensusReportQueue } from "./census-report-queue";
import {
  CensusQuotaError,
  DEFAULT_CENSUS_LIMITS,
  DEFAULT_CENSUS_CAPACITY,
} from "./census-types";
import type {
  CensusCapacity,
  CensusCandidate,
  CensusRequest,
  CensusRun,
  CensusStatus,
  CensusPreviousRun,
  CensusWork,
} from "./census-types";

// Reserve summary + report retry space before admitting traversal, so a full
// frontier cannot prevent reporting its own capacity failure.
const RUN_RESERVE = 8192;
type CompactStatus = Omit<CensusStatus, "run" | "started_at" | "previous">;

function bounded(value: string, max = 2048) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    throw Error("invalid census identifier or path");
  return value;
}
function absolute(value: string) {
  bounded(value);
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value)
    throw Error("census paths must be canonical absolute paths");
  return value;
}
function within(root: string, path: string) {
  return path === root || path.startsWith(root === "/" ? "/" : root + "/");
}
function normalized(request: CensusRequest): CensusRun {
  const limits = { ...DEFAULT_CENSUS_LIMITS, ...request.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)
      throw Error("invalid census limit");
  const root = absolute(request.root);
  if ((request.excluded_paths?.length ?? 0) > 100)
    throw Error("too many census exclusions");
  const excluded_paths = [...new Set(request.excluded_paths ?? [])].sort();
  for (const path of excluded_paths)
    if (!within(root, absolute(path)) || path === root)
      throw Error("census exclusion must be below its root");
  return {
    project_id: bounded(request.project_id, 200),
    run_id: bounded(request.run_id, 200),
    authority: bounded(request.authority, 512),
    volume_id: bounded(request.volume_id, 512),
    root,
    policy_version: bounded(request.policy_version, 200),
    excluded_paths,
    limits,
  };
}
function pageLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid census page limit");
}
export function censusErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : "IO_ERROR";
}
function retryAt(now: number, failures: number) {
  return now + Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
}

/** Host-private metadata only. No method opens project files or starts a worker. */
export class CollaborationCensusStore {
  private reportQueue?: CensusReportQueue;
  /** One queue row fits the per-run reserve. */
  reportWorkQueue(): CensusReportQueue {
    return (this.reportQueue ??= new CensusReportQueue(this.db));
  }
  private readonly db: DatabaseSync;
  private readonly lock: DatabaseSync;
  private closed = false;

  constructor(
    filename: string,
    private readonly capacity: CensusCapacity = DEFAULT_CENSUS_CAPACITY,
  ) {
    if (
      !Number.isSafeInteger(capacity.projects) ||
      capacity.projects < 1 ||
      !Number.isSafeInteger(capacity.bytes) ||
      capacity.bytes < 1
    )
      throw Error("invalid census store capacity");
    this.lock = new DatabaseSync(filename + ".lock");
    let db: DatabaseSync | undefined;
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock(id INTEGER)",
      );
      this.db = db = new DatabaseSync(filename);
      this.db.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS census_runs (
          project_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request TEXT NOT NULL,
          turn INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
          directories INTEGER NOT NULL DEFAULT 0, entries INTEGER NOT NULL DEFAULT 0,
          candidates INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL DEFAULT 0, last_success INTEGER, last_fail INTEGER,
          compact_status TEXT, previous_status TEXT, reserved_bytes INTEGER NOT NULL DEFAULT 0,
          blocked_reason TEXT);
        CREATE TABLE IF NOT EXISTS census_cancellations (
          project_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id,run_id));
        CREATE TABLE IF NOT EXISTS census_reports (
          project_id TEXT PRIMARY KEY REFERENCES census_runs(project_id) ON DELETE CASCADE,
          value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS census_directories (
          project_id TEXT NOT NULL REFERENCES census_runs(project_id) ON DELETE CASCADE,
          path TEXT NOT NULL, depth INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          entries INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0, error TEXT, turn INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(project_id,path));
        CREATE INDEX IF NOT EXISTS census_directories_due ON census_directories(state,retry_at,turn);
        CREATE TABLE IF NOT EXISTS census_candidates (
          project_id TEXT NOT NULL REFERENCES census_runs(project_id) ON DELETE CASCADE,
          chat_path TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
          retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, error TEXT,
          PRIMARY KEY(project_id,chat_path));
        CREATE INDEX IF NOT EXISTS census_candidates_due ON census_candidates(acknowledged,retry_at,project_id,chat_path);
      `);
    } catch (error) {
      db?.close();
      this.lock.close();
      throw error;
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(project_id: string) {
    return this.db
      .prepare("SELECT * FROM census_runs WHERE project_id=?")
      .get(project_id);
  }

  /** Project-level incremental scan watermark; host loss causes a full scan. */
  scanTimes(project_id: string): { last_success?: number; last_fail?: number } {
    const row = this.row(project_id);
    return {
      ...(row?.last_success == null
        ? {}
        : { last_success: Number(row.last_success) }),
      ...(row?.last_fail == null ? {} : { last_fail: Number(row.last_fail) }),
    };
  }

  finishScan(run: Pick<CensusRun, "project_id" | "run_id">, success: boolean) {
    const field = success ? "last_success" : "last_fail";
    this.db
      .prepare(
        `UPDATE census_runs SET ${field}=started_at
      WHERE project_id=? AND run_id=? AND (last_success IS NULL OR last_success<started_at)`,
      )
      .run(run.project_id, run.run_id);
  }

  /** A durable tombstone also fences a request that has not arrived yet. */
  cancel(run: Pick<CensusRun, "project_id" | "run_id">) {
    bounded(run.project_id, 200);
    bounded(run.run_id, 200);
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO census_cancellations VALUES(?,?)")
        .run(run.project_id, run.run_id);
      if (this.row(run.project_id)?.run_id !== run.run_id) return;
      this.db
        .prepare(
          "UPDATE census_runs SET blocked_reason='cancelled' WHERE project_id=?",
        )
        .run(run.project_id);
      this.db
        .prepare(
          "DELETE FROM census_candidates WHERE project_id=? AND acknowledged=0",
        )
        .run(run.project_id);
    });
  }

  isCancelled(run: Pick<CensusRun, "project_id" | "run_id">): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM census_cancellations WHERE project_id=? AND run_id=?",
      )
      .get(run.project_id, run.run_id);
  }

  isCurrent(run: Pick<CensusRun, "project_id" | "run_id">): boolean {
    return (
      !this.isCancelled(run) && this.row(run.project_id)?.run_id === run.run_id
    );
  }

  canContinue(work: CensusWork): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM census_directories d JOIN census_runs r USING(project_id)
      WHERE r.project_id=? AND r.run_id=? AND r.blocked_reason IS NULL AND d.path=? AND d.state='pending'`,
      )
      .get(work.run.project_id, work.run.run_id, work.path);
  }

  /** Owner adapter authorizes before enqueueing; replacement invalidates old ACKs. */
  begin(
    request: CensusRequest,
    expectedRunId?: string,
    now = Date.now(),
    previous?: CensusPreviousRun,
  ): CensusRun {
    const run = normalized(request);
    if (this.isCancelled(run)) throw Error("census run cancelled");
    const json = JSON.stringify(run);
    const priorSummary = previous ? JSON.stringify(previous) : null;
    if (priorSummary && Buffer.byteLength(priorSummary) > 2048)
      throw Error("census previous summary exceeds reserve");
    return this.transaction(() => {
      const current = this.row(run.project_id);
      if (current?.run_id === run.run_id) {
        if (current.request !== json)
          throw Error("census run id reused with different scope");
        return run;
      }
      if (
        current ? current.run_id !== expectedRunId : expectedRunId !== undefined
      )
        throw Error("census replacement requires the current run id");
      if (
        !current &&
        Number(
          this.db.prepare("SELECT count(*) n FROM census_runs").get()!.n,
        ) >= this.capacity.projects
      )
        throw new CensusQuotaError("project_limit");
      const prior = current ? JSON.parse(String(current.request)) : undefined;
      const sameVolume =
        prior?.authority === run.authority &&
        prior?.volume_id === run.volume_id &&
        prior?.root === run.root;
      this.db
        .prepare("DELETE FROM census_runs WHERE project_id=?")
        .run(run.project_id);
      this.db
        .prepare(
          "INSERT INTO census_runs(project_id,run_id,request,started_at,reserved_bytes,previous_status,last_success,last_fail) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          run.project_id,
          run.run_id,
          json,
          now,
          RUN_RESERVE,
          priorSummary,
          sameVolume ? current!.last_success : null,
          sameVolume ? current!.last_fail : null,
        );
      this.charge(run.project_id, Buffer.byteLength(json) + 128 + RUN_RESERVE);
      this.addDirectory(run, run.root, 0);
      return run;
    });
  }

  /** Explicit same-volume rescan only. Drain old candidate/report intents before
   * replacing unfinished traversal; preserve the prior summary and source journal. */
  rescan(
    request: CensusRequest,
    expectedRunId: string,
    now = Date.now(),
  ): CensusRun | undefined {
    const next = normalized(request);
    const status = this.status(next.project_id);
    if (!status || status.run.run_id !== expectedRunId)
      throw Error("census rescan requires the current run id");
    if (
      status.run.authority !== next.authority ||
      status.run.volume_id !== next.volume_id ||
      status.run.root !== next.root
    )
      throw Error("census rescan scope changed");
    if (status.pending_candidates) return;
    const report = this.reportCheckpoint(next.project_id);
    if (report && JSON.parse(report).acknowledged !== true) return;
    const { run, started_at, previous: _previous, ...progress } = status;
    return this.begin(request, expectedRunId, now, {
      ...progress,
      run_id: run.run_id,
      policy_version: run.policy_version,
      started_at,
    });
  }

  reportCheckpoint(project_id: string): string | undefined {
    return this.db
      .prepare("SELECT value FROM census_reports WHERE project_id=?")
      .get(project_id)?.value as string | undefined;
  }

  setReportCheckpoint(project_id: string, value: string) {
    if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
      throw Error("invalid census report checkpoint");
    this.db
      .prepare(
        `INSERT INTO census_reports(project_id,value) VALUES(?,?)
      ON CONFLICT(project_id) DO UPDATE SET value=excluded.value`,
      )
      .run(project_id, value);
  }

  /** Charged logical metadata, including reserved report/checkpoint space. */
  usage() {
    const row = this.db
      .prepare(
        `SELECT count(*) projects,COALESCE(sum(bytes),0) bytes,
      COALESCE(sum(compact_status IS NULL),0) frontiers FROM census_runs`,
      )
      .get()!;
    return {
      projects: Number(row.projects),
      frontiers: Number(row.frontiers),
      bytes: Number(row.bytes),
      capacity: { ...this.capacity },
    };
  }

  /** Reclaim only finished, durably handed-off frontiers. Summaries and report
   * retries remain in this database; receipts remain in the source journal. */
  compactCompleted(limit = 16): number {
    pageLimit(limit);
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT r.project_id FROM census_runs r
        WHERE compact_status IS NULL AND blocked_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM census_directories d WHERE d.project_id=r.project_id AND d.state<>'complete')
        AND NOT EXISTS (SELECT 1 FROM census_candidates c WHERE c.project_id=r.project_id AND c.acknowledged=0)
        ORDER BY r.turn,r.project_id LIMIT ?`,
        )
        .all(limit);
      for (const row of rows) {
        const project_id = String(row.project_id);
        const {
          run,
          started_at: _started,
          previous: _previous,
          ...summary
        } = this.status(project_id)!;
        const json = JSON.stringify(summary satisfies CompactStatus);
        if (Buffer.byteLength(json) > 2048)
          throw Error("census compact summary exceeds reserve");
        this.db
          .prepare(
            `UPDATE census_runs SET compact_status=?,bytes=? WHERE project_id=?`,
          )
          .run(
            json,
            Buffer.byteLength(JSON.stringify(run)) + 128 + RUN_RESERVE,
            project_id,
          );
        for (const table of ["directories", "candidates"])
          this.db
            .prepare(`DELETE FROM census_${table} WHERE project_id=?`)
            .run(project_id);
      }
      return rows.length;
    });
  }

  /** Byte pressure can clear after compaction/operator budget increases. Never
   * reset a semantic per-run quota or discard an unfinished directory. */
  retryCapacityBlocked(now: number, limit = 16) {
    pageLimit(limit);
    if (this.usage().bytes + 64 * 1024 > this.capacity.bytes) return;
    this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT r.project_id FROM census_runs r
        WHERE blocked_reason='byte_limit' AND EXISTS (
          SELECT 1 FROM census_directories d WHERE d.project_id=r.project_id AND d.error='byte_limit' AND retry_at<=?)
        ORDER BY r.turn,r.project_id LIMIT ?`,
        )
        .all(now, limit);
      for (const { project_id } of rows) {
        this.db
          .prepare(
            "UPDATE census_runs SET blocked_reason=NULL WHERE project_id=?",
          )
          .run(project_id);
        this.db
          .prepare(
            "UPDATE census_directories SET state='pending',error=NULL WHERE project_id=? AND error='byte_limit'",
          )
          .run(project_id);
      }
    });
  }

  private charge(project_id: string, bytes: number) {
    const total = this.usage().bytes;
    if (total + bytes > this.capacity.bytes)
      throw new CensusQuotaError("byte_limit");
    this.db
      .prepare("UPDATE census_runs SET bytes=bytes+? WHERE project_id=?")
      .run(bytes, project_id);
  }

  private addDirectory(run: CensusRun, path: string, depth: number) {
    this.charge(run.project_id, Buffer.byteLength(path) + 128);
    this.db
      .prepare(
        "INSERT INTO census_directories(project_id,path,depth) VALUES(?,?,?)",
      )
      .run(run.project_id, path, depth);
    this.db
      .prepare("UPDATE census_runs SET directories=1 WHERE project_id=?")
      .run(run.project_id);
  }

  /** One filename search per admitted project; oldest turn runs first. */
  next(now: number): CensusWork | undefined {
    const row = this.db
      .prepare(
        `SELECT r.request,d.path,d.depth FROM census_directories d
      JOIN census_runs r USING(project_id) WHERE d.state='pending' AND d.retry_at<=?
      AND r.blocked_reason IS NULL ORDER BY r.turn,d.project_id LIMIT 1`,
      )
      .get(now);
    if (!row) return;
    const run: CensusRun = JSON.parse(String(row.request));
    const turn = Number(
      this.db
        .prepare("SELECT COALESCE(MAX(turn),0)+1 n FROM census_runs")
        .get()!.n,
    );
    this.db
      .prepare("UPDATE census_runs SET turn=? WHERE project_id=?")
      .run(turn, run.project_id);
    this.db
      .prepare(
        "UPDATE census_directories SET turn=? WHERE project_id=? AND path=?",
      )
      .run(turn, run.project_id, row.path);
    return { run, path: String(row.path), depth: Number(row.depth) };
  }

  /** A single bounded filename search replaces the per-entry traversal frontier. */
  recordDiscovery(run: CensusRun, paths: string[]): boolean {
    if (paths.length > run.limits.candidates)
      throw new CensusQuotaError("candidate_limit");
    const unique = [...new Set(paths)];
    for (const path of unique) {
      absolute(path);
      if (
        !within(run.root, path) ||
        path === run.root ||
        !/\.chat$/.test(path) ||
        run.excluded_paths.some((root) => within(root, path)) ||
        posix.relative(run.root, path).split("/").includes(".snapshots")
      )
        throw Error("invalid discovered chat path");
    }
    return this.transaction(() => {
      if (
        !this.isCurrent(run) ||
        !this.canContinue({ run, path: run.root, depth: 0 })
      )
        return false;
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO census_candidates(project_id,chat_path) VALUES(?,?)",
      );
      let bytes = 0;
      for (const path of unique) {
        if (insert.run(run.project_id, path).changes)
          bytes += Buffer.byteLength(path) + 128;
      }
      const count = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM census_candidates WHERE project_id=?",
          )
          .get(run.project_id)!.n,
      );
      if (count > run.limits.candidates)
        throw new CensusQuotaError("candidate_limit");
      this.charge(run.project_id, bytes);
      // Commit the filename snapshot and mark its one discovery work item complete.
      this.db
        .prepare("DELETE FROM census_directories WHERE project_id=?")
        .run(run.project_id);
      this.db
        .prepare(
          "INSERT INTO census_directories(project_id,path,depth,state) VALUES(?,?,0,'complete')",
        )
        .run(run.project_id, run.root);
      this.db
        .prepare(
          "UPDATE census_runs SET directories=1,entries=0,candidates=(SELECT count(*) FROM census_candidates WHERE project_id=?) WHERE project_id=?",
        )
        .run(run.project_id, run.project_id);
      return true;
    });
  }

  hasDiscoveryWork(now: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM census_runs r WHERE r.blocked_reason IS NULL AND
      (EXISTS (SELECT 1 FROM census_directories d WHERE d.project_id=r.project_id AND d.state='pending' AND d.retry_at<=?)
      OR EXISTS (SELECT 1 FROM census_candidates c WHERE c.project_id=r.project_id AND c.acknowledged=0 AND c.retry_at<=?)) LIMIT 1`,
      )
      .get(now, now);
  }

  fail(work: CensusWork, error: unknown, now: number) {
    this.transaction(() => {
      if (!this.isCurrent(work.run)) return;
      const quota = error instanceof CensusQuotaError ? error : undefined;
      const row = this.db
        .prepare(
          "SELECT failures FROM census_directories WHERE project_id=? AND path=? AND state='pending'",
        )
        .get(work.run.project_id, work.path);
      if (!row) return;
      const failures = Number(row.failures);
      this.db
        .prepare(
          "UPDATE census_directories SET state=?,error=?,failures=?,retry_at=? WHERE project_id=? AND path=?",
        )
        .run(
          quota || failures >= 2 ? "blocked" : "pending",
          quota?.reason ?? censusErrorCode(error),
          Math.min(30, failures + 1),
          retryAt(now, failures),
          work.run.project_id,
          work.path,
        );
      if (failures >= 2 && !quota)
        this.db
          .prepare(
            "UPDATE census_runs SET blocked_reason='retry_limit' WHERE project_id=?",
          )
          .run(work.run.project_id);
      if (quota?.entireRun)
        this.db
          .prepare("UPDATE census_runs SET blocked_reason=? WHERE project_id=?")
          .run(quota.reason, work.run.project_id);
    });
  }

  /** At-least-once handoff; ACK only after the existing source journal durably accepts it. */
  candidates(now = Date.now(), limit = 100): CensusCandidate[] {
    pageLimit(limit);
    return this.db
      .prepare(
        `SELECT c.project_id,r.run_id,c.chat_path FROM census_candidates c
      JOIN census_runs r USING(project_id) WHERE (r.blocked_reason IS NULL OR r.blocked_reason NOT IN ('cancelled')) AND c.acknowledged=0 AND c.retry_at<=?
      ORDER BY c.retry_at,c.project_id,c.chat_path LIMIT ?`,
      )
      .all(now, limit) as unknown as CensusCandidate[];
  }

  acknowledge(candidate: CensusCandidate): boolean {
    if (!this.isCurrent(candidate)) return false;
    return (
      Number(
        this.db
          .prepare(
            "UPDATE census_candidates SET acknowledged=1,error=NULL,failures=0 WHERE project_id=? AND chat_path=?",
          )
          .run(candidate.project_id, candidate.chat_path).changes,
      ) > 0
    );
  }

  deferCandidate(
    candidate: CensusCandidate,
    error: unknown,
    now = Date.now(),
  ): boolean {
    if (!this.isCurrent(candidate)) return false;
    const row = this.db
      .prepare(
        "SELECT failures FROM census_candidates WHERE project_id=? AND chat_path=? AND acknowledged=0",
      )
      .get(candidate.project_id, candidate.chat_path);
    if (!row) return false;
    if (Number(row.failures) >= 2)
      this.db
        .prepare(
          "UPDATE census_runs SET blocked_reason='retry_limit' WHERE project_id=?",
        )
        .run(candidate.project_id);
    this.db
      .prepare(
        "UPDATE census_candidates SET failures=?,retry_at=?,error=? WHERE project_id=? AND chat_path=?",
      )
      .run(
        Math.min(30, Number(row.failures) + 1),
        retryAt(now, Number(row.failures)),
        censusErrorCode(error),
        candidate.project_id,
        candidate.chat_path,
      );
    return true;
  }

  status(project_id: string): CensusStatus | undefined {
    const row = this.row(project_id);
    if (!row) return;
    const previous = row.previous_status
      ? {
          previous: JSON.parse(
            String(row.previous_status),
          ) as CensusPreviousRun,
        }
      : {};
    if (row.compact_status)
      return {
        ...JSON.parse(String(row.compact_status)),
        run: JSON.parse(String(row.request)),
        started_at: Number(row.started_at),
        ...previous,
      };
    const directories = this.db
      .prepare(
        `SELECT count(*) total,
      COALESCE(SUM(state='complete'),0) complete, COALESCE(SUM(state='blocked'),0) blocked,
      COALESCE(SUM(error IS NOT NULL),0) errors FROM census_directories WHERE project_id=?`,
      )
      .get(project_id)!;
    const candidates = this.db
      .prepare(
        "SELECT count(*) total,COALESCE(SUM(acknowledged=0),0) pending,COALESCE(SUM(error IS NOT NULL),0) errors FROM census_candidates WHERE project_id=?",
      )
      .get(project_id)!;
    const traversal_complete = directories.total === directories.complete;
    const errors = Number(directories.errors) + Number(candidates.errors);
    return {
      run: JSON.parse(String(row.request)),
      started_at: Number(row.started_at),
      ...previous,
      coverage:
        row.blocked_reason || errors
          ? "partial"
          : traversal_complete && !candidates.pending
            ? "complete"
            : "indexing",
      traversal_complete,
      directories: Number(directories.total),
      completed_directories: Number(directories.complete),
      blocked_directories: Number(directories.blocked),
      entries: 0,
      candidates: Number(candidates.total),
      pending_candidates: Number(candidates.pending),
      excluded_entries: 0,
      skipped_symlinks: 0,
      errors,
      ...(row.blocked_reason
        ? { blocked_reason: String(row.blocked_reason) }
        : {}),
    };
  }

  /** Bounded metadata-only round robin for telemetry; no filesystem access. */
  nextProject(after = ""): string | undefined {
    return this.db
      .prepare(
        "SELECT project_id FROM census_runs WHERE project_id>? ORDER BY project_id LIMIT 1",
      )
      .get(after)?.project_id as string | undefined;
  }

  /** Caller must drain/close its engine first. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock.close();
  }
}
