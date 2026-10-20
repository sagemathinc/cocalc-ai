/*
A board stream never yields or allocates a record over a board's record
limit (BOARD_HISTORY_LIMITS.recordBytes), whatever is stored in it: a
restored or otherwise direct history with a record that inflates past the
limit, or whose size column lies, is refused (413) before its decompressed
bytes exist. And a replay response stays under its threshold, sent before the
record that would take it over.
*/

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { boardSyncdbPath } from "@cocalc/util/board/names";
import { uuid } from "@cocalc/util/misc";
import { stream as persistStream } from "@cocalc/conat/persist/client";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { getStream } from "@cocalc/conat/persist/util";
import { boardRecordCap } from "@cocalc/conat/persist/board-record-cap";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import { BOARD_HISTORY_LIMITS } from "@cocalc/conat/persist/board-history";
import { createZstdCompress } from "node:zlib";

beforeAll(before);
afterAll(after);

jest.setTimeout(120_000);

const MiB = 1024 * 1024;
const CAP = BOARD_HISTORY_LIMITS.recordBytes;

const storage = (project_id: string, path: string) =>
  storagePath({
    project_id,
    name: patchesStreamName({ path: boardSyncdbPath(path) }),
  });

// The stream as the persist server holds it: written directly, as a restored
// database would be, bypassing the write service.
async function direct(project_id: string, path: string) {
  return await getStream({
    subject: `${BOARD_WRITE_SERVICE}.hub`,
    service: BOARD_WRITE_SERVICE,
    storage: { path: storage(project_id, path) },
    // As the persist server opens it.
    recordCap: boardRecordCap(storage(project_id, path)),
  });
}

function reader(project_id: string, path: string) {
  return persistStream({
    client: connect(),
    user: { project_id },
    storage: { path: storage(project_id, path) },
    noCache: true,
  });
}

// zstd of n bytes of zeros, made a MiB at a time (never holding n bytes).
async function zstdZeros(n: number): Promise<Buffer> {
  const z = createZstdCompress();
  const out: Buffer[] = [];
  z.on("data", (d) => out.push(d));
  const done = new Promise((resolve) => z.on("end", resolve));
  const chunk = Buffer.alloc(MiB);
  for (let written = 0; written < n; written += MiB) {
    if (!z.write(chunk)) await new Promise((r) => z.once("drain", r));
  }
  z.end();
  await done;
  return Buffer.concat(out);
}

// Insert a stored row as is: compressed raw, and the size column it claims.
function insertRow(stream: any, raw: Buffer, size: number, compress = 1) {
  stream.sqlite(
    "INSERT INTO messages(time, compress, encoding, raw, headers, key, size, ttl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [Date.now() / 1000, compress, 0, raw, null, null, size, null],
  );
}

async function readAll(r: ReturnType<typeof reader>) {
  const pages: number[][] = [];
  for await (const page of r.getAllIter({ timeout: 60_000 })) {
    pages.push(page.map((m: any) => m.raw.length));
  }
  return pages;
}

test("a record that inflates past the cap is refused, and its inflated bytes are never allocated", async () => {
  const project_id = uuid();
  const path = "/home/user/bomb.board.json";
  const bomb = await zstdZeros(1024 * MiB); // 1 GiB of zeros, a few KiB stored
  expect(bomb.length).toBeLessThan(MiB);
  const s = await direct(project_id, path);
  // Its size column says what it inflates to; and a second one that lies.
  insertRow(s, bomb, 1024 * MiB);
  const rss0 = process.resourceUsage().maxRSS;
  const r = reader(project_id, path);
  await expect(readAll(r)).rejects.toMatchObject({ code: 413 });
  r.close();
  // The same row through get: refused too.
  expect(() => s.get({ seq: 1, key: undefined })).toThrow(/over the/);
  const raisedMiB = (process.resourceUsage().maxRSS - rss0) / 1024;
  // Never anything like the 1 GiB it inflates to.
  expect(raisedMiB).toBeLessThan(CAP / MiB + 64);
});

test("a record whose size column lies is stopped by the bounded decompression", async () => {
  const project_id = uuid();
  const path = "/home/user/liar.board.json";
  const bomb = await zstdZeros(256 * MiB);
  const s = await direct(project_id, path);
  insertRow(s, bomb, 10); // claims 10 bytes
  const rss0 = process.resourceUsage().maxRSS;
  const r = reader(project_id, path);
  await expect(readAll(r)).rejects.toMatchObject({ code: 413 });
  r.close();
  expect(() => s.get({ seq: 1, key: undefined })).toThrow(/over the/);
  expect((process.resourceUsage().maxRSS - rss0) / 1024).toBeLessThan(
    CAP / MiB + 64,
  );
});

test("an uncompressed stored record over the cap is refused by its stored length, before it is read", async () => {
  const project_id = uuid();
  const path = "/home/user/big.board.json";
  const s = await direct(project_id, path);
  insertRow(s, Buffer.alloc(CAP + 1), 10, 0); // claims 10 bytes, holds more
  const r = reader(project_id, path);
  await expect(readAll(r)).rejects.toMatchObject({ code: 413 });
  r.close();
});

describe("a replay page's budget counts the bytes stored, not the size column (astra LIMIT-4B7-1)", () => {
  test("astra's probe: 1,000 rows of 4 MiB stored that claim size 1 admit and read one row per 8 MB page", async () => {
    const s: any = await direct(uuid(), "/home/user/meta.board.json");
    // Fake SQLite metadata (nothing that large is allocated): 1,000 rows
    // stored at 4 MiB each, every size column saying 1.
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      seq: i + 1,
      size: 1,
      stored: 4 * MiB,
    }));
    let pulled = 0;
    const db = s.db;
    s.db = {
      prepare: (sql: string) => ({
        all: () => (sql.includes("length(raw) AS stored") ? rows : []),
        *iterate() {
          for (const r of rows) {
            pulled++;
            yield {
              ...r,
              key: null,
              time: 0,
              compress: 0,
              encoding: 0,
              raw: Buffer.alloc(1),
              headers: null,
            };
          }
        },
      }),
    };
    try {
      const budget = 8_000_000;
      const plan = s.planPage({
        after_seq: 0,
        maxRows: 1000,
        maxBytes: budget,
      });
      // At most budget / 4 MiB rows (and always one).
      expect(plan.length).toBe(Math.max(1, Math.floor(budget / (4 * MiB))));
      expect(plan.reduce((t: number, r: any) => t + r.size, 0)).toBe(4 * MiB);
      // Reading the whole range stops at the budget too: one row returned,
      // and only the next one looked at.
      const read = s.readPage(0, 1000, budget);
      expect(read).toHaveLength(1);
      expect(pulled).toBe(2);
    } finally {
      s.db = db;
    }
  });

  test("stored rows that understate their size: every replay page stays within its 8 MB budget", async () => {
    const project_id = uuid();
    const path = "/home/user/understated.board.json";
    const s = await direct(project_id, path);
    // Ten 1 MiB uncompressed rows, each claiming 1 byte: charged by size
    // alone, all ten would be one page.
    for (let i = 0; i < 10; i++) insertRow(s, Buffer.alloc(MiB, i + 1), 1, 0);
    const r = reader(project_id, path);
    const pages = (await readAll(r)).filter((p) => p.length > 0);
    r.close();
    expect(pages.flat()).toHaveLength(10);
    for (const page of pages) {
      expect(page.reduce((t, n) => t + n, 0)).toBeLessThanOrEqual(8_000_000);
    }
    expect(pages.length).toBeGreaterThan(1);
  });

  test("a compressed record inflates to at most its size column: one that understates it is refused", async () => {
    const project_id = uuid();
    const path = "/home/user/inflates.board.json";
    const s = await direct(project_id, path);
    // 1 MiB of zeros (within the cap) that claims to be 100 bytes.
    insertRow(s, await zstdZeros(MiB), 100);
    const r = reader(project_id, path);
    await expect(readAll(r)).rejects.toMatchObject({ code: 413 });
    r.close();
    // Its true size is fine.
    const t = uuid();
    const s2 = await direct(t, path);
    insertRow(s2, await zstdZeros(MiB), MiB);
    const r2 = reader(t, path);
    expect((await readAll(r2)).flat()).toEqual([MiB]);
    r2.close();
  });
});

test("a record at the cap is read; a response holds what fits and is sent before the record that would take it over", async () => {
  const project_id = uuid();
  const path = "/home/user/pages.board.json";
  const s = await direct(project_id, path);
  // The server plans replay pages of at most 8 MB (REPLAY_PAGE_BYTES): two
  // 3 MiB records fit (6.3 MB, just below), a third would not (9.4 MB, just
  // above).
  for (let i = 0; i < 5; i++) {
    s.set({ encoding: 0, raw: Buffer.alloc(3 * MiB, i + 1) });
  }
  // And one exactly at the cap: alone in its response, the only overshoot.
  s.set({ encoding: 0, raw: Buffer.alloc(CAP, 9) });
  const r = reader(project_id, path);
  const pages = (await readAll(r)).filter((p) => p.length > 0);
  r.close();
  expect(pages).toEqual([
    [3 * MiB, 3 * MiB],
    [3 * MiB, 3 * MiB],
    [3 * MiB],
    [CAP],
  ]);
});
