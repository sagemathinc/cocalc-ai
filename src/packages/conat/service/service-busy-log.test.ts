/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const warn = jest.fn();
jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () =>
    new Proxy(
      {},
      {
        get: (_target, level) =>
          level === "warn" ? (...args) => warn(...args) : () => {},
      },
    ),
}));

import { createConatService } from "./service";

async function flushAsyncWork() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("ConatService busy warnings", () => {
  it("logs at most one busy warning per interval and reports how many it skipped", async () => {
    let now = 1_000_000;
    const dateNow = jest.spyOn(Date, "now").mockImplementation(() => now);
    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const respond = jest.fn(async () => undefined);
    const messages = [
      { data: { id: 1 }, respond },
      ...[2, 3, 4].map((id) => ({ data: { id }, respond })),
      {
        data: { id: 5 },
        // the next rejection happens after the interval has passed
        respond: jest.fn(async () => {
          now += 10_001;
        }),
      },
      { data: { id: 6 }, respond },
    ];
    let stopped = false;
    const subscription = {
      stop: () => {
        stopped = true;
      },
      async *[Symbol.asyncIterator]() {
        for (const mesg of messages) {
          yield mesg;
        }
        while (!stopped) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
    };

    const service = createConatService({
      client: { subscribe: jest.fn(async () => subscription) } as any,
      service: "busy-service",
      subject: "busy.subject",
      parallel: true,
      maxParallelHandlers: 1,
      handler: async (req) => {
        if (req.id === 1) {
          await firstDone;
        }
        return "ok";
      },
    });

    try {
      await flushAsyncWork();
      const busy = warn.mock.calls.filter(([message]) =>
        `${message}`.includes("is busy"),
      );
      expect(busy).toHaveLength(2);
      expect(busy[0][1]).not.toHaveProperty("suppressed");
      expect(busy[1][1]).toEqual(expect.objectContaining({ suppressed: 3 }));
    } finally {
      releaseFirst();
      await flushAsyncWork();
      service.close();
      dateNow.mockRestore();
    }
  });
});
