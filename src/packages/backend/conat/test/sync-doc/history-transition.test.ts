/*
An open copy of a document whose history is reset in another session keeps
its edits (bounded history plan H1b-2, r3): if everything it has is provably
in the new history it reloads; otherwise it first saves its current value to
a new recovery copy beside the file.  A copy releases only the generation it
holds: typing while it is written means another copy, and after 3 rounds the
tab says NOT SAVED and keeps its value.

pnpm test ./history-transition.test.ts
*/

import { Readable } from "node:stream";
import { purgeHistory } from "@cocalc/conat/hub/api/sync-impl";
import { createServer as createReadServer } from "@cocalc/conat/files/read";
import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  wait,
  delay,
} from "./setup";

beforeAll(before);
afterAll(async () => {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  await after();
});

// publishes held by tests, released after each test so nothing waits forever
const held: (() => void)[] = [];
afterEach(() => {
  for (const release of held.splice(0)) release();
});

// Holds a tab's publishes until released (or the test ends).
function holdPublishes(doc) {
  const stream = (doc as any).patches_table.dstream.stream;
  const publishMany = stream.publishMany.bind(stream);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  held.push(release);
  stream.publishMany = async (v) => {
    await gate;
    return await publishMany(v);
  };
  return release;
}

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

// What the document reports: resets (reloads) and NOT SAVED.
function record(doc) {
  const events: { name: string; x: any }[] = [];
  for (const name of ["history-reset", "history-reset-unsaved"]) {
    doc.on(name, (x) => events.push({ name, x }));
  }
  return events;
}

// Runs hook(path, data) before each recovery copy is written.
function onCopy(doc, hook: (path: string, data: string) => Promise<void>) {
  const fs = (doc as any).fs;
  const writeFile = fs.writeFile.bind(fs);
  fs.writeFile = async (path: string, data: any, ...rest) => {
    if (path.includes(".unsaved-")) {
      await hook(path, data);
    }
    return await writeFile(path, data, ...rest);
  };
}

async function copiesOf(fs, path: string): Promise<string[]> {
  const names: string[] = await fs.readdir(".");
  return names.filter((name) => name.startsWith(`${path}.unsaved-`)).sort();
}

const purge = (project_id: string, path: string) =>
  purgeHistory({ project_id, path, client: connect() });

describe("a tab with nothing unsaved reloads without a copy", () => {
  const project_id = uuid();
  const path = "clean.txt";

  it("reloads", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    expect((await purge(project_id, path)).reset).toBe(true);
    await wait({ until: () => events.length > 0 });
    expect(events).toEqual([
      { name: "history-reset", x: expect.objectContaining({ copies: [] }) },
    ]);
    expect(doc.isClosed()).toBe(true);
    expect(await copiesOf(fs, path)).toEqual([]);
  });
});

describe("a tab with a draft saves it to a recovery copy, then reloads", () => {
  const project_id = uuid();
  const path = "draft.txt";

  it("copies the draft", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    doc.from_str("hello draft");
    expect((await purge(project_id, path)).reset).toBe(true);
    await wait({ until: () => events.length > 0 });
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(1);
    expect(events).toEqual([
      { name: "history-reset", x: expect.objectContaining({ copies }) },
    ]);
    expect(await fs.readFile(copies[0], "utf8")).toBe("hello draft");
    expect(doc.isClosed()).toBe(true);
    // the file itself is untouched
    expect(await fs.readFile(path, "utf8")).toBe("hello world");
  });
});

describe("committed patches that are not in the new history are copied", () => {
  const project_id = uuid();
  const path = "pending.txt";

  it("copies a patch published in the old epoch, after the reset", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    // hold this tab's next publish until the history was reset
    const stream = (doc as any).patches_table.dstream.stream;
    const publishMany = stream.publishMany.bind(stream);
    let release;
    const reset = new Promise((resolve) => (release = resolve));
    const results: any[] = [];
    stream.publishMany = async (v) => {
      await reset;
      const w = await publishMany(v);
      results.push(...w);
      return w;
    };
    doc.from_str("hello committed");
    expect(doc.commit()).toBe(true);
    void doc.save();
    expect((await purge(project_id, path)).reset).toBe(true);
    release();
    await wait({ until: () => events.length > 0 });
    // the server refused it: it was written in the old epoch
    expect(
      results.every((x) => `${x.error}`.includes("required header mismatch")),
    ).toBe(true);
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(copies[0], "utf8")).toBe("hello committed");
    expect(events).toEqual([
      { name: "history-reset", x: expect.objectContaining({ copies }) },
    ]);
  });
});

// A tab whose next publish is held (never answered) and whose inclusion
// query is answered by answer(ids).
async function pendingTab(
  project_id: string,
  path: string,
  answer: (ids: string[]) => any,
) {
  const { doc, fs } = await savedDocument(project_id, path);
  const events = record(doc);
  holdPublishes(doc);
  const queries: any[] = [];
  (doc as any).client.historyInclusion = async (opts) => {
    queries.push(opts);
    return { ids: answer(opts.ids) };
  };
  doc.from_str("hello pending");
  expect(doc.commit()).toBe(true);
  void doc.save();
  return { doc, fs, events, queries };
}

describe("pending patches proven included in the new history: reload, no copy", () => {
  const project_id = uuid();
  const path = "included.txt";

  it("asks once, about every pending patch, in the epoch they were written in", async () => {
    const { fs, events, queries } = await pendingTab(project_id, path, (ids) =>
      Object.fromEntries(ids.map((id) => [id, { status: "included" }])),
    );
    const { history_epoch } = await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    expect(queries).toHaveLength(1);
    expect(queries[0].ids).toHaveLength(1);
    expect(queries[0].epoch).toBeLessThan(history_epoch);
    expect(events).toEqual([
      { name: "history-reset", x: expect.objectContaining({ copies: [] }) },
    ]);
    expect(await copiesOf(fs, path)).toEqual([]);
  });
});

describe("anything not proven included is copied", () => {
  it("an excluded patch", async () => {
    const project_id = uuid();
    const path = "excluded.txt";
    const { fs, events } = await pendingTab(project_id, path, (ids) =>
      Object.fromEntries(ids.map((id) => [id, { status: "excluded" }])),
    );
    await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(copies[0], "utf8")).toBe("hello pending");
  });

  it("an inclusion query that keeps failing", async () => {
    const project_id = uuid();
    const path = "query-fails.txt";
    const { fs, events, queries } = await pendingTab(project_id, path, () => {
      throw Error("timeout");
    });
    await purge(project_id, path);
    await wait({ until: () => events.length > 0, timeout: 30000 });
    expect(queries).toHaveLength(3);
    expect(await copiesOf(fs, path)).toHaveLength(1);
    expect(events[0].name).toBe("history-reset");
  });

  it("more pending than the admission bound: no query, a copy", async () => {
    const project_id = uuid();
    const path = "admission.txt";
    const { doc, fs, events, queries } = await pendingTab(
      project_id,
      path,
      (ids) =>
        Object.fromEntries(ids.map((id) => [id, { status: "included" }])),
    );
    (doc as any).patches_table.dstream.setPendingSizeOf(
      () => 64 * 1024 * 1024 + 1,
    );
    await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    expect(queries).toEqual([]);
    expect(await copiesOf(fs, path)).toHaveLength(1);
  });
});

describe("typing while a copy is written: the later value is copied too", () => {
  const project_id = uuid();
  const path = "typing.txt";

  it("copies twice and releases only the last value", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    let n = 0;
    onCopy(doc, async () => {
      n += 1;
      if (n == 1) doc.from_str("hello typed during the copy");
    });
    doc.from_str("hello draft");
    await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(2);
    const values = await Promise.all(
      copies.map((name) => fs.readFile(name, "utf8")),
    );
    expect(values.sort()).toEqual(
      ["hello draft", "hello typed during the copy"].sort(),
    );
    expect(events).toEqual([
      {
        name: "history-reset",
        x: expect.objectContaining({ copies: expect.arrayContaining(copies) }),
      },
    ]);
  });
});

describe("still changing after 3 copies: NOT SAVED, and the tab keeps its value", () => {
  const project_id = uuid();
  const path = "changing.txt";
  let doc, fs, events;

  it("reports NOT SAVED after 3 rounds", async () => {
    ({ doc, fs } = await savedDocument(project_id, path));
    events = record(doc);
    let n = 0;
    onCopy(doc, async () => {
      n += 1;
      doc.from_str(`hello ${n}`);
    });
    doc.from_str("hello draft");
    await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    expect(events).toEqual([
      {
        name: "history-reset-unsaved",
        x: expect.objectContaining({ reason: "still-changing" }),
      },
    ]);
    expect(events[0].x.copies).toHaveLength(3);
    expect(await copiesOf(fs, path)).toHaveLength(3);
    expect(doc.isClosed()).toBe(false);
    expect(doc.to_str()).toBe("hello 3");
  });

  it("writes nothing more in the old history, nor over the file, meanwhile", async () => {
    doc.from_str("hello 4");
    expect(doc.commit()).toBe(false);
    await doc.save();
    await doc.save_to_disk();
    expect(doc.to_str()).toBe("hello 4");
    expect(await fs.readFile(path, "utf8")).toBe("hello world");
  });

  it("a download is bound to its generation: an edit after it keeps the tab", async () => {
    const { value, generation } = doc.valueForDownload();
    expect(value).toBe("hello 4");
    doc.from_str("hello 5");
    expect(doc.reloadAfterDownload(generation)).toBe(false);
    expect(doc.isClosed()).toBe(false);
  });

  it("an unchanged download releases the tab", async () => {
    const { generation } = doc.valueForDownload();
    expect(doc.reloadAfterDownload(generation)).toBe(true);
    expect(events.at(-1).name).toBe("history-reset");
    expect(doc.isClosed()).toBe(true);
  });
});

describe("a failed copy after an earlier success: NOT SAVED, the first copy kept", () => {
  const project_id = uuid();
  const path = "fails.txt";

  it("reports copy-failed with the earlier copy", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    let n = 0;
    onCopy(doc, async () => {
      n += 1;
      if (n == 1) {
        doc.from_str("hello after the first copy");
        return;
      }
      throw Error("disk full");
    });
    doc.from_str("hello draft");
    await purge(project_id, path);
    await wait({ until: () => events.length > 0, timeout: 30000 });
    expect(events).toEqual([
      {
        name: "history-reset-unsaved",
        x: expect.objectContaining({ reason: "copy-failed" }),
      },
    ]);
    const copies = await copiesOf(fs, path);
    expect(events[0].x.copies).toEqual(copies);
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(copies[0], "utf8")).toBe("hello draft");
    expect(doc.to_str()).toBe("hello after the first copy");
    expect(doc.isClosed()).toBe(false);
    doc.close();
  });
});

describe("a newer reset in the middle of a copy restarts the transition", () => {
  const project_id = uuid();
  const path = "newer.txt";

  it("finishes with the newer epoch", async () => {
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    let second;
    let n = 0;
    onCopy(doc, async () => {
      n += 1;
      if (n == 1) {
        second = await purge(project_id, path);
        await wait({
          until: () =>
            (doc as any).historyTransition?.toEpoch === second.history_epoch,
        });
      }
    });
    doc.from_str("hello draft");
    const first = await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    expect(second.history_epoch).toBeGreaterThan(first.history_epoch);
    expect(events).toEqual([
      {
        name: "history-reset",
        x: expect.objectContaining({ history_epoch: second.history_epoch }),
      },
    ]);
    // the first copy is kept; the restarted transition copied again
    const copies = await copiesOf(fs, path);
    expect(events[0].x.copies).toEqual(expect.arrayContaining(copies));
    for (const name of copies) {
      expect(await fs.readFile(name, "utf8")).toBe("hello draft");
    }
  });
});

describe("two tabs with drafts: each writes its own copy", () => {
  const project_id = uuid();
  const path = "two.txt";

  it("never overwrites the other's copy", async () => {
    const { doc: a, fs } = await savedDocument(project_id, path);
    const b = open(project_id, path);
    await once(b, "ready");
    await wait({ until: () => b.to_str() == "hello world" });
    const eventsA = record(a);
    const eventsB = record(b);
    a.from_str("hello from a");
    b.from_str("hello from b");
    await purge(project_id, path);
    await wait({ until: () => eventsA.length > 0 && eventsB.length > 0 });
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(2);
    const values = await Promise.all(
      copies.map((name) => fs.readFile(name, "utf8")),
    );
    expect(values.sort()).toEqual(["hello from a", "hello from b"]);
    expect(eventsA[0].name).toBe("history-reset");
    expect(eventsB[0].name).toBe("history-reset");
  });
});

describe("a value over 32 MiB is NOT SAVED; nothing is serialized", () => {
  const project_id = uuid();
  const path = "huge.txt";

  it("reports too-large before any query or comparison, and writes no copy", async () => {
    const { doc, fs, events, queries } = await pendingTab(
      project_id,
      path,
      (ids) =>
        Object.fromEntries(ids.map((id) => [id, { status: "included" }])),
    );
    onCopy(doc, async () => {
      throw Error("no copy may be written");
    });
    doc.from_str("x".repeat(32 * 1024 * 1024 + 1));
    // nothing may walk the whole document before it is measured
    const value = (doc as any).doc;
    let compared = 0;
    const isEqual = value.is_equal.bind(value);
    value.is_equal = (other) => {
      compared += 1;
      return isEqual(other);
    };
    await purge(project_id, path);
    await wait({ until: () => events.length > 0 });
    expect(events).toEqual([
      {
        name: "history-reset-unsaved",
        x: expect.objectContaining({ reason: "too-large", copies: [] }),
      },
    ]);
    expect(queries).toEqual([]);
    expect(compared).toBe(0);
    expect(await copiesOf(fs, path)).toEqual([]);
    expect(doc.isClosed()).toBe(false);
    doc.close();
  });
});

describe("saving to disk never writes over the file once a reset began (CORR-H1B2-1)", () => {
  const writes = (doc) => {
    const fs = (doc as any).fs;
    const calls: string[] = [];
    for (const name of ["writeFileDelta", "writeFile"]) {
      const f = fs[name].bind(fs);
      fs[name] = async (path: string, ...rest) => {
        calls.push(`${name} ${path}`);
        return await f(path, ...rest);
      };
    }
    return calls;
  };

  it("a save waiting for its acknowledgment when the reset arrives", async () => {
    const project_id = uuid();
    const path = "save-race.txt";
    const { doc, fs } = await savedDocument(project_id, path);
    const events = record(doc);
    // a committed edit whose acknowledgment is held: doc == last, and
    // save_to_disk waits for it in save()
    const acknowledge = holdPublishes(doc);
    doc.from_str("hello committed");
    expect(doc.commit()).toBe(true);
    // the transition is still running (asking about that patch) when the
    // acknowledgment, here the fence's refusal, arrives
    let releaseQuery!: () => void;
    const queryHeld = new Promise<void>((resolve) => (releaseQuery = resolve));
    let asked = false;
    (doc as any).client.historyInclusion = async ({ ids }) => {
      asked = true;
      await queryHeld;
      return {
        ids: Object.fromEntries(ids.map((id) => [id, { status: "absent" }])),
      };
    };
    const calls = writes(doc);
    let saved = false;
    const saving = doc
      .save_to_disk()
      .catch(() => {})
      .then(() => (saved = true));
    await delay(100);
    expect(saved).toBe(false);
    await purge(project_id, path);
    await wait({ until: () => asked });
    acknowledge();
    await saving;
    expect(calls.filter((x) => x.endsWith(` ${path}`))).toEqual([]);
    releaseQuery();
    await wait({ until: () => events.length > 0 });
    expect(calls.filter((x) => x.endsWith(` ${path}`))).toEqual([]);
    expect(await fs.readFile(path, "utf8")).toBe("hello world");
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(copies[0], "utf8")).toBe("hello committed");
  });

  it("writeFile itself, entered while transitioning or during its stat", async () => {
    const project_id = uuid();
    const path = "stat-race.txt";
    const { doc, fs } = await savedDocument(project_id, path);
    const calls = writes(doc);
    // read only until a held stat says otherwise
    let readOnly = true;
    (doc as any).is_read_only = () => readOnly;
    let releaseStat!: () => void;
    const statHeld = new Promise<void>((resolve) => (releaseStat = resolve));
    (doc as any).stat = async () => {
      await statHeld;
      readOnly = false;
    };
    const writing = doc.writeFile();
    // the reset arrives during the stat
    (doc as any).historyTransition = {
      fromEpoch: 0,
      toEpoch: 1,
      startGeneration: 0,
      copies: [],
      restart: false,
    };
    releaseStat();
    await writing;
    // and entering it while transitioning
    await doc.writeFile();
    expect(calls).toEqual([]);
    expect(await fs.readFile(path, "utf8")).toBe("hello world");
    (doc as any).historyTransition = undefined;
    doc.close();
  });
});

// The project's file read service, so the saved file can be read with a bound.
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

describe("a SEEDED reset: the new epoch never reaches this tab's value (CORR-H1B2-2)", () => {
  const project_id = uuid();
  const path = "seeded.txt";

  it("keeps a pending edit, the draft and later typing through the seed and new-epoch patches", async () => {
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    await serveFileReads(project_id);
    const fs = connect().fs({ project_id, service: server.service });
    await fs.writeFile(path, "hello");
    const tab = open(project_id, path);
    await once(tab, "ready");
    // a huge history entry, then the saved file "hello again", whose proof
    // covers every accepted edit: the next open restarts the history from
    // the file automatically, with the file as the new epoch's seed
    tab.from_str(`hello ${"x".repeat(50_000)}`);
    tab.commit();
    await tab.save();
    tab.from_str("hello again");
    tab.commit();
    await tab.save();
    await tab.save_to_disk();
    expect(await fs.readFile(path, "utf8")).toBe("hello again");
    const events = record(tab);

    // this tab's pending edit: committed, not yet acknowledged
    holdPublishes(tab);
    tab.from_str("hello pending");
    expect(tab.commit()).toBe(true);
    void tab.save();
    // its inclusion query is held until the seed and a new-epoch patch
    // have reached the old graph
    let releaseQuery!: () => void;
    const queryHeld = new Promise<void>((resolve) => (releaseQuery = resolve));
    let asked = 0;
    (tab as any).client.historyInclusion = async ({ ids }) => {
      asked += 1;
      await queryHeld;
      return {
        ids: Object.fromEntries(ids.map((id) => [id, { status: "absent" }])),
      };
    };

    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
    const other = open(project_id, path);
    await once(other, "ready", 30000);
    expect(other.to_str()).toBe("hello again");
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    await wait({ until: () => asked > 0 });
    // a new-epoch patch
    other.from_str("hello from the new epoch");
    other.commit();
    await other.save();
    await delay(500);
    // the old graph may have them; this tab's value does not
    expect(tab.to_str()).toBe("hello pending");
    // a draft, and typing later
    tab.from_str("hello pending, then typed");
    releaseQuery();
    await wait({ until: () => events.length > 0 });
    expect(events[0].name).toBe("history-reset");
    const copies = await copiesOf(fs, path);
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(copies[0], "utf8")).toBe(
      "hello pending, then typed",
    );
    other.close();
  });
});
