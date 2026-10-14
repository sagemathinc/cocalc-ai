/*
A document whose edit history holds an entry too large to load (in
production, a runaway notebook output saved as a single 500 MB patch) must
still open: the client opening it resets the history through the document's
own patch stream, the browser tells the user with a toast that stays until
dismissed, and other open copies of the document close instead of writing
stale state.  The old history is kept aside in the patch stream's database.
When several clients hit the oversized entry at once, only one resets the
history, and a late reset never deletes edits made after the first.

pnpm test ./oversized-history.test.ts
*/

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { purgeHistory } from "@cocalc/conat/hub/api/sync-impl";
import {
  SyncClient,
  setSyncClientHooks,
} from "@cocalc/conat/sync-doc/sync-client";
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

function open(client, project_id: string, path: string) {
  const doc = client.sync.string({
    project_id,
    path,
    service: server.service,
    firstReadLockTimeout: 1,
  });
  // record the resets this document makes, through its real SyncClient
  const syncClient = (doc as any).client;
  const reset = syncClient.resetOversizedHistory;
  syncClient.resetOversizedHistory = async (opts) => {
    const result = await reset(opts);
    resets.push({ opts, result });
    return result;
  };
  return doc;
}

// Like a notebook whose runaway output was saved, then cleared: the file is
// small, but its history holds a huge entry.  The editor stays open.
async function documentWithLargeHistoryEntry(project_id: string, path: string) {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  const client = connect();
  const fs = client.fs({ project_id, service: server.service });
  await fs.writeFile(path, "hello");
  const editor = open(client, project_id, path);
  await once(editor, "ready");
  editor.from_str(`hello ${"x".repeat(50_000)}`);
  editor.commit();
  await editor.save();
  editor.from_str("hello again");
  editor.commit();
  await editor.save();
  await editor.save_to_disk();
  await delay(100);
  expect(await fs.readFile(path, "utf8")).toBe("hello again");
  // Every history entry over 20 KB is now too large to load.
  process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
  return editor;
}

describe("opening a document whose history holds an entry too large to load", () => {
  const project_id = uuid();
  const path = "big.txt";
  let editor, opened, firstReset;

  it("creates the document", async () => {
    editor = await documentWithLargeHistoryEntry(project_id, path);
  });

  it("resets the history, opens the file and tells the user; the open copy closes", async () => {
    const before = await archivedHistories();
    const historyResets: any[] = [];
    editor.on("history-reset", (x) => historyResets.push(x));

    const client2 = connect();
    opened = open(client2, project_id, path);

    await once(opened, "ready", 30000);
    // the file opened normally, with its current content
    expect(opened.to_str()).toBe("hello again");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "info",
      title: "Edit history reset",
      block: true,
    });
    expect(alerts[0].message).toContain("too large to load");
    expect(alerts[0].message).toContain("kept a copy");
    expect(resets).toHaveLength(1);
    expect(resets[0].opts.oversized_seq).toEqual(expect.any(Number));
    expect(resets[0].result.reset).toBe(true);
    firstReset = resets[0].opts;
    // the editor that had the old history open closed itself
    await wait({
      until: () => editor.get_state() === "closed",
      timeout: 10000,
    });
    expect(historyResets.length).toBe(1);

    // the old history was kept, in the same database, not copied
    const after = await archivedHistories();
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1].count).toBeGreaterThan(0);
  });

  it("keeps working: new edits are saved with the new history epoch and reach a fresh copy", async () => {
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
  });

  it("a late reset for the same oversized entry changes nothing", async () => {
    // e.g., a second client that hit the oversized entry before the first
    // reset, and asks to reset only after edits were made in the new history
    const archives = await archivedHistories();
    const result = await new SyncClient(connect()).resetOversizedHistory(
      firstReset,
    );
    expect(result.reset).toBe(false);
    expect(opened.get_state()).toBe("ready");
    expect(await archivedHistories()).toEqual(archives);
    // the edit made after the first reset is still there
    const reopened = open(connect(), project_id, path);
    await once(reopened, "ready", 30000);
    await wait({
      until: () => reopened.to_str() === "after reset",
      timeout: 10000,
    });
    reopened.close();
  });

  it("purging the history (TimeTravel) also drops the history kept aside", async () => {
    const before = await archivedHistories();
    const result = await purgeHistory({ project_id, path, client: connect() });
    expect(result.reset).toBe(true);
    expect((await archivedHistories()).length).toBe(before.length - 1);
    opened.close();
  });
});

describe("two browsers opening the document at once", () => {
  const project_id = uuid();
  const path = "big2.txt";

  it("only one resets the history; both open and keep editing together", async () => {
    const editor = await documentWithLargeHistoryEntry(project_id, path);
    const before = await archivedHistories();

    const clientA = connect();
    const clientB = connect();
    const a = open(clientA, project_id, path);
    const b = open(clientB, project_id, path);
    await Promise.all([once(a, "ready", 30000), once(b, "ready", 30000)]);
    expect(a.to_str()).toBe("hello again");
    expect(b.to_str()).toBe("hello again");

    // exactly one reset, so exactly one toast and one history kept aside
    expect(resets.filter(({ result }) => result.reset)).toHaveLength(1);
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
