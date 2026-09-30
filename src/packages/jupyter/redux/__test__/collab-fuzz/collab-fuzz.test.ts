/*
Randomized multi-client collaboration test for Jupyter notebooks (J2 in
src/.agents/harden-jupyter-collaborative-editing-plan-2026-09-30.md).

Oracle: every fragment typed or inserted carries a unique token. After the
network is quiet, all clients must converge; every cell must be a whole
record (string input, numeric position); no token may be duplicated; no
token may be lost unless the client that deleted it could see it; and every
open cell editor must show its cell's input.

Run with JUPYTER_FUZZ=1. FUZZ_RUNS (default 6) and FUZZ_SEED (default 1) select the seeds; a failure
prints its seed, so it can be replayed with FUZZ_SEED=<seed> FUZZ_RUNS=1.
FUZZ_STEPS sets operations per session and FUZZ_VERBOSE prints the operation
log and final notebook. FUZZ_NO_SPLIT_MERGE leaves out splitting and merging
cells, and FUZZ_MERGE_PROBE reports core merges that drop a token.
*/

jest.mock("@cocalc/conat/sync/akv", () => ({ akv: () => ({}) }));
jest.mock("../../runtime-state", () => ({
  ...jest.requireActual("../../runtime-state"),
  openJupyterRuntimeState: async () => undefined,
}));

import { encodePatchId, type PatchEnvelope } from "patchflow";
import {
  codec,
  fromStr,
  makeRng,
  NotebookClient,
  pick,
  SAVE_DEBOUNCE_MS,
  SimNetwork,
  tokensIn,
  type Commit,
  type Rng,
} from "./harness";

const RUNS = Number(process.env.FUZZ_RUNS ?? 6);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);

const INITIAL_RECORDS = [
  { type: "settings", kernel: "python3" },
  {
    type: "cell",
    id: "c0",
    pos: 0,
    cell_type: "code",
    input: "import math tkx0q",
  },
  {
    type: "cell",
    id: "c1",
    pos: 1,
    cell_type: "code",
    input: "x = 1 tkx1q\ny = 2 tkx2q\nprint(x + y) tkx3q",
  },
  {
    type: "cell",
    id: "c2",
    pos: 2,
    cell_type: "markdown",
    input: "# Notes tkx4q\n\nSome text tkx5q",
  },
  {
    type: "cell",
    id: "c3",
    pos: 3,
    cell_type: "code",
    input: "def f(): tkx6q\n    return 1 tkx7q",
  },
];
const INITIAL = INITIAL_RECORDS.map((r) => JSON.stringify(r)).join("\n");

interface Records {
  cells: any[];
  inputs: string;
}

function parse(doc: string): Records {
  const cells = doc
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((r) => r.type === "cell");
  return { cells, inputs: cells.map((c) => c.input ?? "").join("\n") };
}

// Which commit removed a token, or first made two copies of it?
function classify(
  tok: string,
  clients: NotebookClient[],
  lost: boolean,
): string {
  const count = (doc: string) => parse(doc).inputs.split(tok).length - 1;
  for (const c of clients) {
    for (const commit of c.syncdb.commits as Commit[]) {
      const [before, after] = [count(commit.before), count(commit.after)];
      if (lost ? before > 0 && after === 0 : after > 1 && before <= 1) {
        if (process.env.FUZZ_VERBOSE) {
          const cellOf = (doc: string) =>
            parse(doc).cells.find((cell) => (cell.input ?? "").includes(tok))
              ?.id;
          const id = cellOf(commit.before) ?? cellOf(commit.after);
          const input = (doc: string) =>
            parse(doc).cells.find((cell) => cell.id === id)?.input;
          // eslint-disable-next-line no-console
          console.log(
            `c${c.id} ${commit.source} commit on ${id}:\n  before: ${JSON.stringify(input(commit.before))}\n  after:  ${JSON.stringify(input(commit.after))}`,
          );
        }
        return `${lost ? "removed" : "duplicated"} by a c${c.id} ${commit.source ?? "?"} commit`;
      }
    }
  }
  return lost ? "lost in merge" : "duplicated in merge";
}

// Which commit first left cell `id` without an input or a position?
function classifyGhost(id: string, clients: NotebookClient[]): string {
  const whole = (doc: string) => {
    const cell = parse(doc).cells.find((c) => c.id === id);
    return (
      cell == null ||
      (typeof cell.input === "string" && typeof cell.pos === "number")
    );
  };
  for (const c of clients) {
    for (const commit of c.syncdb.commits as Commit[]) {
      if (whole(commit.before) && !whole(commit.after)) {
        return `made by a c${c.id} ${commit.source ?? "?"} commit`;
      }
    }
  }
  return "made in merge";
}

async function runSession(seed: number, steps = STEPS) {
  const rng: Rng = makeRng(seed);
  const log: string[] = [];
  const problems: string[] = [];
  const now = () => Date.now();
  const net = new SimNetwork(rng, now, 400);
  const initialPatch: PatchEnvelope = {
    time: encodePatchId(1_000, "init"),
    parents: [],
    patch: codec.makePatch(fromStr(""), fromStr(INITIAL)),
    userId: 0,
  } as any;
  const nUsers = 2 + Math.floor(rng() * 2);
  const clients: NotebookClient[] = [];
  for (let id = 0; id < nUsers + 1; id++) {
    clients.push(new NotebookClient(id, net, now, [initialPatch]));
  }
  for (const c of clients) await c.start();
  const users = clients.slice(0, nUsers);
  const backend = clients[nUsers]; // writes outputs, like the project's kernel

  const inserted = new Set<string>(tokensIn(INITIAL));
  const deleted = new Set<string>();
  let counter = 0;
  const newToken = (c: NotebookClient) => `tk${"abcdefgh"[c.id]}${counter++}q`;

  const settle = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    net.deliverDue();
    await Promise.resolve();
  };

  for (let step = 0; step < steps; step++) {
    const c = pick(rng, users);
    const cells = c.cellList();
    const r = rng();
    const label = `step ${step} c${c.id}`;
    try {
      if (r < 0.35) {
        // type a word into a cell
        if (c.editor == null || c.editor.closed || rng() < 0.2) {
          if (cells.length === 0) continue;
          c.focus(pick(rng, cells));
        }
        const tok = newToken(c);
        inserted.add(tok);
        c.editor!.edit((value) => {
          const lines = value.split("\n");
          const i = Math.floor(rng() * lines.length);
          const words = lines[i].split(" ");
          words.splice(Math.floor(rng() * (words.length + 1)), 0, tok);
          lines[i] = words.join(" ");
          if (rng() < 0.15) lines.splice(i + 1, 0, `new line ${newToken(c)}`);
          return lines.join("\n");
        });
        for (const t of tokensIn(c.editor!.value)) inserted.add(t);
        log.push(`${label}: type ${tok} in ${c.editor!.id}`);
      } else if (r < 0.45) {
        // delete a word in the focused cell
        const ed = c.editor;
        if (ed == null || ed.closed) continue;
        ed.edit((value) => {
          const lines = value.split("\n");
          const i = Math.floor(rng() * lines.length);
          const words = lines[i].split(" ");
          const j = Math.floor(rng() * words.length);
          for (const t of tokensIn(words[j] ?? "")) deleted.add(t);
          words.splice(j, 1);
          lines[i] = words.join(" ");
          return lines.join("\n");
        });
        log.push(`${label}: delete a word in ${ed.id}`);
      } else if (r < 0.55) {
        // insert a cell with some text
        if (cells.length === 0) continue;
        const at = pick(rng, cells);
        const tok = newToken(c);
        inserted.add(tok);
        c.run("insert cell", () => {
          const id = c.actions.insert_cell_adjacent(
            at,
            rng() < 0.5 ? -1 : 1,
            false,
          );
          c.actions.set_cell_input(id, `z = 0 ${tok}`, true);
          log.push(`${label}: insert cell ${id} next to ${at} with ${tok}`);
        });
      } else if (r < 0.62) {
        // delete a cell
        if (cells.length <= 1) continue;
        const id = pick(rng, cells);
        // Deleting a cell deletes what this client has of it, including
        // remote edits merged but not yet rendered.
        for (const t of tokensIn(c.cellInput(id) ?? "")) deleted.add(t);
        const synced = c.syncdb.get_one({ type: "cell", id })?.get("input");
        for (const t of tokensIn(typeof synced === "string" ? synced : ""))
          deleted.add(t);
        if (c.editor?.id === id) {
          for (const t of tokensIn(c.editor.value)) deleted.add(t);
        }
        c.frameCommand("delete cell", () => c.actions.delete_cells([id]));
        log.push(`${label}: delete cell ${id}`);
      } else if (r < 0.7) {
        // move a cell
        if (cells.length <= 1) continue;
        const from = Math.floor(rng() * cells.length);
        const to = Math.floor(rng() * cells.length);
        c.run("move cell", () => c.actions.moveCell(from, to));
        log.push(`${label}: move cell ${from} -> ${to}`);
      } else if (r < 0.8 && process.env.FUZZ_NO_SPLIT_MERGE) {
        continue;
      } else if (r < 0.75) {
        // split the focused cell at a line (the frontend passes the editor cursor)
        const ed = c.editor;
        if (ed == null || ed.closed) continue;
        const line = Math.floor(rng() * ed.value.split("\n").length);
        c.frameCommand("split cell", () =>
          c.actions.split_cell(ed.id, { line, ch: 0 }),
        );
        log.push(`${label}: split cell ${ed.id} at line ${line}`);
      } else if (r < 0.8) {
        // merge a cell with the one below
        if (cells.length <= 1) continue;
        const id = pick(rng, cells.slice(0, -1));
        c.frameCommand("merge cells", () =>
          c.actions.merge_cell_below_cell(id, true),
        );
        log.push(`${label}: merge cell ${id} with the one below`);
      } else if (r < 0.85) {
        // change a cell's type
        if (cells.length === 0) continue;
        const id = pick(rng, cells);
        const type = pick(rng, ["code", "markdown", "raw"]);
        c.run("cell type", () => c.actions.set_cell_type(id, type));
        log.push(`${label}: set type of ${id} to ${type}`);
      } else if (r < 0.93) {
        // the backend runs a cell and writes its output
        const bcells = backend.cellList();
        if (bcells.length === 0) continue;
        const id = pick(rng, bcells);
        backend.run("backend output", () => {
          backend.actions._set(
            {
              type: "cell",
              id,
              output: { 0: { name: "stdout", text: `ran ${step}` } },
              exec_count: step,
            },
            true,
          );
        });
        log.push(`step ${step} backend: output for ${id}`);
      } else {
        // focus another cell, or none
        const id =
          rng() < 0.3 || cells.length === 0 ? undefined : pick(rng, cells);
        c.focus(id);
        log.push(`${label}: focus ${id ?? "nothing"}`);
      }
    } catch (err) {
      problems.push(`${label}: exception ${err}`);
    }
    await settle(Math.floor(rng() * 300));
  }

  // Quiesce: flush editor saves and deliver everything until nothing changes.
  let stable = 0;
  for (let i = 0; i < 200 && stable < 3; i++) {
    const before = clients.map((c) => c.doc()).join("\u0000");
    jest.advanceTimersByTime(SAVE_DEBOUNCE_MS + 50);
    net.deliverDue(true);
    await Promise.resolve();
    jest.advanceTimersByTime(100);
    const after = clients.map((c) => c.doc()).join("\u0000");
    stable = before === after && net.pending() === 0 ? stable + 1 : 0;
  }

  const docs = clients.map((c) => c.doc());
  if (new Set(docs).size !== 1) {
    problems.push("clients did not converge");
    if (process.env.FUZZ_VERBOSE) {
      const lines0 = new Set(docs[0].split("\n"));
      for (let i = 1; i < docs.length; i++) {
        const lines = new Set(docs[i].split("\n"));
        // eslint-disable-next-line no-console
        console.log(
          `c${i} vs c0:\n  only c${i}: ${JSON.stringify([...lines].filter((l) => !lines0.has(l)))}\n  only c0: ${JSON.stringify([...lines0].filter((l) => !lines.has(l)))}\n  heads c${i}: ${clients[i].session.getHeads().length} c0: ${clients[0].session.getHeads().length}`,
        );
      }
    }
  }
  const final = parse(docs[0]);
  for (const cell of final.cells) {
    if (typeof cell.input !== "string" || typeof cell.pos !== "number") {
      problems.push(
        `ghost cell ${JSON.stringify(cell)} (${classifyGhost(cell.id, clients)})`,
      );
    }
  }
  const counts = new Map<string, number>();
  for (const tok of tokensIn(final.inputs))
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  for (const [tok, n] of counts) {
    if (n <= 1) continue;
    const cellsWith = final.cells.filter((cell) =>
      (cell.input ?? "").includes(tok),
    ).length;
    const where = cellsWith > 1 ? "across cells" : "in one cell";
    problems.push(
      `duplicated token ${tok} (x${n}, ${where}, ${classify(tok, clients, false)})`,
    );
  }
  for (const tok of inserted) {
    if (!deleted.has(tok) && !counts.has(tok)) {
      problems.push(`lost token ${tok} (${classify(tok, clients, true)})`);
    }
  }
  for (const c of clients) {
    const ed = c.editor;
    if (
      ed != null &&
      !ed.closed &&
      c.cellInput(ed.id) != null &&
      ed.value !== c.cellInput(ed.id)
    ) {
      problems.push(`c${c.id} editor for ${ed.id} does not show its cell`);
    }
  }
  if (process.env.FUZZ_VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(`seed ${seed}:\n${log.join("\n")}\n--- final ---\n${docs[0]}`);
  }
  for (const c of clients) c.stop();
  return { seed, problems, log };
}

// Today's code fails most seeds (see the plan's baseline), so the fuzzer only
// runs when asked for (JUPYTER_FUZZ=1) until the fixes land; it then becomes a
// default test, as the Markdown fuzzer is.
const describeFuzz = process.env.JUPYTER_FUZZ ? describe : describe.skip;

describeFuzz("collaborative notebook editing fuzz", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
    it(`seed ${seed}`, async () => {
      const { problems } = await runSession(seed);
      if (problems.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`seed ${seed}: ${problems.join("; ")}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
