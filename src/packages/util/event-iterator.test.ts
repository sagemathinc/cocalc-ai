import { EventEmitter } from "events";

import { EventIterator } from "./event-iterator";

describe("EventIterator", () => {
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
