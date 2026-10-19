/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The open boards on this host, keyed by project and path, at most one
manager each.

A board's entry is "open" from its first boardOpen until its lease runs out
(or its file goes away), then "closing" until its manager and syncdb are
completely done: its final save, its syncdb's close, and any step of the
manager that outlived a timeout. A closing entry stays in the map, counted
against maxOpen and blocking the key: a boardOpen for that board waits for
it (up to takeoverWaitMs, then fails, to be retried), so a board never has
two managers here. Writes are also conditional in storage (each replaces
the file only if it is still the text its manager last saw, and keeps any
other version), so even a manager elsewhere that outlived its turn cannot
write over a later owner's save.

Starting and closing are bounded by timeouts for the caller; the slot
stays taken until the work behind them really ends.
*/

import type { BoardStatus } from "./manager";

export interface BoardManagerLike {
  getStatus(): BoardStatus;
  isRetired(): boolean;
  save(): Promise<void>;
  close(): Promise<void>;
  revoke(): void;
  settled(): Promise<void>;
  // Call f when the manager retires (its file went away, or its document
  // grew too large): its board is then closed at once.
  onRetire?(f: () => void): void;
}

export interface StartedBoard {
  manager: BoardManagerLike;
  // Close the board's syncdb.
  close(): Promise<void>;
}

// Start a board's manager: resolves once it has loaded, or rejects after
// cleaning up whatever it started.
export type StartBoard = () => Promise<StartedBoard>;

export interface BoardRegistryOptions {
  leaseMs?: number;
  sweepMs?: number;
  maxOpen?: number;
  // At most this many entries per group (a key's part before its first
  // ":", the project), so one project cannot take every slot.
  maxPerGroup?: number;
  // The open boards' bytes (each its reservation or its current size,
  // whichever is larger) never exceed this: a board that would take the
  // total over it does not start.
  maxTotalBytes?: number;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  takeoverWaitMs?: number;
  log?: (message: string, extra?: object) => void;
}

interface Entry {
  key: string;
  path: string;
  state: "open" | "closing";
  lastSeen: number;
  ready: Promise<StartedBoard>;
  started?: StartedBoard;
  // Bytes reserved at admission (the file's size then), held through
  // start and close.
  reserved: number;
  // Settles when everything the entry started has ended.
  closed?: Promise<void>;
}

function groupOf(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
}

export class TimeoutError extends Error {
  code = "ETIMEDOUT";
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`${what} timed out after ${ms} ms`)),
          ms,
        );
        (timer as any).unref?.();
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export class BoardRegistry {
  readonly leaseMs: number;
  private readonly sweepMs: number;
  private readonly maxOpen: number;
  private readonly maxPerGroup: number;
  private readonly maxTotalBytes: number;
  private readonly startTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly takeoverWaitMs: number;
  private readonly log: (message: string, extra?: object) => void;
  private readonly boards = new Map<string, Entry>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(opts: BoardRegistryOptions) {
    this.leaseMs = opts.leaseMs ?? 90_000;
    this.sweepMs = opts.sweepMs ?? 30_000;
    this.maxOpen = opts.maxOpen ?? 200;
    this.maxPerGroup = opts.maxPerGroup ?? 20;
    this.maxTotalBytes = opts.maxTotalBytes ?? 256 * 1024 * 1024;
    this.startTimeoutMs = opts.startTimeoutMs ?? 60_000;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 30_000;
    this.takeoverWaitMs = opts.takeoverWaitMs ?? 15_000;
    this.log = opts.log ?? (() => {});
  }

  // Entries open or closing: what counts against maxOpen.
  size(): number {
    return this.boards.size;
  }

  has(key: string): boolean {
    return this.boards.has(key);
  }

  // The board's manager, started with start if need be, with its lease
  // renewed.
  // reserveBytes: what the board will hold once loaded (its file's size),
  // charged against maxTotalBytes from admission.
  async open(
    key: string,
    path: string,
    start: StartBoard,
    reserveBytes = 0,
  ): Promise<BoardManagerLike> {
    for (;;) {
      const entry = await this.entryFor(key, path, start, reserveBytes);
      let started: StartedBoard;
      try {
        started = await withTimeout(
          entry.ready,
          this.startTimeoutMs,
          `starting board ${path}`,
        );
      } catch (err) {
        void this.stop(entry);
        throw err;
      }
      if (entry.state === "open" && !started.manager.isRetired()) {
        entry.lastSeen = Date.now();
        return started.manager;
      }
      // Its file went away (or it began closing): a new manager reports
      // that, and loads the file if it comes back.
      await this.waitClosed(this.stop(entry), path);
    }
  }

  private async entryFor(
    key: string,
    path: string,
    start: StartBoard,
    reserveBytes: number,
  ): Promise<Entry> {
    for (;;) {
      const entry = this.boards.get(key);
      if (entry?.state === "open") return entry;
      if (entry?.state === "closing") {
        await this.waitClosed(entry.closed!, path);
        continue;
      }
      this.admit(key, reserveBytes);
      const created: Entry = {
        key,
        path,
        state: "open",
        lastSeen: Date.now(),
        reserved: reserveBytes,
        ready: start(),
      };
      created.ready.then(
        (started) => {
          created.started = started;
          started.manager.onRetire?.(() => void this.stop(created));
        },
        () => {},
      );
      this.boards.set(key, created);
      this.ensureSweeper();
      return created;
    }
  }

  // Bytes an entry is charged: its reservation, or what its board holds now
  // if that is more. Starting and closing entries keep their reservation.
  private charged(entry: Entry): number {
    const status = entry.started?.manager.getStatus();
    const bytes =
      status?.state === "ok" || status?.state === "too-large"
        ? (status.bytes ?? 0)
        : 0;
    return Math.max(entry.reserved, bytes);
  }

  // Bytes charged to all entries.
  chargedBytes(): number {
    let bytes = 0;
    for (const entry of this.boards.values()) bytes += this.charged(entry);
    return bytes;
  }

  // Refuse a new entry over the limits, counting it. Open, starting and
  // closing entries all count.
  private admit(key: string, reserveBytes: number): void {
    if (this.boards.size >= this.maxOpen) {
      throw Error(`too many open boards on this host (${this.maxOpen})`);
    }
    const group = groupOf(key);
    let inGroup = 0;
    let bytes = 0;
    for (const entry of this.boards.values()) {
      if (groupOf(entry.key) === group) inGroup += 1;
      bytes += this.charged(entry);
    }
    if (inGroup >= this.maxPerGroup) {
      throw Error(`too many open boards in this project (${this.maxPerGroup})`);
    }
    if (bytes + reserveBytes > this.maxTotalBytes) {
      throw Error(
        `the open boards on this host are too large (${bytes} bytes); try again later`,
      );
    }
  }

  private async waitClosed(closed: Promise<void>, path: string) {
    try {
      await withTimeout(closed, this.takeoverWaitMs, `closing board ${path}`);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw Error(`board ${path} is still closing; try again`);
      }
      throw err;
    }
  }

  // Close an entry: a final save, then its syncdb. It stays in the map
  // (closing) until all its work has ended.
  stop(entry: Entry): Promise<void> {
    if (entry.closed != null) return entry.closed;
    entry.state = "closing";
    const done = this.closeEntry(entry).finally(() => {
      if (this.boards.get(entry.key) === entry) this.boards.delete(entry.key);
      this.maybeStopSweeper();
    });
    entry.closed = done;
    return done;
  }

  private async closeEntry(entry: Entry): Promise<void> {
    let started: StartedBoard;
    try {
      // However long it takes: a start that never ends keeps its slot.
      started = await entry.ready;
    } catch {
      return; // the start cleaned up after itself
    }
    const { manager } = started;
    try {
      await withTimeout(
        manager.close(),
        this.closeTimeoutMs,
        `final save of ${entry.path}`,
      );
    } catch (err) {
      this.log("board: final save failed; revoking the manager", {
        path: entry.path,
        err: `${err}`,
      });
      manager.revoke();
    }
    const closing = started.close();
    try {
      await withTimeout(
        closing,
        this.closeTimeoutMs,
        `closing the syncdb of ${entry.path}`,
      );
    } catch (err) {
      // Only reported: the slot stays taken until the close ends.
      this.log("board: closing the syncdb is slow or failed", {
        path: entry.path,
        err: `${err}`,
      });
    }
    // Whatever outlived a timeout above (the syncdb's close, a held write)
    // ends before the slot is free.
    await closing.catch(() => {});
    await manager.settled();
  }

  // Stop the boards whose lease has run out.
  sweep(now = Date.now()): void {
    for (const entry of [...this.boards.values()]) {
      if (entry.state === "open" && now - entry.lastSeen > this.leaseMs) {
        void this.stop(entry);
      }
    }
    this.maybeStopSweeper();
  }

  // Stop every board, or those whose key starts with prefix.
  async closeAll(prefix = ""): Promise<void> {
    await Promise.all(
      [...this.boards.values()]
        .filter((entry) => entry.key.startsWith(prefix))
        .map((entry) => this.stop(entry)),
    );
  }

  private ensureSweeper(): void {
    if (this.sweeper != null) return;
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs);
    (this.sweeper as any).unref?.();
  }

  private maybeStopSweeper(): void {
    if (this.boards.size === 0 && this.sweeper != null) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }
}
