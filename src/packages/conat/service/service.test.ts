/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

import { createConatService } from "./service";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createSubscription(messages: any[]) {
  const state = { stopped: false };
  return {
    stop: () => {
      state.stopped = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const mesg of messages) {
        yield mesg;
      }
      while (!state.stopped) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  };
}

async function flushAsyncWork() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("ConatService", () => {
  it("can handle multiple requests concurrently when parallel=true", async () => {
    const firstDone = deferred<void>();
    const secondStarted = deferred<void>();
    const respond1 = jest.fn(async () => undefined);
    const respond2 = jest.fn(async () => undefined);
    const handler = jest.fn(async (req) => {
      if (req.id === 1) {
        await firstDone.promise;
        return "one";
      }
      secondStarted.resolve();
      return "two";
    });
    const subscription = createSubscription([
      { data: { id: 1 }, respond: respond1 },
      { data: { id: 2 }, respond: respond2 },
    ]);
    const client = {
      subscribe: jest.fn(async () => subscription),
    };

    const service = createConatService({
      client: client as any,
      service: "test-service",
      subject: "test.subject",
      parallel: true,
      handler,
    });

    await secondStarted.promise;
    expect(handler).toHaveBeenCalledTimes(2);

    firstDone.resolve();
    await flushAsyncWork();

    expect(respond1).toHaveBeenCalledWith("one");
    expect(respond2).toHaveBeenCalledWith("two");
    service.close();
  });
});
