/*
 * A board whose edit history cannot be loaded is rebuilt from its saved
 * .board.json by its host, or answers why not with ways to its content that
 * do not depend on the rebuild (bounded history plan H1b-4 r3, §6).
 *
 * Real Conat, file server and persist servers (with the board write
 * service), Sagebrush's own board library.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import "@cocalc/conat/sync-doc/install";
import {
  before as beforeConat,
  after as afterConat,
  connect,
  tempDir,
} from "@cocalc/backend/conat/test/setup";
import {
  createPathFileserver,
  cleanupFileservers,
} from "@cocalc/backend/conat/files/test/util";
import * as lib from "@sagemathinc/sagebrush-board";
import { uuid } from "@cocalc/util/misc";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import { createServer as createReadServer } from "@cocalc/conat/files/read";
import { handleFileDownload } from "@cocalc/conat/files/file-download";
import { dstream } from "@cocalc/conat/sync/dstream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import type { BoardOpenResult } from "@cocalc/conat/files/fs";
import { boardSyncdbPath } from "@cocalc/util/board/names";
import {
  BOARD_FILE_RESET_REASON,
  HISTORY_UNLOADABLE_DOCS,
} from "@cocalc/util/board/history-unloadable";
import {
  resetRunState,
  runInProgress,
  startRun,
  unresolvedReset,
} from "@cocalc/sync/editor/generic/reset-run";
import {
  closeBoards,
  fileOf,
  forgetUnknownRebuilds,
  openBoard,
  openBoardSyncdb,
  recordsToString,
} from "./service";
import {
  BOARD_HISTORY_PERSIST,
  REBUILD_LIMITS,
  rebuildBoardHistory,
} from "./history-rebuild";

jest.setTimeout(90_000);

let home: string;
let rootfs: string;
let fileserver: Awaited<ReturnType<typeof createPathFileserver>>;
// one client for the fixture's own reads and the host's calls (a second
// host and the browser replicas have their own)
let client: ReturnType<typeof connect>;
let sync: SyncClient;
const DEFAULT_LIMITS = { ...REBUILD_LIMITS };

beforeAll(async () => {
  await beforeConat();
  client = connect();
  sync = new SyncClient(client);
  home = await mkdtemp(join(tmpdir(), "board-rebuild-home-"));
  rootfs = await mkdtemp(join(tmpdir(), "board-rebuild-rootfs-"));
  fileserver = await createPathFileserver({
    path: home,
    rootfs,
    unsafeMode: false,
    homeAliases: ["/home/user"],
  });
});

afterAll(async () => {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  for (const fs of locals) fs.close();
  await cleanupFileservers();
  await rm(home, { recursive: true, force: true });
  await rm(rootfs, { recursive: true, force: true });
  await afterConat();
});

afterEach(async () => {
  Object.assign(REBUILD_LIMITS, DEFAULT_LIMITS);
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  forgetUnknownRebuilds();
  for (const project_id of projects) await closeBoards(project_id);
  projects.length = 0;
});

const projects: string[] = [];
const locals: SandboxedFilesystem[] = [];
function localFs(project_id: string): any {
  const fs = new SandboxedFilesystem(join(home, project_id), {
    host: project_id,
    homeAliases: ["/home/user"],
    allowSafeModeHardlink: true,
    allowSafeModeSymlink: true,
  });
  locals.push(fs);
  return fs;
}

const BOARD = {
  format: "sagebrush-board",
  version: 1,
  title: "Plan",
  nodes: [
    { id: "a", text: "hello world", x: 0, y: 0 },
    { id: "b", text: "second", x: 200, y: 0 },
  ],
  edges: [{ from: "a", to: "b" }],
};

const canonical = (doc: any) => lib.canonical(lib.cleanDoc(doc));
const valueOf = (text: string) =>
  recordsToString(lib.toRecords(lib.cleanDoc(JSON.parse(text))));

async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function deferred<T = void>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// the histories kept aside by resets, in every persist database
async function archivedCount(): Promise<number> {
  let n = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.name.endsWith(".db")) {
        const db = new DatabaseSync(p, { readOnly: true });
        try {
          const tables = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'messages_archived_%'",
            )
            .all();
          n += tables.length;
        } finally {
          db.close();
        }
      }
    }
  };
  await walk(tempDir);
  return n;
}

const historyState = (project_id: string, path: string) =>
  sync.historyResetState({
    project_id,
    path: boardSyncdbPath(path),
    persist: BOARD_HISTORY_PERSIST,
  });

// A board whose file is text, and whose history holds an entry too large to
// load (in production, a note holding a pasted runaway output), as left by
// its host: the file was saved after the large entry was removed again.
async function unloadableBoard(text = canonical(BOARD)) {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  const project_id = uuid();
  projects.push(project_id);
  // as the host names it (canonicalBoardPath)
  const path = `/home/user/plan-${uuid().slice(0, 8)}.board.json`;
  const fs: any = client.fs({ project_id, service: fileserver.service });
  await fs.writeFile(path, canonical(BOARD));
  const db = await openBoardSyncdb({
    writer: true,
    client,
    project_id,
    path,
    service: fileserver.service,
  });
  db.from_str(valueOf(canonical(BOARD)));
  db.commit();
  await db.save();
  db.set({ type: "item", page: "", id: "a", text: "x".repeat(50_000) });
  db.commit();
  await db.save();
  db.set({ type: "item", page: "", id: "a", text: "hello world" });
  db.commit();
  await db.save();
  await db.close();
  await fs.writeFile(path, text);
  // Every history entry over 20 KB is now too large to load.
  process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
  const state = await historyState(project_id, path);
  return {
    project_id,
    path,
    fs,
    local: localFs(project_id),
    state,
    // A save renames the board aside for an instant: a reader then may find
    // no file, and reads again.
    read: async () => {
      for (let i = 0; ; i++) {
        try {
          return Buffer.from(await fs.readFile(path));
        } catch (err) {
          if (i >= 20) throw err;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    },
  };
}

function opts(b: { project_id: string; path: string; local: any }, extra = {}) {
  return {
    client,
    project_id: b.project_id,
    path: b.path,
    fs: b.local,
    service: fileserver.service,
    ...extra,
  };
}

// A SyncClient whose history operations can be watched and held.
function watchedClient(
  hooks: {
    historyResetState?: (real: () => Promise<any>) => Promise<any>;
    resetHistory?: (real: () => Promise<any>, opts: any) => Promise<any>;
  } = {},
) {
  const real = sync;
  const calls = { historyResetState: 0, resetHistory: [] as any[] };
  const client = {
    historyResetState: async (o: any) => {
      calls.historyResetState += 1;
      const call = () => real.historyResetState(o);
      return await (hooks.historyResetState?.(call) ?? call());
    },
    resetHistory: async (o: any) => {
      calls.resetHistory.push(o);
      const call = () => real.resetHistory(o);
      return await (hooks.resetHistory?.(call, o) ?? call());
    },
  };
  return { client: client as any, calls };
}

// The board's live document as its host would now open it.
async function liveValue(b: { project_id: string; path: string }) {
  const db = await openBoardSyncdb({
    writer: true,
    client,
    project_id: b.project_id,
    path: b.path,
    service: fileserver.service,
    timeoutMs: 20_000,
  });
  try {
    return db.to_str();
  } finally {
    await db.close();
  }
}

function expectUntouched(
  before: { epoch: number; seq: number; count: number },
  after: { epoch: number; seq: number; count: number },
) {
  expect({ epoch: after.epoch, seq: after.seq, count: after.count }).toEqual({
    epoch: before.epoch,
    seq: before.seq,
    count: before.count,
  });
}

describe("the rebuild", () => {
  test("rebuilds the history from the file: exact records, archived old history, recovered", async () => {
    const b = await unloadableBoard();
    const bytes = await b.read();
    const archivedBefore = await archivedCount();
    const { client, calls } = watchedClient();
    const result = await openBoard(opts(b, { syncClient: client }));
    expect(result).toMatchObject({
      state: "ok",
      recovered: { reason: BOARD_FILE_RESET_REASON },
    });
    expect(result.recovered!.history_epoch).toBeGreaterThan(b.state.epoch);
    // one reset, conditional on the history the open failed in
    expect(calls.resetHistory).toHaveLength(1);
    expect(calls.resetHistory[0].options).toMatchObject({
      ifInitEpoch: b.state.epoch,
      ifRevision: { seq: b.state.seq, count: b.state.count },
      coveredSeq: 0,
      allowRollback: true,
      archive: true,
      reason: BOARD_FILE_RESET_REASON,
      settings: { history_reset: { reason: BOARD_FILE_RESET_REASON } },
    });
    expect(calls.resetHistory[0].persist).toEqual(BOARD_HISTORY_PERSIST);
    // the file is untouched, and the history is exactly its records
    expect((await b.read()).equals(bytes)).toBe(true);
    await closeBoards(b.project_id);
    expect(await liveValue(b)).toBe(valueOf(bytes.toString()));
    expect(await archivedCount()).toBe(archivedBefore + 1);
    const after = await historyState(b.project_id, b.path);
    expect(after.epoch).toBe(result.recovered!.history_epoch);
    expect(after.reset?.reason).toBe(BOARD_FILE_RESET_REASON);
  });
});

test("every open of the rebuilt board says so; the browser shows it once per epoch", async () => {
  const b = await unloadableBoard();
  const first = await openBoard(opts(b));
  const again = await openBoard(opts(b));
  expect(again.recovered).toEqual(first.recovered);
});

// What the download link and "Open as text" reach: the project's own file
// services, never the board host.
async function download(project_id: string, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const res: any = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: () => {},
    removeHeader: () => {},
    write: (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end: (chunk?: any) => {
      if (chunk != null) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.emit("finish");
    },
    destroy: () => {},
    destroyed: false,
    writableEnded: false,
    headersSent: true,
  });
  await handleFileDownload({
    req: { method: "GET", url: `/${project_id}/files${path}?download` },
    res,
    client,
  });
  expect(res.statusCode).toBe(200);
  return Buffer.concat(chunks);
}

const served = new Set<string>();
async function serveFileReads(project_id: string) {
  if (served.has(project_id)) return;
  served.add(project_id);
  // streamed from disk, as the project host serves a download
  await createReadServer({
    project_id,
    client,
    createReadStream: (async (path: string, o: any = {}) =>
      createReadStream(
        join(home, project_id, path.replace(/^\/home\/user\//, "")),
        o,
      )) as any,
  });
}

async function openAsText(project_id: string, path: string): Promise<string> {
  const doc = client.sync.string({
    project_id,
    path,
    service: fileserver.service,
  });
  await new Promise((r) => doc.once("ready", r));
  try {
    return doc.to_str();
  } finally {
    await doc.close();
  }
}

function expectFallbacks(result: BoardOpenResult, cause: string) {
  expect(result).toMatchObject({
    state: "history-unloadable",
    cause,
    actions: ["open-as-text", "download", "retry"],
    docs: HISTORY_UNLOADABLE_DOCS,
  });
}

describe("every refusal: the right cause and actions; the file and the history untouched", () => {
  async function refused(
    text: string,
    cause: string,
    extra: object = {},
    actions = ["open-as-text", "download", "retry"],
  ) {
    const b = await unloadableBoard(text);
    const bytes = await b.read();
    const archived = await archivedCount();
    const { client, calls } = watchedClient((extra as any).hooks);
    const result = await openBoard(opts(b, { syncClient: client }));
    expect(result).toMatchObject({
      state: "history-unloadable",
      cause,
      actions,
      docs: HISTORY_UNLOADABLE_DOCS,
    });
    expect(calls.resetHistory).toHaveLength(0);
    expect((await b.read()).equals(bytes)).toBe(true);
    expectUntouched(b.state, await historyState(b.project_id, b.path));
    expect(await archivedCount()).toBe(archived);
    return { b, result, bytes };
  }

  test("not JSON: file-invalid, and the message does not quote the file", async () => {
    const { result } = await refused('{"secret": "do not echo', "file-invalid");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("JSON, but not a board: file-invalid", async () => {
    await refused(JSON.stringify({ format: "other" }), "file-invalid");
  });

  test("more records than a host edits: file-too-large", async () => {
    const nodes = Array.from({ length: 1001 }, (_, i) => ({
      id: `n${i}`,
      text: "",
      x: i,
      y: 0,
    }));
    await refused(canonical({ ...BOARD, nodes, edges: [] }), "file-too-large");
  });

  test("a rebuild already running: busy, Retry only", async () => {
    const b = await unloadableBoard();
    const bytes = await b.read();
    const run = startRun(boardSyncdbPath(b.path), { deadlineMs: 60_000 })!;
    try {
      const { client, calls } = watchedClient();
      const result = await openBoard(opts(b, { syncClient: client }));
      expect(result).toMatchObject({
        state: "history-unloadable",
        cause: "busy",
        actions: ["retry"],
      });
      // nothing was read or asked
      expect(calls.historyResetState).toBe(0);
      expect(calls.resetHistory).toHaveLength(0);
      expect((await b.read()).equals(bytes)).toBe(true);
    } finally {
      run.finish();
    }
    await until(() => !runInProgress(boardSyncdbPath(b.path)));
  });

  test("the rebuild takes too long before anything is sent: deadline", async () => {
    REBUILD_LIMITS.deadlineMs = 1000;
    await refused(canonical(BOARD), "deadline", {
      hooks: {
        historyResetState: async (real) => {
          await new Promise((r) => setTimeout(r, 2000));
          return await real();
        },
      },
    });
  });

  test("the rebuild fails: failed", async () => {
    await refused(canonical(BOARD), "failed", {
      hooks: {
        historyResetState: async () => {
          throw Error("the history service is down");
        },
      },
    });
  });
});

describe("the refusals of the rebuild itself, with each of its caps", () => {
  async function direct(
    b: Awaited<ReturnType<typeof unloadableBoard>>,
    limits: Partial<typeof REBUILD_LIMITS> = {},
    file = fileOf(b.local, b.path),
  ) {
    const bytes = await b.read();
    const { client, calls } = watchedClient();
    const result = await rebuildBoardHistory({
      project_id: b.project_id,
      syncPath: boardSyncdbPath(b.path),
      file,
      lib,
      recordsToString,
      failedEpoch: b.state.epoch,
      syncClient: client,
      limits: { ...DEFAULT_LIMITS, ...limits },
    });
    expect(calls.resetHistory).toHaveLength(0);
    expect((await b.read()).equals(bytes)).toBe(true);
    expectUntouched(b.state, await historyState(b.project_id, b.path));
    return result;
  }

  test("the file's byte cap", async () => {
    const b = await unloadableBoard();
    expect(await direct(b, { fileBytes: 100 })).toMatchObject({
      outcome: "refused",
      cause: "file-too-large",
    });
  });

  test("the value cap", async () => {
    const b = await unloadableBoard();
    expect(await direct(b, { valueBytes: 200 })).toMatchObject({
      outcome: "refused",
      cause: "file-too-large",
    });
  });

  test("the value's work cap", async () => {
    const b = await unloadableBoard();
    expect(await direct(b, { valueWork: 10 })).toMatchObject({
      outcome: "refused",
      cause: "file-too-large",
    });
  });

  test("the seed cap", async () => {
    const b = await unloadableBoard();
    expect(await direct(b, { seedBytes: 100 })).toMatchObject({
      outcome: "refused",
      cause: "file-too-large",
    });
  });

  test("the file is gone: file-missing, with restore", async () => {
    const b = await unloadableBoard();
    const result = await direct(
      b,
      {},
      fileOf(b.local, "/home/user/gone.board.json"),
    );
    expect(result).toMatchObject({ outcome: "refused", cause: "file-missing" });
  });
});

describe("the fallbacks work while the rebuild keeps failing", () => {
  for (const cause of ["deadline", "failed"]) {
    test(`${cause}: Download streams the exact bytes; Open as text opens the file`, async () => {
      REBUILD_LIMITS.deadlineMs = 1000;
      const b = await unloadableBoard();
      await serveFileReads(b.project_id);
      const bytes = await b.read();
      const failing = watchedClient({
        historyResetState: async (real) => {
          if (cause == "failed") throw Error("down");
          await new Promise((r) => setTimeout(r, 2000));
          return await real();
        },
      });
      for (let i = 0; i < 2; i++) {
        const result = await openBoard(opts(b, { syncClient: failing.client }));
        expectFallbacks(result, cause);
        expect((await download(b.project_id, result.path)).equals(bytes)).toBe(
          true,
        );
        expect(await openAsText(b.project_id, result.path)).toBe(
          bytes.toString(),
        );
        await until(() => !runInProgress(boardSyncdbPath(b.path)));
      }
      expect(failing.calls.resetHistory).toHaveLength(0);
    });
  }

  test("the result holds only paths and links: its size does not grow with the file's", async () => {
    const small = await unloadableBoard("x");
    const large = await unloadableBoard("x".repeat(3 * 1024 * 1024));
    const a = await openBoard(opts(small));
    const c = await openBoard(opts(large));
    expectFallbacks(a, "file-invalid");
    expectFallbacks(c, "file-invalid");
    expect(JSON.stringify(c).length).toBe(JSON.stringify(a).length);
    expect(JSON.stringify(c).length).toBeLessThan(2000);
  });
});

describe("CORR-H1B4P-2: two hosts, one held after reading the file", () => {
  // A and B take the conditions and read the file; B is held before its
  // reset; A rebuilds, and a live edit is saved to the file (F1); then B's
  // reset goes.  sameFile: A read the same bytes as B (so the same opId);
  // otherwise the file changed between B's read and A's.
  for (const sameFile of [true, false]) {
    test(`B never resets over A's recovery; the edit since survives (${sameFile ? "same file: B's reset is A's, repeated" : "changed file: B's reset is refused, and B recognizes A's recovery"})`, async () => {
      const b = await unloadableBoard();
      const E0 = b.state.epoch;
      // host B: its own process state (run slots, gates)
      let hostB: typeof import("./history-rebuild");
      jest.isolateModules(() => {
        hostB = require("./history-rebuild");
      });
      const hold = deferred();
      const B = watchedClient({
        resetHistory: async (real) => {
          await hold.promise;
          return await real();
        },
      });
      const bRun = hostB!.rebuildBoardHistory({
        project_id: b.project_id,
        syncPath: boardSyncdbPath(b.path),
        file: fileOf(b.local, b.path),
        lib,
        recordsToString,
        failedEpoch: E0,
        syncClient: B.client,
        limits: { ...DEFAULT_LIMITS, deadlineMs: 60_000 },
      });
      // B took the conditions and read F0, and sent its reset (held)
      await until(() => B.calls.resetHistory.length == 1);
      if (!sameFile) {
        await b.fs.writeFile(
          b.path,
          canonical({ ...BOARD, title: "Plan, as A read it" }),
        );
      }

      let browser: Awaited<ReturnType<typeof openBoardSyncdb>> | undefined;
      try {
        // host A rebuilds, and a live edit is saved to the file (F1)
        const a = await openBoard(opts(b));
        expect(a.state).toBe("ok");
        const E1 = a.recovered!.history_epoch;
        expect(E1).toBeGreaterThan(E0);
        browser = await openBoardSyncdb({
          writer: true,
          client: connect(),
          project_id: b.project_id,
          path: b.path,
          service: fileserver.service,
        });
        browser.set({ type: "item", page: "", id: "b", text: "edit after A" });
        browser.commit();
        await browser.save();
        await until(async () => (await b.read()).includes("edit after A"));
        const archived = await archivedCount();

        hold.resolve();
        const result = await bRun;
        expect(result).toMatchObject(
          sameFile
            ? { outcome: "rebuilt", repeated: true, history_epoch: E1 }
            : { outcome: "recovered", history_epoch: E1 },
        );
        // B's one reset, with F0's conditions, was not applied: never sent
        // again under E1
        expect(B.calls.resetHistory).toHaveLength(1);
        expect(B.calls.resetHistory[0].options.ifInitEpoch).toBe(E0);
        expect((await historyState(b.project_id, b.path)).epoch).toBe(E1);
        expect(await archivedCount()).toBe(archived);
        expect((await b.read()).includes("edit after A")).toBe(true);
        expect(browser.get_one({ type: "item", page: "", id: "b" })?.text).toBe(
          "edit after A",
        );

        // stale retries from before the epoch change, with the same file and
        // with a changed one: recognized, nothing reset
        for (const change of [false, true]) {
          if (change) {
            await b.fs.writeFile(
              b.path,
              canonical({
                ...BOARD,
                nodes: [{ id: "z", text: "changed", x: 0, y: 0 }],
                edges: [],
              }),
            );
          }
          const retry = watchedClient();
          expect(
            await rebuildBoardHistory({
              project_id: b.project_id,
              syncPath: boardSyncdbPath(b.path),
              file: fileOf(b.local, b.path),
              lib,
              recordsToString,
              failedEpoch: E0,
              syncClient: retry.client,
            }),
          ).toMatchObject({ outcome: "recovered", history_epoch: E1 });
          expect(retry.calls.resetHistory).toHaveLength(0);
          expect((await historyState(b.project_id, b.path)).epoch).toBe(E1);
        }
      } finally {
        hold.resolve();
        await bRun.catch(() => {});
        await browser?.close();
      }
    });
  }
});

test("a board-file marker at the failed open's epoch is not a recovery: the host rebuilds", async () => {
  const b = await unloadableBoard();
  const first = await openBoard(opts(b));
  const E1 = first.recovered!.history_epoch;
  await closeBoards(b.project_id);
  // the history becomes unloadable again, in E1, which a board-file reset
  // made
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  const db = await openBoardSyncdb({
    writer: true,
    client: connect(),
    project_id: b.project_id,
    path: b.path,
    service: fileserver.service,
  });
  db.set({ type: "item", page: "", id: "a", text: "y".repeat(50_000) });
  db.commit();
  await db.save();
  db.set({ type: "item", page: "", id: "a", text: "hello world" });
  db.commit();
  await db.save();
  await db.close();
  process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
  const marked = await historyState(b.project_id, b.path);
  expect(marked).toMatchObject({
    epoch: E1,
    reset: { reason: BOARD_FILE_RESET_REASON },
  });
  const { client, calls } = watchedClient();
  const second = await openBoard(opts(b, { syncClient: client }));
  expect(second.state).toBe("ok");
  expect(second.recovered!.history_epoch).toBeGreaterThan(E1);
  expect(calls.resetHistory).toHaveLength(1);
  expect(calls.resetHistory[0].options.ifInitEpoch).toBe(E1);
});

describe("reset-unknown: a reset sent without an answer in time", () => {
  test("held past the deadline: unknown; other opens busy; when it applies, Retry opens it", async () => {
    REBUILD_LIMITS.deadlineMs = 2000;
    const b = await unloadableBoard();
    const syncPath = boardSyncdbPath(b.path);
    const hold = deferred();
    const held = watchedClient({
      resetHistory: async (real) => {
        await hold.promise;
        return await real();
      },
    });
    const result = await openBoard(opts(b, { syncClient: held.client }));
    expectFallbacks(result, "reset-unknown");
    expect(result.message).toMatch(/may already have been rebuilt/);
    expect(runInProgress(syncPath)).toBe(true);
    expect(unresolvedReset(syncPath)).toBeDefined();
    // another open meanwhile: busy, nothing asked
    const other = watchedClient();
    expect(
      await openBoard(opts(b, { syncClient: other.client })),
    ).toMatchObject({
      state: "history-unloadable",
      cause: "busy",
      actions: ["retry"],
    });
    expect(other.calls.historyResetState).toBe(0);
    hold.resolve();
    await until(() => !runInProgress(syncPath));
    expect(unresolvedReset(syncPath)).toBeUndefined();
    const retry = await openBoard(opts(b));
    expect(retry).toMatchObject({
      state: "ok",
      recovered: { reason: BOARD_FILE_RESET_REASON },
    });
    expect(retry.recovered!.history_epoch).toBeGreaterThan(b.state.epoch);
    expect(held.calls.resetHistory).toHaveLength(1);
  });

  test("held past the deadline, then refused: the history is as it was, and Retry rebuilds", async () => {
    REBUILD_LIMITS.deadlineMs = 2000;
    const b = await unloadableBoard();
    const syncPath = boardSyncdbPath(b.path);
    const hold = deferred();
    const held = watchedClient({
      resetHistory: async (real) => {
        await hold.promise;
        return await real();
      },
    });
    const archived = await archivedCount();
    expectFallbacks(
      await openBoard(opts(b, { syncClient: held.client })),
      "reset-unknown",
    );
    // the history moves meanwhile, so the held reset's conditions fail
    // (written by a client that can still load it)
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    const ds = await dstream({
      client: connect(),
      project_id: b.project_id,
      name: patchesStreamName({ path: syncPath }),
      service: BOARD_WRITE_SERVICE,
      persistUser: {},
      noInventory: true,
    });
    ds.publish({ moved: true });
    await ds.save();
    ds.close();
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
    hold.resolve();
    await until(() => !runInProgress(syncPath));
    const after = await historyState(b.project_id, b.path);
    expect(after.epoch).toBe(b.state.epoch);
    expect(await archivedCount()).toBe(archived);
    expect(unresolvedReset(syncPath)).toBeUndefined();
    const retry = await openBoard(opts(b));
    expect(retry.state).toBe("ok");
    expect(retry.recovered!.history_epoch).toBeGreaterThan(b.state.epoch);
  });

  test("a transport timeout after the reset was sent is unknown, never a refusal", async () => {
    const b = await unloadableBoard();
    const timeout = watchedClient({
      resetHistory: async (real) => {
        await real();
        throw Object.assign(Error("request timed out"), { code: 408 });
      },
    });
    expectFallbacks(
      await openBoard(opts(b, { syncClient: timeout.client })),
      "reset-unknown",
    );
    await until(() => !runInProgress(boardSyncdbPath(b.path)));
    // it had applied: Retry opens the rebuilt board, and says so
    const retry = await openBoard(opts(b));
    expect(retry).toMatchObject({
      state: "ok",
      recovered: { reason: BOARD_FILE_RESET_REASON },
    });
  });

  test("a disconnect after the reset was sent is unknown; Retry rebuilds if it never applied", async () => {
    const b = await unloadableBoard();
    const dropped = watchedClient({
      resetHistory: async () => {
        throw Object.assign(Error("disconnected"), { code: 503 });
      },
    });
    expectFallbacks(
      await openBoard(opts(b, { syncClient: dropped.client })),
      "reset-unknown",
    );
    expectUntouched(b.state, await historyState(b.project_id, b.path));
    await until(() => !runInProgress(boardSyncdbPath(b.path)));
    const retry = await openBoard(opts(b));
    expect(retry.state).toBe("ok");
    expect(retry.recovered!.history_epoch).toBeGreaterThan(b.state.epoch);
  });
});

describe("the slot is taken before anything is read", () => {
  function counted(b: { local: any; path: string }, hold?: Promise<void>) {
    const file = fileOf(b.local, b.path);
    const reads = { n: 0 };
    return {
      reads,
      file: {
        read: async (max: number) => {
          reads.n += 1;
          await hold;
          return await file.read(max);
        },
      },
    };
  }
  const rebuild = (b, file, limits: Partial<typeof REBUILD_LIMITS> = {}) =>
    rebuildBoardHistory({
      project_id: b.project_id,
      syncPath: boardSyncdbPath(b.path),
      file,
      lib,
      recordsToString,
      failedEpoch: b.state.epoch,
      syncClient: watchedClient().client,
      limits: { ...DEFAULT_LIMITS, ...limits },
    });

  test("a concurrent rebuild is busy without reading", async () => {
    const b = await unloadableBoard();
    const hold = deferred();
    const first = counted(b, hold.promise);
    const running = rebuild(b, first.file);
    await until(() => first.reads.n == 1);
    const second = counted(b);
    expect(await rebuild(b, second.file)).toMatchObject({
      outcome: "refused",
      cause: "busy",
    });
    expect(second.reads.n).toBe(0);
    hold.resolve();
    expect((await running).outcome).toBe("rebuilt");
  });

  test("a read held past repeated deadlines: one read in all", async () => {
    const b = await unloadableBoard();
    const hold = deferred();
    const c = counted(b, hold.promise);
    expect(await rebuild(b, c.file, { deadlineMs: 300 })).toMatchObject({
      outcome: "refused",
      cause: "deadline",
    });
    for (let i = 0; i < 3; i++) {
      expect(await rebuild(b, c.file, { deadlineMs: 300 })).toMatchObject({
        outcome: "refused",
        cause: "busy",
      });
    }
    expect(c.reads.n).toBe(1);
    hold.resolve();
    await until(() => !runInProgress(boardSyncdbPath(b.path)));
    expect(c.reads.n).toBe(1);
    expectUntouched(b.state, await historyState(b.project_id, b.path));
  });
});

afterAll(() => resetRunState());
