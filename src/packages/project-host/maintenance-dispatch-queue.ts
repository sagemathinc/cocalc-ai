/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";

type Row = HostProjectMaintenanceSchedule;

/** Returned by an operation that was refused before it changed anything, for
 * a reason that holds the whole lane (a project start, emergency I/O): the
 * same work goes back to its place in the queue and the lane parks. */
export interface MaintenanceRequeue {
  requeue: string;
}

type RunResult = void | "deferred" | MaintenanceRequeue;

interface Work {
  row: Row;
  observedAt: number;
  due: (row: Row) => string | null | undefined;
  // Resolves to "deferred" when storage admission refused the operation
  // before it did any work: that does not use up the account's turn.
  run: (row: Row, opts: { afterRunning: boolean }) => Promise<RunResult>;
  waiters: { resolve: () => void; reject: (err: unknown) => void }[];
  // Reports a failure that no waiter observes (detached submissions).
  onError?: (err: unknown, row: Row) => void;
  // Submitted while an operation for the same project was running, so the row
  // predates that operation's result and must be re-read before use.
  afterRunning?: boolean;
  // The account turn this work took when dispatched, to give back if refused.
  served?: {
    account: string;
    turn: number;
    dispatch: Dispatch;
  };
}

// One dispatch, for the paid/free interleave (see paidSinceFree).
interface Dispatch {
  paying: boolean;
  // Refused or requeued: it did not use up a paid or free slot.
  given_back: boolean;
}

// Dispatches remembered for the interleave. Only "at least 9 paying since the
// last free" matters beyond this, so older history is not needed.
const DISPATCH_RING = 64;
const PAID_PER_FREE = 9;
const DEFAULT_PARK_POLL_MS = 5_000;

export interface MaintenanceDispatchQueueOptions {
  /** Why the lane may not start an operation now (a fixed token), checked
   * before each dispatch and while parked; undefined when it may. */
  parkCheck?: () => string | undefined;
  /** How often a parked lane checks again. */
  parkPollMs?: number;
  /** Max-age promotion: within its class (paying, or the rest), pending work
   * due at least this long ago goes first, oldest due first, regardless of
   * account turns. The paid/free interleave is unchanged, so promoted paying
   * work still leaves a free dispatch in every PAID_PER_FREE + 1. Off unless
   * set. */
  promoteAfterMs?: { paying: number; free: number };
  /** Whether this work may be promoted at all (e.g. not while it is in
   * failure backoff, whose retry time decides when it runs). */
  promotable?: (row: Row) => boolean;
  now?: () => number;
}

export interface MaintenanceDispatchQueueStatus {
  pending: number;
  active: number;
  parked: boolean;
  park_reason?: string;
  parked_ms_total: number;
  /** Operations put back in their place, by the reason they were refused. */
  requeued_total: Record<string, number>;
  /** The earliest due time (ms) among pending work, if any is pending. */
  oldest_pending_due_ms?: number;
  /** Pending work past its class's promote age (with promotion on). */
  promoted_pending: number;
  /** The most promoted pending items that belong to one account. */
  promoted_largest_account_count: number;
  /** Dispatches that went first by promotion, by class (refused ones too). */
  promoted_dispatched_total: { paying: number; free: number };
}

// One queue per host/lane. Arrivals join between operations, never by starting
// another lane or interrupting an admitted Btrfs mutation.
export class MaintenanceDispatchQueue {
  private readonly pending = new Map<string, Work>();
  private readonly active = new Map<string, Work>();
  // Each account's latest turn whose operation was not refused, and the
  // turns of its operations still running. Ordering uses the latest of both;
  // a refused operation only drops its running turn, in whatever order
  // concurrent operations finish.
  private readonly servedAccounts = new Map<string, number>();
  private readonly runningTurns = new Map<string, Set<number>>();
  private turn = 0;
  // Recent dispatches, oldest first (see paidSinceFree).
  private dispatches: Dispatch[] = [];
  private concurrency = 1;
  private readonly parkCheck?: () => string | undefined;
  private readonly parkPollMs: number;
  private readonly now: () => number;
  private parked?: { reason: string; since: number };
  private parkTimer?: ReturnType<typeof setInterval>;
  private parkedMsTotal = 0;
  private readonly requeuedTotal: Record<string, number> = {};
  private readonly promoteAfterMs?: { paying: number; free: number };
  private readonly promotable?: (row: Row) => boolean;
  private readonly promotedDispatched = { paying: 0, free: 0 };

  constructor(options: MaintenanceDispatchQueueOptions = {}) {
    this.parkCheck = options.parkCheck;
    this.parkPollMs = options.parkPollMs ?? DEFAULT_PARK_POLL_MS;
    this.promoteAfterMs = options.promoteAfterMs;
    this.promotable = options.promotable;
    this.now = options.now ?? Date.now;
  }

  pendingProjectIds(limit: number): string[] {
    const ids: string[] = [];
    for (const id of this.pending.keys()) {
      if (ids.length >= limit) break;
      ids.push(id);
    }
    return ids;
  }

  /** Whether this project waits in the queue, or runs now. */
  has(project_id: string): "pending" | "active" | undefined {
    if (this.active.has(project_id)) return "active";
    if (this.pending.has(project_id)) return "pending";
    return undefined;
  }

  status(): MaintenanceDispatchQueueStatus {
    const now = this.now();
    let oldest: number | undefined;
    let promotedPending = 0;
    const promotedByAccount = new Map<string, number>();
    for (const work of this.pending.values()) {
      const due = this.dueMs(work);
      if (Number.isFinite(due) && (oldest == null || due < oldest)) {
        oldest = due;
      }
      if (this.promoted(work, now)) {
        promotedPending += 1;
        const account = this.account(work);
        promotedByAccount.set(
          account,
          (promotedByAccount.get(account) ?? 0) + 1,
        );
      }
    }
    return {
      pending: this.pending.size,
      active: this.active.size,
      parked: this.parked != null,
      ...(this.parked ? { park_reason: this.parked.reason } : {}),
      parked_ms_total:
        this.parkedMsTotal +
        (this.parked ? Math.max(0, this.now() - this.parked.since) : 0),
      requeued_total: { ...this.requeuedTotal },
      ...(oldest != null ? { oldest_pending_due_ms: oldest } : {}),
      promoted_pending: promotedPending,
      promoted_largest_account_count: Math.max(
        0,
        ...promotedByAccount.values(),
      ),
      promoted_dispatched_total: { ...this.promotedDispatched },
    };
  }

  submit({
    rows,
    observedAt,
    parallelism,
    due,
    run,
    detach = false,
    onError,
  }: {
    rows: Row[];
    observedAt: number;
    parallelism: number;
    due: Work["due"];
    run: Work["run"];
    /**
     * Queue the rows without waiting for them. Repeated sweeps over a long
     * backlog would otherwise each hold a waiter on every pending row.
     */
    detach?: boolean;
    onError?: Work["onError"];
  }): Promise<void> {
    this.concurrency = Math.max(1, parallelism);
    const enqueue = (row: Row, waiter?: Work["waiters"][number]) => {
      const waiters = waiter ? [waiter] : [];
      const running = this.active.get(row.project_id);
      const pending = this.pending.get(row.project_id);
      if (running && running.observedAt >= observedAt && !pending) {
        running.waiters.push(...waiters);
        return;
      }
      if (pending) {
        if (observedAt >= pending.observedAt) {
          Object.assign(pending, { row, observedAt, due, run, onError });
        }
        if (running) pending.afterRunning = true;
        pending.waiters.push(...waiters);
      } else {
        this.pending.set(row.project_id, {
          row,
          observedAt,
          due,
          run,
          waiters,
          onError,
          afterRunning: running != null,
        });
      }
    };
    // While parked, nothing here can finish soon: queue the rows without a
    // waiter, so repeated submissions during a long park hold nothing.
    if (detach || this.parked) {
      for (const row of rows) enqueue(row);
      this.pump();
      return Promise.resolve();
    }
    const completions = rows.map(
      (row) =>
        new Promise<void>((resolve, reject) =>
          enqueue(row, { resolve, reject }),
        ),
    );
    this.pump();
    return Promise.all(completions).then(() => {});
  }

  private account(work: Work): string {
    return `${work.row.storage_service_class}:${work.row.storage_account_id || work.row.project_id}`;
  }

  // Paying dispatches since the last free one, not counting refused or
  // requeued ones: derived from the recent dispatches, so giving a slot back
  // is exact even when other operations were dispatched meanwhile. Beyond
  // the remembered dispatches, only "at least PAID_PER_FREE" matters.
  private paidSinceFree(): number {
    let count = 0;
    for (let i = this.dispatches.length - 1; i >= 0; i--) {
      const dispatch = this.dispatches[i];
      if (dispatch.given_back) continue;
      if (!dispatch.paying) return count;
      count += 1;
      if (count >= PAID_PER_FREE) return count;
    }
    // No free dispatch remembered: exact if nothing was forgotten.
    return this.dispatches.length < DISPATCH_RING ? count : PAID_PER_FREE;
  }

  private dueMs(work: Work): number {
    const value = Date.parse(work.due(work.row) ?? "");
    return Number.isFinite(value) ? value : Infinity;
  }

  private isPaying(work: Work): boolean {
    return work.row.storage_service_class === "paying";
  }

  // Past its class's promote age, and allowed to be promoted.
  private promoted(work: Work, now: number): boolean {
    if (!this.promoteAfterMs) return false;
    const due = this.dueMs(work);
    if (!Number.isFinite(due)) return false;
    const after = this.isPaying(work)
      ? this.promoteAfterMs.paying
      : this.promoteAfterMs.free;
    return now - due >= after && (this.promotable?.(work.row) ?? true);
  }

  private next(): Work | undefined {
    const now = this.now();
    let paying: Work | undefined;
    let free: Work | undefined;
    let payingPromoted: Work | undefined;
    let freePromoted: Work | undefined;
    const byDue = (a: Work, b: Work): boolean => {
      const aDue = this.dueMs(a);
      const bDue = this.dueMs(b);
      return (
        aDue < bDue ||
        (aDue === bDue &&
          ((a.row.storage_priority ?? 0) > (b.row.storage_priority ?? 0) ||
            ((a.row.storage_priority ?? 0) === (b.row.storage_priority ?? 0) &&
              a.row.project_id < b.row.project_id)))
      );
    };
    const earlier = (a: Work, b: Work): boolean => {
      const aTurn = this.accountTurn(this.account(a));
      const bTurn = this.accountTurn(this.account(b));
      if (aTurn !== bTurn) return aTurn < bTurn;
      return byDue(a, b);
    };
    for (const work of this.pending.values()) {
      if (this.active.has(work.row.project_id)) continue;
      // Promoted work ignores account turns: the oldest due goes first, so
      // its wait is bounded by how many promoted items are older.
      if (this.promoted(work, now)) {
        if (this.isPaying(work)) {
          if (!payingPromoted || byDue(work, payingPromoted)) {
            payingPromoted = work;
          }
        } else if (!freePromoted || byDue(work, freePromoted)) {
          freePromoted = work;
        }
      } else if (this.isPaying(work)) {
        if (!paying || earlier(work, paying)) paying = work;
      } else if (!free || earlier(work, free)) free = work;
    }
    paying = payingPromoted ?? paying;
    free = freePromoted ?? free;
    const next =
      free && (!paying || this.paidSinceFree() >= PAID_PER_FREE)
        ? free
        : (paying ?? free);
    if (next) {
      if (next === payingPromoted) this.promotedDispatched.paying += 1;
      else if (next === freePromoted) this.promotedDispatched.free += 1;
      const account = this.account(next);
      const dispatch: Dispatch = { paying: next === paying, given_back: false };
      this.dispatches.push(dispatch);
      if (this.dispatches.length > DISPATCH_RING) this.dispatches.shift();
      next.served = { account, turn: this.turn, dispatch };
      let running = this.runningTurns.get(account);
      if (!running) {
        running = new Set();
        this.runningTurns.set(account, running);
      }
      running.add(this.turn++);
      this.pending.delete(next.row.project_id);
    }
    return next;
  }

  private accountTurn(account: string): number {
    let turn = this.servedAccounts.get(account) ?? -1;
    for (const running of this.runningTurns.get(account) ?? []) {
      turn = Math.max(turn, running);
    }
    return turn;
  }

  // The operation finished. One refused by storage admission before it did
  // any work (e.g. in an I/O-gate recovery window) gives its account turn
  // back, so when the project returns it is not queued behind every account
  // served meanwhile, and its paid/free slot back.
  private settleTurn(work: Work, refused: boolean): void {
    const served = work.served;
    if (!served) return;
    work.served = undefined;
    const running = this.runningTurns.get(served.account);
    running?.delete(served.turn);
    if (running?.size === 0) this.runningTurns.delete(served.account);
    if (!refused) {
      this.servedAccounts.set(
        served.account,
        Math.max(this.servedAccounts.get(served.account) ?? -1, served.turn),
      );
    } else {
      served.dispatch.given_back = true;
    }
  }

  private pump(): void {
    while (!this.parked && this.active.size < this.concurrency) {
      if (this.pending.size === 0) break;
      const reason = this.parkCheck?.();
      if (reason) {
        this.park(reason);
        break;
      }
      const work = this.next();
      if (!work) break;
      this.active.set(work.row.project_id, work);
      void Promise.resolve()
        .then(() =>
          work.run(work.row, { afterRunning: work.afterRunning === true }),
        )
        .then(
          (result) => {
            if (result != null && typeof result === "object") {
              this.requeue(work, result.requeue);
              return;
            }
            this.settleTurn(work, result === "deferred");
            this.finish(work);
          },
          (err) => {
            this.settleTurn(work, false);
            this.finish(work, { err });
          },
        );
    }
  }

  // Put work refused before it changed anything back in its place, in one
  // synchronous step: the account turn and the paid/free slot it took are
  // given back, the same Work (row, observation, callbacks, waiters) is
  // pending again (merged with a newer submission for the project, if one
  // arrived meanwhile), no waiter is settled, and the lane parks.
  private requeue(work: Work, reason: string): void {
    this.settleTurn(work, true);
    this.active.delete(work.row.project_id);
    const newer = this.pending.get(work.row.project_id);
    if (newer) {
      // The newer submission keeps its newer row and callbacks; the waiters
      // of both wait for whichever operation runs.
      if (work.observedAt > newer.observedAt) {
        Object.assign(newer, {
          row: work.row,
          observedAt: work.observedAt,
          due: work.due,
          run: work.run,
          onError: work.onError,
        });
      }
      newer.waiters.push(...work.waiters);
    } else {
      // It may wait a while parked: read its row afresh when it runs again,
      // like work queued behind a running operation.
      work.afterRunning = true;
      this.pending.set(work.row.project_id, work);
    }
    this.requeuedTotal[reason] = (this.requeuedTotal[reason] ?? 0) + 1;
    this.park(reason);
    this.pump();
  }

  private park(reason: string): void {
    if (this.parked) return;
    this.parked = { reason, since: this.now() };
    // At least one interval, so a refusal that the cheap check cannot see
    // (a start that began after the last admission sample) is not retried in
    // a tight loop.
    this.parkTimer = setInterval(() => {
      if (!this.parkCheck?.()) this.resume();
    }, this.parkPollMs);
    this.parkTimer.unref?.();
  }

  private resume(): void {
    if (!this.parked) return;
    this.parkedMsTotal += Math.max(0, this.now() - this.parked.since);
    this.parked = undefined;
    clearInterval(this.parkTimer);
    this.parkTimer = undefined;
    this.pump();
  }

  /** Stop parking (for tests and shutdown); nothing pending is settled. */
  close(): void {
    clearInterval(this.parkTimer);
    this.parkTimer = undefined;
    this.parked = undefined;
  }

  private finish(work: Work, failure?: { err: unknown }): void {
    this.active.delete(work.row.project_id);
    if (!this.active.size && !this.pending.size) {
      this.servedAccounts.clear();
      this.runningTurns.clear();
      this.turn = 0;
      this.dispatches = [];
    }
    this.pump();
    if (failure && !work.waiters.length) work.onError?.(failure.err, work.row);
    for (const waiter of work.waiters) {
      if (failure) waiter.reject(failure.err);
      else waiter.resolve();
    }
  }
}
