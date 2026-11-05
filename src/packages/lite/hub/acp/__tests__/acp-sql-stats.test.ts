/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { OTHER_SQL, SqlStatementStats } from "../../sqlite/acp-sql-stats";

const opts = { windowMs: 60_000, minTotalMs: 1_000, maxKeys: 3, top: 2 };

describe("acp sqlite statement totals", () => {
  it("reports the top statements by total time once a window ends, then starts over", () => {
    const stats = new SqlStatementStats(opts, 0);
    expect(stats.record("SELECT a FROM t WHERE x = ?", 600, 1)).toBeUndefined();
    expect(stats.record("SELECT a FROM t WHERE x = ?", 500, 2)).toBeUndefined();
    expect(stats.record("SELECT b FROM t", 300, 3)).toBeUndefined();
    expect(stats.record("SELECT c FROM t", 10, 4)).toBeUndefined();
    const report = stats.record("SELECT c FROM t", 10, 60_000);
    expect(report).toEqual({
      window_ms: 60_000,
      total_ms: 1_420,
      calls: 5,
      distinct: 3,
      overflow_calls: 0,
      top: [
        {
          sql: "SELECT a FROM t WHERE x = ?",
          calls: 2,
          total_ms: 1_100,
          max_ms: 600,
        },
        { sql: "SELECT b FROM t", calls: 1, total_ms: 300, max_ms: 300 },
      ],
    });
    expect(stats.size()).toBe(0);
  });

  it("keeps at most maxKeys statements; the rest are counted as (other)", () => {
    const stats = new SqlStatementStats({ ...opts, top: 10 }, 0);
    for (let i = 0; i < 10; i++) stats.record(`SELECT ${i}`, 200, i);
    expect(stats.size()).toBe(4); // 3 statements + "(other)"
    const report = stats.flush(60_000)!;
    expect(report.distinct).toBe(4);
    expect(report.overflow_calls).toBe(7);
    expect(report.top.find((stat) => stat.sql === OTHER_SQL)).toEqual({
      sql: OTHER_SQL,
      calls: 7,
      total_ms: 1_400,
      max_ms: 200,
    });
  });

  it("a quiet window is not reported, and is still reset", () => {
    const stats = new SqlStatementStats(opts, 0);
    stats.record("SELECT 1", 5, 1);
    expect(stats.flush(60_000)).toBeUndefined();
    expect(stats.size()).toBe(0);
  });

  it("is off with a window of 0: nothing is kept or reported", () => {
    const stats = new SqlStatementStats({ ...opts, windowMs: 0 }, 0);
    expect(stats.enabled).toBe(false);
    expect(stats.record("SELECT 1", 5_000, 1)).toBeUndefined();
    expect(stats.flush(10 ** 9)).toBeUndefined();
    expect(stats.size()).toBe(0);
  });
});
