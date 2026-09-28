/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

import { callConatService, createConatService } from "./service";
import { serviceErrorAttributes } from "../util";

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
  it("round trips admission metadata without copying private error fields or replaying", async () => {
    const reply = deferred<any>();
    const handler = jest.fn(async () => {
      throw Object.assign(new Error("search rate exceeded"), {
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
        credential: "must-not-cross-wire",
      });
    });
    const subscription = createSubscription([
      {
        data: {},
        respond: (data) => reply.resolve(JSON.parse(JSON.stringify(data))),
      },
    ]);
    const service = createConatService({
      client: { subscribe: async () => subscription } as any,
      service: "test",
      handler,
    });
    try {
      const data = await reply.promise;
      expect(data).toEqual({
        error: "Error: search rate exceeded",
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
      });
      const request = jest.fn(async () => ({ data }));
      await expect(
        callConatService({
          client: { request } as any,
          service: "test",
          mesg: {},
        }),
      ).rejects.toMatchObject({
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      service.close();
    }
  });

  it.each([-1, 0.5, Infinity, NaN, "100", {}, Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid retry metadata %p",
    (retry_after_ms) => {
      expect(
        serviceErrorAttributes({ code: {}, retry_after_ms, stack: "private" }),
      ).toEqual({});
    },
  );

  it("retains legacy errors and rejects arbitrary remote properties", async () => {
    const request = jest.fn(async () => ({
      data: {
        error: "legacy failure",
        message: "spoofed message",
        stack: "spoofed stack",
        credential: "private",
        code: "bad code",
      },
    }));
    const error = await callConatService({
      client: { request } as any,
      service: "test",
      mesg: {},
    }).catch((err) => err);
    expect(error.message).toBe("legacy failure");
    expect(error.stack).not.toBe("spoofed stack");
    expect(error.credential).toBeUndefined();
    expect(error.code).toBeUndefined();
  });

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

  it("rejects parallel requests above the active handler cap", async () => {
    const firstDone = deferred<void>();
    const respond1 = jest.fn(async () => undefined);
    const respond2 = jest.fn(async () => undefined);
    const handler = jest.fn(async (req) => {
      if (req.id === 1) {
        await firstDone.promise;
      }
      return "ok";
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
      maxParallelHandlers: 1,
      handler,
    });

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond2).toHaveBeenCalledWith(
      { error: "service 'test-service' is busy", code: 503 },
      {
        noThrow: true,
        headers: {
          error: "service 'test-service' is busy",
          error_attrs: { code: 503 },
        },
      },
    );

    firstDone.resolve();
    await flushAsyncWork();
    expect(respond1).toHaveBeenCalledWith("ok");
    service.close();
  });
});
