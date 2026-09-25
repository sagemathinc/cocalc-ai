/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ComputeWorkLease {
  id: string;
  worker_id: string;
  attempt: number;
  lost: boolean;
  completed: boolean;
}

const storage = new AsyncLocalStorage<ComputeWorkLease>();

export class ComputeWorkLeaseLostError extends Error {
  constructor() {
    super("Managed compute work lease was lost.");
    this.name = "ComputeWorkLeaseLostError";
  }
}

export function currentComputeWorkLease(): ComputeWorkLease | undefined {
  return storage.getStore();
}

export function markCurrentComputeWorkLeaseLost(): void {
  const lease = storage.getStore();
  if (lease) lease.lost = true;
}

export function markCurrentComputeWorkLeaseCompleted(): void {
  const lease = storage.getStore();
  if (lease) lease.completed = true;
}

export async function runWithComputeWorkLease<T>(
  lease: Omit<ComputeWorkLease, "lost" | "completed">,
  fn: () => Promise<T>,
): Promise<T> {
  return await storage.run({ ...lease, lost: false, completed: false }, fn);
}

export function requireCurrentComputeWorkLease(): ComputeWorkLease | undefined {
  const lease = storage.getStore();
  if (lease?.lost) throw new ComputeWorkLeaseLostError();
  // Completion releases the queue generation; it must never disable fencing
  // for later resource writes in the same async context.
  if (lease?.completed) throw new ComputeWorkLeaseLostError();
  return lease;
}

export function computeWorkLeaseSql(firstParameter: number): {
  cte: string;
  clause: string;
  values: unknown[];
} {
  const lease = requireCurrentComputeWorkLease();
  if (!lease) return { cte: "", clause: "", values: [] };
  return {
    cte: `WITH renewed_compute_work_lease AS (
      UPDATE compute_resource_work
         SET locked_at=NOW(), updated_at=NOW()
       WHERE id=$${firstParameter}
         AND state='in_progress'
         AND locked_by=$${firstParameter + 1}
         AND attempt=$${firstParameter + 2}
       RETURNING 1
    )`,
    clause: " AND EXISTS (SELECT 1 FROM renewed_compute_work_lease)",
    values: [lease.id, lease.worker_id, lease.attempt],
  };
}

export function requireFencedResourceUpdate<T>(
  row: T | undefined,
): T | undefined {
  if (row || !currentComputeWorkLease()) return row;
  markCurrentComputeWorkLeaseLost();
  throw new ComputeWorkLeaseLostError();
}
