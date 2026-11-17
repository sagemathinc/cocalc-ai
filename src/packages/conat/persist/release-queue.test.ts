/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { refCacheSync } from "@cocalc/util/refcache";
import {
  DEFAULT_PERSIST_STREAM_RELEASE_GRACE_MS,
  PersistStreamReleaseQueue,
  resolvePersistStreamReleaseGraceMs,
} from "./release-queue";

describe("PersistStreamReleaseQueue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("retains a disconnected stream for the reconnect grace period", () => {
    const close = jest.fn();
    const queue = new PersistStreamReleaseQueue({ graceMs: 1_000 });

    queue.schedule({ close });
    jest.advanceTimersByTime(999);
    expect(close).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(queue.diagnostics()).toMatchObject({
      grace_ms: 1_000,
      pending: 0,
      scheduled_total: 1,
      released_total: 1,
      errors_total: 0,
      max_pending: 1,
    });
  });

  it("reuses a cached stream when it reconnects before release", () => {
    const finalClose = jest.fn();
    const cache = refCacheSync<
      { path: string },
      {
        close: () => void;
      }
    >({
      name: `persist-release-queue-${Math.random()}`,
      createKey: ({ path }) => path,
      createObject: () => ({ close: finalClose }),
    });
    const queue = new PersistStreamReleaseQueue({ graceMs: 1_000 });
    const first = cache({ path: "/stream" });

    queue.schedule(first);
    const reconnected = cache({ path: "/stream" });
    expect(reconnected).toBe(first);

    jest.advanceTimersByTime(1_000);
    expect(finalClose).not.toHaveBeenCalled();

    queue.schedule(reconnected);
    jest.advanceTimersByTime(1_000);
    expect(finalClose).toHaveBeenCalledTimes(1);
  });

  it("yields between due releases", () => {
    const queue = new PersistStreamReleaseQueue({ graceMs: 1_000 });
    const first = jest.fn();
    const second = jest.fn();

    queue.schedule({ close: first });
    queue.schedule({ close: second });
    jest.advanceTimersByTime(1_000);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drains immediately while still yielding between releases", async () => {
    const queue = new PersistStreamReleaseQueue({ graceMs: 60_000 });
    const first = jest.fn();
    const second = jest.fn();

    queue.schedule({ close: first });
    queue.schedule({ close: second });
    const drained = queue.drain();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    await drained;

    expect(second).toHaveBeenCalledTimes(1);
    expect(queue.diagnostics()).toMatchObject({
      pending: 0,
      released_total: 2,
    });
  });

  it("uses a safe default for invalid grace values", () => {
    expect(
      resolvePersistStreamReleaseGraceMs({
        CONAT_PERSIST_STREAM_RELEASE_GRACE_MS: "-1",
      }),
    ).toBe(DEFAULT_PERSIST_STREAM_RELEASE_GRACE_MS);
    expect(
      resolvePersistStreamReleaseGraceMs({
        CONAT_PERSIST_STREAM_RELEASE_GRACE_MS: "1200",
      }),
    ).toBe(1_200);
  });

  it("releases immediately by default in tests", () => {
    expect(resolvePersistStreamReleaseGraceMs({ NODE_ENV: "test" })).toBe(0);
    expect(
      resolvePersistStreamReleaseGraceMs({ COCALC_TEST_MODE: "true" }),
    ).toBe(0);
  });

  it("releases a persist stream only once what it has queued is committed (028 releaseDurably)", () => {
    const order: string[] = [];
    const stream = {
      close: () => order.push("close"),
      atWriteIdle: (fn: () => void) => {
        order.push("commit queued");
        fn();
      },
    };
    const queue = new PersistStreamReleaseQueue({ graceMs: 10 });
    queue.schedule(stream);
    jest.advanceTimersByTime(10);
    expect(order).toEqual(["commit queued", "close"]);
  });
});
