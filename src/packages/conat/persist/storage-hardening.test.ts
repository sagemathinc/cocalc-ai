/*
A project's persist databases live in the project, so the project can change
them.  The persist server must not trust what it reads: these tests write
"hostile" files directly with node:sqlite and check that the server refuses
them or bounds the cost of reading them.
*/

import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
} from "node:zlib";

import { initContext, syncFiles } from "./context";
import {
  PersistentStream,
  persistSqliteBusyTimeoutMs,
  persistSqliteLockingMode,
  storedRowToMessage,
  unexpectedPersistSchema,
  HISTORY_SCHEMA,
  RESET_TRASH_SCHEMA,
} from "./storage";

const zstdDecompressAsync = promisify(zstdDecompress);

let dir: string;
let n = 0;

beforeAll(() => {
  initContext({
    sqlite: { DatabaseSync },
    compress: zstdCompressSync,
    decompress: (data, maxOutputLength) =>
      zstdDecompressSync(data, maxOutputLength ? { maxOutputLength } : {}),
    decompressAsync: (data, maxOutputLength) =>
      zstdDecompressAsync(data, maxOutputLength ? { maxOutputLength } : {}),
    // files in dir/project are "in a project"
    isProjectOwnedDatabasePath: (path) =>
      path.startsWith(join(dir, "project") + "/"),
    syncFiles,
    statSync,
    copyFileSync,
    ensureContainingDirectoryExists: async () => undefined,
  });
  dir = mkdtempSync(join(tmpdir(), "persist-hardening-"));
  mkdirSync(join(dir, "project"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// a stream file created by the server itself, then closed
function serverFile({
  inProject = false,
}: { inProject?: boolean } = {}): string {
  const path = join(dir, inProject ? "project" : "", `stream-${n++}`);
  const stream = new PersistentStream({ path, noCache: true } as any);
  stream.set({ encoding: 1 as any, raw: Buffer.from('{"a":1}') });
  stream.close();
  return path;
}

function tamper(path: string, sql: string) {
  const db = new DatabaseSync(path + ".db");
  db.exec(sql);
  db.close();
}

function open(path: string) {
  return new PersistentStream({ path, noCache: true } as any);
}

describe("the schema of a stored database", () => {
  it("opens files the server wrote", () => {
    const path = serverFile();
    const stream = open(path);
    const raw = stream.get({ seq: 1, key: undefined })?.raw;
    expect(Buffer.from(raw!).toString()).toBe('{"a":1}');
    stream.close();
  });

  it.each([
    [
      "a trigger",
      "CREATE TRIGGER t AFTER INSERT ON messages BEGIN SELECT 1; END",
    ],
    ["a view", "CREATE VIEW v AS SELECT * FROM messages"],
    ["another index", "CREATE INDEX extra ON messages(length(raw))"],
    ["planner statistics", "ANALYZE"],
    ["another table", "CREATE TABLE other(x)"],
    [
      "an archived table name with a quote",
      `CREATE TABLE "messages_archived_1""; ATTACH 'x' AS y; --"(x)`,
    ],
    [
      "a changed index",
      "DROP INDEX idx_messages_time; CREATE INDEX idx_messages_time ON messages(time, raw)",
    ],
  ])("refuses %s", (_, sql) => {
    const path = serverFile();
    tamper(path, sql);
    expect(() => open(path)).toThrow(/changed outside CoCalc/);
  });

  it("refuses a changed table definition", () => {
    const path = join(dir, `stream-${n++}`);
    const db = new DatabaseSync(path + ".db");
    // a column computed on every insert
    db.exec(
      "CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, time INTEGER NOT NULL, headers TEXT, compress NUMBER NOT NULL, encoding NUMBER NOT NULL, raw BLOB NOT NULL, size NUMBER NOT NULL, ttl NUMBER, x BLOB AS (zeroblob(1000)) STORED)",
    );
    db.close();
    expect(() => open(path)).toThrow(/changed outside CoCalc/);
  });

  it("opens files with history archived by resetHistory", () => {
    const path = serverFile();
    let stream = open(path);
    const { archive } = stream.resetHistory({ archive: true });
    stream.close();
    expect(archive).toMatch(/^messages_archived_\d+$/);
    stream = open(path);
    expect([...stream.getAll()]).toEqual([]);
    const tables = ((stream as any).db as DatabaseSync)
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(({ name }: any) => name);
    expect(tables).toContain(archive);
    stream.close();
  });

  it("opens files with the history tables, which a newer server creates", () => {
    const path = serverFile();
    // with the autoindexes of their primary keys, as SQLite makes them
    tamper(path, Object.values(HISTORY_SCHEMA).join(";\n"));
    const stream = open(path);
    expect(
      Buffer.from(stream.get({ seq: 1, key: undefined })!.raw).toString(),
    ).toBe('{"a":1}');
    stream.close();
  });

  it("creates the history tables from HISTORY_SCHEMA, so a fresh database passes the check", () => {
    const path = serverFile();
    const db = new DatabaseSync(path + ".db");
    const objects = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master")
      .all() as any[];
    db.close();
    expect(unexpectedPersistSchema(objects)).toBeUndefined();
    const names = objects.map(({ name }) => name);
    for (const name of Object.keys(HISTORY_SCHEMA)) {
      expect(names).toContain(name);
    }
    // the stored definitions are exactly HISTORY_SCHEMA's
    for (const [name, sql] of Object.entries(HISTORY_SCHEMA)) {
      const stored = objects.find((o) => o.name === name)!.sql;
      expect(stored.replace(/\s+/g, " ")).toBe(
        sql.replace(/\s+/g, " ").replace(" IF NOT EXISTS", ""),
      );
    }
  });

  it("still passes the check after a seeded reset and archive", () => {
    const path = serverFile();
    let stream = open(path);
    stream.set({ encoding: 1 as any, raw: Buffer.from('"b"'), msgID: "b" });
    const { seq, count } = stream.inventory();
    expect(
      stream.resetHistory({
        ifRevision: { seq, count },
        coveredSeq: seq,
        archive: true,
        opId: "op",
        seed: {
          encoding: 1 as any,
          raw: Buffer.from('{"is_snapshot":true,"snapshot":"v"}'),
          msgID: "seed",
          checkpoint: { name: "latest_snapshot" },
        },
      }).reset,
    ).toBe(true);
    stream.close();
    stream = open(path);
    expect(stream.length).toBe(1);
    stream.close();
  });

  describe("msg ids written by an older server (rolled back after H1a)", () => {
    const seedOptions = (stream: PersistentStream) => {
      const { seq, count } = stream.inventory();
      return {
        ifRevision: { seq, count },
        coveredSeq: seq,
        archive: true,
        seed: {
          encoding: 1 as any,
          raw: Buffer.from('{"is_snapshot":true,"snapshot":"v"}'),
        },
      };
    };
    // What #1247's server (ec031aacf3) writes for an acknowledged message:
    // the messages row only, with no msg id and no history_epochs update.
    const olderServerWrite = (path: string) =>
      tamper(
        path,
        `INSERT INTO messages(time, compress, encoding, raw, headers, key, size, ttl) VALUES (${Date.now() / 1000}, 0, 1, X'2262220a', NULL, NULL, 4, NULL)`,
      );

    it("never reports as absent an id the older server accepted", () => {
      const path = serverFile();
      let stream = open(path);
      stream.set({ encoding: 1 as any, raw: Buffer.from('"a"'), msgID: "a" });
      stream.close();
      // its acknowledgment for "b" is seq 3; it records no id
      olderServerWrite(path);
      stream = open(path);
      expect(stream.resetHistory(seedOptions(stream)).reset).toBe(true);
      expect(
        stream.historyInclusion({ epoch: 0, ids: ["a", "b"] }).ids,
      ).toEqual({
        a: { status: "included", seq: 2 },
        b: { status: "unknown" },
      });
      stream.close();
    });

    it("notices a write by another server while this one has the file open", () => {
      const path = serverFile();
      const stream = open(path);
      stream.set({ encoding: 1 as any, raw: Buffer.from('"a"'), msgID: "a" });
      olderServerWrite(path);
      stream.set({ encoding: 1 as any, raw: Buffer.from('"c"'), msgID: "c" });
      expect(stream.resetHistory(seedOptions(stream)).reset).toBe(true);
      expect(
        stream.historyInclusion({ epoch: 0, ids: ["a", "b", "c"] }).ids,
      ).toMatchObject({
        a: { status: "included" },
        b: { status: "unknown" },
        c: { status: "included" },
      });
      stream.close();
    });

    it("notices an epoch changed by another server", () => {
      const path = serverFile();
      let stream = open(path);
      stream.set({ encoding: 1 as any, raw: Buffer.from('"a"'), msgID: "a" });
      stream.close();
      tamper(
        path,
        `INSERT INTO config(field, value) VALUES('required_headers', '{"history_epoch":3}')`,
      );
      stream = open(path);
      expect(stream.resetHistory(seedOptions(stream)).reset).toBe(true);
      expect(stream.historyInclusion({ epoch: 0, ids: ["x"] }).ids).toEqual({
        x: { status: "unknown" },
      });
      stream.close();
    });

    it("still proves absence after a clean close and reopen", () => {
      const path = serverFile();
      let stream = open(path);
      // the file serverFile made is from before msg ids: start a complete
      // epoch with a reset
      stream.resetHistory(seedOptions(stream));
      stream.set({
        encoding: 1 as any,
        raw: Buffer.from('"a"'),
        msgID: "a",
        headers: { history_epoch: 1 },
      });
      stream.close();
      stream = open(path);
      expect(stream.resetHistory(seedOptions(stream)).reset).toBe(true);
      expect(
        stream.historyInclusion({ epoch: 1, ids: ["a", "x"] }).ids,
      ).toEqual({ a: { status: "included", seq: 3 }, x: { status: "absent" } });
      stream.close();
    });
  });

  // H1c-0: a server rolled back past H1c must still open what H1c wrote
  describe("the reset-trash schema (accepted for H1c)", () => {
    // what H1c leaves after a purge and an archive: the counts and trash
    // tables; renamed tables keeping their indexes; and the live tables'
    // generation-suffixed indexes
    const H1C_SHAPE = [
      ...Object.values(RESET_TRASH_SCHEMA),
      'ALTER TABLE messages RENAME TO "messages_archived_3"',
      "CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, time INTEGER NOT NULL, headers TEXT, compress NUMBER NOT NULL, encoding NUMBER NOT NULL, raw BLOB NOT NULL, size NUMBER NOT NULL, ttl NUMBER)",
      "CREATE INDEX idx_messages_key_g1 ON messages(key)",
      "CREATE INDEX idx_messages_time_g1 ON messages(time)",
      'ALTER TABLE message_ids RENAME TO "message_ids_trash_7"',
      "CREATE TABLE message_ids (seq INTEGER PRIMARY KEY, msg_id TEXT NOT NULL)",
      "CREATE INDEX idx_message_ids_msg_id_g1 ON message_ids(msg_id)",
      "INSERT INTO messages(time, compress, encoding, raw, size) VALUES (1, 0, 1, CAST('{\"b\":2}' AS BLOB), 7)",
    ].join(";\n");

    const indexesOf = (path: string) => {
      const db = new DatabaseSync(path + ".db");
      try {
        return db
          .prepare(
            "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string; tbl_name: string }[];
      } finally {
        db.close();
      }
    };

    it("opens, reads and writes a database H1c shaped, and creates no second index of a purpose", () => {
      const path = serverFile();
      tamper(path, H1C_SHAPE);
      const before = indexesOf(path);
      let stream = open(path);
      expect(
        [...stream.getAll()].map((m) => Buffer.from(m.raw).toString()),
      ).toEqual(['{"b":2}']);
      stream.set({ encoding: 1 as any, raw: Buffer.from('"c"'), msgID: "c" });
      stream.close();
      // the live tables' indexes are the same: they already had theirs (the
      // renamed messages table is unindexed archive, which the open trims)
      const live = (list: { name: string; tbl_name: string }[]) =>
        list.filter((i) => ["messages", "message_ids"].includes(i.tbl_name));
      expect(live(indexesOf(path))).toEqual(live(before));
      expect(live(before)).toHaveLength(3);
      // and it still opens
      stream = open(path);
      expect([...stream.getAll()]).toHaveLength(2);
      stream.close();
    });

    it("gives a live table without an index of a purpose one under a free name", () => {
      const path = serverFile();
      // the base name is carried by a renamed table
      tamper(
        path,
        [
          'ALTER TABLE message_ids RENAME TO "message_ids_trash_2"',
          "CREATE TABLE message_ids (seq INTEGER PRIMARY KEY, msg_id TEXT NOT NULL)",
        ].join(";\n"),
      );
      open(path).close();
      expect(
        indexesOf(path).filter((i) => i.name.startsWith("idx_message_ids")),
      ).toEqual([
        { name: "idx_message_ids_msg_id", tbl_name: "message_ids_trash_2" },
        { name: "idx_message_ids_msg_id_g1", tbl_name: "message_ids" },
      ]);
    });

    it.each([
      [
        "a second index of a purpose on one table",
        "CREATE INDEX idx_messages_key_g5 ON messages(key)",
      ],
      [
        "an index whose column is not its name's",
        "CREATE INDEX idx_messages_key_g5 ON messages(time)",
      ],
      [
        "a unique index of a purpose",
        "DROP INDEX idx_messages_time; CREATE UNIQUE INDEX idx_messages_time_g2 ON messages(time)",
      ],
      [
        "an index of a purpose on another table",
        "CREATE INDEX idx_messages_key_g5 ON message_ids(msg_id)",
      ],
      [
        "an index of a purpose on a table of another purpose",
        "CREATE INDEX idx_message_ids_msg_id_g5 ON messages(key)",
      ],
      [
        "an index of a purpose on two columns",
        "DROP INDEX idx_messages_time; CREATE INDEX idx_messages_time_g2 ON messages(time, raw)",
      ],
      [
        "a generation that is not a number",
        "DROP INDEX idx_messages_time; CREATE INDEX idx_messages_time_gx ON messages(time)",
      ],
      [
        "a changed counts table",
        RESET_TRASH_SCHEMA.stream_counts.replace(
          "trash_unknown_items INTEGER NOT NULL DEFAULT 0",
          "trash_unknown_items INTEGER NOT NULL DEFAULT 0, x BLOB",
        ),
      ],
      [
        "a changed trash ledger",
        RESET_TRASH_SCHEMA.history_trash.replace(
          "kind TEXT NOT NULL",
          "kind BLOB",
        ),
      ],
      [
        "a changed renamed id table",
        'CREATE TABLE "message_ids_trash_4" (seq INTEGER PRIMARY KEY, msg_id TEXT NOT NULL, x BLOB)',
      ],
      [
        "a trash id table name with a quote",
        `CREATE TABLE "message_ids_trash_1""; --"(seq INTEGER PRIMARY KEY, msg_id TEXT NOT NULL)`,
      ],
    ])("refuses %s", (_, sql) => {
      const path = serverFile();
      tamper(path, sql);
      expect(() => open(path)).toThrow(/changed outside CoCalc/);
    });

    it("this server does not create the reset-trash tables", () => {
      const path = serverFile();
      const db = new DatabaseSync(path + ".db");
      const names = (
        db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]
      ).map(({ name }) => name);
      db.close();
      for (const name of Object.keys(RESET_TRASH_SCHEMA)) {
        expect(names).not.toContain(name);
      }
    });
  });

  it("refuses a changed history table", () => {
    const path = serverFile();
    tamper(
      path,
      "DROP TABLE message_ids; CREATE TABLE message_ids (seq INTEGER PRIMARY KEY, msg_id TEXT NOT NULL, x BLOB)",
    );
    expect(() => open(path)).toThrow(/changed outside CoCalc/);
  });

  it("can be turned off in an emergency", () => {
    const path = serverFile();
    tamper(path, "CREATE TABLE other(x)");
    process.env.COCALC_PERSIST_SCHEMA_CHECK = "off";
    try {
      open(path).close();
    } finally {
      delete process.env.COCALC_PERSIST_SCHEMA_CHECK;
    }
  });

  it("describes the problem without trusting the name", () => {
    expect(
      unexpectedPersistSchema([
        {
          type: "trigger",
          name: "x".repeat(500),
          tbl_name: "messages",
          sql: "",
        },
      ]),
    ).toMatch(/^unexpected trigger "x{80}"$/);
  });
});

describe("the connection to a stored database", () => {
  it("cannot attach other databases or run untrusted schema functions", () => {
    const stream = open(serverFile());
    const db = (stream as any).db as DatabaseSync;
    expect(() => db.exec(`ATTACH '${join(dir, "other.db")}' AS other`)).toThrow(
      /too many attached databases/,
    );
    expect(db.prepare("PRAGMA trusted_schema").get()).toEqual({
      trusted_schema: 0,
    });
    stream.close();
  });

  it("keeps the WAL index of project files in memory, so a project cannot crash the server through -shm", () => {
    const path = serverFile({ inProject: true });
    // e.g., left by an older server; a mapped -shm that the project
    // truncates raises SIGBUS in the server
    writeFileSync(path + ".db-shm", Buffer.alloc(32 * 1024));
    const stream = open(path);
    stream.set({ encoding: 1 as any, raw: Buffer.from('{"b":2}') });
    const db = (stream as any).db as DatabaseSync;
    expect(db.prepare("PRAGMA locking_mode").get()).toEqual({
      locking_mode: "exclusive",
    });
    if (existsSync("/proc/self/maps")) {
      expect(readFileSync("/proc/self/maps", "utf8")).not.toContain(
        path + ".db-shm",
      );
    }
    // nothing else can use the file while the server has it open
    expect(() => tamper(path, "CREATE TABLE other(x)")).toThrow(
      /database is locked/,
    );
    stream.close();
    const reopened = open(path);
    expect(reopened.get({ seq: 2, key: undefined })).toBeDefined();
    reopened.close();
  });

  it("shares files that are not in a project, unless configured otherwise", () => {
    const inProject = join(dir, "project", "a.db");
    const elsewhere = join(dir, "a.db");
    expect(persistSqliteLockingMode(inProject, {})).toBe("exclusive");
    expect(persistSqliteLockingMode(elsewhere, {})).toBe("normal");
    expect(persistSqliteLockingMode(":memory:", {})).toBe("normal");
    const normal = { COCALC_PERSIST_SQLITE_LOCKING_MODE: "normal" };
    expect(persistSqliteLockingMode(inProject, normal)).toBe("normal");
    const exclusive = { COCALC_PERSIST_SQLITE_LOCKING_MODE: "exclusive" };
    expect(persistSqliteLockingMode(elsewhere, exclusive)).toBe("exclusive");
    // e.g., several persist servers, or test workers, using the same file
    const path = serverFile();
    const stream = open(path);
    tamper(path, "CREATE TABLE other(x); DROP TABLE other");
    stream.close();
  });

  it("waits for locks also on the first read", () => {
    const path = serverFile({ inProject: true });
    const reader = new DatabaseSync(path + ".db", { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM messages").get();
    process.env.COCALC_PERSIST_SQLITE_BUSY_TIMEOUT_MS = "300";
    const start = Date.now();
    try {
      expect(() => open(path)).toThrow(/database is locked/);
      expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    } finally {
      delete process.env.COCALC_PERSIST_SQLITE_BUSY_TIMEOUT_MS;
      reader.exec("COMMIT");
      reader.close();
    }
    open(path).close();
  });

  it("runs nothing from a trigger the project adds while it is open", () => {
    // A project can change the bytes of its files whatever the locking mode;
    // this file is not in a project, so this test can do it through SQLite.
    const path = serverFile();
    const stream = open(path);
    // the project changes the file after the schema was checked
    tamper(
      path,
      "CREATE TABLE log(n); CREATE TRIGGER t AFTER INSERT ON messages BEGIN INSERT INTO log VALUES (1); END",
    );
    expect(() =>
      stream.set({ encoding: 1 as any, raw: Buffer.from('{"c":3}') }),
    ).toThrow(/not authorized/);
    stream.close();
    const db = new DatabaseSync(path + ".db");
    expect(db.prepare("SELECT count(*) AS n FROM log").get()).toEqual({ n: 0 });
    db.close();
  });

  it("waits only briefly for locks", () => {
    expect(persistSqliteBusyTimeoutMs({})).toBe(500);
    expect(
      persistSqliteBusyTimeoutMs({
        COCALC_PERSIST_SQLITE_BUSY_TIMEOUT_MS: "0",
      }),
    ).toBe(0);
    expect(
      persistSqliteBusyTimeoutMs({
        COCALC_PERSIST_SQLITE_BUSY_TIMEOUT_MS: "x",
      }),
    ).toBe(500);
    const stream = open(serverFile());
    expect(
      ((stream as any).db as DatabaseSync).prepare("PRAGMA busy_timeout").get(),
    ).toEqual({ timeout: 500 });
    stream.close();
  });
});

describe("stored messages", () => {
  // A row as a project could write it: any raw data, any recorded size.
  function hostileRow({
    raw,
    compress,
    size,
    headers = null,
  }: {
    raw: Buffer | string;
    compress: number;
    size: number;
    headers?: string | null;
  }): string {
    const path = serverFile();
    const db = new DatabaseSync(path + ".db");
    db.prepare(
      "INSERT INTO messages(seq, time, compress, encoding, raw, headers, size) VALUES (10, 0, ?, 1, ?, ?, ?)",
    ).run(compress, raw, headers, size);
    db.close();
    return path;
  }

  // 10 MB that compresses to a few hundred bytes
  const bomb = zstdCompressSync(Buffer.alloc(10 * 1024 * 1024));

  it("are never decompressed beyond their recorded size", async () => {
    expect(bomb.length).toBeLessThan(1000);
    const stream = open(hostileRow({ raw: bomb, compress: 1, size: 100 }));
    expect(() => stream.get({ seq: 10, key: undefined })).toThrow(
      /larger than/,
    );
    expect(() => [...stream.getAll()]).toThrow(/larger than/);
    const [row] = stream.readPage(9, 10);
    await expect(storedRowToMessage(row)).rejects.toThrow(/larger than/);
    stream.close();
  });

  it("decompress legitimate large messages in full", async () => {
    const path = join(dir, `stream-${n++}`);
    const stream = new PersistentStream({ path, noCache: true } as any);
    const data = Buffer.alloc(3 * 1024 * 1024, 7);
    const { seq } = stream.set({ encoding: 1 as any, raw: data });
    const raw = stream.get({ seq, key: undefined })?.raw;
    expect(Buffer.from(raw!).equals(data)).toBe(true);
    const [row] = stream.readPage(seq - 1, seq);
    expect(Buffer.from((await storedRowToMessage(row)).raw).equals(data)).toBe(
      true,
    );
    stream.close();
  });

  it("are as large as what is stored, whatever size is recorded", () => {
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = String(1024 * 1024);
    try {
      const stream = open(
        hostileRow({
          raw: Buffer.alloc(2 * 1024 * 1024),
          compress: 0,
          size: 1,
        }),
      );
      expect(
        stream.planPage({ after_seq: 9, maxRows: 10, maxBytes: 1e9 }),
      ).toEqual([{ seq: 10, size: 2 * 1024 * 1024 }]);
      expect(() => stream.get({ seq: 10, key: undefined })).toThrow(
        /over the 1048576 byte limit/,
      );
      expect(() => [...stream.getAll()]).toThrow(/over the 1048576 byte limit/);
      stream.close();
    } finally {
      delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    }
  });

  it("that are not stored as bytes are corrupt, and never read", async () => {
    // a TEXT value, whose length() SQLite would have to scan
    const stream = open(
      hostileRow({ raw: "x".repeat(100_000), compress: 0, size: 2 }),
    );
    expect(
      stream.planPage({ after_seq: 9, maxRows: 10, maxBytes: 1e9 }),
    ).toEqual([{ seq: 10, size: Number.MAX_SAFE_INTEGER }]);
    expect(() => stream.get({ seq: 10, key: undefined })).toThrow(/is corrupt/);
    expect(() => [...stream.getAll()]).toThrow(/is corrupt/);
    const [row] = stream.readPage(9, 10);
    await expect(storedRowToMessage(row)).rejects.toThrow(/is corrupt/);
    stream.close();
  });

  it("with huge headers are not parsed", () => {
    const headers = JSON.stringify({ x: "y".repeat(2_000_000) });
    const stream = open(
      hostileRow({
        raw: Buffer.from("{}"),
        compress: 0,
        size: headers.length + 2,
        headers,
      }),
    );
    expect(() => stream.get({ seq: 10, key: undefined })).toThrow(
      /headers are .* over the 1000000 limit/,
    );
    stream.close();
  });
});
