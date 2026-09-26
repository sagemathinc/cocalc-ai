/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Transform } from "node:stream";
import type {
  ApiRelayAllowance,
  ApiRelayUsageRequest,
} from "@cocalc/conat/project-host/api-relay";

export interface ApiRelayMeter {
  take: (bytes: number, direction: "sent" | "received") => Promise<number>;
  close: (reason: string) => Promise<void>;
}

export async function createApiRelayMeter({
  request,
  update,
  onError,
}: {
  request: Omit<ApiRelayUsageRequest, "sequence" | "sent" | "received">;
  update: (request: ApiRelayUsageRequest) => Promise<ApiRelayAllowance>;
  onError: (error: Error) => void;
}): Promise<ApiRelayMeter> {
  let sent = 0,
    received = 0,
    sequence = 0;
  let allowance = 0,
    expires = 0;
  let closing = false;
  let failure: Error | undefined;
  let uncertain = false;
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;

  const serialize = <T>(f: () => Promise<T>): Promise<T> => {
    const result = queue.then(f);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const refresh = async (close = false, reason?: string) => {
    clearTimeout(timer);
    uncertain = true;
    const value = await update({
      ...request,
      sequence,
      sent,
      received,
      close,
      reason,
    });
    // A failed/unknown update is never followed by a fresh sequence. The caller
    // may retry the exact update, but must stop forwarding until it succeeds.
    sequence++;
    if (
      !Number.isSafeInteger(value.allowance) ||
      value.allowance < sent + received ||
      !Number.isFinite(value.expires_at)
    )
      throw Error("invalid API relay allowance");
    allowance = value.allowance;
    expires = value.expires_at;
    uncertain = false;
    if (!close) scheduleRenewal();
  };
  const quotaError = () =>
    Object.assign(Error("account traffic quota exhausted"), {
      statusCode: 429,
    });
  const scheduleRenewal = () => {
    clearTimeout(timer);
    if (closing || failure || sent + received >= allowance) return;
    // Idle credit needs no periodic reporting. A one-shot timer is rearmed
    // only after a successful renewal, so slow RPCs cannot build a backlog.
    timer = setTimeout(
      () => {
        void serialize(async () => {
          if (closing || failure || Date.now() < expires) return;
          await refresh();
          if (sent + received >= allowance || Date.now() >= expires) {
            throw quotaError();
          }
        }).catch((err) => {
          failure = err as Error;
          clearTimeout(timer);
          onError(failure);
        });
      },
      Math.max(1, expires - Date.now()),
    );
    timer.unref();
  };
  await refresh();
  if (allowance <= 0 || expires <= Date.now()) {
    clearTimeout(timer);
    // A zero initial grant has no durable reservation to settle.
    if (allowance > 0) await refresh(true, "admission expired");
    throw quotaError();
  }

  return {
    take: (bytes, direction) =>
      serialize(async () => {
        if (closing) throw Error("API relay session closed");
        if (failure) throw failure;
        try {
          if (Date.now() >= expires || sent + received >= allowance)
            await refresh();
          const count = Math.min(bytes, allowance - sent - received, 64 * 1024);
          if (Date.now() >= expires || count <= 0) {
            throw Object.assign(Error("account traffic quota exhausted"), {
              statusCode: 429,
            });
          }
          if (direction === "sent") sent += count;
          else received += count;
          return count;
        } catch (err) {
          failure = err as Error;
          throw err;
        }
      }),
    close: (reason) => {
      if (closePromise) return closePromise;
      closing = true;
      clearTimeout(timer);
      closePromise = serialize(async () => {
        // An uncertain renewal must not be overwritten with a different request
        // using the same sequence. Its reservation stays conservatively charged.
        if (uncertain) return;
        await refresh(true, reason);
      });
      return closePromise;
    },
  };
}

export function meteredStream(
  meter: ApiRelayMeter,
  direction: "sent" | "received",
): Transform {
  return new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, done) {
      const forward = async () => {
        for (let offset = 0; offset < chunk.length; ) {
          const count = await meter.take(chunk.length - offset, direction);
          if (this.destroyed) return;
          this.push(chunk.subarray(offset, offset + count));
          offset += count;
        }
      };
      void forward().then(
        () => done(),
        (err) => done(err),
      );
    },
  });
}
