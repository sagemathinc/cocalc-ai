/*
Randomized multi-client collaboration test for task lists, like the notebook
fuzzer (jupyter/redux/__test__/collab-fuzz). Each client uses the real tasks
session (SyncDBTasksSession, as TaskActions does) on a simulated SyncDB over
a simulated network, and a model of the description editor
(desc-editor.tsx: live value, debounced save, SimpleInputMerge for remote
changes, save on close).

Oracle: every fragment typed carries a unique token. After the network is
quiet, all clients converge; every task is a whole record; no token is
duplicated or lost unless the client that removed it could see it; and every
open description editor shows its task's description.

FUZZ_RUNS (default 6), FUZZ_SEED, FUZZ_STEPS (default 40), FUZZ_VERBOSE.
*/

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
// New task ids come from the session's seed, so a failing seed replays exactly.
let uuidRng: () => number = Math.random;
jest.mock("@cocalc/util/misc", () => ({
  ...jest.requireActual("@cocalc/util/misc"),
  uuid: () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(uuidRng() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    }),
}));

import { debounce } from "lodash";
import { TaskActions } from "../actions";
import { encodePatchId, type PatchEnvelope } from "patchflow";
import { SyncDBTasksSession } from "@cocalc/app-tasks";
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
import { SimpleInputMerge } from "@cocalc/sync/editor/generic/simple-input-merge";

const RUNS = Number(process.env.FUZZ_RUNS ?? 6);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const SAVE_DEBOUNCE_MS = 750; // frame-editors/code-editor/const.ts

// util/syncdoc-doctypes.ts
const codec = dbCodec({ primaryKeys: ["task_id"], stringCols: ["desc"] });

const INITIAL_TASKS = [
  { task_id: "t0", position: 0, desc: "Buy milk tkx0q\n\n- eggs tkx1q" },
  { task_id: "t1", position: 1, desc: "Write the report tkx2q" },
  {
    task_id: "t2",
    position: 2,
    desc: "# Plan tkx3q\n\nsome notes tkx4q",
    done: true,
  },
];
const INITIAL = INITIAL_TASKS.map((t) => JSON.stringify(t)).join("\n");

class TaskClient {
  session!: SyncDBTasksSession;
  syncdb!: SimSyncDB;
  // The real TaskActions methods used by the description editor, on this
  // client's session and syncdb.
  actions!: TaskActions;
  editor?: DescEditor;

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
    this.session = new SyncDBTasksSession(this.syncdb as any);
    this.actions = Object.create(TaskActions.prototype);
    Object.assign(this.actions, {
      syncdb: this.syncdb,
      tasksSession: this.session,
      is_closed: false,
    });
    // TaskActions updates its store on syncdb changes; the open editor sees
    // the new description on the next render.
    this.syncdb.on("change", () => {
      setTimeout(() => this.editor?.storeChanged(), 0);
    });
  }

  tasks(): any[] {
    return this.syncdb
      .to_str()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }

  desc(taskId: string): string | undefined {
    const desc = this.syncdb.get_one({ task_id: taskId })?.get("desc");
    return typeof desc === "string" ? desc : undefined;
  }

  // TaskActions.set_desc etc. go through the session; errors are caught and
  // only logged there (runSessionMutation), as here.
  mutate(source: string, f: () => Promise<unknown>): void {
    this.syncdb.run(source, () => {
      f().catch(() => {});
    });
  }

  open(taskId: string) {
    if (this.editor?.taskId === taskId) return;
    this.editor?.close();
    this.editor = new DescEditor(this, taskId);
  }
}

// desc-editor.tsx
class DescEditor {
  value: string; // what the markdown editor shows
  private merge: SimpleInputMerge;
  private base: string; // baseRef
  private seen: string;
  closed = false;
  private commit = debounce(
    () => this.save("desc save", this.value),
    SAVE_DEBOUNCE_MS,
  );

  constructor(
    private client: TaskClient,
    public taskId: string,
  ) {
    const desc = client.desc(taskId) ?? "";
    this.value = desc;
    this.seen = desc;
    this.base = desc;
    this.merge = new SimpleInputMerge(desc);
  }

  edit(f: (value: string) => string) {
    this.value = f(this.value);
    this.commit();
  }

  private save(source: string, value: string) {
    const saved =
      this.client.syncdb.run(source, () =>
        this.client.actions.set_desc(this.taskId, value, true, this.base),
      ) ?? value;
    this.base = saved;
    this.merge.noteLocalEcho(saved);
    if (saved !== value) this.value = saved;
  }

  storeChanged() {
    if (this.closed) return;
    const desc = this.client.desc(this.taskId);
    if (desc == null || desc === this.seen) return;
    this.seen = desc;
    this.merge.handleRemote({
      remote: desc,
      getLocal: () => this.value,
      applyMerged: (v) => {
        this.base = desc;
        this.value = v;
        // The editor shows it now; desc-editor.tsx settles the request in an
        // effect after it renders.
        this.merge.noteRendered();
      },
    });
  }

  // saveAndClose (blur, shift+enter, close button)
  close() {
    if (this.closed) return;
    this.commit.cancel();
    this.save("desc close", this.value);
    this.closed = true;
  }
}

function classify(tok: string, clients: TaskClient[], lost: boolean): string {
  const count = (doc: string) => doc.split(tok).length - 1;
  for (const c of clients) {
    for (const commit of c.syncdb.commits as Commit[]) {
      const [before, after] = [count(commit.before), count(commit.after)];
      if (lost ? before > 0 && after === 0 : after > 1 && before <= 1) {
        if (process.env.FUZZ_VERBOSE) {
          // eslint-disable-next-line no-console
          console.log(
            `c${c.id} ${commit.source} commit:\n  before: ${commit.before}\n  after:  ${commit.after}`,
          );
        }
        return `${lost ? "removed" : "duplicated"} by a c${c.id} ${commit.source ?? "?"} commit`;
      }
    }
  }
  return lost ? "lost in merge" : "duplicated in merge";
}

async function runSession(seed: number, steps = STEPS) {
  const rng = makeRng(seed);
  uuidRng = makeRng(seed + 1_000_003);
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
  const clients: TaskClient[] = [];
  for (let id = 0; id < n; id++)
    clients.push(new TaskClient(id, net, [initial]));
  for (const c of clients) await c.start();

  const inserted = new Set<string>(tokensIn(INITIAL));
  const removed = new Set<string>();
  // Emptying the trash deletes tasks for good, including text typed into
  // them at the same moment: tokens typed into a task that gets emptied may
  // be gone.
  const typedInto = new Map<string, string>();
  const emptied = new Set<string>();
  let counter = 0;
  const token = (c: TaskClient) => `tk${"abcd"[c.id]}${counter++}q`;

  for (let step = 0; step < steps; step++) {
    const c = pick(rng, clients);
    const tasks = c.tasks();
    const ids = tasks.map((t) => t.task_id);
    const label = `step ${step} c${c.id}`;
    const r = rng();
    try {
      if (r < 0.1 || ids.length === 0) {
        const tok = token(c);
        inserted.add(tok);
        c.mutate("create", () =>
          c.session.createTask({ desc: `new task ${tok}` }),
        );
        log.push(`${label}: create task with ${tok}`);
      } else if (r < 0.2) {
        const id = pick(rng, ids);
        c.open(id);
        log.push(`${label}: open ${id}`);
      } else if (r < 0.5) {
        if (c.editor == null || c.editor.closed) c.open(pick(rng, ids));
        const tok = token(c);
        inserted.add(tok);
        c.editor!.edit((value) => {
          const lines = value.split("\n");
          const i = Math.floor(rng() * lines.length);
          const words = lines[i].split(" ");
          words.splice(Math.floor(rng() * (words.length + 1)), 0, tok);
          lines[i] = words.join(" ");
          if (rng() < 0.15) lines.splice(i + 1, 0, `- item ${token(c)}`);
          return lines.join("\n");
        });
        for (const t of tokensIn(c.editor!.value)) {
          inserted.add(t);
          if (!typedInto.has(t)) typedInto.set(t, c.editor!.taskId);
        }
        log.push(`${label}: type ${tok} in ${c.editor!.taskId}`);
      } else if (r < 0.58) {
        const ed = c.editor;
        if (ed == null || ed.closed) continue;
        // A word within a line. (Deleting a line break while someone else
        // rewrites both lines is a structural conflict: both versions are
        // kept, as for rewrites of the same line; not tested here.)
        ed.edit((value) => {
          const lines = value.split("\n");
          const i = Math.floor(rng() * lines.length);
          const words = lines[i].split(" ");
          const j = Math.floor(rng() * words.length);
          for (const t of tokensIn(words[j] ?? "")) removed.add(t);
          words.splice(j, 1);
          lines[i] = words.join(" ");
          return lines.join("\n");
        });
        log.push(`${label}: delete a word in ${ed.taskId}`);
      } else if (r < 0.65) {
        c.editor?.close();
        c.editor = undefined;
        log.push(`${label}: close editor`);
      } else if (r < 0.72) {
        const t = pick(rng, tasks);
        c.mutate("trash", () =>
          c.session.updateTask(t.task_id, { deleted: !t.deleted }),
        );
        log.push(`${label}: ${t.deleted ? "undelete" : "delete"} ${t.task_id}`);
      } else if (r < 0.8) {
        const t = pick(rng, tasks);
        c.mutate("done", () => c.session.setDone(t.task_id, !t.done));
        log.push(`${label}: toggle done ${t.task_id}`);
      } else if (r < 0.88) {
        const id = pick(rng, ids);
        const position = Math.floor(rng() * 1000) / 100;
        c.mutate("move", () => c.session.updateTask(id, { position }));
        log.push(`${label}: move ${id} to ${position}`);
      } else if (r < 0.93) {
        const id = pick(rng, ids);
        const due_date = 1_900_000_000_000 + Math.floor(rng() * 1e6);
        c.mutate("due", () => c.session.updateTask(id, { due_date }));
        log.push(`${label}: due date of ${id}`);
      } else {
        // empty the trash
        const trash = tasks.filter((t) => t.deleted).map((t) => t.task_id);
        if (trash.length === 0) continue;
        for (const id of trash) {
          emptied.add(id);
          for (const t of tokensIn(c.desc(id) ?? "")) removed.add(t);
          if (c.editor?.taskId === id) {
            for (const t of tokensIn(c.editor.value)) removed.add(t);
          }
        }
        c.mutate("empty trash", () => c.session.removeTasks(trash));
        log.push(`${label}: empty trash ${trash.join(",")}`);
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
    jest.advanceTimersByTime(SAVE_DEBOUNCE_MS + 50);
    net.deliverDue(true);
    await Promise.resolve();
    jest.advanceTimersByTime(100);
    const after = clients.map((c) => c.syncdb.to_str()).join("\u0000");
    stable = before === after && net.pending() === 0 ? stable + 1 : 0;
  }

  const docs = clients.map((c) => c.syncdb.to_str());
  if (new Set(docs).size !== 1) problems.push("clients did not converge");
  const tasks = clients[0].tasks();
  for (const t of tasks) {
    if (typeof t.position !== "number" || typeof t.desc !== "string") {
      problems.push(`partial task ${JSON.stringify(t)}`);
    }
  }
  const all = tasks.map((t) => t.desc ?? "").join("\n");
  const counts = new Map<string, number>();
  for (const tok of tokensIn(all)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  for (const [tok, k] of counts) {
    if (k > 1)
      problems.push(
        `duplicated token ${tok} (x${k}, ${classify(tok, clients, false)})`,
      );
  }
  for (const tok of inserted) {
    const emptiedWith = emptied.has(typedInto.get(tok) ?? "");
    if (!removed.has(tok) && !emptiedWith && !counts.has(tok)) {
      problems.push(`lost token ${tok} (${classify(tok, clients, true)})`);
    }
  }
  for (const c of clients) {
    const ed = c.editor;
    if (ed != null && !ed.closed) {
      const desc = c.desc(ed.taskId);
      if (desc != null && desc !== ed.value) {
        problems.push(
          `c${c.id} editor for ${ed.taskId} does not show its description (editor ${JSON.stringify(ed.value)}, task ${JSON.stringify(desc)})`,
        );
      }
    }
  }
  if (process.env.FUZZ_VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(`seed ${seed}:\n${log.join("\n")}\n--- final ---\n${docs[0]}`);
  }
  for (const c of clients) c.syncdb.close();
  return problems;
}

// Seeds that found bugs; always run them as regression tests.
//  294 (60 steps): an editor merge's render request stayed open, so a later
//                  merge guessed an older baseline and duplicated text
const REGRESSION_SEEDS: { seed: number; steps: number }[] = [
  { seed: 294, steps: 60 },
];

describe("collaborative task list editing fuzz", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const cases = process.env.FUZZ_SEED
    ? []
    : REGRESSION_SEEDS.map(({ seed, steps }) => ({
        name: `regression seed ${seed} (${steps} steps)`,
        seed,
        steps,
      }));
  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
    cases.push({ name: `seed ${seed}`, seed, steps: STEPS });
  }
  for (const { name, seed, steps } of cases) {
    it(name, async () => {
      const problems = await runSession(seed, steps);
      if (problems.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`seed ${seed}: ${problems.join("; ")}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
