/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Admission of board edits on the project host (board stream design v4.5,
section 4). Nothing here knows what an edit is; the manager (a later step)
validates an edit with Sagebrush's editState, then submits it here with its
encoded size, and applies a commit's edits when this says to.

- Rates: per board, across all its clients (a burst of 20, then 5 a
  second), and per client (2 a second).
- Host-wide work: one bucket for the whole host, in milliseconds of
  estimated work, so that board edits stay under a quarter of one core. An
  edit is charged 0.23 ms + 0.34 ms/KiB of its encoded size when admitted,
  and a commit is charged the time its apply actually took. At most 64
  edits wait across the host, and at most 2 commits apply at once.
- Commits are coalesced: at most one every 250 ms per board, so history
  grows by at most 4 commits a second. A commit is at most 512 KiB. An edit
  goes into the pending commit if it fits, else into one next-commit slot
  (also at most 512 KiB), else it is refused; an edit over 512 KiB by itself
  is always refused. All of this happens before anything is applied, so an
  edit is never applied and then dropped.
- At a flush the commit's final encoding is measured, and if it is not a
  size within the cap the whole commit is refused before anything is
  applied.
- A commit's write has a deadline (commitTimeoutMs). One that doesn't settle
  by then is "unknown": its host slot is freed and its reservations consumed,
  so a write that never settles can't hold the host.
- Every duration and bucket uses one monotonic clock (the host's), never the
  wall clock, so a clock change can't stall or flood the buckets.
- Each admitted edit holds a reservation (a host queue slot and its work).
  It ends exactly once: consumed when its commit is applied, or released
  (its work refunded) when it is refused, cancelled or closed. A next-commit
  slot promoted to the pending commit keeps its reservations.
- An edit's outcome is known only when its commit's write is: "committed"
  after the write is acknowledged; "refused" if the commit was refused
  before or by the write; "unknown" if the write's outcome is not known (a
  timeout, a lost reply). Unknown is never reported as refused: the caller
  must reconcile by patch id before resubmitting (design section 5b).
*/

export const BOARD_ADMISSION = {
  boardBurst: 20,
  boardPerSecond: 5,
  clientBurst: 20,
  clientPerSecond: 2,
  maxCommitBytes: 512 * 1024,
  commitIntervalMs: 250,
  // A commit's write that hasn't settled by then is an unknown outcome.
  commitTimeoutMs: 30_000,
  hostMaxWaiting: 64,
  hostMaxApplying: 2,
  workBaseMs: 0.23,
  workPerKiBMs: 0.34,
  // A quarter of one core, with up to half a second of work at once.
  hostWorkPerSecondMs: 250,
  hostWorkBurstMs: 500,
  // Distinct clients remembered per board (each with its own bucket).
  maxClients: 256,
} as const;

export type AdmissionLimits = typeof BOARD_ADMISSION;

export type Refusal = {
  reason:
    | "too-large" // over the commit cap by itself, or the commit's encoding
    | "rate" // the board's or the client's rate
    | "host-busy" // the host's work budget or its queue
    | "board-busy" // the pending commit and the next-commit slot are full
    | "closed"
    | "write-refused"; // the write was refused (e.g. a cap)
  message: string;
  // ms until it may be sent again (rates and budgets)
  retryAfter?: number;
};

export type Outcome =
  | { status: "committed" }
  | ({ status: "refused" } & Refusal)
  | { status: "unknown"; message: string };

// Milliseconds on a monotonic clock.
type Clock = () => number;

const monotonic: Clock = () => performance.now();

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    now: number,
  ) {
    if (!(burst > 0) || !(perSecond > 0)) {
      throw Error("a token bucket needs a positive burst and rate");
    }
    this.tokens = burst;
    this.last = now;
  }

  private refill(now: number): void {
    if (now < this.last) {
      // A clock that went back (only an injected one can): grant nothing,
      // and count from here.
      this.last = now;
    } else if (now > this.last) {
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.last) * this.perSecond) / 1000,
      );
      this.last = now;
    }
  }

  // ms until n tokens are available (0: now).
  wait(n: number, now: number): number {
    this.refill(now);
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) * 1000) / this.perSecond);
  }

  take(n: number, now: number): void {
    this.refill(now);
    this.tokens -= n;
  }

  give(n: number, now: number): void {
    this.refill(now);
    this.tokens = Math.min(this.burst, this.tokens + n);
  }
}

export function editWorkMs(
  bytes: number,
  limits: AdmissionLimits = BOARD_ADMISSION,
): number {
  return limits.workBaseMs + (limits.workPerKiBMs * bytes) / 1024;
}

// What an admitted edit holds on the host until its commit is applied.
export class Reservation {
  private done = false;

  constructor(
    private readonly host: HostAdmission,
    readonly workMs: number,
  ) {}

  // Its commit was applied: the work stays spent.
  consume(): void {
    if (this.done) return;
    this.done = true;
    this.host.end(this, false);
  }

  // Refused, cancelled or closed: the work is refunded.
  release(): void {
    if (this.done) return;
    this.done = true;
    this.host.end(this, true);
  }

  get ended(): boolean {
    return this.done;
  }
}

// The host-wide budget, shared by every board on the host.
export class HostAdmission {
  readonly limits: AdmissionLimits;
  // The one clock for the host and its boards.
  readonly now: Clock;
  private readonly work: TokenBucket;
  private waiting = 0;
  private applying = 0;
  private applyWaiters: (() => void)[] = [];

  constructor({
    limits = BOARD_ADMISSION,
    now = monotonic,
  }: { limits?: AdmissionLimits; now?: Clock } = {}) {
    this.limits = limits;
    this.now = now;
    this.work = new TokenBucket(
      limits.hostWorkBurstMs,
      limits.hostWorkPerSecondMs,
      now(),
    );
  }

  get stats() {
    return { waiting: this.waiting, applying: this.applying };
  }

  // A reservation for an edit of this many encoded bytes, or why not.
  reserve(bytes: number): Reservation | Refusal {
    if (this.waiting >= this.limits.hostMaxWaiting) {
      return {
        reason: "host-busy",
        message: "the host is busy; send the edit again",
        retryAfter: this.limits.commitIntervalMs,
      };
    }
    const workMs = editWorkMs(bytes, this.limits);
    const now = this.now();
    const wait = this.work.wait(workMs, now);
    if (wait > 0) {
      return {
        reason: "host-busy",
        message: "the host is busy; send the edit again",
        retryAfter: wait,
      };
    }
    this.work.take(workMs, now);
    this.waiting += 1;
    return new Reservation(this, workMs);
  }

  // Only Reservation calls this, exactly once per reservation.
  end(reservation: Reservation, refund: boolean): void {
    this.waiting -= 1;
    if (refund) this.work.give(reservation.workMs, this.now());
  }

  // Wait for one of the host's commit slots; call the returned function
  // when the apply is done, with the time it took.
  async startApply(): Promise<(elapsedMs: number) => void> {
    while (this.applying >= this.limits.hostMaxApplying) {
      await new Promise<void>((resolve) => this.applyWaiters.push(resolve));
    }
    this.applying += 1;
    let ended = false;
    return (elapsedMs: number) => {
      if (ended) return;
      ended = true;
      this.applying -= 1;
      // Charged after the fact: the bucket may go below zero, which holds
      // later edits back until it refills.
      if (elapsedMs > 0) this.work.take(elapsedMs, this.now());
      this.applyWaiters.shift()?.();
    };
  }
}

// The write of a commit: acknowledged, refused, or not known.
export type CommitResult =
  | { status: "acknowledged" }
  | { status: "refused"; message: string }
  | { status: "unknown"; message: string };

export interface BoardAdmissionOptions<E> {
  host: HostAdmission;
  // The encoded size of a commit of these edits, envelope included: the
  // final check before anything is applied.
  measure: (edits: E[]) => number;
  // Apply these edits as one commit and write it. A throw, or no result
  // within commitTimeoutMs, is an unknown outcome, never a refusal; the
  // write may still complete after that, so the caller reconciles by patch
  // id before resubmitting.
  commit: (edits: E[]) => Promise<CommitResult>;
  log?: (message: string, extra?: object) => void;
}

interface Waiting<E> {
  edit: E;
  bytes: number;
  reservation: Reservation;
  resolve: (outcome: Outcome) => void;
}

interface Batch<E> {
  items: Waiting<E>[];
  bytes: number;
}

// One board's admission and commit coalescing.
export class BoardAdmission<E> {
  private readonly host: HostAdmission;
  private readonly limits: AdmissionLimits;
  private readonly measure: (edits: E[]) => number;
  private readonly commitEdits: (edits: E[]) => Promise<CommitResult>;
  private readonly now: Clock;
  private readonly log: (message: string, extra?: object) => void;
  private readonly board: TokenBucket;
  private readonly clients = new Map<string, TokenBucket>();
  private pending: Batch<E> = { items: [], bytes: 0 };
  private next: Batch<E> = { items: [], bytes: 0 };
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastCommitStart = -Infinity;
  private closed = false;
  private idleWaiters: (() => void)[] = [];

  constructor(opts: BoardAdmissionOptions<E>) {
    this.host = opts.host;
    this.limits = opts.host.limits;
    this.measure = opts.measure;
    this.commitEdits = opts.commit;
    this.now = opts.host.now;
    this.log = opts.log ?? (() => {});
    this.board = new TokenBucket(
      this.limits.boardBurst,
      this.limits.boardPerSecond,
      this.now(),
    );
  }

  get stats() {
    return {
      pending: this.pending.items.length,
      pendingBytes: this.pending.bytes,
      next: this.next.items.length,
      nextBytes: this.next.bytes,
      flushing: this.flushing,
    };
  }

  // Submit an edit of this many encoded bytes. Resolves with its outcome:
  // refusals at once, otherwise when its commit's write is known.
  submit(clientId: string, edit: E, bytes: number): Promise<Outcome> {
    const refused = (r: Refusal): Promise<Outcome> =>
      Promise.resolve({ status: "refused", ...r });
    if (this.closed) {
      return refused({ reason: "closed", message: "the board is closed" });
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw Error("an edit's size must be a non-negative integer");
    }
    if (bytes > this.limits.maxCommitBytes) {
      return refused({
        reason: "too-large",
        message: `the edit is ${bytes} bytes, over the ${this.limits.maxCommitBytes} one edit may be`,
      });
    }
    // Where it would go, before anything is charged.
    const target =
      this.pending.bytes + bytes <= this.limits.maxCommitBytes
        ? this.pending
        : this.next.bytes + bytes <= this.limits.maxCommitBytes
          ? this.next
          : undefined;
    if (target === undefined) {
      return refused({
        reason: "board-busy",
        message: "the board is busy; send the edit again",
        retryAfter: this.limits.commitIntervalMs,
      });
    }
    const now = this.now();
    const client = this.clientBucket(clientId, now);
    const wait = Math.max(this.board.wait(1, now), client?.wait(1, now) ?? 0);
    if (client === undefined) {
      return refused({
        reason: "rate",
        message: "too many people are editing this board; try again soon",
        retryAfter: 1000,
      });
    }
    if (wait > 0) {
      return refused({
        reason: "rate",
        message: "too many edits; send the edit again",
        retryAfter: wait,
      });
    }
    const reservation = this.host.reserve(bytes);
    if (!(reservation instanceof Reservation)) return refused(reservation);
    this.board.take(1, now);
    client.take(1, now);
    return new Promise<Outcome>((resolve) => {
      target.items.push({ edit, bytes, reservation, resolve });
      target.bytes += bytes;
      this.schedule();
    });
  }

  // Refuse everything waiting, and resolve when no commit is applying.
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (this.timer != null) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      for (const batch of [this.pending, this.next]) {
        this.finish(batch.items, {
          status: "refused",
          reason: "closed",
          message: "the board was closed",
        });
      }
      this.pending = { items: [], bytes: 0 };
      this.next = { items: [], bytes: 0 };
    }
    while (this.flushing) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  // A client's bucket; undefined if the board already has too many clients.
  private clientBucket(clientId: string, now: number): TokenBucket | undefined {
    let bucket = this.clients.get(clientId);
    if (bucket === undefined) {
      if (this.clients.size >= this.limits.maxClients) {
        // Forget clients whose buckets are full again: they lose nothing.
        for (const [id, b] of this.clients) {
          if (b.wait(this.limits.clientBurst, now) === 0)
            this.clients.delete(id);
        }
        if (this.clients.size >= this.limits.maxClients) return;
      }
      bucket = new TokenBucket(
        this.limits.clientBurst,
        this.limits.clientPerSecond,
        now,
      );
      this.clients.set(clientId, bucket);
    }
    return bucket;
  }

  private schedule(): void {
    if (this.closed || this.flushing || this.timer != null) return;
    if (this.pending.items.length === 0) return;
    // At most one interval, even if an injected clock went back.
    const delay = Math.min(
      this.limits.commitIntervalMs,
      Math.max(
        0,
        this.lastCommitStart + this.limits.commitIntervalMs - this.now(),
      ),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    (this.timer as any).unref?.();
  }

  private async flush(): Promise<void> {
    if (this.closed || this.flushing || this.pending.items.length === 0) return;
    this.flushing = true;
    const batch = this.pending;
    // The next-commit slot becomes the pending commit, keeping its
    // reservations.
    this.pending = this.next;
    this.next = { items: [], bytes: 0 };
    try {
      await this.apply(batch);
    } finally {
      this.flushing = false;
      for (const f of this.idleWaiters.splice(0)) f();
      this.schedule();
    }
  }

  private async apply(batch: Batch<E>): Promise<void> {
    const edits = batch.items.map((w) => w.edit);
    let encoded: number;
    try {
      encoded = this.measure(edits);
    } catch (err) {
      this.finish(batch.items, {
        status: "refused",
        reason: "too-large",
        message: `the commit could not be encoded: ${err}`.slice(0, 500),
      });
      return;
    }
    if (
      !Number.isSafeInteger(encoded) ||
      encoded < 0 ||
      encoded > this.limits.maxCommitBytes
    ) {
      // Nothing has been applied: refuse the whole commit.
      this.finish(batch.items, {
        status: "refused",
        reason: "too-large",
        message: `the commit is ${encoded} bytes encoded, over the ${this.limits.maxCommitBytes} a commit may be`,
      });
      return;
    }
    const done = await this.host.startApply();
    if (this.closed) {
      // Closed while waiting for a slot: nothing has been applied.
      done(0);
      this.finish(batch.items, {
        status: "refused",
        reason: "closed",
        message: "the board was closed",
      });
      return;
    }
    const start = this.now();
    this.lastCommitStart = start;
    let result: CommitResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        this.commitEdits(edits),
        new Promise<CommitResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: "unknown",
                message: `the write did not finish in ${this.limits.commitTimeoutMs} ms`,
              }),
            this.limits.commitTimeoutMs,
          );
        }),
      ]);
    } catch (err) {
      result = { status: "unknown", message: `${err}`.slice(0, 500) };
    } finally {
      if (timer != null) clearTimeout(timer);
      done(Math.max(0, this.now() - start));
    }
    if (result.status === "acknowledged") {
      for (const w of batch.items) w.reservation.consume();
      for (const w of batch.items) w.resolve({ status: "committed" });
    } else if (result.status === "refused") {
      this.finish(batch.items, {
        status: "refused",
        reason: "write-refused",
        message: result.message,
      });
    } else {
      // The write may have been stored: the work was done either way.
      this.log("board: a commit's outcome is unknown", {
        message: result.message,
      });
      for (const w of batch.items) w.reservation.consume();
      for (const w of batch.items) {
        w.resolve({ status: "unknown", message: result.message });
      }
    }
  }

  private finish(items: Waiting<E>[], outcome: Outcome): void {
    for (const w of items) w.reservation.release();
    for (const w of items) w.resolve(outcome);
  }
}
