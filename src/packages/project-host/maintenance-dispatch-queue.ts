/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";

type Row = HostProjectMaintenanceSchedule;
interface Work {
  row: Row;
  observedAt: number;
  due: (row: Row) => string | null | undefined;
  run: (row: Row) => Promise<void>;
  waiters: { resolve: () => void; reject: (err: unknown) => void }[];
}

// One queue per host/lane. Arrivals join between operations, never by starting
// another lane or interrupting an admitted Btrfs mutation.
export class MaintenanceDispatchQueue {
  private readonly pending = new Map<string, Work>();
  private readonly active = new Map<string, Work>();
  private readonly servedAccounts = new Map<string, number>();
  private turn = 0;
  private paidSinceFree = 0;
  private concurrency = 1;

  submit({
    rows,
    observedAt,
    parallelism,
    due,
    run,
  }: {
    rows: Row[];
    observedAt: number;
    parallelism: number;
    due: Work["due"];
    run: Work["run"];
  }): Promise<void> {
    this.concurrency = Math.max(1, parallelism);
    const completions = rows.map(
      (row) =>
        new Promise<void>((resolve, reject) => {
          const running = this.active.get(row.project_id);
          const pending = this.pending.get(row.project_id);
          if (running && running.observedAt >= observedAt && !pending) {
            running.waiters.push({ resolve, reject });
            return;
          }
          if (pending) {
            if (observedAt >= pending.observedAt) {
              Object.assign(pending, { row, observedAt, due, run });
            }
            pending.waiters.push({ resolve, reject });
          } else {
            this.pending.set(row.project_id, {
              row,
              observedAt,
              due,
              run,
              waiters: [{ resolve, reject }],
            });
          }
        }),
    );
    this.pump();
    return Promise.all(completions).then(() => {});
  }

  private account(work: Work): string {
    return `${work.row.storage_service_class}:${work.row.storage_account_id || work.row.project_id}`;
  }

  private next(): Work | undefined {
    let paying: Work | undefined;
    let free: Work | undefined;
    const earlier = (a: Work, b: Work): boolean => {
      const aTurn = this.servedAccounts.get(this.account(a)) ?? -1;
      const bTurn = this.servedAccounts.get(this.account(b)) ?? -1;
      if (aTurn !== bTurn) return aTurn < bTurn;
      const time = (work: Work) => {
        const value = Date.parse(work.due(work.row) ?? "");
        return Number.isFinite(value) ? value : Infinity;
      };
      return (
        time(a) < time(b) ||
        (time(a) === time(b) &&
          ((a.row.storage_priority ?? 0) > (b.row.storage_priority ?? 0) ||
            ((a.row.storage_priority ?? 0) === (b.row.storage_priority ?? 0) &&
              a.row.project_id < b.row.project_id)))
      );
    };
    for (const work of this.pending.values()) {
      if (this.active.has(work.row.project_id)) continue;
      if (work.row.storage_service_class === "paying") {
        if (!paying || earlier(work, paying)) paying = work;
      } else if (!free || earlier(work, free)) free = work;
    }
    const next =
      free && (!paying || this.paidSinceFree >= 9) ? free : (paying ?? free);
    if (next) {
      this.paidSinceFree = next === paying ? this.paidSinceFree + 1 : 0;
      this.servedAccounts.set(this.account(next), this.turn++);
      this.pending.delete(next.row.project_id);
    }
    return next;
  }

  private pump(): void {
    while (this.active.size < this.concurrency) {
      const work = this.next();
      if (!work) break;
      this.active.set(work.row.project_id, work);
      void Promise.resolve()
        .then(() => work.run(work.row))
        .then(
          () => this.finish(work),
          (err) => this.finish(work, { err }),
        );
    }
  }

  private finish(work: Work, failure?: { err: unknown }): void {
    this.active.delete(work.row.project_id);
    if (!this.active.size && !this.pending.size) {
      this.servedAccounts.clear();
      this.turn = 0;
      this.paidSinceFree = 0;
    }
    this.pump();
    for (const waiter of work.waiters) {
      if (failure) waiter.reject(failure.err);
      else waiter.resolve();
    }
  }
}
