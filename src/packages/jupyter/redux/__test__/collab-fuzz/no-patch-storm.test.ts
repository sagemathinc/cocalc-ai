/*
An editor applies every collaborator's change it receives through
set_cell_input. With nothing to change it must not commit: a commit while
the notebook has several heads always makes a merge patch, which every
other client receives and (before this was fixed) answered with another
merge patch -- ten browsers in one notebook never stopped.
*/

jest.mock("@cocalc/conat/sync/akv", () => ({ akv: () => ({}) }));
jest.mock("../../runtime-state", () => ({
  ...jest.requireActual("../../runtime-state"),
  openJupyterRuntimeState: async () => undefined,
}));

import { encodePatchId, type PatchEnvelope } from "patchflow";
import { codec, fromStr, makeRng, NotebookClient, SimNetwork } from "./harness";

const INITIAL = [
  { type: "settings", kernel: "python3" },
  { type: "cell", id: "c0", pos: 0, cell_type: "code", input: "a = 1" },
  { type: "cell", id: "c1", pos: 1, cell_type: "code", input: "b = 2" },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

describe("a client with several heads and nothing to change", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  });
  afterEach(() => jest.useRealTimers());

  it("does not commit when an editor applies an unchanged input", async () => {
    const net = new SimNetwork(makeRng(1), () => Date.now(), 0);
    const initial: PatchEnvelope = {
      time: encodePatchId(1_000, "init"),
      parents: [],
      patch: codec.makePatch(fromStr(""), fromStr(INITIAL)),
      userId: 0,
    } as any;
    const clients = [0, 1, 2].map(
      (id) => new NotebookClient(id, net, () => Date.now(), [initial]),
    );
    for (const c of clients) await c.start();
    const [a, b, c] = clients;
    // Two concurrent edits: c receives both and has two heads.
    a.actions.set_cell_input("c0", "a = 10", true);
    b.actions.set_cell_input("c1", "b = 20", true);
    jest.advanceTimersByTime(10);
    net.deliverDue(true);
    await Promise.resolve();
    expect(c.session.getHeads().length).toBeGreaterThan(1);

    const commits = c.syncdb.commits.length;
    const input = c.syncdb.get_one({ type: "cell", id: "c0" }).get("input");
    expect(c.actions.set_cell_input("c0", input, true, input)).toBe(input);
    expect(c.syncdb.commits.length).toBe(commits);

    for (const client of clients) client.stop();
  });
});
