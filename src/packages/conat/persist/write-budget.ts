/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The server-held per-owner write budget (finding 028 B-3a, DESIGN v1.21 §3.2.9,
vanta H3, @review H2).

Under synchronous=FULL every commit syncs, so the commit RATE a project can
drive is a host-wide cost (checkpoints and syncs on the shared main thread).
The per-stream `conf` limits can't bound it: they are per stream, unlimited by
default, and client-settable.  So the persist server holds ONE budget per
logical owner (a project id, or "host" for the bay/host/hub control streams),
summed over all of that owner's streams, as two token buckets: transactions
and bytes.

Committed-work accounting: a request is CHECKED against what the bucket would
have left after the charges of its batch so far, its charge is recorded
batch-locally when its savepoint is released, and the batch's charges move
into the bucket only after COMMIT returned OK.  A request that fails or is
rolled back, or any request of an aborted batch, spends nothing; a committed
one spends exactly once.  A charge larger than a bucket's burst (one big
message, e.g. a snapshot up to maxPersistMessageBytes) is admitted only when
that bucket is FULL and nothing else of the batch is pending; it then drives
the bucket into debt, and nothing more is admitted until it refills (ops3's
consult: otherwise such a write would be refused forever).  The sustained
rate is unchanged.  Every mutating transaction costs at least one
transaction token and max(its payload bytes, MIN_TXN_BYTES) bytes (a tiny
transaction still writes a WAL frame).  Over budget: a retryable
`rate_limited` error for that request only.

The rates are server settings (env), never client-settable.

"host" is NOT an aggregate ceiling: it is the owner of the host/hub/bay
control streams, whose budget is 10x a project's.  There is no host-wide
ceiling over all projects (ops0 3568).

The client side (persist/client.ts, ops0 3568): every request refused with
`rate_limited` is resent with DStream's backoff until its retry window has
passed, on every write path; a refused request was not applied, so a resend
never applies it twice.

Provisional numbers (ops0 3550/3551/3568; William decides on the card): a
project 200 txn/s, burst 10,000 txn (the only measured data point: a
synthetic 8-editor conflict test peaks at 485 txn/s for 15 s); 8 MiB/s,
burst 64 MiB.  The host owner 10x.
*/

import { ConatError } from "@cocalc/conat/core/client";

export const MIN_TXN_BYTES = 4096;

export interface BudgetLimits {
  txnPerSecond: number;
  txnBurst: number;
  bytesPerSecond: number;
  bytesBurst: number;
}

const MiB = 1024 * 1024;

function envNumber(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Provisional defaults (ops0 3568); every value is overridable.
export function projectBudgetLimits(): BudgetLimits {
  return {
    txnPerSecond: envNumber("COCALC_PERSIST_PROJECT_TXN_PER_SEC", 200),
    txnBurst: envNumber("COCALC_PERSIST_PROJECT_TXN_BURST", 10_000),
    bytesPerSecond: envNumber("COCALC_PERSIST_PROJECT_BYTES_PER_SEC", 8 * MiB),
    bytesBurst: envNumber("COCALC_PERSIST_PROJECT_BYTES_BURST", 64 * MiB),
  };
}

export function hostBudgetLimits(): BudgetLimits {
  return {
    txnPerSecond: envNumber("COCALC_PERSIST_HOST_TXN_PER_SEC", 2000),
    txnBurst: envNumber("COCALC_PERSIST_HOST_TXN_BURST", 100_000),
    bytesPerSecond: envNumber("COCALC_PERSIST_HOST_BYTES_PER_SEC", 64 * MiB),
    bytesBurst: envNumber("COCALC_PERSIST_HOST_BYTES_BURST", 512 * MiB),
  };
}

export interface Charge {
  txn: number;
  bytes: number;
}

export function chargeFor(payloadBytes: number): Charge {
  return { txn: 1, bytes: Math.max(MIN_TXN_BYTES, Math.ceil(payloadBytes)) };
}

class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  private refill(): void {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    }
    this.last = t;
  }
  available(): number {
    this.refill();
    return this.tokens;
  }
  static fits(b: Bucket, need: number, pending: number): boolean {
    const left = b.available() - pending;
    if (need <= b.burst) return left >= need;
    // larger than the burst: only from a full bucket, alone in its batch
    return pending === 0 && left >= b.burst;
  }
  take(n: number): void {
    this.refill();
    // committed work is always recorded, even past zero (it already happened)
    this.tokens -= n;
  }
}

export class OwnerBudget {
  private readonly txn: Bucket;
  private readonly bytes: Bucket;
  refused = 0;
  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.txn = new Bucket(limits.txnPerSecond, limits.txnBurst, now);
    this.bytes = new Bucket(limits.bytesPerSecond, limits.bytesBurst, now);
  }
  // would `charge` fit after `pending` (the batch's charges so far)?
  fits(charge: Charge, pending: Charge = { txn: 0, bytes: 0 }): boolean {
    return (
      Bucket.fits(this.txn, charge.txn, pending.txn) &&
      Bucket.fits(this.bytes, charge.bytes, pending.bytes)
    );
  }
  // after COMMIT returned OK
  commit(charge: Charge): void {
    if (charge.txn > 0) this.txn.take(charge.txn);
    if (charge.bytes > 0) this.bytes.take(charge.bytes);
  }
  snapshot(): { txn: number; bytes: number } {
    return { txn: this.txn.available(), bytes: this.bytes.available() };
  }
  // the same state as a new bucket
  isFull(): boolean {
    return this.txn.available() >= this.txn.burst && this.bytes.available() >= this.bytes.burst;
  }
}

const budgets = new Map<string, OwnerBudget>();
let clock: () => number = Date.now;

// SA 3351 A3: one bucket per owner ever seen would grow without bound; a
// FULL bucket is the same state as a new one, so full buckets are dropped
// (checked whenever the map has grown by SWEEP_EVERY since the last sweep).
const SWEEP_EVERY = 1000;
let sweepAt = SWEEP_EVERY;
export function sweepFullBudgets(): number {
  let dropped = 0;
  for (const [owner, b] of budgets) {
    if (b.isFull()) {
      budgets.delete(owner);
      dropped += 1;
    }
  }
  sweepAt = budgets.size + SWEEP_EVERY;
  return dropped;
}

export function budgetCount(): number {
  return budgets.size;
}

export function ownerBudget(owner: string): OwnerBudget {
  let b = budgets.get(owner);
  if (b == null) {
    if (budgets.size >= sweepAt) sweepFullBudgets();
    b = new OwnerBudget(
      owner === "host" ? hostBudgetLimits() : projectBudgetLimits(),
      clock,
    );
    budgets.set(owner, b);
  }
  return b;
}

export const budgetStats = { refused_total: 0 };

export function rateLimitedError(owner: string): ConatError {
  budgetStats.refused_total += 1;
  const b = budgets.get(owner);
  if (b != null) b.refused += 1;
  return new ConatError(
    "persist: this project is writing faster than its write budget allows; try again shortly",
    { code: "rate_limited" },
  );
}

// tests only
export function resetBudgetsForTests(now?: () => number): void {
  budgets.clear();
  sweepAt = SWEEP_EVERY;
  clock = now ?? Date.now;
  budgetStats.refused_total = 0;
}
