/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project's notebook session around a history reset (bounded history
// plan H1b-3 r4, §4): after a completed hand-off it comes back once in the new
// epoch; a late "closed" from the old session never stops its replacement;
// NOT SAVED stops nothing; and after any reset the notebook is never refilled
// from the .ipynb, even with no cells (CORR-H1B3P-2).

import { EventEmitter } from "events";
import { Map as IMap } from "immutable";

const syncdbs: FakeSyncDB[] = [];
// the actions each session created
const created: any[] = [];

class FakeSyncDB extends EventEmitter {
  state = "ready";
  settings: any;
  closed = false;
  constructor(public opts: any) {
    super();
    this.settings = nextSettings;
    syncdbs.push(this);
  }
  get_state = () => this.state;
  isClosed = () => this.closed;
  get_settings = () => this.settings;
  // no cells
  get = () => IMap();
  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    this.emit("closed");
  };
}
let nextSettings: any = IMap();

jest.mock("@cocalc/sync/editor/db/sync", () => ({
  SyncDB: jest.fn().mockImplementation((opts) => new FakeSyncDB(opts)),
}));

jest.mock("@cocalc/jupyter/kernel", () => ({
  initJupyterRedux: (syncdb) => {
    const actions = {
      syncdb,
      store: { get: () => undefined },
      setState: jest.fn(),
      setToIpynb: jest.fn(async () => {}),
    };
    created.push(actions);
    return { actions };
  },
  removeJupyterRedux: jest.fn(),
}));

jest.mock("@cocalc/jupyter/kernel/kernel-data", () => ({
  get_kernel_data: jest.fn(async () => []),
}));

import { start, isRunning } from "../control";

const path = "nb.ipynb";
const ipynb = JSON.stringify({
  cells: [{ cell_type: "code", source: ["saved"], outputs: [], metadata: {} }],
  metadata: { kernelspec: { name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
});

function fs() {
  const reads: string[] = [];
  return {
    reads,
    readFile: jest.fn(async (p: string) => {
      reads.push(p);
      return Buffer.from(ipynb);
    }),
  } as any;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  for (const s of syncdbs) s.close();
  syncdbs.length = 0;
  created.length = 0;
  nextSettings = IMap();
});

describe("start() after a history reset", () => {
  it("a never-reset empty notebook is filled from the .ipynb, as before", async () => {
    await start({ path, project_id: "p", client: {}, fs: fs() });
    expect(created[0].setToIpynb).toHaveBeenCalledTimes(1);
  });

  it("after a reset, a notebook with no cells is NOT refilled from the .ipynb", async () => {
    nextSettings = IMap({ history_reset: IMap({ reason: "live-seed" }) });
    await start({ path, project_id: "p", client: {}, fs: fs() });
    expect(created).toHaveLength(1);
    expect(created[0].setToIpynb).not.toHaveBeenCalled();
    expect(isRunning(path)).toBe(true);
  });
});

describe("the reopen, tied to the session's identity", () => {
  it("a completed hand-off reopens the notebook once, in a new session", async () => {
    await start({ path, project_id: "p", client: {}, fs: fs() });
    expect(syncdbs).toHaveLength(1);
    const old = syncdbs[0];
    old.emit("history-reset", { history_epoch: 2, copies: [] });
    old.close();
    await flush();
    await flush();
    expect(syncdbs).toHaveLength(2);
    expect(isRunning(path)).toBe(true);
    expect(syncdbs[1].closed).toBe(false);
  });

  it("a late 'closed' or 'error' from the old session never stops the replacement", async () => {
    await start({ path, project_id: "p", client: {}, fs: fs() });
    const old = syncdbs[0];
    old.emit("history-reset", { history_epoch: 2, copies: [] });
    old.close();
    await flush();
    await flush();
    const replacement = syncdbs[1];
    // delayed events from the old session
    old.emit("closed");
    old.emit("error", new Error("late"));
    await flush();
    expect(replacement.closed).toBe(false);
    expect(isRunning(path)).toBe(true);
    expect(syncdbs).toHaveLength(2);
  });

  it("NOT SAVED stops nothing", async () => {
    await start({ path, project_id: "p", client: {}, fs: fs() });
    const session = syncdbs[0];
    session.emit("history-reset-unsaved", { reason: "too-large" });
    await flush();
    expect(session.closed).toBe(false);
    expect(isRunning(path)).toBe(true);
    expect(syncdbs).toHaveLength(1);
  });

  it("a close without a reset stops the session and does not reopen", async () => {
    await start({ path, project_id: "p", client: {}, fs: fs() });
    syncdbs[0].close();
    await flush();
    expect(isRunning(path)).toBe(false);
    expect(syncdbs).toHaveLength(1);
  });
});
