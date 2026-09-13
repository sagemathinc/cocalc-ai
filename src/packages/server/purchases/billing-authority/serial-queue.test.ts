/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { BillingAuthoritySerialQueue } from "./serial-queue";

describe("BillingAuthoritySerialQueue", () => {
  it("runs commands in FIFO order without overlap", async () => {
    const queue = new BillingAuthoritySerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.stats()).toMatchObject({ active: true, queue_depth: 1 });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(queue.stats()).toEqual({
      active: false,
      queue_depth: 0,
      completed: 2,
      failed: 0,
    });
  });

  it("continues after a failed command", async () => {
    const queue = new BillingAuthoritySerialQueue();
    const failed = queue.run(async () => {
      throw Error("expected failure");
    });
    const next = queue.run(async () => "completed");

    await expect(failed).rejects.toThrow("expected failure");
    await expect(next).resolves.toBe("completed");
    expect(queue.stats()).toMatchObject({ completed: 1, failed: 1 });
  });
});
