/*
A document whose edit history holds an entry too large to load (in
production, a runaway notebook output saved as a single 500 MB patch) must
still open: the browser resets the history like TimeTravel's "purge history",
tells the user with a toast that stays until dismissed, and other open copies
of the document close instead of writing stale state.  The persist server
keeps a copy of the old history.

pnpm test ./oversized-history.test.ts
*/

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { purgeHistory } from "@cocalc/conat/hub/api/sync-impl";
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

beforeAll(before);
afterAll(async () => {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  await after();
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

describe("opening a document whose history holds an entry too large to load", () => {
  const project_id = uuid();
  const path = "big.txt";
  const big = "x".repeat(50_000);
  let client, fs, editor;

  it("saves a large edit into the history, then shrinks the file again", async () => {
    // Like a notebook whose runaway output was saved, then cleared: the file
    // is small, but its history holds a huge entry.
    client = connect();
    fs = client.fs({ project_id, service: server.service });
    await fs.writeFile(path, "hello");
    editor = client.sync.string({
      project_id,
      path,
      service: server.service,
      firstReadLockTimeout: 1,
    });
    await once(editor, "ready");
    editor.from_str(`hello ${big}`);
    editor.commit();
    await editor.save();
    editor.from_str("hello again");
    editor.commit();
    await editor.save();
    await editor.save_to_disk();
    await delay(100);
    expect(await fs.readFile(path, "utf8")).toBe("hello again");
  });

  it("resets the history, opens the file and tells the user; the open copy closes", async () => {
    // Every history entry over 20 KB is now too large to load.
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
    const resets: any[] = [];
    editor.on("history-reset", (x) => resets.push(x));

    const client2 = connect();
    const opened = client2.sync.string({
      project_id,
      path,
      service: server.service,
      firstReadLockTimeout: 1,
    });
    // what a browser client provides
    const alerts: any[] = [];
    const syncClient = (opened as any).client;
    syncClient.purgeHistory = (opts) =>
      purgeHistory({ ...opts, client: client2 });
    syncClient.alert_message = (opts) => alerts.push(opts);

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
    // the editor that had the old history open closed itself
    await wait({
      until: () => editor.get_state() === "closed",
      timeout: 10000,
    });
    expect(resets.length).toBe(1);

    // the old history was kept
    const archives = await findFiles(tempDir, (name) =>
      name.includes(".oversized-"),
    );
    expect(archives.length).toBe(1);

    // and the document keeps working: new edits are saved with the new
    // history epoch and reach a fresh copy
    opened.from_str("after reset");
    opened.commit();
    await opened.save();
    const client3 = connect();
    const reopened = client3.sync.string({
      project_id,
      path,
      service: server.service,
      firstReadLockTimeout: 1,
    });
    await once(reopened, "ready", 30000);
    await wait({
      until: () => reopened.to_str() === "after reset",
      timeout: 10000,
    });
    reopened.close();
    opened.close();
  });
});
