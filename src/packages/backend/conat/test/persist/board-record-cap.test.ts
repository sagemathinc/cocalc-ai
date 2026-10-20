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
