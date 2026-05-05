/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  getBackupExecutionLimit,
  getCachedBackupExecutionLimit,
} from "./backup-execution-limit";

const logger = getLogger("project-host:backup-queue");

let backupInFlight = 0;
const backupWaiters: Array<() => void> = [];
const backupProjectTails = new Map<string, Promise<void>>();

async function acquireBackupSlot(): Promise<void> {
  const { max_parallel } = await getBackupExecutionLimit();
  while (backupWaiters.length > 0 && backupInFlight < max_parallel) {
    backupInFlight += 1;
    backupWaiters.shift()?.();
  }
  if (backupInFlight < max_parallel) {
    backupInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    backupWaiters.push(() => {
      backupInFlight += 1;
      resolve();
    });
  });
}

function releaseBackupSlot() {
  backupInFlight = Math.max(0, backupInFlight - 1);
  const { max_parallel } = getCachedBackupExecutionLimit();
  while (backupWaiters.length > 0 && backupInFlight < max_parallel) {
    backupInFlight += 1;
    backupWaiters.shift()?.();
  }
}

export async function getBackupExecutionStatus() {
  const { max_parallel, config_source } = await getBackupExecutionLimit();
  return {
    max_parallel,
    in_flight: backupInFlight,
    queued: backupWaiters.length,
    project_lock_count: backupProjectTails.size,
    config_source,
  };
}

type BackupLockOptions<T> = {
  project_id: string;
  op: string;
  run: () => Promise<T>;
};

type QueuedBackupLockOptions<T> = BackupLockOptions<T> & {
  queue_if_busy?: true;
};

type TryBackupLockOptions<T> = BackupLockOptions<T> & {
  queue_if_busy: false;
};

function createBackupProjectTail(project_id: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = backupProjectTails.get(project_id) ?? Promise.resolve();
  const queued = previous.then(() => gate);
  backupProjectTails.set(project_id, queued);
  return { previous, queued, release };
}

export async function withBackupProjectLock<T>(
  opts: QueuedBackupLockOptions<T>,
): Promise<T>;
export async function withBackupProjectLock<T>(
  opts: TryBackupLockOptions<T>,
): Promise<T | undefined>;
export async function withBackupProjectLock<T>({
  project_id,
  op,
  run,
  queue_if_busy = true,
}: QueuedBackupLockOptions<T> | TryBackupLockOptions<T>): Promise<
  T | undefined
> {
  if (!queue_if_busy && backupProjectTails.has(project_id)) {
    logger.debug("skipping backup project lock wait", {
      project_id,
      op,
      queued_projects: backupProjectTails.size,
    });
    return undefined;
  }

  const { previous, queued, release } = createBackupProjectTail(project_id);
  const waitStartedAt = Date.now();
  await previous;
  logger.debug("backup project lock acquired", {
    project_id,
    op,
    wait_ms: Date.now() - waitStartedAt,
    queued_projects: backupProjectTails.size,
  });

  try {
    return await run();
  } finally {
    release();
    if (backupProjectTails.get(project_id) === queued) {
      backupProjectTails.delete(project_id);
    }
    logger.debug("backup project lock released", {
      project_id,
      op,
      queued_projects: backupProjectTails.size,
    });
  }
}

export async function withBackupParallelLimit<T>(
  opts: QueuedBackupLockOptions<T>,
): Promise<T>;
export async function withBackupParallelLimit<T>(
  opts: TryBackupLockOptions<T>,
): Promise<T | undefined>;
export async function withBackupParallelLimit<T>({
  project_id,
  op,
  run,
  queue_if_busy = true,
}: QueuedBackupLockOptions<T> | TryBackupLockOptions<T>): Promise<
  T | undefined
> {
  const lockedRun = async () => {
    await acquireBackupSlot();
    logger.debug("backup slot acquired", {
      project_id,
      op,
      in_flight: backupInFlight,
      queued: backupWaiters.length,
      max_parallel: getCachedBackupExecutionLimit().max_parallel,
    });
    try {
      return await run();
    } finally {
      releaseBackupSlot();
      logger.debug("backup slot released", {
        project_id,
        op,
        in_flight: backupInFlight,
        queued: backupWaiters.length,
        max_parallel: getCachedBackupExecutionLimit().max_parallel,
      });
    }
  };

  if (!queue_if_busy) {
    return await withBackupProjectLock({
      project_id,
      op,
      queue_if_busy: false,
      run: lockedRun,
    });
  }

  return await withBackupProjectLock({
    project_id,
    op,
    run: lockedRun,
  });
}

export function resetBackupQueueForTest(): void {
  backupInFlight = 0;
  backupWaiters.splice(0, backupWaiters.length);
  backupProjectTails.clear();
}
