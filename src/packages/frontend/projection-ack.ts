/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  recordProjectionAckConverged,
  recordProjectionAckFailed,
  recordProjectionAckStart,
} from "./projection-diagnostics";

const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_REPAIR_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 100;

export type ProjectionAckOptions<T> = {
  consumer: string;
  id?: string;
  name: string;
  write: () => Promise<T>;
  matchesProjection: () => boolean;
  repair: () => Promise<void>;
  timeout_ms?: number;
  repair_timeout_ms?: number;
  poll_ms?: number;
  onPending?: () => void;
  onConverged?: () => void;
  onFailed?: (error: Error) => void;
};

function ackId(name: string): string {
  return `${name}:${Date.now()}:${Math.random()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as any).unref?.();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeout_ms}ms`));
        }, timeout_ms);
        (timer as any).unref?.();
      }),
    ]);
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
}

async function waitForProjectionMatch({
  matchesProjection,
  timeout_ms,
  poll_ms,
}: {
  matchesProjection: () => boolean;
  timeout_ms: number;
  poll_ms: number;
}): Promise<boolean> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (matchesProjection()) {
      return true;
    }
    await sleep(Math.min(poll_ms, Math.max(1, deadline - Date.now())));
  }
  return matchesProjection();
}

export async function writeAndWaitForProjection<T>({
  consumer,
  id,
  name,
  write,
  matchesProjection,
  repair,
  timeout_ms = DEFAULT_ACK_TIMEOUT_MS,
  repair_timeout_ms = DEFAULT_REPAIR_TIMEOUT_MS,
  poll_ms = DEFAULT_POLL_MS,
  onPending,
  onConverged,
  onFailed,
}: ProjectionAckOptions<T>): Promise<T> {
  const resolvedId = id ?? ackId(name);
  recordProjectionAckStart({
    consumer,
    id: resolvedId,
    name,
  });
  onPending?.();
  try {
    const result = await write();
    if (
      await waitForProjectionMatch({
        matchesProjection,
        timeout_ms,
        poll_ms,
      })
    ) {
      recordProjectionAckConverged({ consumer, id: resolvedId, name });
      onConverged?.();
      return result;
    }

    await withTimeout(repair(), repair_timeout_ms, `${name} projection repair`);
    if (
      await waitForProjectionMatch({
        matchesProjection,
        timeout_ms,
        poll_ms,
      })
    ) {
      recordProjectionAckConverged({ consumer, id: resolvedId, name });
      onConverged?.();
      return result;
    }

    throw new Error(`${name} projection did not converge`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(`${err}`);
    recordProjectionAckFailed({
      consumer,
      id: resolvedId,
      name,
      error,
    });
    onFailed?.(error);
    throw error;
  }
}
