import { EventEmitter } from "events";

import { EventIterator } from "./event-iterator";

describe("EventIterator", () => {
  const bounded = (emitter: EventEmitter) =>
    new EventIterator<Buffer>(emitter, "data", {
      map: ([value]) => value,
      maxQueueBytes: 10,
      sizeOf: (value) => value.length,
      overflow: "throw",
    });

  test("byte overflow fails without retaining or dropping partial data silently", async () => {
    const emitter = new EventEmitter();
    const iter = bounded(emitter);
    emitter.emit("data", Buffer.alloc(8));
    expect(iter.queueBytes()).toBe(8);
    emitter.emit("data", Buffer.alloc(8));
    expect(iter.ended).toBe(true);
    expect(iter.queueBytes()).toBe(0);
    expect(iter.queueSize()).toBe(0);
    expect(emitter.listenerCount("data")).toBe(0);
    await expect(iter.next()).rejects.toThrow("maxQueue overflow");
  });

  test("overflow rejects an outstanding next, rather than reporting successful end", async () => {
    const emitter = new EventEmitter();
    const iter = bounded(emitter);
    const next = iter.next();
    emitter.emit("data", Buffer.alloc(11));
    await expect(next).rejects.toThrow("maxQueue overflow");
    expect(emitter.listenerCount("data")).toBe(0);
  });

  test("graceful end drains, while cancellation discards even an ended queue", async () => {
    const emitter = new EventEmitter();
    const iter = bounded(emitter);
    emitter.emit("data", Buffer.alloc(3));
    emitter.emit("data", Buffer.alloc(5));
    iter.end();
    expect((await iter.next()).value).toHaveLength(3);
    expect(iter.queueBytes()).toBe(5);
    iter.cancel();
    expect(iter.queueBytes()).toBe(0);
    await expect(iter.next()).resolves.toMatchObject({ done: true });
  });

  test("cancellation rejects pending next and releases listeners", async () => {
    const emitter = new EventEmitter();
    const iter = bounded(emitter);
    const next = iter.next();
    iter.cancel(Error("aborted"));
    await expect(next).rejects.toThrow("aborted");
    expect(emitter.listenerCount("data")).toBe(0);
  });

  test("return releases a suspended consumer's payloads", async () => {
    const emitter = new EventEmitter();
    const iter = bounded(emitter);
    emitter.emit("data", Buffer.alloc(8));
    await iter.return();
    expect(iter.queueBytes()).toBe(0);
    expect(iter.queueSize()).toBe(0);
  });

  test("end clears pending next idle timer", async () => {
    const emitter = new EventEmitter();
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const active = new Set<any>();

    global.setTimeout = ((
      fn: (...args: any[]) => void,
      ms?: number,
      ...args: any[]
    ) => {
      const timer = realSetTimeout(
        ((...inner: any[]) => {
          active.delete(timer);
          return fn(...inner);
        }) as typeof fn,
        ms,
        ...args,
      );
      active.add(timer);
      return timer;
    }) as typeof setTimeout;

    global.clearTimeout = ((timer: any) => {
      active.delete(timer);
      return realClearTimeout(timer);
    }) as typeof clearTimeout;

    try {
      const iter = new EventIterator<string>(emitter, "data", { idle: 1000 });
      const pending = iter.next();
      iter.end();
      await expect(pending).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(active.size).toBe(0);
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  });
});
