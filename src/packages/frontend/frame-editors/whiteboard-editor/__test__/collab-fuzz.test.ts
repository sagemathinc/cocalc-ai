/*
Randomized multi-client collaboration test for whiteboards and slides (the
same editor), like the notebook and task list fuzzers. Each client calls the
real whiteboard Actions methods (setElement, setElementData, deleteElements)
on a simulated SyncDB over a simulated network; text is saved whole, as the
text element does.

Oracle: after the network is quiet, all clients converge; every element is a
whole record (has a type); and no token in element text is duplicated or lost
unless the client that deleted it could see it. (Edges left pointing at an
element deleted concurrently are accepted; see below.)

FUZZ_RUNS (default 6), FUZZ_SEED, FUZZ_STEPS (default 40), FUZZ_VERBOSE.
*/

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

import { Map as ImmutableMap } from "immutable";
import { encodePatchId, type PatchEnvelope } from "patchflow";
import {
  dbCodec,
  makeRng,
  pick,
  SimNetwork,
  SimSyncDB,
  simSession,
  tokensIn,
  type Commit,
} from "@cocalc/sync/editor/sim";
import { Actions } from "../actions";

const RUNS = Number(process.env.FUZZ_RUNS ?? 6);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);

// util/syncdoc-doctypes.ts (board and slides)
const codec = dbCodec({ primaryKeys: ["id"], stringCols: ["str"] });

const INITIAL_ELEMENTS = [
  { id: "p1", type: "page", data: { pos: 0 } },
  {
    id: "e0",
    type: "text",
    page: "p1",
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    z: 0,
    str: "Hello tkx0q",
  },
  {
    id: "e1",
    type: "note",
    page: "p1",
    x: 300,
    y: 0,
    w: 200,
    h: 100,
    z: 1,
    str: "A note tkx1q\n\nwith more tkx2q",
    data: { color: "#ff0" },
  },
  { id: "e2", type: "edge", page: "p1", z: 2, data: { from: "e0", to: "e1" } },
];
const INITIAL = INITIAL_ELEMENTS.map((e) => JSON.stringify(e)).join("\n");

class BoardClient {
  syncdb!: SimSyncDB;
  actions!: any;

  constructor(
    public id: number,
    private net: SimNetwork,
    private initial: PatchEnvelope[],
  ) {}

  async start() {
    const session = await simSession({
      id: this.id,
      net: this.net,
      clock: () => Date.now(),
      initial: this.initial,
      codec,
    });
    this.syncdb = new SimSyncDB(session);
    this.syncdb.emitInitialChange();
    const syncdb = this.syncdb;
    this.actions = Object.create(Actions.prototype);
    Object.assign(this.actions, {
      _syncstring: syncdb,
      syncstring_commit: () => syncdb.commit(),
      setCursors: () => {},
      // The frame editor keeps elements in its store from syncdb changes.
      store: {
        get: (key: string) =>
          key === "elements" ? this.elementsMap() : undefined,
        getIn: ([key, id, field]: string[]) =>
          key === "elements"
            ? this.elementsMap().getIn([id, field])
            : undefined,
      },
    });
  }

  elementsMap(): ImmutableMap<string, any> {
    let map = ImmutableMap<string, any>();
    this.syncdb.get().forEach((record: any) => {
      map = map.set(record.get("id"), record);
    });
    return map;
  }

  elements(): any[] {
    return this.syncdb
      .to_str()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }
}

function classify(tok: string, clients: BoardClient[], lost: boolean): string {
  const count = (doc: string) => doc.split(tok).length - 1;
  for (const c of clients) {
    for (const commit of c.syncdb.commits as Commit[]) {
      const [before, after] = [count(commit.before), count(commit.after)];
      if (lost ? before > 0 && after === 0 : after > 1 && before <= 1) {
        return `${lost ? "removed" : "duplicated"} by a c${c.id} ${commit.source ?? "?"} commit`;
      }
    }
  }
  return lost ? "lost in merge" : "duplicated in merge";
}

async function runSession(seed: number, steps = STEPS) {
  const rng = makeRng(seed);
  const log: string[] = [];
  const problems: string[] = [];
  const net = new SimNetwork(rng, () => Date.now(), 400);
  const initial: PatchEnvelope = {
    time: encodePatchId(1_000, "init"),
    parents: [],
    patch: codec.makePatch(codec.fromString(""), codec.fromString(INITIAL)),
    userId: 0,
  } as any;
  const n = 2 + Math.floor(rng() * 2);
  const clients: BoardClient[] = [];
  for (let id = 0; id < n; id++)
    clients.push(new BoardClient(id, net, [initial]));
  for (const c of clients) await c.start();

  const inserted = new Set<string>(tokensIn(INITIAL));
  const removed = new Set<string>();
  let counter = 0;
  const token = (c: BoardClient) => `tk${"abcd"[c.id]}${counter++}q`;
  let ids = 0;

  for (let step = 0; step < steps; step++) {
    const c = pick(rng, clients);
    const all = c.elements();
    const shapes = all.filter((e) => e.type !== "page" && e.type !== "edge");
    const label = `step ${step} c${c.id}`;
    const r = rng();
    const run = (source: string, f: () => void) => c.syncdb.run(source, f);
    try {
      if (r < 0.15 || shapes.length === 0) {
        const tok = token(c);
        inserted.add(tok);
        const id = `n${c.id}x${ids++}`;
        run("create", () =>
          c.actions.setElement({
            create: true,
            obj: {
              id,
              type: "text",
              page: "p1",
              x: step * 10,
              y: 50,
              w: 100,
              h: 50,
              z: step,
              str: `text ${tok}`,
            },
          }),
        );
        log.push(`${label}: create ${id} with ${tok}`);
      } else if (r < 0.45) {
        // edit an element's text (saved whole, as text.tsx does)
        const e = pick(rng, shapes);
        const tok = token(c);
        inserted.add(tok);
        const words = (e.str ?? "").split(" ");
        words.splice(Math.floor(rng() * (words.length + 1)), 0, tok);
        run("text", () =>
          c.actions.setElement({ obj: { id: e.id, str: words.join(" ") } }),
        );
        log.push(`${label}: type ${tok} in ${e.id}`);
      } else if (r < 0.52) {
        const e = pick(rng, shapes);
        const words = (e.str ?? "").split(" ");
        const j = Math.floor(rng() * words.length);
        for (const t of tokensIn(words[j] ?? "")) removed.add(t);
        words.splice(j, 1);
        run("text", () =>
          c.actions.setElement({ obj: { id: e.id, str: words.join(" ") } }),
        );
        log.push(`${label}: delete a word in ${e.id}`);
      } else if (r < 0.64) {
        const e = pick(rng, shapes);
        const x = Math.floor(rng() * 1000);
        const y = Math.floor(rng() * 1000);
        run("move", () => c.actions.setElement({ obj: { id: e.id, x, y } }));
        log.push(`${label}: move ${e.id}`);
      } else if (r < 0.72) {
        const e = pick(rng, shapes);
        const w = 50 + Math.floor(rng() * 300);
        run("resize", () => c.actions.setElement({ obj: { id: e.id, w } }));
        log.push(`${label}: resize ${e.id}`);
      } else if (r < 0.82) {
        const e = pick(rng, shapes);
        const key = pick(rng, ["color", "fontSize", "radius"]);
        const value =
          key === "color"
            ? pick(rng, ["#f00", "#0f0", "#00f"])
            : Math.floor(rng() * 40);
        run("data", () =>
          c.actions.setElementData({ element: e, obj: { [key]: value } }),
        );
        log.push(`${label}: set ${key} of ${e.id}`);
      } else if (r < 0.9) {
        if (shapes.length < 2) continue;
        const from = pick(rng, shapes).id;
        const to = pick(rng, shapes).id;
        const id = `g${c.id}x${ids++}`;
        run("edge", () =>
          c.actions.setElement({
            create: true,
            obj: { id, type: "edge", page: "p1", z: step, data: { from, to } },
          }),
        );
        log.push(`${label}: edge ${id} ${from} -> ${to}`);
      } else {
        const e = pick(rng, shapes);
        for (const t of tokensIn(e.str ?? "")) removed.add(t);
        run("delete", () => c.actions.deleteElements([e]));
        log.push(`${label}: delete ${e.id}`);
      }
    } catch (err) {
      problems.push(`${label}: exception ${err}`);
    }
    jest.advanceTimersByTime(Math.floor(rng() * 300));
    net.deliverDue();
    await Promise.resolve();
  }

  let stable = 0;
  for (let i = 0; i < 200 && stable < 3; i++) {
    const before = clients.map((c) => c.syncdb.to_str()).join("\u0000");
    jest.advanceTimersByTime(500);
    net.deliverDue(true);
    await Promise.resolve();
    const after = clients.map((c) => c.syncdb.to_str()).join("\u0000");
    stable = before === after && net.pending() === 0 ? stable + 1 : 0;
  }

  const docs = clients.map((c) => c.syncdb.to_str());
  if (new Set(docs).size !== 1) problems.push("clients did not converge");
  const elements = clients[0].elements();
  const byId = new Map(elements.map((e) => [e.id, e]));
  const dangling: string[] = [];
  for (const e of elements) {
    if (typeof e.type !== "string")
      problems.push(`partial element ${JSON.stringify(e)}`);
    // An edge to an element deleted at the same moment (by someone who did not
    // know about the edge yet) stays as a record; it is not drawn while an end
    // is missing (edge.tsx), and is again if the element comes back. Accepted.
    if (
      e.type === "edge" &&
      (!byId.has(e.data?.from) || !byId.has(e.data?.to))
    ) {
      dangling.push(e.id);
    }
  }
  const all = elements.map((e) => e.str ?? "").join("\n");
  const counts = new Map<string, number>();
  for (const tok of tokensIn(all)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  for (const [tok, k] of counts) {
    if (k > 1)
      problems.push(
        `duplicated token ${tok} (x${k}, ${classify(tok, clients, false)})`,
      );
  }
  for (const tok of inserted) {
    if (!removed.has(tok) && !counts.has(tok)) {
      problems.push(`lost token ${tok} (${classify(tok, clients, true)})`);
    }
  }
  if (process.env.FUZZ_VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(
      `seed ${seed}:\n${log.join("\n")}\n--- final ---\n${docs[0]}` +
        (dangling.length > 0
          ? `\naccepted dangling edges: ${dangling.join(" ")}`
          : ""),
    );
  }
  for (const c of clients) c.syncdb.close();
  return problems;
}

describe("collaborative whiteboard editing fuzz", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
    it(`seed ${seed}`, async () => {
      const problems = await runSession(seed);
      if (problems.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`seed ${seed}: ${problems.join("; ")}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
