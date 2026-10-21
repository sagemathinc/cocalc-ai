/*
A document whose edit history holds an entry too large to load (in
production, a runaway notebook output saved as a single 500 MB patch) must
still open, without losing an edit (bounded history plan r3, §2.3):

- if the saved file's proof covers every accepted edit, the client opening
  the document restarts the history from the file automatically, keeping the
  old history aside in the patch stream's database, and tells the user with
  a toast that stays until dismissed; open copies close instead of writing
  stale state;
- otherwise nothing is reset automatically: the editor is told, and the user
  can choose to restart the history from the saved file, which moves newer
  edits out of the live document into the archived history;
- documents saved some other way (noSaveToDisk, e.g., a notebook's .ipynb)
  keep the unseeded reset for now (H1b-3).

When several clients hit the oversized entry at once, only one resets the
history, and a late reset never deletes edits made after the first.

pnpm test ./oversized-history.test.ts
*/

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { purgeHistory } from "@cocalc/conat/hub/api/sync-impl";
import {
  SyncClient,
  setSyncClientHooks,
} from "@cocalc/conat/sync-doc/sync-client";
import { createServer as createReadServer } from "@cocalc/conat/files/read";
import { tempDir } from "@cocalc/backend/conat/test/setup";
import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  delay,
  wait,
} from "./setup";

// What the browser app registers at startup (frontend/conat/client.ts):
// toasts.  Recorded here, with the resets documents make.
let alerts: any[] = [];
let resets: any[] = [];

beforeAll(async () => {
  await before();
  setSyncClientHooks({ alert_message: (opts) => alerts.push(opts) });
});
afterAll(async () => {
  setSyncClientHooks({ alert_message: undefined });
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  await after();
});

beforeEach(() => {
  alerts = [];
  resets = [];
});

jest.setTimeout(60000);

// The project's file read service (in production, the project host's), so
// the saved file can be read with a bound.
async function serveFileReads(project_id: string) {
  const fs = connect().fs({ project_id, service: server.service });
  await createReadServer({
    project_id,
    client: connect(),
    createReadStream: (async (path: string, opts: any = {}) => {
      const data = Buffer.from(await fs.readFile(path));
      return Readable.from([
        data.subarray(
          opts.start ?? 0,
          opts.end == null ? undefined : opts.end + 1,
        ),
      ]);
    }) as any,
  });
}

async function findFiles(dir: string, match: (name: string) => boolean) {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findFiles(path, match)));
    } else if (match(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

// the history kept aside by resets, in all persist databases
async function archivedHistories(): Promise<
  { file: string; table: string; count: number }[]
> {
  const found: { file: string; table: string; count: number }[] = [];
  for (const file of await findFiles(tempDir, (name) => name.endsWith(".db"))) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      for (const { name } of tables) {
        if (name.startsWith("messages_archived_")) {
          const { n } = db
            .prepare(`SELECT COUNT(*) AS n FROM "${name}"`)
            .get() as { n: number };
          found.push({ file, table: name, count: n });
        }
      }
    } finally {
      db.close();
    }
  }
  return found;
}

function open(
  client,
  project_id: string,
  path: string,
  opts: { noSaveToDisk?: boolean } = {},
) {
  const doc = client.sync.string({
    project_id,
    path,
    service: server.service,
    firstReadLockTimeout: 1,
    ...opts,
  });
  // record the resets this document makes, through its real SyncClient
  const syncClient = (doc as any).client;
  for (const name of ["resetOversizedHistory", "resetHistory"]) {
    const reset = syncClient[name];
    syncClient[name] = async (opts) => {
      const result = await reset(opts);
      resets.push({ name, opts, result });
      return result;
    };
  }
  return doc;
}

// Like a notebook whose runaway output was saved, then cleared: the file is
// small, but its history holds a huge entry.  The editor stays open.
async function documentWithLargeHistoryEntry(
  project_id: string,
  path: string,
  opts: { noSaveToDisk?: boolean } = {},
) {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  const client = connect();
  const fs = client.fs({ project_id, service: server.service });
  await fs.writeFile(path, "hello");
  const editor = open(client, project_id, path, opts);
  await once(editor, "ready");
  editor.from_str(`hello ${"x".repeat(50_000)}`);
  editor.commit();
  await editor.save();
  editor.from_str("hello again");
  editor.commit();
  await editor.save();
  if (opts.noSaveToDisk) {
    await fs.writeFile(path, "hello again");
  } else {
    await editor.save_to_disk();
  }
  await delay(100);
  expect(await fs.readFile(path, "utf8")).toBe("hello again");
  // Every history entry over 20 KB is now too large to load.
  process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
  return editor;
}

describe("the saved file's proof covers every edit: the history restarts from it automatically", () => {
  const project_id = uuid();
  const path = "big.txt";
  let editor, opened;

  it("creates the document", async () => {
    await serveFileReads(project_id);
    editor = await documentWithLargeHistoryEntry(project_id, path);
  });

  it("restarts the history from the file, opens it and tells the user; the open copy closes", async () => {
    const before = await archivedHistories();
    const historyResets: any[] = [];
    editor.on("history-reset", (x) => historyResets.push(x));

    opened = open(connect(), project_id, path);
    await once(opened, "ready", 30000);
    expect(opened.to_str()).toBe("hello again");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "info",
      title: "Edit history archived and restarted",
      block: true,
    });
    expect(alerts[0].message).toContain("includes every edit");
    // one seeded, conditional reset, covering everything: no rollback
    const seeded = resets.filter(({ name }) => name == "resetHistory");
    expect(seeded).toHaveLength(1);
    expect(seeded[0].opts.options).toMatchObject({
      allowRollback: false,
      reason: "oversized",
    });
    expect(seeded[0].result).toMatchObject({
      reset: true,
      coveredSeq: seeded[0].opts.options.ifRevision.seq,
    });
    // the editor that had the old history open closed itself
    await wait({
      until: () => editor.get_state() === "closed",
      timeout: 10000,
    });
    expect(historyResets.length).toBe(1);
    // the old history was kept, in the same database, not copied
    const after = await archivedHistories();
    expect(after.length).toBe(before.length + 1);
  });

  it("keeps working: new edits reach a fresh copy", async () => {
    opened.from_str("after reset");
    opened.commit();
    await opened.save();
    const reopened = open(connect(), project_id, path);
    await once(reopened, "ready", 30000);
    await wait({
      until: () => reopened.to_str() === "after reset",
      timeout: 10000,
    });
    reopened.close();
    opened.close();
  });
});

describe("an acknowledged edit newer than the saved file: nothing is reset automatically", () => {
  const project_id = uuid();
  const path = "newer.txt";
  let opened;

  it("does not reset, and tells the editor the history cannot be loaded", async () => {
    await serveFileReads(project_id);
    const editor = await documentWithLargeHistoryEntry(project_id, path);
    // astra's case: an accepted edit after the save, and every tab closed
    editor.from_str("hello world");
    editor.commit();
    await editor.save();
    await editor.close();

    const before = await archivedHistories();
    opened = open(connect(), project_id, path);
    const unloadable = once(opened, "history-unloadable", 30000);
    await unloadable;
    expect(opened.get_state()).toBe("init");
    expect(resets).toEqual([]);
    expect(alerts).toEqual([]);
    expect(await archivedHistories()).toEqual(before);
  });

  it("the user's explicit restart rolls back to the file and keeps the newer edit in the archive", async () => {
    const before = await archivedHistories();
    const result = await opened.restartHistoryFromSavedFile();
    expect(result).toMatchObject({ reset: true });
    // the proof is valid, so the file covers what it proves, and no more
    const options = resets[0].opts.options;
    expect(options).toMatchObject({
      allowRollback: true,
      reason: "user-restart-from-file",
    });
    expect(options.coveredSeq).toBeGreaterThan(0);
    expect(options.coveredSeq).toBeLessThan(options.ifRevision.seq);
    const after = await archivedHistories();
    expect(after.length).toBe(before.length + 1);
    // the newer edit ("hello world", the newest seq) is in the archive
    const added = after.filter(
      (x) => !before.some((y) => y.file == x.file && y.table == x.table),
    );
    expect(added).toHaveLength(1);
    const { file, table } = added[0];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(
        db
          .prepare(`SELECT seq FROM "${table}" WHERE seq=?`)
          .get(options.ifRevision.seq),
      ).toEqual({ seq: options.ifRevision.seq });
    } finally {
      db.close();
    }
    // and the document opens with the saved file's value
    await once(opened, "ready", 30000);
    expect(opened.to_str()).toBe("hello again");
    opened.close();
  });
});

describe("a host copy (noSaveToDisk, e.g., the sync-fs service) of a text file with an acknowledged edit newer than the save", () => {
  it("never resets silently", async () => {
    const project_id = uuid();
    const path = "host.txt";
    await serveFileReads(project_id);
    const editor = await documentWithLargeHistoryEntry(project_id, path);
    editor.from_str("hello world");
    editor.commit();
    await editor.save();
    await editor.close();
    const host = open(connect(), project_id, path, { noSaveToDisk: true });
    await once(host, "history-unloadable", 30000);
    await delay(500);
    expect(host.get_state()).toBe("init");
    expect(resets).toEqual([]);
    host.close();
  });
});

describe("no saved file: nothing to restart from", () => {
  it("cannot restart the history", async () => {
    const project_id = uuid();
    const path = "gone.txt";
    await serveFileReads(project_id);
    const editor = await documentWithLargeHistoryEntry(project_id, path);
    await editor.close();
    const fs = connect().fs({ project_id, service: server.service });
    await fs.unlink(path);
    const opened = open(connect(), project_id, path);
    await once(opened, "history-unloadable", 30000);
    await expect(opened.restartHistoryFromSavedFile()).rejects.toThrow(
      "does not exist",
    );
    expect(resets).toEqual([]);
    opened.close();
  });
});

describe("a client that never writes the file (noSaveToDisk, e.g., an agent) opening a text file", () => {
  it("still restarts the history only from a proof covering every edit", async () => {
    const project_id = uuid();
    const path = "agent.txt";
    await serveFileReads(project_id);
    const editor = await documentWithLargeHistoryEntry(project_id, path);
    await editor.close();
    const opened = open(connect(), project_id, path, { noSaveToDisk: true });
    await once(opened, "ready", 30000);
    expect(opened.to_str()).toBe("hello again");
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({
      name: "resetHistory",
      opts: { options: { allowRollback: false, reason: "oversized" } },
    });
    opened.close();
  });
});

describe("two browsers opening the document at once", () => {
  const project_id = uuid();
  const path = "big2.txt";

  it("only one resets the history; both open and keep editing together", async () => {
    await serveFileReads(project_id);
    const editor = await documentWithLargeHistoryEntry(project_id, path);
    const before = await archivedHistories();

    const a = open(connect(), project_id, path);
    const b = open(connect(), project_id, path);
    await Promise.all([once(a, "ready", 30000), once(b, "ready", 30000)]);
    expect(a.to_str()).toBe("hello again");
    expect(b.to_str()).toBe("hello again");

    // exactly one reset ran, so exactly one toast and one history kept aside
    expect(
      resets.filter(({ result }) => result.reset && !result.repeated),
    ).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect((await archivedHistories()).length).toBe(before.length + 1);
    await wait({
      until: () => editor.get_state() === "closed",
      timeout: 10000,
    });

    // neither copy was closed by the other's reset, and they stay in sync
    expect(a.get_state()).toBe("ready");
    expect(b.get_state()).toBe("ready");
    a.from_str("edited in a");
    a.commit();
    await a.save();
    await wait({
      until: () => b.to_str() === "edited in a",
      timeout: 10000,
    });
    a.close();
    b.close();
  });
});

describe("a document whose file is written elsewhere (a notebook's syncdb) keeps the unseeded reset", () => {
  const project_id = uuid();
  // as a notebook's syncdb: its .ipynb is written by the Jupyter code
  const path = ".other.ipynb.sage-jupyter2";
  let opened, firstReset;

  it("resets the history and opens, empty for its own import to refill (e.g., Jupyter's)", async () => {
    const editor = await documentWithLargeHistoryEntry(project_id, path, {
      noSaveToDisk: true,
    });
    const before = await archivedHistories();
    opened = open(connect(), project_id, path, { noSaveToDisk: true });
    await once(opened, "ready", 30000);
    // a noSaveToDisk document does not load its file itself
    expect(opened.to_str()).toBe("");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ title: "Edit history reset" });
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({
      name: "resetOversizedHistory",
      result: { reset: true },
    });
    firstReset = resets[0].opts;
    await wait({
      until: () => editor.get_state() === "closed",
      timeout: 10000,
    });
    expect((await archivedHistories()).length).toBe(before.length + 1);
  });

  it("a late reset for the same oversized entry changes nothing", async () => {
    opened.from_str("after reset");
    opened.commit();
    await opened.save();
    const archives = await archivedHistories();
    const result = await new SyncClient(connect()).resetOversizedHistory(
      firstReset,
    );
    expect(result.reset).toBe(false);
    expect(opened.get_state()).toBe("ready");
    expect(await archivedHistories()).toEqual(archives);
  });

  it("purging the history (TimeTravel) also drops the history kept aside", async () => {
    const before = await archivedHistories();
    const result = await purgeHistory({ project_id, path, client: connect() });
    expect(result.reset).toBe(true);
    expect((await archivedHistories()).length).toBe(before.length - 1);
    opened.close();
  });
});
