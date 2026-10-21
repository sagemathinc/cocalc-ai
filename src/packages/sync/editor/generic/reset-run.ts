/*
The bounds every automatic or confirmed history reset of a backend runs
under (bounded history plan H1b-3 r4 §2.1-2.2, H1b-4 r3 §2): shared by the
restart of a notebook from its .ipynb and the live-writer seed (jupyter), and
by the rebuild of a board from its .board.json (project-host).

- One run per document at a time (the run slot), taken before any read or
  build.  It is released only when every operation the run started has
  settled, not at the run's deadline (LIMIT-H1B3B-1): the deadline only ends
  the caller's wait, so a retry never starts work beside abandoned work.
- At most one unresolved reset per document (the gate): set right before a
  reset is sent, cleared only by that reset's own answer (matching opId), or
  by an observation that the history moved past it.
- One overall deadline per run; every wait gets only what remains of it.

In-process state; the persist server's own reset slot (H1b-3a) bounds what
survives a restart of this process.
*/

export interface ResetGate {
  opId: string;
  epoch: number;
  revision: { seq: number; count: number };
  // when this process last asked the history whether it moved
  observedAt: number;
}

const runs = new Set<string>();
const gates = new Map<string, ResetGate>();

// for tests
export function resetRunState(): void {
  runs.clear();
  gates.clear();
}

// whether a run for this document is still doing (or waiting on) work
export function runInProgress(key: string): boolean {
  return runs.has(key);
}

export function unresolvedReset(key: string): ResetGate | undefined {
  return gates.get(key);
}

export function hasUnresolvedReset(key: string): boolean {
  return gates.has(key);
}

// Right before a reset is sent: false if another one is unresolved.
export function setUnresolvedReset(key: string, gate: ResetGate): boolean {
  if (gates.has(key)) return false;
  gates.set(key, gate);
  return true;
}

// A reset answered: clear the gate, but only if it is this reset's (a late
// answer to an older reset must not clear a newer gate).
export function resolveGate(key: string, opId: string): void {
  if (gates.get(key)?.opId === opId) gates.delete(key);
}

export function isNonnegativeSafeInteger(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

let encoder: TextEncoder | undefined;
export function utf8Bytes(s: string): number {
  encoder ??= new TextEncoder();
  return encoder.encode(s).length;
}

export class DeadlineExpired extends Error {}

// p, or DeadlineExpired once deadlineAt has passed (p is not cancelled: the
// run slot waits for it, see startRun).
export function withDeadline<T>(
  deadlineAt: number,
  p: Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    p.catch(() => {});
    return Promise.reject(new DeadlineExpired());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExpired()), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface Run {
  deadlineAt: number;
  // every operation the run starts: the slot waits for them to settle
  track: <T>(p: Promise<T>) => Promise<T>;
  // the run is done (answered); the slot is released once everything it
  // started settled, then onSettled runs
  finish: (onSettled?: () => void) => void;
}

// The document's run slot, or undefined if a run holds it (busy).
export function startRun(
  key: string,
  { deadlineMs, now = Date.now }: { deadlineMs: number; now?: () => number },
): Run | undefined {
  if (runs.has(key)) return undefined;
  runs.add(key);
  const started: Promise<unknown>[] = [];
  return {
    deadlineAt: now() + deadlineMs,
    track: <T>(p: Promise<T>): Promise<T> => {
      started.push(p);
      return p;
    },
    finish: (onSettled) => {
      void Promise.allSettled(started).then(() => {
        try {
          onSettled?.();
        } finally {
          runs.delete(key);
        }
      });
    },
  };
}

// While a reset is unresolved, no other one is sent.  It is resolved by its
// own answer (resolveGate), or here by an observation: the epoch moved past
// it (it, or another reset, applied), or the revision moved in its epoch (its
// ifRevision can no longer hold).  Observed at most every observeMs.
export async function gateAllowsReset({
  key,
  readState,
  deadlineAt,
  observeMs,
  now = Date.now,
  track = (p) => p,
}: {
  key: string;
  readState: () => Promise<{ epoch: number; seq: number; count: number }>;
  deadlineAt: number;
  observeMs: number;
  now?: () => number;
  track?: <T>(p: Promise<T>) => Promise<T>;
}): Promise<boolean> {
  const gate = gates.get(key);
  if (gate == null) return true;
  if (now() - gate.observedAt < observeMs) return false;
  gate.observedAt = now();
  const state = await withDeadline(deadlineAt, track(readState()), now);
  if (gates.get(key) !== gate) {
    // its answer came meanwhile
    return !gates.has(key);
  }
  if (
    state.epoch > gate.epoch ||
    (state.epoch == gate.epoch &&
      (state.seq != gate.revision.seq || state.count != gate.revision.count))
  ) {
    gates.delete(key);
    return true;
  }
  return false;
}
