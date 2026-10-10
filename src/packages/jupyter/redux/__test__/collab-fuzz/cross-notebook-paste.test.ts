/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Copy Cells in one notebook and Paste Cells in another, in the same page (support
#20980): the real JupyterActions/JupyterStore of two separate notebooks share
one cell clipboard.
*/

jest.mock("@cocalc/conat/sync/akv", () => ({ akv: () => ({}) }));
jest.mock("../../runtime-state", () => ({
  ...jest.requireActual("../../runtime-state"),
  openJupyterRuntimeState: async () => undefined,
}));

import { encodePatchId, type PatchEnvelope } from "patchflow";
import { codec, fromStr, makeRng, NotebookClient, SimNetwork } from "./harness";

function notebook(records: object[]): PatchEnvelope {
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  return {
    time: encodePatchId(1_000, "init"),
    parents: [],
    patch: codec.makePatch(fromStr(""), fromStr(text)),
    userId: 0,
  } as any;
}

describe("copy cells in one notebook, paste into another", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  });
  afterEach(() => jest.useRealTimers());

  it("pastes into a different notebook", async () => {
    const netA = new SimNetwork(makeRng(1), () => Date.now(), 0);
    const netB = new SimNetwork(makeRng(2), () => Date.now(), 0);
    const a = new NotebookClient(0, netA, () => Date.now(), [
      notebook([
        { type: "settings", kernel: "python3" },
        { type: "cell", id: "a0", pos: 0, cell_type: "code", input: "x = 1" },
        {
          type: "cell",
          id: "a1",
          pos: 1,
          cell_type: "code",
          input: "print(x)",
          exec_count: 3,
          output: { "0": { name: "stdout", text: "1\n" } },
        },
      ]),
    ]);
    const b = new NotebookClient(1, netB, () => Date.now(), [
      notebook([
        { type: "settings", kernel: "python3" },
        { type: "cell", id: "b0", pos: 0, cell_type: "code", input: "y = 2" },
        { type: "cell", id: "b1", pos: 1, cell_type: "code", input: "z = 3" },
      ]),
    ]);
    await a.start();
    await b.start();
    jest.advanceTimersByTime(10);

    a.actions.copy_cells(["a0", "a1"]);
    b.actions.paste_cells_at(["b0"], 1);
    jest.advanceTimersByTime(10);

    const inputs = b
      .cellList()
      .map((id: string) => b.store.getIn(["cells", id, "input"]));
    expect(inputs).toEqual(["y = 2", "x = 1", "print(x)", "z = 3"]);
    a.stop();
    b.stop();
  });

  it("pastes back into the same notebook", async () => {
    const netA = new SimNetwork(makeRng(1), () => Date.now(), 0);
    const a = new NotebookClient(0, netA, () => Date.now(), [
      notebook([
        { type: "settings", kernel: "python3" },
        { type: "cell", id: "a0", pos: 0, cell_type: "code", input: "x = 1" },
        { type: "cell", id: "a1", pos: 1, cell_type: "code", input: "w = 0" },
      ]),
    ]);
    await a.start();
    jest.advanceTimersByTime(10);
    a.actions.copy_cells(["a0"]);
    a.actions.paste_cells_at(["a1"], 1);
    jest.advanceTimersByTime(10);
    const inputs = a
      .cellList()
      .map((id: string) => a.store.getIn(["cells", id, "input"]));
    expect(inputs).toEqual(["x = 1", "w = 0", "x = 1"]);
    a.stop();
  });
});
