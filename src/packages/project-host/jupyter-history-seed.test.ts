/*
The live-writer seed of a notebook's unloadable edit history (bounded history
plan H1b-3 r4, §2, option A): the project's backend, with the notebook open
and ready, seeds a new history from its live value covering exactly the
history's revision N; anything else refuses, and a refusal or no answer is
never a rollback.

Real persist servers.  The "backend" is a syncdb opened before the history
became unloadable; openers then hit the 413.
*/

import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  wait,
  delay,
} from "@cocalc/backend/conat/test/sync-doc/setup";
import {
  SyncClient,
  setSyncClientHooks,
} from "@cocalc/conat/sync-doc/sync-client";
import { ipynbPath, syncdbPath } from "@cocalc/util/jupyter/names";
import {
  RESTART_LIMITS,
  resetHistoryRestartState,
  runInProgress,
  seedOversizedHistory,
  unresolvedReset,
} from "@cocalc/jupyter/history-restart";

let alerts: any[] = [];
beforeAll(async () => {
  await before();
  setSyncClientHooks({ alert_message: (opts) => alerts.push(opts) });
});
afterAll(async () => {
  setSyncClientHooks({ alert_message: undefined });
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  await after();
});
jest.setTimeout(90000);

const LIMITS = { ...RESTART_LIMITS };
// publishes held by a test, released when it ends
const held: (() => void)[] = [];
afterEach(() => {
  for (const release of held.splice(0)) release();
  Object.assign(RESTART_LIMITS, LIMITS);
  resetHistoryRestartState();
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  alerts = [];
});

// short steps, so refusals do not take 10 s each
const fast = { stepMs: 300, reserveMs: 100 };

function openNotebook(project_id: string, path: string) {
  return connect().sync.db({
    project_id,
    path: syncdbPath(path),
    service: server.service,
    primary_keys: ["type", "id"],
    string_cols: ["input"],
    firstReadLockTimeout: 1,
  });
}

// The backend's notebook, live, with an entry too large for anyone else to
// load (a runaway output saved once, then cleared), and a live edit never
// saved to any .ipynb.
async function liveWriter(project_id: string, path: string) {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  const writer = openNotebook(project_id, path);
  await once(writer, "ready");
  writer.set({ type: "cell", id: "c1", pos: 0, input: "x".repeat(50_000) });
  writer.commit();
  await writer.save();
  writer.set({ type: "cell", id: "c1", input: "cleared" });
  writer.set({ type: "cell", id: "c2", pos: 1, input: "live, never saved" });
  writer.set({ type: "settings", kernel: "python3" });
  writer.commit();
  await writer.save();
  // every history entry over 20 KB is now too large to load
  process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
  return writer;
}

const stateOf = async (project_id: string, path: string) =>
  await new SyncClient(connect()).historyResetState({
    project_id,
    path: syncdbPath(path),
  });

function seed(
  project_id: string,
  path: string,
  writer: any,
  epoch: number,
  limits: any = fast,
) {
  return seedOversizedHistory({
    project_id,
    path,
    epoch,
    oversizedSeq: 1,
    syncdbOf: () => writer,
    syncClient: new SyncClient(connect()),
    limits,
  });
}

async function inputsOf(project_id: string, path: string) {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  const doc = openNotebook(project_id, path);
  await once(doc, "ready", 30000);
  const inputs = doc
    .get({ type: "cell" })
    .toJS()
    .map((c) => c.input)
    .sort();
  const versions = doc.versions().length;
  doc.close();
  return { inputs, versions };
}

// The writer's resetHistory, wrapped: before(n) runs before the n-th call
// is sent.
function wrapResets(writer: any, before: (n: number) => Promise<void> | void) {
  const client = writer.client;
  const resetHistory = client.resetHistory.bind(client);
  let n = 0;
  client.resetHistory = async (opts) => {
    n += 1;
    await before(n);
    return await resetHistory(opts);
  };
  return () => n;
}

describe("(A) an opener hits the 413 and the live writer seeds", () => {
  it("the opener opens with the live value, including edits never saved, and is told the kernel restarted", async () => {
    const project_id = uuid();
    const path = ipynbPath("happy.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);

    const opener = openNotebook(project_id, path);
    (opener as any).client.askLiveWriterToSeed = async (opts) =>
      await seedOversizedHistory({
        ...opts,
        project_id,
        syncdbOf: () => writer,
        syncClient: new SyncClient(connect()),
      });
    await once(opener, "ready", 60000);
    expect(
      opener
        .get({ type: "cell" })
        .toJS()
        .map((c) => c.input)
        .sort(),
    ).toEqual(["cleared", "live, never saved"]);
    const after = await stateOf(project_id, path);
    expect(after.epoch).toBe(before.epoch + 1);
    expect(alerts).toEqual([
      expect.objectContaining({ title: "Edit history archived and restarted" }),
    ]);
    expect(alerts[0].message).toMatch(/kernel was restarted/);
    // the writer hands off (H1b-2): nothing of its own was pending
    await wait({ until: () => writer.get_state() == "closed", timeout: 30000 });
    opener.close();
  });

  it("no live writer: the opener is told, with the restart from the .ipynb, and nothing is reset", async () => {
    const project_id = uuid();
    const path = ipynbPath("none.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    const opener = openNotebook(project_id, path);
    (opener as any).client.askLiveWriterToSeed = async (opts) =>
      await seedOversizedHistory({
        ...opts,
        project_id,
        syncdbOf: () => undefined,
        syncClient: new SyncClient(connect()),
      });
    const unloadable: any[] = [];
    opener.on("history-unloadable", (x) => unloadable.push(x));
    await wait({ until: () => unloadable.length > 0, timeout: 30000 });
    expect(unloadable[0]).toMatchObject({ restart: "ipynb" });
    expect((await stateOf(project_id, path)).epoch).toBe(before.epoch);
    opener.close();
    writer.close();
  });
});

describe("(A) refusals: nothing is reset", () => {
  const cases: [string, (writer: any) => any, string, any?][] = [
    [
      "not ready (a backend stuck on the 413)",
      () => ({ isReady: () => false }),
      "not-ready",
    ],
    [
      "not caught up (records held)",
      (writer) => {
        writer.dstream().receivedThroughSeq = () => 0;
        return writer;
      },
      "not-caught-up",
    ],
    [
      "busy (its own patch never acknowledged)",
      (writer) => {
        const stream = writer.patches_table.dstream.stream;
        const publishMany = stream.publishMany.bind(stream);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        held.push(release);
        stream.publishMany = async (v) => {
          await gate;
          return await publishMany(v);
        };
        writer.set({ type: "cell", id: "c9", pos: 9, input: "pending" });
        writer.commit();
        return writer;
      },
      "busy",
    ],
    ["too large", (writer) => writer, "too-large", { ...fast, valueBytes: 10 }],
  ];
  for (const [name, prepare, reason, limits] of cases) {
    it(name, async () => {
      const project_id = uuid();
      const path = ipynbPath("refusal.ipynb");
      const writer = await liveWriter(project_id, path);
      const before = await stateOf(project_id, path);
      const result = await seed(
        project_id,
        path,
        prepare(writer),
        before.epoch,
        limits,
      );
      expect(result).toEqual(
        expect.objectContaining({ seeded: false, reason }),
      );
      expect((await stateOf(project_id, path)).epoch).toBe(before.epoch);
      expect(unresolvedReset(syncdbPath(path))).toBeUndefined();
      writer.close();
    });
  }

  it("the wrong epoch, and invalid requests", async () => {
    const project_id = uuid();
    const path = ipynbPath("epoch.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    expect(await seed(project_id, path, writer, before.epoch + 5)).toEqual(
      expect.objectContaining({ seeded: false, reason: "epoch" }),
    );
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await seedOversizedHistory({
        project_id,
        path,
        epoch: bad,
        oversizedSeq: 1,
        syncdbOf: () => writer,
        syncClient: new SyncClient(connect()),
      });
      expect(result).toEqual(
        expect.objectContaining({ seeded: false, reason: "invalid" }),
      );
    }
    writer.close();
  });
});

describe("(A) the fence", () => {
  it("a record accepted between capture and reset: moved, then a new round seeds it too", async () => {
    const project_id = uuid();
    const path = ipynbPath("moved.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    const other = openNotebook(project_id, path);
    await once(other, "ready");
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "20000";
    const resets = wrapResets(writer, async (n) => {
      if (n == 1) {
        other.set({
          type: "cell",
          id: "late",
          pos: 5,
          input: "accepted after N",
        });
        other.commit();
        await other.save();
      }
    });
    const result = await seed(project_id, path, writer, before.epoch, {
      stepMs: 5000,
      reserveMs: 100,
    });
    expect(result).toEqual(expect.objectContaining({ seeded: true }));
    expect(resets()).toBe(2);
    other.close();
    expect((await inputsOf(project_id, path)).inputs).toEqual([
      "accepted after N",
      "cleared",
      "live, never saved",
    ]);
  });

  it("a draft typed after the capture is copied by the writer's own hand-off", async () => {
    const project_id = uuid();
    const path = ipynbPath("draft.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    wrapResets(writer, () => {
      // typed after the capture, before the reset
      writer.set({ type: "cell", id: "c2", input: "typed after the capture" });
    });
    const resetEvents: any[] = [];
    writer.on("history-reset", (x) => resetEvents.push(x));
    const result = await seed(project_id, path, writer, before.epoch);
    expect(result).toEqual(expect.objectContaining({ seeded: true }));
    await wait({ until: () => resetEvents.length > 0, timeout: 30000 });
    expect(resetEvents[0].copies).toHaveLength(1);
    const fs = connect().fs({ project_id, service: server.service });
    expect(await fs.readFile(resetEvents[0].copies[0], "utf8")).toContain(
      "typed after the capture",
    );
  });
});

describe("(A) the deadline and the gate (LIMIT-H1B3P-1, -2)", () => {
  it("historyResetState held past repeated deadlines: nothing sent; retries busy until it settles (LIMIT-H1B3B-1)", async () => {
    const project_id = uuid();
    const path = ipynbPath("held-state.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    Object.assign(RESTART_LIMITS, { deadlineMs: 400 });
    const historyResetState = writer.client.historyResetState;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    writer.client.historyResetState = async (opts) => {
      asked += 1;
      await held;
      return await historyResetState(opts);
    };
    const resets = wrapResets(writer, () => {});
    expect(await seed(project_id, path, writer, before.epoch)).toEqual(
      expect.objectContaining({ seeded: false, reason: "deadline" }),
    );
    // the abandoned request keeps the slot: retries start nothing
    for (let i = 0; i < 3; i++) {
      expect(await seed(project_id, path, writer, before.epoch)).toEqual(
        expect.objectContaining({ seeded: false, reason: "busy" }),
      );
    }
    expect(asked).toBe(1);
    expect(resets()).toBe(0);
    writer.client.historyResetState = historyResetState;
    Object.assign(RESTART_LIMITS, { deadlineMs: LIMITS.deadlineMs });
    release();
    await wait({ until: () => !runInProgress(syncdbPath(path)) });
    expect(await seed(project_id, path, writer, before.epoch)).toEqual(
      expect.objectContaining({ seeded: true }),
    );
  });

  it("resetHistory held across several deadlines: one reset in all, the rest busy; its answer clears the gate", async () => {
    const project_id = uuid();
    const path = ipynbPath("held-reset.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    Object.assign(RESTART_LIMITS, { deadlineMs: 600, gateObserveMs: 60_000 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const resets = wrapResets(writer, async () => await held);
    expect(await seed(project_id, path, writer, before.epoch)).toEqual(
      expect.objectContaining({ seeded: false, reason: "deadline" }),
    );
    for (let i = 0; i < 3; i++) {
      expect(await seed(project_id, path, writer, before.epoch)).toEqual(
        expect.objectContaining({ seeded: false, reason: "busy" }),
      );
    }
    expect(resets()).toBe(1);
    release();
    await wait({
      until: () => unresolvedReset(syncdbPath(path)) == null,
      timeout: 30000,
    });
    expect((await stateOf(project_id, path)).epoch).toBe(before.epoch + 1);
  });
});

describe("(A) two openers at once", () => {
  it("one seed; the other, refused busy meanwhile, opens with it", async () => {
    const project_id = uuid();
    const path = ipynbPath("two.ipynb");
    const writer = await liveWriter(project_id, path);
    const before = await stateOf(project_id, path);
    const resets = wrapResets(writer, async () => await delay(500));
    const openers = [
      openNotebook(project_id, path),
      openNotebook(project_id, path),
    ];
    const answers: any[] = [];
    for (const opener of openers) {
      (opener as any).client.askLiveWriterToSeed = async (opts) => {
        const answer = await seedOversizedHistory({
          ...opts,
          project_id,
          syncdbOf: () => writer,
          syncClient: new SyncClient(connect()),
        });
        answers.push(answer);
        return answer;
      };
    }
    await Promise.all(openers.map((o) => once(o, "ready", 60000)));
    expect(resets()).toBe(1);
    expect(answers.filter((a) => a.seeded)).toHaveLength(1);
    expect((await stateOf(project_id, path)).epoch).toBe(before.epoch + 1);
    for (const opener of openers) opener.close();
  });
});
