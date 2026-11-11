import { readFileSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import { getPersistentStreamDiagnostics } from "@cocalc/conat/persist/storage";
import {
  countCommits,
  getPersistWriteStats,
  logPersistWriteRate,
  persistWriteCounter,
  sqlClass,
  sqlVerb,
} from "@cocalc/backend/conat/persist-write-rate";

const msg = (s: string) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
});

function delta(before: Record<string, number>, key: string): number {
  return getPersistWriteStats()[key] - before[key];
}

// Date.now() at a controlled time for the duration of fn.
function at<T>(now: number, fn: () => T): T {
  const spy = jest.spyOn(Date, "now").mockReturnValue(now);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe("persist write-rate counters", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-write-rate-"));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  // Must run first: the window starts when the first disk stream opens.
  it("starts the first window when the first disk stream opens, not at module load", () => {
    const t0 = Date.now();
    logPersistWriteRate(t0);
    const eph = pstream({ path: join(dir, "early"), ephemeral: true });
    try {
      at(t0 + 1_000, () => eph.set(msg("before any disk stream")));
    } finally {
      eph.close();
    }
    const stream = at(t0 + 100_000, () =>
      pstream({ path: join(dir, "first") }),
    );
    try {
      at(t0 + 100_500, () => stream.set(msg("x")));
      const entry = logPersistWriteRate(t0 + 160_000);
      expect(entry.window_seconds).toBe(60);
      expect(entry.ephemeral_commits).toBe(0);
      expect(entry.disk_rows).toBe(1);
      expect(entry.disk_txn_commits).toBe(1);
    } finally {
      stream.close();
    }
  });

  it("counts committed transactions, the rows they add and their bytes", () => {
    const stream = pstream({ path: join(dir, "a") });
    try {
      const before = getPersistWriteStats();
      stream.set({ key: "one", ...msg("x".repeat(10)) });
      stream.setMany([msg("a"), msg("b"), msg("c")]);
      expect(delta(before, "disk_txn_commits_total")).toBe(2);
      expect(delta(before, "disk_commits_total")).toBe(2);
      expect(delta(before, "disk_autocommits_total")).toBe(0);
      expect(delta(before, "disk_rows_total")).toBe(4);
      expect(delta(before, "disk_bytes_total")).toBeGreaterThanOrEqual(13);
      expect(delta(before, "ephemeral_commits_total")).toBe(0);
      expect(
        getPersistWriteStats().disk_sqlite_commit_call_ms_max,
      ).toBeGreaterThanOrEqual(0);
    } finally {
      stream.close();
    }
  });

  it("does not count a transaction that rolls back", () => {
    const stream = pstream({ path: join(dir, "b") });
    try {
      stream.config({ max_msgs: 1, discard_policy: "new" });
      stream.set(msg("1"));
      const before = getPersistWriteStats();
      expect(() => stream.set(msg("2"))).toThrow();
      expect(delta(before, "disk_commits_total")).toBe(0);
      expect(delta(before, "disk_rows_total")).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("counts config() writes and the deletes of its limits as disk autocommits", () => {
    const stream = pstream({ path: join(dir, "config") });
    try {
      stream.setMany([msg("1"), msg("2"), msg("3")]);
      const before = getPersistWriteStats();
      // one config upsert, then enforceLimits(0) deletes the two oldest
      stream.config({ max_msgs: 1 });
      expect(delta(before, "disk_autocommits_total")).toBeGreaterThanOrEqual(2);
      expect(delta(before, "disk_commits_total")).toBe(
        delta(before, "disk_autocommits_total") +
          delta(before, "disk_txn_commits_total"),
      );
      expect(delta(before, "disk_rows_total")).toBe(0);
      expect(stream.length).toBe(1);

      // the same config again writes nothing
      const again = getPersistWriteStats();
      stream.config({ max_msgs: 1 });
      expect(delta(again, "disk_commits_total")).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("counts deleteCheckpoint as a disk autocommit, only when it deletes", () => {
    const stream = pstream({ path: join(dir, "checkpoint") });
    try {
      const { seq } = stream.set(msg("1"));
      stream.setCheckpoint({ name: "c", seq });
      const before = getPersistWriteStats();
      stream.deleteCheckpoint("c");
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      expect(delta(before, "disk_commits_total")).toBe(1);
      const none = getPersistWriteStats();
      stream.deleteCheckpoint("c");
      expect(delta(none, "disk_commits_total")).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("does not count the schema statements of reopening an existing stream", () => {
    const path = join(dir, "reopen");
    pstream({ path }).close();
    const before = getPersistWriteStats();
    const stream = pstream({ path });
    try {
      // CREATE ... IF NOT EXISTS changes nothing here
      expect(delta(before, "disk_autocommits_total")).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("splits every figure between disk and ephemeral streams", () => {
    const disk = pstream({ path: join(dir, "disk") });
    const eph = pstream({ path: join(dir, "eph"), ephemeral: true });
    try {
      const t = Math.floor(Date.now() / 1000) * 1000;
      logPersistWriteRate(t);
      at(t + 100, () => {
        disk.set(msg("d1"));
        eph.set(msg("e1"));
        eph.setMany([msg("e2"), msg("e3"), msg("e4")]);
        disk.set(msg("d2"));
        eph.set(msg("e5"));
      });
      const entry = logPersistWriteRate(t + 10_000);
      expect(entry.disk_txn_commits).toBe(2);
      expect(entry.disk_commits).toBe(2);
      expect(entry.disk_rows).toBe(2);
      expect(entry.disk_peak_commits_per_second).toBe(2);
      expect(entry.disk_peak_rows_per_second).toBe(2);
      expect(entry.disk_rows_per_second).toBeCloseTo(0.2);
      expect(entry.ephemeral_txn_commits).toBe(3);
      expect(entry.ephemeral_rows).toBe(5);
      expect(entry.ephemeral_peak_commits_per_second).toBe(3);
      expect(entry.ephemeral_peak_rows_per_second).toBe(5);
      expect(entry.disk_bytes).toBeGreaterThan(0);
      expect(entry.ephemeral_bytes).toBeGreaterThan(entry.disk_bytes);
    } finally {
      disk.close();
      eph.close();
    }
  });

  it("logs per-window deltas, then resets the window", () => {
    const stream = pstream({ path: join(dir, "d") });
    try {
      const start = Date.now();
      logPersistWriteRate(start);
      for (let i = 0; i < 5; i++) {
        stream.set(msg(`${i}`));
      }
      const entry = logPersistWriteRate(start + 60_000);
      expect(entry.window_seconds).toBe(60);
      expect(entry.disk_rows).toBe(5);
      expect(entry.disk_txn_commits).toBe(5);
      expect(entry.disk_rows_per_second).toBeCloseTo(5 / 60);
      expect(entry.disk_sqlite_commit_call_ms_avg).toBeGreaterThanOrEqual(0);

      const empty = logPersistWriteRate(start + 120_000);
      expect(empty.disk_commits).toBe(0);
      expect(empty.disk_rows).toBe(0);
      expect(empty.disk_peak_commits_per_second).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("does not carry a partly counted second into the next window", () => {
    const stream = pstream({ path: join(dir, "second") });
    try {
      const s = (Math.floor(Date.now() / 1000) + 5) * 1000;
      logPersistWriteRate(s);
      at(s + 200, () => stream.set(msg("before the log")));
      const first = logPersistWriteRate(s + 500);
      expect(first.disk_peak_commits_per_second).toBe(1);
      at(s + 700, () => stream.set(msg("after the log, same second")));
      const second = logPersistWriteRate(s + 900);
      expect(second.disk_commits).toBe(1);
      expect(second.disk_peak_commits_per_second).toBe(1);
      expect(second.disk_peak_rows_per_second).toBe(1);
    } finally {
      stream.close();
    }
  });

  describe("what countCommits counts on the stream's own connection", () => {
    let stream: ReturnType<typeof pstream>;
    let db: any;
    const insert = (name: string) =>
      `INSERT INTO stream_checkpoints(name, seq, time) VALUES ('${name}', 1, 1)`;

    beforeEach(() => {
      stream = pstream({ path: join(dir, "raw") });
      db = (stream as any).db;
    });

    afterEach(() => {
      stream.close();
    });

    it("runs a multi-statement exec as written and counts it once (a lower bound)", () => {
      const before = getPersistWriteStats();
      db.exec(
        `${insert("m1")}; ${insert("m;2")};\n CREATE TABLE t_multi(a); DROP TABLE t_multi; SELECT 1;`,
      );
      expect(stream.getCheckpoint("m1")).toBeDefined();
      expect(stream.getCheckpoint("m;2")).toBeDefined();
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      expect(delta(before, "disk_txn_commits_total")).toBe(0);
      const none = getPersistWriteStats();
      db.exec("SELECT 1; SELECT 2;");
      expect(delta(none, "disk_commits_total")).toBe(0);
    });

    it("gives every script the same result or error as SQLite without it", () => {
      const scripts = [
        `${insert("p1")}; ${insert("p;2")}; SELECT 1`,
        `${insert("p3")}; INSERT INTO stream_checkpoints(name, seq, time) VALUES ('p;4, 1, 1)`,
        `${insert("p5")}; /* ; */ ${insert("p6")} -- ;`,
        `${insert("p7")}; INSERT INTO nowhere VALUES (1); ${insert("p8")}`,
        "BEGIN; " + insert("p9") + "; COMMIT;",
      ];
      const raw = new DatabaseSync(":memory:");
      raw.exec(
        "CREATE TABLE stream_checkpoints (name TEXT PRIMARY KEY, seq INTEGER NOT NULL, time INTEGER NOT NULL, data_json TEXT, revision INTEGER NOT NULL DEFAULT 0)",
      );
      const outcome = (d: any, sql: string) => {
        try {
          d.exec(sql);
          return "ok";
        } catch (err) {
          return `${err}`;
        }
      };
      const names = (d: any) =>
        d
          .prepare("SELECT name FROM stream_checkpoints ORDER BY name")
          .all()
          .map((r: any) => r.name);
      for (const sql of scripts) {
        expect(outcome(db, sql)).toBe(outcome(raw, sql));
        expect(names(db)).toEqual(names(raw));
      }
      expect(names(db)).toEqual(["p1", "p3", "p5", "p6", "p7", "p9", "p;2"]);
      raw.close();
    });

    it("does not count a WITH ... SELECT after a DELETE (run's changes is the last DML's)", () => {
      db.exec(insert("w1"));
      db.prepare("DELETE FROM stream_checkpoints WHERE name='w1'").run();
      const before = getPersistWriteStats();
      db.prepare("WITH c AS (SELECT 1) SELECT replace('a', 'a', 'b')").run();
      expect(delta(before, "disk_commits_total")).toBe(0);
    });

    it("does not split at a semicolon inside a literal or a comment", () => {
      const before = getPersistWriteStats();
      db.exec(`${insert("a;b")} -- not; a split\n`);
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      expect(stream.getCheckpoint("a;b")).toBeDefined();
    });

    it("counts a DELETE without WHERE (the truncate path) only when it deletes", () => {
      db.exec(`${insert("t1")}; ${insert("t2")}`);
      const before = getPersistWriteStats();
      db.prepare("DELETE FROM stream_checkpoints").run();
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      const empty = getPersistWriteStats();
      db.prepare("DELETE FROM stream_checkpoints").run();
      expect(delta(empty, "disk_autocommits_total")).toBe(0);
    });

    it("counts DML with RETURNING through get and all only when it changes rows", () => {
      db.exec(insert("r1"));
      const before = getPersistWriteStats();
      const sql = "DELETE FROM stream_checkpoints WHERE name=? RETURNING name";
      expect(db.prepare(sql).get("r1")).toBeDefined();
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      const none = getPersistWriteStats();
      expect(db.prepare(sql).get("r1")).toBeUndefined();
      expect(db.prepare(sql).all("r1")).toEqual([]);
      expect(delta(none, "disk_autocommits_total")).toBe(0);
    });

    it("counts nothing for a statement that fails part way", () => {
      const before = getPersistWriteStats();
      expect(() =>
        db
          .prepare(
            "INSERT INTO stream_checkpoints(name, seq, time) VALUES ('d', 1, 1), ('d', 2, 2)",
          )
          .run(),
      ).toThrow();
      expect(delta(before, "disk_commits_total")).toBe(0);
      expect(stream.getCheckpoint("d")).toBeUndefined();
    });

    it("counts the PRAGMAs that write, and not the others", () => {
      const before = getPersistWriteStats();
      db.exec("PRAGMA user_version=7");
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      const others = getPersistWriteStats();
      db.exec("PRAGMA busy_timeout=100");
      db.prepare("PRAGMA journal_mode=WAL").run(); // already WAL
      db.prepare("PRAGMA wal_checkpoint(PASSIVE)").run();
      db.prepare("PRAGMA user_version").get();
      expect(delta(others, "disk_commits_total")).toBe(0);
    });

    it("counts a transaction that writes once, and an empty one not at all", () => {
      const before = getPersistWriteStats();
      db.exec("BEGIN");
      db.exec(insert("x1"));
      db.prepare(insert("x2")).run();
      db.exec("COMMIT");
      expect(delta(before, "disk_txn_commits_total")).toBe(1);
      expect(delta(before, "disk_autocommits_total")).toBe(0);
      const empty = getPersistWriteStats();
      db.exec("BEGIN");
      db.prepare("SELECT 1").get();
      db.exec("COMMIT");
      expect(delta(empty, "disk_commits_total")).toBe(0);
    });

    it("follows SQLite's transaction state when a COMMIT fails", () => {
      const before = getPersistWriteStats();
      const exec = db.exec;
      db.exec = (sql: string) => {
        if (sql === "COMMIT") throw Error("injected COMMIT failure");
        return exec(sql);
      };
      try {
        expect(() => stream.set(msg("lost"))).toThrow("injected");
      } finally {
        db.exec = exec;
      }
      expect(db.isTransaction).toBe(false);
      expect(delta(before, "disk_commits_total")).toBe(0);
      expect(delta(before, "disk_rows_total")).toBe(0);
      db.prepare(insert("after")).run();
      expect(delta(before, "disk_autocommits_total")).toBe(1);
      expect(delta(before, "disk_commits_total")).toBe(1);
    });
  });

  describe("a failing read of the counter never fails the call", () => {
    let stream: ReturnType<typeof pstream>;
    let db: any;
    const TOTAL_CHANGES = "SELECT total_changes() AS n";
    const SCHEMA_VERSION = "PRAGMA schema_version";

    // Make the counter's own read `sql` throw on the calls `fail` picks.
    // (Write statements have their own get, so this reaches only reads.)
    // (Each call replaces the previous injection.)
    const get = StatementSync.prototype.get;
    function failRead(sql: string, fail: (n: number) => boolean) {
      let n = 0;
      jest.spyOn(StatementSync.prototype, "get").mockImplementation(function (
        this: any,
        ...args: any[]
      ) {
        if (this.sourceSQL === sql && fail(++n)) {
          throw Error("injected counter read failure");
        }
        return get.apply(this, args as any);
      });
    }

    beforeEach(() => {
      stream = pstream({ path: join(dir, "fail") });
      db = (stream as any).db;
    });

    let output: jest.SpyInstance[];
    beforeEach(() => {
      output = [
        jest.spyOn(console, "log"),
        jest.spyOn(console, "info"),
        jest.spyOn(console, "warn"),
        jest.spyOn(console, "error"),
        jest.spyOn(console, "debug"),
        jest.spyOn(process.stderr, "write"),
        jest.spyOn(process.stdout, "write"),
      ];
    });

    afterEach(() => {
      // nothing about the failure was printed or logged
      for (const spy of output) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain("injected");
      }
      jest.restoreAllMocks();
      stream.close();
    });

    it("after a successful COMMIT", () => {
      const before = getPersistWriteStats();
      // read 1 is BEGIN's start, read 2 the one after COMMIT
      failRead(TOTAL_CHANGES, (n) => n === 2);
      const { seq } = stream.set(msg("committed"));
      expect(stream.get({ seq })).toBeDefined();
      expect(db.isTransaction).toBe(false);
      expect(delta(before, "disk_count_errors_total")).toBe(1);
      expect(delta(before, "disk_commits_total")).toBe(0);
    });

    it("before a BEGIN", () => {
      const before = getPersistWriteStats();
      failRead(TOTAL_CHANGES, (n) => n === 1);
      const { seq } = stream.set(msg("committed"));
      expect(stream.get({ seq })).toBeDefined();
      expect(delta(before, "disk_count_errors_total")).toBe(1);
      // its start unknown, the transaction is counted as writing
      expect(delta(before, "disk_txn_commits_total")).toBe(1);
      expect(delta(before, "disk_rows_total")).toBe(1);
    });

    it("before and after an autocommit", () => {
      const before = getPersistWriteStats();
      failRead(SCHEMA_VERSION, (n) => n === 1);
      db.exec("CREATE TABLE t_fail_before(a)");
      // exec has no result, so the INSERT reads total_changes before (1)
      // and after (2); the DELETE uses reads 3 and 4
      failRead(TOTAL_CHANGES, (n) => n === 2);
      db.exec(
        "INSERT INTO stream_checkpoints(name, seq, time) VALUES ('f', 1, 1)",
      );
      expect(
        db
          .prepare("DELETE FROM stream_checkpoints WHERE name=? RETURNING name")
          .get("f"),
      ).toBeDefined();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='t_fail_before'",
          )
          .get(),
      ).toBeDefined();
      expect(stream.getCheckpoint("f")).toBeUndefined();
      expect(delta(before, "disk_count_errors_total")).toBe(2);
      // the CREATE and the INSERT are not counted; the DELETE is
      expect(delta(before, "disk_autocommits_total")).toBe(1);
    });
  });

  it("counts a connection it cannot count, and says so in the log line", () => {
    const before = getPersistWriteStats();
    const fake = { prepare: () => {}, exec: () => {} } as any;
    expect(countCommits(fake, "disk", () => ({ rows: 0, bytes: 0 }))).toBe(
      fake,
    );
    expect(delta(before, "disk_uncounted_connections_total")).toBe(1);
    const t = Date.now();
    logPersistWriteRate(t);
    const log = jest.fn();
    const entry = logPersistWriteRate(t + 60_000, log);
    expect(entry.disk_commits).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][1].disk_uncounted_connections_total).toBe(
      getPersistWriteStats().disk_uncounted_connections_total,
    );
    expect(entry.disk_uncounted_connections_total).toBeGreaterThanOrEqual(1);
  });

  it("survives a failing transaction-state read after a COMMIT; the next transaction counts only its own rows", () => {
    // isTransaction is a non-configurable property of a real connection, so
    // a Proxy over one stands in to make that read throw.
    const real = new DatabaseSync(":memory:");
    real.exec("CREATE TABLE t(a)");
    let armed = false;
    const proxy = new Proxy(real as any, {
      get(target, prop) {
        if (prop === "isTransaction" && armed && !target.isTransaction) {
          throw Error("injected isTransaction failure");
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let pending = { rows: 0, bytes: 0 };
    const takeRows = () => {
      const rows = pending;
      pending = { rows: 0, bytes: 0 };
      return rows;
    };
    const db: any = countCommits(proxy, "ephemeral", takeRows);
    // like runTransaction: reset the row tally, BEGIN, write, COMMIT
    const transaction = (rows: number, failAfterCommit: boolean) => {
      pending = { rows: 0, bytes: 0 };
      db.exec("BEGIN");
      db.prepare("INSERT INTO t VALUES (1)").run();
      pending = { rows, bytes: rows };
      armed = failAfterCommit;
      try {
        db.exec("COMMIT");
      } finally {
        armed = false;
      }
    };
    const before = getPersistWriteStats();
    transaction(5, true);
    expect(real.isTransaction).toBe(false);
    expect((real.prepare("SELECT COUNT(*) AS n FROM t").get() as any).n).toBe(
      1,
    );
    expect(delta(before, "ephemeral_count_errors_total")).toBe(1);
    expect(delta(before, "ephemeral_txn_commits_total")).toBe(0);
    transaction(1, false);
    expect(delta(before, "ephemeral_txn_commits_total")).toBe(1);
    expect(delta(before, "ephemeral_rows_total")).toBe(1);
    real.close();
  });

  describe("the SQL classification takes linear time", () => {
    const ms = (f: () => unknown) => {
      const started = performance.now();
      f();
      return performance.now() - started;
    };

    it("on long runs of whitespace, comments and words", () => {
      // First sizes an exponential regex needs seconds for (\s+ in the
      // group; a lazy comment body), so a regression fails here instead of
      // hanging on the large inputs below.
      expect(ms(() => sqlVerb(" ".repeat(28) + "("))).toBeLessThan(100);
      expect(ms(() => sqlVerb("/* c */".repeat(24) + "("))).toBeLessThan(100);
      const inputs = [
        " ".repeat(10_000) + "(",
        " ".repeat(10_000),
        "\n\t ".repeat(5_000) + "(",
        "-- c\n".repeat(5_000) + "(",
        "/* c */".repeat(5_000) + "(",
        "/*" + " ".repeat(10_000),
        "PRAGMA " + "a".repeat(40_000),
        "PRAGMA " + " ".repeat(20_000) + ".",
        "WITH " + "x".repeat(1_000_000),
      ];
      for (const sql of inputs) {
        expect(ms(() => sqlClass(sql))).toBeLessThan(100);
      }
    });

    it("and still finds the verb", () => {
      expect(sqlVerb("  SELECT 1")).toBe("SELECT");
      expect(sqlVerb("-- c\n INSERT x")).toBe("INSERT");
      expect(sqlVerb("/* a */ BEGIN")).toBe("BEGIN");
      expect(sqlVerb("/***/ /* * / ** */SELECT")).toBe("SELECT");
      expect(sqlVerb("/* not closed SELECT")).toBe("");
      expect(sqlVerb("\n\t -- x\n/* y */\n  delete from t")).toBe("DELETE");
      // (small: the large inputs are timed above, after the guards)
      expect(sqlVerb(" ".repeat(10) + "(")).toBe("");
      expect(sqlClass("\n  pragma user_version = 3")).toBe("other-write");
      expect(sqlClass("  PRAGMA busy_timeout=5")).toBeUndefined();
    });
  });

  it("never throws from wrap: a connection it can't wrap counts as uncounted", () => {
    const before = getPersistWriteStats();
    const odd = {
      isTransaction: false,
      get prepare(): any {
        throw Error("no prepare");
      },
    } as any;
    expect(
      persistWriteCounter.wrap(odd, "disk", () => ({ rows: 0, bytes: 0 })),
    ).toBe(odd);
    expect(delta(before, "disk_uncounted_connections_total")).toBe(1);
  });

  describe("the sources", () => {
    const packages = join(__dirname, "../../../..");
    const source = readFileSync(
      join(packages, "conat/persist/storage.ts"),
      "utf8",
    );
    const counterSource = readFileSync(
      join(packages, "backend/conat/persist-write-rate.ts"),
      "utf8",
    );
    // the SQL classification and countCommits itself
    const start = counterSource.indexOf("// The first word of a statement");
    const end = counterSource.indexOf(
      "\n}\n",
      counterSource.indexOf("function countCommits("),
    );
    const counter = counterSource.slice(start, end);

    it("storage opens exactly one connection, and hands it to the counter", () => {
      expect(source.match(/createDatabase\(/g)).toHaveLength(1);
      expect(source).toMatch(
        /const db = createDatabase\([^)]*\);\s*(\/\/[^\n]*\s*)*this\.db = writeCounter\?\.wrap\(db, /,
      );
      expect(source).not.toMatch(/DatabaseSync\(/);
      // and the backend registers the counter with the persist context
      expect(
        readFileSync(join(packages, "backend/conat/persist.ts"), "utf8"),
      ).toMatch(
        /initContext\(\{[\s\S]*?\n  writeCounter: persistWriteCounter,\n\}\);/,
      );
    });

    it("storage runs every statement through this.db, i.e. through the counter", () => {
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const rest = source;
      const calls = [...rest.matchAll(/\.(prepare|exec)\(/g)];
      expect(calls.length).toBeGreaterThan(50);
      for (const call of calls) {
        const before = rest.slice(Math.max(0, call.index! - 40), call.index);
        expect(before).toMatch(/this\.db\s*$/);
      }
    });

    it("storage resets the row tally before every BEGIN", () => {
      expect(source).toMatch(
        /private runTransaction = [^\n]*\n\s*this\.pendingRows = 0;\n\s*this\.pendingBytes = 0;\n\s*this\.db\.exec\("BEGIN"\);/,
      );
    });

    it("storage runs no multi-statement script through exec", () => {
      const rest = source;
      const execs = [...rest.matchAll(/this\.db\s*\.exec\(([^)]*)\)/g)];
      expect(execs.length).toBeGreaterThan(5);
      for (const [, arg] of execs) {
        expect(arg).not.toContain(";");
      }
    });

    it("never logs or keeps SQL text in the counter", () => {
      expect(counter).not.toMatch(/logger|console|debug\(|\bwarn\(/);
    });
  });

  it("reports the counters in the persistence diagnostics, counts only", () => {
    const diagnostics = getPersistentStreamDiagnostics();
    expect(diagnostics.write_stats).toEqual(getPersistWriteStats());
    const fields = [
      "autocommits_total",
      "bytes_total",
      "commits_total",
      "count_errors_total",
      "rows_total",
      "sqlite_commit_call_ms_max",
      "sqlite_commit_call_ms_total",
      "txn_commits_total",
      "uncounted_connections_total",
    ];
    expect(Object.keys(diagnostics.write_stats).sort()).toEqual(
      ["disk", "ephemeral"]
        .flatMap((kind) => fields.map((f) => `${kind}_${f}`))
        .sort(),
    );
    for (const value of Object.values(diagnostics.write_stats)) {
      expect(typeof value).toBe("number");
    }
  });
});
