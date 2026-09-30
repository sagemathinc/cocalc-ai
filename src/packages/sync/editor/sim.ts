/*
Simulation of multi-client realtime sync, for headless collaboration fuzzers
(notebooks, tasks, whiteboards). See
src/.agents/harden-jupyter-collaborative-editing-plan-2026-09-30.md.

Clients run real patchflow Sessions and exchange patches over a seeded
simulated network with delays and reordering. SimSyncDB reproduces the
semantics of SyncDoc for db documents (local draft, commit, rebasing the
draft onto merged remote patches, throttled change events) with CoCalc's db
codec, including its exact three-way merge. Meant for tests only.
*/

import { EventEmitter } from "events";
import { debounce, throttle } from "lodash";
import { Session, type PatchEnvelope, type PatchStore } from "patchflow";
import { from_str } from "./db/doc";
import { dbMerge3 } from "./db/merge3";
import { rebaseLocalDocument } from "./generic/rebase-local-document";

export type Rng = () => number;

// Small deterministic PRNG so every failure is replayable from its seed.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];

// Fragments inserted by fuzzers carry unique tokens like "tka12q".
export const TOKEN_RE = /tk[a-z]\d+q/g;
export const tokensIn = (text: string): string[] => text.match(TOKEN_RE) ?? [];

export interface DbCodecOptions {
  primaryKeys: string[];
  stringCols: string[];
}

// The patchflow codec SyncDoc.buildPatchflowCodec builds for a db document,
// with the same exact merge. FUZZ_MERGE_PROBE reports merges that drop a
// token either side added, or have more copies of one than either side.
export function dbCodec(opts: DbCodecOptions) {
  const fromStr = (s: string) => from_str(s, opts.primaryKeys, opts.stringCols);
  const merge3 = dbMerge3<any>(fromStr, (d: any) => d.to_str(), opts);
  return {
    fromString: fromStr,
    toString: (d: any) => d.to_str(),
    applyPatch: (d: any, p: unknown) => d.apply_patch(p),
    applyPatchBatch: (d: any, ps: unknown[]) => d.apply_patch_batch(ps),
    makePatch: (a: any, b: any) => a.make_patch(b),
    merge3: (base: any, a: any, b: any, ancestors?: any[]) => {
      const out = merge3(base, a, b, ancestors);
      if (process.env.FUZZ_MERGE_PROBE) probeMerge(base, a, b, out);
      return out;
    },
  };
}

function probeMerge(base: any, a: any, b: any, out: any): void {
  const [s0, sa, sb, so] = [base, a, b, out].map((d) => d.to_str());
  const n = (text: string, tok: string) => text.split(tok).length - 1;
  for (const tok of new Set(tokensIn(`${sa}\n${sb}`))) {
    const report = (what: string) =>
      // eslint-disable-next-line no-console
      console.log(
        `PROBE merge ${what} ${tok}\n${JSON.stringify({ base: s0, a: sa, b: sb, out: so }, null, 1)}`,
      );
    if (n(so, tok) > Math.max(n(sa, tok), n(sb, tok))) report("duplicated");
    if (!s0.includes(tok) && !so.includes(tok)) report("dropped");
  }
}

interface InFlight {
  to: number;
  env: PatchEnvelope;
  deliverAt: number;
}

export class SimNetwork {
  private queue: InFlight[] = [];
  private receivers = new Map<number, (env: PatchEnvelope) => void>();
  public log: { from: number; env: PatchEnvelope }[] = [];

  constructor(
    private rng: Rng,
    private now: () => number,
    private maxDelayMs: number,
  ) {}

  register(id: number, onEnvelope: (env: PatchEnvelope) => void): void {
    this.receivers.set(id, onEnvelope);
  }

  send(from: number, env: PatchEnvelope): void {
    this.log.push({ from, env });
    for (const to of this.receivers.keys()) {
      if (to === from) continue;
      this.queue.push({
        to,
        env,
        deliverAt: this.now() + Math.floor(this.rng() * this.maxDelayMs),
      });
    }
  }

  pending(): number {
    return this.queue.length;
  }

  // Deliver messages that are due, in random order (patchflow must tolerate
  // reordering).
  deliverDue(all = false): number {
    const now = this.now();
    const due = this.queue.filter((m) => all || m.deliverAt <= now);
    this.queue = this.queue.filter((m) => !due.includes(m));
    for (let i = due.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [due[i], due[j]] = [due[j], due[i]];
    }
    for (const m of due) this.receivers.get(m.to)?.(m.env);
    return due.length;
  }
}

export class SimPatchStore implements PatchStore {
  private listeners: ((env: PatchEnvelope) => void)[] = [];
  constructor(
    private id: number,
    private net: SimNetwork,
    private initial: PatchEnvelope[],
  ) {
    net.register(id, (env) => {
      for (const fn of this.listeners) fn(env);
    });
  }
  async loadInitial() {
    return { patches: this.initial.slice() };
  }
  append(env: PatchEnvelope): void {
    this.net.send(this.id, env);
  }
  subscribe(fn: (env: PatchEnvelope) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }
}

// A patchflow Session for client `id` on the simulated network.
export async function simSession(opts: {
  id: number;
  net: SimNetwork;
  clock: () => number;
  initial: PatchEnvelope[];
  codec: ReturnType<typeof dbCodec>;
}): Promise<Session> {
  const session = new Session({
    codec: opts.codec,
    patchStore: new SimPatchStore(opts.id, opts.net, opts.initial),
    clock: opts.clock,
    userId: opts.id + 1,
    clientId: `client${opts.id}`,
  });
  await session.init();
  return session;
}

export interface Commit {
  before: string;
  after: string;
  source?: string;
}

// The subset of SyncDB that editors use, with the semantics of SyncDoc
// (sync/editor/generic/sync-doc.ts): set/delete edit a local draft and emit a
// debounced change; commit rebases the draft onto the committed document and
// commits it as a patch; merged remote patches rebase the draft and emit a
// change throttled by changeThrottle. Every commit is recorded with the label
// in `source`, for classifying fuzzer failures.
export class SimSyncDB extends EventEmitter {
  public project_id = "00000000-0000-4000-8000-000000000000";
  private doc: any;
  private last: any;
  private before_change: any;
  public commits: Commit[] = [];
  public source?: string;
  private emit_change: () => void;
  private emit_change_debounced: () => void;

  constructor(
    public session: Session,
    opts: { changeThrottle?: number } = {},
  ) {
    super();
    this.setMaxListeners(100);
    this.doc = session.getDocument();
    this.last = this.doc;
    this.emit_change_debounced = debounce(this.emitChangeNow, 0);
    this.emit_change =
      opts.changeThrottle != null
        ? throttle(this.emitChangeNow, opts.changeThrottle)
        : this.emitChangeNow;
    session.on("change", this.handlePatchflowChange);
  }

  // SyncDoc emits a change "from nothing to something" when ready, which
  // also sets the baseline later changes are computed against.
  emitInitialChange = (): void => this.emitChangeNow();

  private emitChangeNow = (): void => {
    this.emit("change", this.doc?.changes?.(this.before_change));
    this.before_change = this.doc;
  };

  private handlePatchflowChange = (committed: any): void => {
    const previous = this.doc;
    const next =
      previous == null
        ? committed
        : rebaseLocalDocument({ base: this.last, draft: previous, committed });
    this.last = committed;
    this.doc = next;
    if (previous != null && previous.is_equal(next)) return;
    this.emit("after-change");
    this.emit_change();
  };

  private set_doc(doc: any): void {
    if (doc.is_equal(this.doc)) return;
    this.doc = doc;
    this.emit_change_debounced();
  }

  set = (x: any): void => this.set_doc(this.doc.set(x));
  delete = (x?: any): void => this.set_doc(this.doc.delete(x));
  get = (x?: any): any => this.doc.get(x);
  get_one = (x?: any): any => this.doc.get_one?.(x);
  get_doc = (): any => this.doc;
  to_str = (): string => this.doc.to_str();

  commit = (): boolean => {
    const draft = this.doc;
    const current = this.session.getDocument() as any;
    const forceMerge = this.session.getHeads().length > 1;
    const next = rebaseLocalDocument({
      base: this.last,
      draft,
      committed: current,
    });
    this.doc = next;
    if (!forceMerge && current.is_equal(next)) return false;
    this.last = next;
    const before = current.to_str();
    this.session.commit(next);
    this.commits.push({ before, after: next.to_str(), source: this.source });
    return true;
  };

  // Label the commits `f` makes.
  run<T>(source: string, f: () => T): T {
    const prev = this.source;
    this.source = source;
    try {
      return f();
    } finally {
      this.source = prev;
    }
  }

  save = async (): Promise<void> => {};
  save_to_disk = async (): Promise<void> => {};
  wait_until_ready = async (): Promise<void> => {};
  get_state = (): string => "ready";
  isReady = (): boolean => true;
  isClosed = (): boolean => false;
  is_read_only = (): boolean => false;
  init_ipywidgets = (): void => {};
  in_undo_mode = (): boolean => false;
  undo = (): void => {};
  redo = (): void => {};
  has_uncommitted_changes = (): boolean => false;
  close = (): void => {
    this.session.close();
  };
}
