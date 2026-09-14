import { EventEmitter } from "node:events";
import { stream } from "./client";

function fixture(frames: { data?: any; headers?: any }[]) {
  const sub = {
    async *[Symbol.asyncIterator]() {
      yield* frames;
    },
    cancel: jest.fn(),
  };
  const socket = Object.assign(new EventEmitter(), {
    state: "ready",
    close: jest.fn(),
    write: jest.fn(),
    requestMany: jest.fn(async () => sub),
  });
  const persist = stream({
    client: {
      id: Math.random().toString(),
      state: "connected",
      socket: { connect: () => socket },
    } as any,
    user: { hub_id: "test" },
    storage: { path: "hub/bootstrap-test" },
    noCache: true,
    registerRecoveryWithScheduler: false,
  });
  return { persist, socket, sub };
}

const info = {
  config: { allow_msg_ttl: false },
  metadata: { users: ["editor"] },
  checkpoints: {},
};

describe("persistence completion integrity", () => {
  it.each(["getAll", "getAllWithInfo"] as const)(
    "%s rejects missing frames and completion",
    async (method) => {
      for (const frames of [
        [],
        [{ data: null, headers: { seq: 1 } }],
        [{ data: [], headers: { seq: 0, ...info } }],
        [
          { data: [], headers: { seq: 0, ...info } },
          { data: null, headers: { seq: 2 } },
        ],
        [{ data: null }],
        [{ data: {}, headers: { seq: 0, ...info } }],
      ]) {
        const { persist, sub } = fixture(frames);
        try {
          await expect(persist[method]()).rejects.toMatchObject({ code: 503 });
          expect(sub.cancel).toHaveBeenCalledTimes(1);
        } finally {
          persist.close();
        }
      }
    },
  );

  it.each(["config", "checkpoints"])(
    "rejects a completion missing requested %s",
    async (missing) => {
      const headers: any = { seq: 0, ...info };
      delete headers[missing];
      const { persist, sub } = fixture([{ data: null, headers }]);
      try {
        await expect(persist.getAllWithInfo()).rejects.toThrow(
          "incomplete persistence bootstrap state",
        );
        expect(sub.cancel).toHaveBeenCalledTimes(1);
      } finally {
        persist.close();
      }
    },
  );

  it("preserves an explicitly empty legacy stream without inventing metadata", async () => {
    const { persist, sub } = fixture([
      { data: null, headers: { seq: 0, config: info.config, checkpoints: {} } },
    ]);
    try {
      await expect(persist.getAllWithInfo()).resolves.toMatchObject({
        messages: [],
        config: info.config,
        metadata: undefined,
        checkpoints: {},
      });
      expect(sub.cancel).toHaveBeenCalledTimes(1);
    } finally {
      persist.close();
    }
  });

  it("propagates an explicit rejection without accepting a following completion", async () => {
    const { persist, sub } = fixture([
      { data: null, headers: { error: "invalid message headers", code: 400 } },
      { data: null, headers: { seq: 0, ...info } },
    ]);
    try {
      await expect(persist.getAllWithInfo()).rejects.toMatchObject({
        code: 400,
      });
      expect(sub.cancel).toHaveBeenCalledTimes(1);
    } finally {
      persist.close();
    }
  });
});
