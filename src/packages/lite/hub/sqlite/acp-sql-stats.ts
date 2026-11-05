/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Time spent in acp.sqlite, per statement. The database is synchronous, so
// every statement blocks its process's event loop; slow single statements
// are logged already, and these totals show which statements add up. Keys
// are the statements as prepared (with ? placeholders), never their values.

export interface SqlStatementStat {
  sql: string;
  calls: number;
  total_ms: number;
  max_ms: number;
}

export interface SqlStatsReport {
  window_ms: number;
  total_ms: number;
  calls: number;
  distinct: number;
  // Statements not tracked on their own because the window already had the
  // maximum number of distinct ones (their time is in "(other)").
  overflow_calls: number;
  top: SqlStatementStat[];
}

export const OTHER_SQL = "(other)";
// Every db.exec, whatever its text.
export const EXEC_SQL = "(exec)";

/**
 * The key a statement's time is counted under: a prepared statement's SQL
 * (with ? placeholders; callers interpolate only identifiers), and one fixed
 * key for every exec, whose text can hold literals such as a file name.
 */
export function statementStatsKey(
  op: "exec" | "run" | "all" | "get",
  sql: string,
): string {
  return op === "exec"
    ? EXEC_SQL
    : sql.replace(/\s+/g, " ").trim().slice(0, 200);
}

export class SqlStatementStats {
  private stats = new Map<string, SqlStatementStat>();
  private windowStart: number;
  private overflowCalls = 0;

  constructor(
    private readonly opts: {
      // Report every this many ms (0 disables everything).
      windowMs: number;
      // Report only a window that spent at least this long in sqlite.
      minTotalMs: number;
      maxKeys: number;
      top: number;
    },
    now: number,
  ) {
    this.windowStart = now;
  }

  get enabled(): boolean {
    return this.opts.windowMs > 0;
  }

  /** Records one statement; returns the finished window's report, if due. */
  record(
    sql: string,
    elapsedMs: number,
    now: number,
  ): SqlStatsReport | undefined {
    if (!this.enabled) return undefined;
    let key = sql;
    if (!this.stats.has(key) && this.stats.size >= this.opts.maxKeys) {
      key = OTHER_SQL;
      this.overflowCalls += 1;
    }
    const stat = this.stats.get(key) ?? {
      sql: key,
      calls: 0,
      total_ms: 0,
      max_ms: 0,
    };
    stat.calls += 1;
    stat.total_ms += elapsedMs;
    stat.max_ms = Math.max(stat.max_ms, elapsedMs);
    this.stats.set(key, stat);
    return this.flush(now);
  }

  /** The finished window's report (if due and worth reporting); resets it. */
  flush(now: number): SqlStatsReport | undefined {
    if (!this.enabled || now - this.windowStart < this.opts.windowMs) {
      return undefined;
    }
    const all = [...this.stats.values()];
    const total_ms = all.reduce((sum, stat) => sum + stat.total_ms, 0);
    const report: SqlStatsReport = {
      window_ms: Math.round(now - this.windowStart),
      total_ms: Math.round(total_ms),
      calls: all.reduce((sum, stat) => sum + stat.calls, 0),
      distinct: all.length,
      overflow_calls: this.overflowCalls,
      top: all
        .sort((a, b) => b.total_ms - a.total_ms)
        .slice(0, this.opts.top)
        .map((stat) => ({
          sql: stat.sql,
          calls: stat.calls,
          total_ms: Math.round(stat.total_ms),
          max_ms: Math.round(stat.max_ms),
        })),
    };
    this.stats = new Map();
    this.overflowCalls = 0;
    this.windowStart = now;
    return total_ms >= this.opts.minTotalMs ? report : undefined;
  }

  size(): number {
    return this.stats.size;
  }
}
