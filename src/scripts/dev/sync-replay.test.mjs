import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGraph, explain, loadPatches, summarize } from "./sync-replay.mjs";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pf = createRequire(path.join(SRC_ROOT, "packages/sync/package.json"))(
  "patchflow",
);
const msgpack = createRequire(
  path.join(SRC_ROOT, "packages/conat/package.json"),
)("@msgpack/msgpack");

const PARAGRAPH = "A long paragraph that exists once in the document. ".repeat(
  6,
);

function writeDb(dir, messages) {
  const file = path.join(dir, "doc.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE,
    time INTEGER NOT NULL, headers TEXT, compress NUMBER NOT NULL, encoding NUMBER NOT NULL,
    raw BLOB NOT NULL, size NUMBER NOT NULL, ttl NUMBER);
    CREATE TABLE stream_metadata (id INTEGER PRIMARY KEY, metadata_json TEXT, revision INTEGER);`);
  db.prepare("INSERT INTO stream_metadata VALUES (1, ?, 0)").run(
    JSON.stringify({ users: ["__filesystem__", "alice", "bob"] }),
  );
  const insert = db.prepare(
    "INSERT INTO messages (time, compress, encoding, raw, size) VALUES (?, 0, 0, ?, ?)",
  );
  for (const m of messages) {
    const raw = Buffer.from(msgpack.encode(m));
    insert.run(m.wall, raw, raw.length);
  }
  db.close();
  return file;
}

function history() {
  const v1 = `intro\n\n${PARAGRAPH}\n\nend\n`;
  const v2 = `intro\n\n${PARAGRAPH}\n\n${PARAGRAPH}\n\nend\n`; // bob duplicates it
  const v3 = v1; // alice reverts bob's patch exactly
  const t1 = pf.encodePatchId(1000, "alice0");
  const t2 = pf.encodePatchId(2000, "bob0");
  const t3 = pf.encodePatchId(3000, "alice0");
  const msg = (time, wall, userId, parents, version, from, to) => ({
    time,
    wall,
    user_id: userId,
    parents,
    version,
    is_snapshot: false,
    patch: JSON.stringify(pf.makePatch(from, to)),
  });
  return [
    msg(t1, 1000, 1, [], 1, "", v1),
    msg(t2, 2000, 2, [t1], 2, v1, v2),
    msg(t3, 3000, 1, [t2], 3, v2, v3),
  ];
}

test("decodes a stream and flags duplicated and reverting patches", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { patches, users } = loadPatches(writeDb(dir, history()));
  assert.deepEqual(users, ["__filesystem__", "alice", "bob"]);
  assert.equal(patches.length, 3);
  const graph = buildGraph(patches);
  const rows = summarize(patches, graph, { minDup: 100 });
  assert.deepEqual(
    rows.map((r) => [r.version, r.flags]),
    [
      [1, ["BIG"]],
      [2, ["BIG", "DUP"]],
      [3, ["REVERT"]],
    ],
  );
});

test("explain finds the merge inputs that reproduce a patch", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { patches } = loadPatches(writeDb(dir, history()));
  const graph = buildGraph(patches);
  // v3 (the revert) equals merge(base=v2, local=v1, remote=v2).
  const { hits } = explain(patches, graph, 3, { from: 1, to: 2 });
  assert.ok(hits.some((h) => h.base === 2 && h.local === 1));
});
