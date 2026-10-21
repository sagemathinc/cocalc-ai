/*
An open copy of a document whose history files are replaced under a persist
fence (e.g., the project was restored, conat/persist/fence.ts) hands off to
the new history as after a history reset (history-transition.test.ts): it
reloads if nothing it has is missing there, and otherwise first saves its
value to a recovery copy beside the file.

pnpm test ./history-replaced.test.ts
*/

import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { syncFiles } from "@cocalc/conat/persist/context";
import {
  initPersistFenceService,
  PERSIST_FENCE_SUBJECT,
  withPersistFence,
} from "@cocalc/conat/persist/fence";
import { before, after, uuid, connect, server, once, wait } from "./setup";

let fenceService: { close: () => void } | undefined;

beforeAll(async () => {
  await before();
  fenceService = initPersistFenceService({ client: connect() });
  const client = connect();
  await wait({
    until: async () => {
      try {
        await client.request(PERSIST_FENCE_SUBJECT, null, { timeout: 500 });
      } catch (err) {
        // answered (with an error): the service is listening
        return `${err}`.includes("invalid project_id");
      }
      return false;
    },
  });
});

afterAll(async () => {
  fenceService?.close();
  await after();
});

jest.setTimeout(60000);

function open(project_id: string, path: string) {
  return connect().sync.string({
    project_id,
    path,
    service: server.service,
    firstReadLockTimeout: 1,
  });
}

// A document with a saved file and an acknowledged history.
async function savedDocument(project_id: string, path: string) {
  const fs = connect().fs({ project_id, service: server.service });
  await fs.writeFile(path, "hello");
  const doc = open(project_id, path);
  await once(doc, "ready");
  doc.from_str("hello world");
  doc.commit();
  await doc.save();
  await doc.save_to_disk();
  return { doc, fs };
}

function record(doc) {
  const events: { name: string; x: any }[] = [];
  for (const name of ["history-reset", "history-reset-unsaved"]) {
    doc.on(name, (x) => events.push({ name, x }));
  }
  return events;
}

async function copiesOf(fs, path: string): Promise<string[]> {
  const names: string[] = await fs.readdir(".");
  return names.filter((name) => name.startsWith(`${path}.unsaved-`)).sort();
}

function databases(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...databases(path));
    } else if (entry.name.endsWith(".db")) {
      found.push(path);
    }
  }
  return found;
}

const historyDir = (project_id: string) =>
  join(syncFiles.local, "projects", project_id);

// A copy of all of the project's history, taken while nothing has it open.
async function saveHistory(project_id: string): Promise<string[]> {
  const saved: string[] = [];
  const fence = { client: connect(), project_id, replaces: false };
  await withPersistFence(fence, async () => {
    for (const path of databases(historyDir(project_id))) {
      copyFileSync(path, `${path}.saved`);
      saved.push(path);
    }
  });
  return saved;
}

// Puts back the saved history, as restoring the project would.
async function restoreHistory(project_id: string, saved: string[]) {
  await withPersistFence({ client: connect(), project_id }, async () => {
    for (const path of databases(historyDir(project_id))) {
      if (!saved.includes(path)) rmSync(path);
    }
    for (const path of saved) {
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      copyFileSync(`${path}.saved`, path);
    }
  });
}

describe("a tab with nothing unsaved reloads the restored history", () => {
  const project_id = uuid();
  const path = "clean.txt";

  it("reloads without a copy, and opens with the restored history", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const saved = await saveHistory(project_id);
    doc.from_str("hello world, later");
    doc.commit();
    await doc.save();
    const events = record(doc);
    await restoreHistory(project_id, saved);
    await wait({ until: () => events.length > 0 });
    expect(events).toEqual([
      {
        name: "history-reset",
        x: expect.objectContaining({ copies: [], cause: "replaced" }),
      },
    ]);
    expect(doc.isClosed()).toBe(true);
    expect(await copiesOf(fs, path)).toEqual([]);

    const reopened = open(project_id, path);
    await once(reopened, "ready");
    expect(reopened.to_str()).toBe("hello world");
    reopened.close();
  });
});

describe("a tab with a draft saves it to a recovery copy, then reloads", () => {
  const project_id = uuid();
  const path = "draft.txt";

  it("copies the draft", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const saved = await saveHistory(project_id);
    const events = record(doc);
    doc.from_str("hello draft");
    await restoreHistory(project_id, saved);
    await wait({ until: () => events.length > 0 });
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(1);
    expect(events).toEqual([
      {
        name: "history-reset",
        x: expect.objectContaining({ copies, cause: "replaced" }),
      },
    ]);
    expect(await fs.readFile(copies[0], "utf8")).toBe("hello draft");
    expect(doc.isClosed()).toBe(true);
  });
});

describe("a fence that only reads the history does not disturb an open tab", () => {
  const project_id = uuid();
  const path = "read.txt";

  it("keeps the tab open and editing", async () => {
    const { doc } = await savedDocument(project_id, path);
    const events = record(doc);
    await saveHistory(project_id);
    doc.from_str("hello world, still here");
    doc.commit();
    await wait({
      until: async () => {
        try {
          await doc.save();
          return true;
        } catch {
          return false;
        }
      },
    });
    expect(events).toEqual([]);
    expect(doc.isClosed()).toBe(false);
    const other = open(project_id, path);
    await once(other, "ready");
    expect(other.to_str()).toBe("hello world, still here");
    other.close();
    doc.close();
  });
});
