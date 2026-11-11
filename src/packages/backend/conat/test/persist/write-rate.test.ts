import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  getPersistWriteStats,
  getPersistentStreamDiagnostics,
  logPersistWriteRate,
} from "@cocalc/conat/persist/storage";

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

    it("counts each write statement of a multi-statement exec", () => {
      const before = getPersistWriteStats();
      db.exec(
        `${insert("m1")}; ${insert("m2")};\n CREATE TABLE t_multi(a); DROP TABLE t_multi; SELECT 1;`,
      );
      expect(delta(before, "disk_autocommits_total")).toBe(4);
      expect(delta(before, "disk_txn_commits_total")).toBe(0);
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

  describe("the source of storage.ts", () => {
    const source = readFileSync(
      join(__dirname, "../../../../conat/persist/storage.ts"),
      "utf8",
    );
    // the SQL classification and countCommits itself
    const start = source.indexOf("// The first word of a statement");
    const end = source.indexOf(
      "\n}\n",
      source.indexOf("function countCommits("),
    );
    const counter = source.slice(start, end);

    it("opens exactly one connection, and counts it", () => {
      expect(source.match(/createDatabase\(/g)).toHaveLength(1);
      expect(source).toMatch(/countCommits\(\s*createDatabase\(/);
      expect(source).not.toMatch(/DatabaseSync\(/);
    });

    it("runs every statement through this.db, i.e. through countCommits", () => {
      expect(start).toBeGreaterThan(0);
      const rest = source.slice(0, start) + source.slice(end);
      const calls = [...rest.matchAll(/\.(prepare|exec)\(/g)];
      expect(calls.length).toBeGreaterThan(50);
      for (const call of calls) {
        const before = rest.slice(Math.max(0, call.index! - 40), call.index);
        expect(before).toMatch(/this\.db\s*$/);
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
      "rows_total",
      "sqlite_commit_call_ms_max",
      "sqlite_commit_call_ms_total",
      "txn_commits_total",
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
