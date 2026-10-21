/*
Restarting a notebook's unloadable edit history from its saved .ipynb, as
the user confirmed it (bounded history plan H1b-3 r4, §3, option B): one
seeded reset, conditional on the confirmed epoch and revision, built offline
with capped work, one run per notebook, one deadline, and at most one
unresolved reset per notebook.

Real persist servers; the saved file is served by a fake bounded read.
*/

import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  wait,
} from "@cocalc/backend/conat/test/sync-doc/setup";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import { ipynbPath, syncdbPath } from "@cocalc/util/jupyter/names";
import {
  RESTART_LIMITS,
  resetHistoryRestartState,
  restartHistoryFromIpynb,
  runInProgress,
  unresolvedReset,
} from "@cocalc/jupyter/history-restart";

beforeAll(before);
afterAll(after);
jest.setTimeout(60000);

const LIMITS = { ...RESTART_LIMITS };
afterEach(() => {
  Object.assign(RESTART_LIMITS, LIMITS);
  resetHistoryRestartState();
});

function ipynbOf(sources: string[], kernel = "python3") {
  return {
    cells: sources.map((source) => ({
      cell_type: "code",
      source: [source],
      outputs: [],
      metadata: {},
      execution_count: null,
    })),
    metadata: { kernelspec: { name: kernel, display_name: kernel } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

const bytesOf = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));

// The notebook's syncdb, as an editor opens it.
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

// A notebook with some live history.
async function liveNotebook(project_id: string, path: string) {
  const doc = openNotebook(project_id, path);
  await once(doc, "ready");
  doc.set({ type: "cell", id: "live1", pos: 0, input: "live edit" });
  doc.set({ type: "settings", kernel: "python3" });
  doc.commit();
  await doc.save();
  return doc;
}

// A SyncClient whose file read serves `file` (counted) and whose resetHistory
// can be held.
function harness(file: () => Uint8Array | "missing") {
  const real = new SyncClient(connect());
  const counts = { reads: 0, resets: 0 };
  let hold: Promise<void> | undefined;
  let holdRead: Promise<void> | undefined;
  // resets held one by one, in the order they are sent, when holdEach is on
  let holdEach = false;
  const heldResets: (() => void)[] = [];
  const syncClient: any = {
    historyResetState: real.historyResetState,
    readFileBounded: async ({ maxBytes }) => {
      counts.reads += 1;
      if (holdRead) await holdRead;
      const data = file();
      if (data == "missing") return { status: "missing" };
      if (data.length > maxBytes) return { status: "too-large" };
      return { status: "ok", data };
    },
    resetHistory: async (opts) => {
      counts.resets += 1;
      if (hold) await hold;
      if (holdEach) {
        await new Promise<void>((resolve) => heldResets.push(resolve));
      }
      return await real.resetHistory(opts);
    },
  };
  const holdResets = () => {
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    return () => {
      hold = undefined;
      release();
    };
  };
  const holdReads = () => {
    let release!: () => void;
    holdRead = new Promise((resolve) => (release = resolve));
    return () => {
      holdRead = undefined;
      release();
    };
  };
  const holdEachReset = () => {
    holdEach = true;
    return heldResets;
  };
  return { syncClient, counts, holdResets, holdReads, holdEachReset, real };
}

async function state(project_id: string, path: string) {
  return await new SyncClient(connect()).historyResetState({
    project_id,
    path: syncdbPath(path),
  });
}

function restart(
  project_id: string,
  path: string,
  confirmed: { epoch: number; seq: number; count: number },
  syncClient: any,
) {
  return restartHistoryFromIpynb({
    project_id,
    path,
    epoch: confirmed.epoch,
    revision: { seq: confirmed.seq, count: confirmed.count },
    client: connect(),
    fs: {},
    syncClient,
  });
}

// the notebook as it is now: its cells' inputs, its kernel
async function contents(project_id: string, path: string) {
  const doc = openNotebook(project_id, path);
  await once(doc, "ready");
  const cells = doc
    .get({ type: "cell" })
    .toJS()
    .map((c) => c.input)
    .sort();
  const kernel = doc.get_one({ type: "settings" })?.get("kernel");
  const versions = doc.versions().length;
  doc.close();
  return { cells, kernel, versions };
}

describe("(B) the confirmed restart from the saved notebook", () => {
  const project_id = uuid();
  const path = ipynbPath("happy.ipynb");

  it("one seeded reset: the notebook is exactly the .ipynb, and no import patch exists", async () => {
    const live = await liveNotebook(project_id, path);
    const { syncClient, counts } = harness(() =>
      bytesOf(ipynbOf(["print(1)", "x = 2"], "julia")),
    );
    const confirmed = await state(project_id, path);
    const result = await restart(project_id, path, confirmed, syncClient);
    expect(result).toEqual({
      restarted: true,
      history_epoch: confirmed.epoch + 1,
    });
    expect(counts).toEqual({ reads: 1, resets: 1 });
    expect(await contents(project_id, path)).toEqual({
      cells: ["print(1)", "x = 2"],
      kernel: "julia",
      // the seed only
      versions: 1,
    });
    expect(unresolvedReset(syncdbPath(path))).toBeUndefined();
    live.close();
  });
});

describe("two restarts of the same notebook (CORR-H1B3P-1)", () => {
  it("(i) the second, while the first's reset is held, is refused before reading", async () => {
    const project_id = uuid();
    const path = ipynbPath("two-i.ipynb");
    const live = await liveNotebook(project_id, path);
    const h = harness(() => bytesOf(ipynbOf(["a"])));
    const confirmed = await state(project_id, path);
    const release = h.holdResets();
    const first = restart(project_id, path, confirmed, h.syncClient);
    await wait({ until: () => h.counts.resets == 1 });
    const second = await restart(project_id, path, confirmed, h.syncClient);
    expect(second).toEqual(
      expect.objectContaining({ restarted: false, reason: "busy" }),
    );
    // the second read nothing and sent nothing
    expect(h.counts).toEqual({ reads: 1, resets: 1 });
    release();
    expect((await first).restarted).toBe(true);
    live.close();
  });

  it("(ii) after the first applied and live edits followed: a stale second restart never applies", async () => {
    const project_id = uuid();
    const path = ipynbPath("two-ii.ipynb");
    const live = await liveNotebook(project_id, path);
    let file = bytesOf(ipynbOf(["v1"]));
    const h = harness(() => file);
    const confirmed = await state(project_id, path);
    expect(
      (await restart(project_id, path, confirmed, h.syncClient)).restarted,
    ).toBe(true);
    await wait({ until: () => !runInProgress(syncdbPath(path)) });
    live.close();

    // live edits, an output and a settings change in the new epoch
    const doc = openNotebook(project_id, path);
    await once(doc, "ready");
    const cell = doc.get({ type: "cell" }).toJS()[0];
    doc.set({ type: "cell", id: cell.id, input: "edited live" });
    doc.set({
      type: "cell",
      id: cell.id,
      output: { 0: { text: "live output" } },
    });
    doc.set({ type: "settings", kernel: "ir" });
    doc.commit();
    await doc.save();

    // the same file: the same opId, so the first result, applied once
    const same = await restart(project_id, path, confirmed, h.syncClient);
    await wait({ until: () => !runInProgress(syncdbPath(path)) });
    expect(same).toEqual(
      expect.objectContaining({ restarted: true, repeated: true }),
    );
    // a changed file: refused by the epoch fence
    file = bytesOf(ipynbOf(["v2"]));
    const changed = await restart(project_id, path, confirmed, h.syncClient);
    expect(changed).toEqual(
      expect.objectContaining({ restarted: false, reason: "epoch" }),
    );

    await wait({
      until: () => doc.get_one({ type: "settings" })?.get("kernel") == "ir",
    });
    const after = await contents(project_id, path);
    expect(after.cells).toEqual(["edited live"]);
    expect(after.kernel).toBe("ir");
    const reopened = openNotebook(project_id, path);
    await once(reopened, "ready");
    expect(
      reopened
        .get_one({ type: "cell", id: cell.id })
        ?.getIn(["output", "0", "text"]),
    ).toBe("live output");
    reopened.close();
    doc.close();
  });
});

describe("an edit accepted after the user confirmed refuses the restart", () => {
  it("a settings-only change (a kernel switch): moved, and it survives", async () => {
    const project_id = uuid();
    const path = ipynbPath("moved.ipynb");
    const live = await liveNotebook(project_id, path);
    const h = harness(() => bytesOf(ipynbOf(["saved"])));
    const confirmed = await state(project_id, path);
    live.set({ type: "settings", kernel: "sage" });
    live.commit();
    await live.save();
    const result = await restart(project_id, path, confirmed, h.syncClient);
    expect(result).toEqual(
      expect.objectContaining({ restarted: false, reason: "moved" }),
    );
    const now = await contents(project_id, path);
    expect(now.kernel).toBe("sage");
    expect(now.cells).toEqual(["live edit"]);
    live.close();
  });
});

describe("caps, applied as the import goes (LIMIT-H1B3P-3)", () => {
  const cases: [string, () => any, Partial<typeof RESTART_LIMITS>][] = [
    [
      "more cells than the cap",
      () => ipynbOf(["a", "b", "c", "d"]),
      { cells: 3 },
    ],
    [
      "more attachments than the cap",
      () => {
        const nb = ipynbOf(["a"]);
        (nb.cells[0] as any).cell_type = "markdown";
        (nb.cells[0] as any).attachments = {
          "a.png": { "image/png": "AAAA" },
          "b.png": { "image/png": "AAAA" },
        };
        return nb;
      },
      { attachments: 1 },
    ],
    [
      "a value over the byte cap",
      () => ipynbOf(["x".repeat(5000)]),
      { valueBytes: 1000, valueWork: 1_000_000 },
    ],
    [
      "a value over the work cap",
      () => ipynbOf(["a", "b", "c"]),
      { valueWork: 5 },
    ],
  ];
  for (const [name, nb, limits] of cases) {
    it(`${name}: too-large, and nothing is sent`, async () => {
      const project_id = uuid();
      const path = ipynbPath("caps.ipynb");
      const live = await liveNotebook(project_id, path);
      Object.assign(RESTART_LIMITS, limits);
      const h = harness(() => bytesOf(nb()));
      const confirmed = await state(project_id, path);
      const result = await restart(project_id, path, confirmed, h.syncClient);
      expect(result).toEqual(
        expect.objectContaining({ restarted: false, reason: "too-large" }),
      );
      expect(h.counts.resets).toBe(0);
      expect((await contents(project_id, path)).cells).toEqual(["live edit"]);
      live.close();
    });
  }

  it("a file over the read cap is never read whole", async () => {
    const project_id = uuid();
    const path = ipynbPath("big.ipynb");
    Object.assign(RESTART_LIMITS, { fileBytes: 100 });
    const h = harness(() => bytesOf(ipynbOf(["x".repeat(1000)])));
    const result = await restart(
      project_id,
      path,
      { epoch: 0, seq: 0, count: 0 },
      h.syncClient,
    );
    expect(result).toEqual(
      expect.objectContaining({ restarted: false, reason: "too-large" }),
    );
    expect(h.counts.resets).toBe(0);
  });
});

describe("the deadline and the run slot", () => {
  it("a read held past repeated deadlines: one read in all; retries are busy until it settles (LIMIT-H1B3B-1)", async () => {
    const project_id = uuid();
    const path = ipynbPath("deadline.ipynb");
    Object.assign(RESTART_LIMITS, { deadlineMs: 200 });
    const h = harness(() => bytesOf(ipynbOf(["a"])));
    const release = h.holdReads();
    const confirmed = { epoch: 0, seq: 0, count: 0 };
    expect(await restart(project_id, path, confirmed, h.syncClient)).toEqual(
      expect.objectContaining({ restarted: false, reason: "deadline" }),
    );
    // after the deadline the abandoned read keeps the slot: retries never
    // start a second one
    for (let i = 0; i < 3; i++) {
      expect(await restart(project_id, path, confirmed, h.syncClient)).toEqual(
        expect.objectContaining({ restarted: false, reason: "busy" }),
      );
    }
    expect(h.counts).toEqual({ reads: 1, resets: 0 });
    // once it settles, the slot is free again
    release();
    Object.assign(RESTART_LIMITS, { deadlineMs: LIMITS.deadlineMs });
    await wait({
      until: async () =>
        (await restart(project_id, path, confirmed, h.syncClient)).reason !=
        "busy",
    });
    expect(h.counts.reads).toBe(2);
  });

  it("a preparation held past repeated deadlines: one preparation in all; retries are busy until it settles", async () => {
    const project_id = uuid();
    const path = ipynbPath("deadline-prepare.ipynb");
    Object.assign(RESTART_LIMITS, { deadlineMs: 200 });
    const h = harness(() => bytesOf(ipynbOf(["a"])));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let prepared = 0;
    const fs = {
      jupyterImportIpynb: async (ipynb) => {
        prepared += 1;
        await held;
        return { ipynb };
      },
    };
    const go = () =>
      restartHistoryFromIpynb({
        project_id,
        path,
        epoch: 0,
        revision: { seq: 0, count: 0 },
        client: connect(),
        fs,
        syncClient: h.syncClient,
      });
    expect(await go()).toEqual(
      expect.objectContaining({ restarted: false, reason: "deadline" }),
    );
    for (let i = 0; i < 3; i++) {
      expect(await go()).toEqual(
        expect.objectContaining({ restarted: false, reason: "busy" }),
      );
    }
    expect(prepared).toBe(1);
    expect(h.counts).toEqual({ reads: 1, resets: 0 });
    release();
    await wait({ until: async () => (await go()).reason != "busy" });
    expect(prepared).toBe(2);
  });

  it("an output write still pending at the deadline holds the slot until it settles", async () => {
    const project_id = uuid();
    const path = ipynbPath("deadline-write.ipynb");
    Object.assign(RESTART_LIMITS, { deadlineMs: 300 });
    const nb: any = ipynbOf(["plot()"]);
    nb.cells[0].outputs = [
      {
        output_type: "display_data",
        data: { "image/png": Buffer.from("png bytes").toString("base64") },
        metadata: {},
      },
    ];
    const h = harness(() => bytesOf(nb));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    let closed = 0;
    const blobStoreOf = () => ({
      set: async () => {
        writes += 1;
        await held;
      },
      close: () => {
        closed += 1;
      },
    });
    const go = () =>
      restartHistoryFromIpynb({
        project_id,
        path,
        epoch: 0,
        revision: { seq: 0, count: 0 },
        client: connect(),
        fs: {},
        syncClient: h.syncClient,
        blobStoreOf,
      });
    expect(await go()).toEqual(
      expect.objectContaining({ restarted: false, reason: "deadline" }),
    );
    expect(await go()).toEqual(
      expect.objectContaining({ restarted: false, reason: "busy" }),
    );
    expect(writes).toBe(1);
    expect(h.counts.resets).toBe(0);
    // the store is closed only after its writes settled
    expect(closed).toBe(0);
    release();
    await wait({ until: () => closed == 1 });
    await wait({ until: async () => (await go()).reason != "busy" });
  });

  it("invalid requests are refused before anything else", async () => {
    const h = harness(() => bytesOf(ipynbOf(["a"])));
    for (const bad of [
      { epoch: -1, seq: 0, count: 0 },
      { epoch: 0.5, seq: 0, count: 0 },
      { epoch: 0, seq: Number.MAX_SAFE_INTEGER + 1, count: 0 },
    ]) {
      const result = await restart(uuid(), "a.ipynb", bad, h.syncClient);
      expect(result).toEqual(
        expect.objectContaining({ restarted: false, reason: "invalid" }),
      );
    }
    const longPath = `${"é".repeat(2100)}.ipynb`;
    const result = await restart(
      uuid(),
      longPath,
      { epoch: 0, seq: 0, count: 0 },
      h.syncClient,
    );
    expect(result).toEqual(
      expect.objectContaining({ restarted: false, reason: "invalid" }),
    );
    expect(h.counts).toEqual({ reads: 0, resets: 0 });
  });
});

describe("at most one unresolved reset per notebook (LIMIT-H1B3P-2)", () => {
  it("a reset held across several deadlines: no second reset is sent; its own answer clears the gate", async () => {
    const project_id = uuid();
    const path = ipynbPath("gate.ipynb");
    const live = await liveNotebook(project_id, path);
    Object.assign(RESTART_LIMITS, { deadlineMs: 300 });
    const h = harness(() => bytesOf(ipynbOf(["a"])));
    const confirmed = await state(project_id, path);
    const release = h.holdResets();
    const first = await restart(project_id, path, confirmed, h.syncClient);
    expect(first).toEqual(
      expect.objectContaining({ restarted: false, reason: "deadline" }),
    );
    const gate = unresolvedReset(syncdbPath(path));
    expect(gate?.opId).toContain("ipynb-restart:");
    for (let i = 0; i < 3; i++) {
      const again = await restart(project_id, path, confirmed, h.syncClient);
      expect(again).toEqual(
        expect.objectContaining({ restarted: false, reason: "busy" }),
      );
    }
    // one reset mutation was sent in all; the gate is one small record
    expect(h.counts.resets).toBe(1);
    expect(Object.keys(unresolvedReset(syncdbPath(path))!).sort()).toEqual([
      "epoch",
      "observedAt",
      "opId",
      "revision",
    ]);
    release();
    await wait({ until: () => unresolvedReset(syncdbPath(path)) == null });
    live.close();
  });

  it("while a reset is unresolved, a new confirmation sends nothing; that reset's own answer clears the gate", async () => {
    const project_id = uuid();
    const path = ipynbPath("gate2.ipynb");
    const live = await liveNotebook(project_id, path);
    Object.assign(RESTART_LIMITS, { deadlineMs: 300, gateObserveMs: 0 });
    const h = harness(() => bytesOf(ipynbOf(["a"])));
    const held = h.holdEachReset();
    const confirmed = await state(project_id, path);
    await restart(project_id, path, confirmed, h.syncClient);
    const oldOpId = unresolvedReset(syncdbPath(path))!.opId;

    // the history moves, and the user confirms again
    live.set({ type: "cell", id: "more", pos: 1, input: "more" });
    live.commit();
    await live.save();
    const moved = await state(project_id, path);
    for (let i = 0; i < 2; i++) {
      expect(await restart(project_id, path, moved, h.syncClient)).toEqual(
        expect.objectContaining({ restarted: false, reason: "busy" }),
      );
    }
    // one reset mutation in all
    expect(h.counts.resets).toBe(1);
    expect(held).toHaveLength(1);
    expect(unresolvedReset(syncdbPath(path))?.opId).toBe(oldOpId);

    // its answer (refused: its revision moved) clears its own gate and the slot
    held[0]();
    await wait({
      until: () =>
        unresolvedReset(syncdbPath(path)) == null &&
        !runInProgress(syncdbPath(path)),
    });
    // the new confirmation now runs
    const next = restart(project_id, path, moved, h.syncClient);
    await wait({ until: () => held.length == 2 });
    held[1]();
    expect(await next).toEqual(expect.objectContaining({ restarted: true }));
    expect((await contents(project_id, path)).cells).toEqual(["a"]);
    live.close();
  });
});
