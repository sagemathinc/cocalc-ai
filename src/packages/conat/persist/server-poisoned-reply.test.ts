/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Finding 028 (#139), SA's 065 sweep L1/L2: two replies read the stream's
// history epoch outside the request's try -- a busy reset, before it, and an
// oversized-message error, in its catch.  A poisoned stream throws on every
// statement, so that read throws; it must become an error reply, never an
// exception out of the handler, which would end the shared persist process.

import { EventEmitter } from "events";

const getStream = jest.fn();

jest.mock("./util", () => ({
  ...jest.requireActual("./util"),
  getStream: (...args: any[]) => getStream(...args),
}));

jest.mock("@cocalc/conat/monitor/usage", () => ({
  UsageMonitor: class {
    add = jest.fn();
    delete = jest.fn();
    close = jest.fn();
  },
}));

import { server } from "./server";

class FakeSocket extends EventEmitter {
  subject = "persist.project-x.server.0";
  write = jest.fn();
}

function request(socket: FakeSocket, headers: any, data?: any): Promise<any[]> {
  return new Promise((resolve) => {
    socket.emit("request", {
      headers,
      data,
      respondSync: (...args: any[]) => resolve(args),
    });
  });
}

function poisonedError(): Error {
  const err: any = new Error(
    "persist: this stream had a sync error and is refused",
  );
  err.code = 503;
  return err;
}

// a poisoned stream: every read of the database throws
function poisonedStream(extra: object = {}) {
  return {
    on: jest.fn(),
    historyEpochNow: () => {
      throw poisonedError();
    },
    resetHistory: jest.fn(() => {
      throw poisonedError();
    }),
    ...extra,
  };
}

describe("028: replies that read a poisoned stream outside the request's try", () => {
  let listener: any;
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);

  beforeAll(() => {
    process.on("unhandledRejection", onUnhandled);
  });
  afterAll(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  beforeEach(() => {
    unhandled.length = 0;
    listener = new EventEmitter();
    const client: any = { socket: { listen: () => listener } };
    server({ client, clusterMode: true });
  });

  afterEach(() => {
    getStream.mockReset();
  });

  const connect = (path: string) => {
    const socket = new FakeSocket();
    listener.emit("connection", socket);
    socket.emit("data", { storage: { path } });
    return socket;
  };

  it("a busy reset on a poisoned stream (L1): the busy error reply, no throw", async () => {
    // the first socket's reset holds the slot while its stream opens
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    getStream.mockImplementationOnce(async () => {
      await opened;
      return poisonedStream();
    });
    const first = connect("projects/x/p.sage-jupyter2");
    const firstAnswer = request(first, { cmd: "resetHistory" }, { opId: "1" });

    // the second socket's stream is open, and poisoned
    getStream.mockResolvedValueOnce(poisonedStream());
    const second = connect("projects/x/p.sage-jupyter2");
    await new Promise((resolve) => setImmediate(resolve));
    const [data, opts] = await request(
      second,
      { cmd: "resetHistory" },
      { opId: "2" },
    );
    expect(data).toBe(null);
    expect(opts?.headers?.code).toBe(409);
    expect(opts?.headers?.error).toContain("resetHistory: busy");

    release();
    const [, held] = await firstAnswer;
    expect(held?.headers?.code).toBe(503);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("an oversized-message error on a poisoned stream (L2): the error reply, without the epoch, no throw", async () => {
    const stream = poisonedStream({
      setQueued: jest.fn(async () => {
        const err: any = new Error("message too large");
        err.code = 413;
        err.oversizedSeq = 7;
        throw err;
      }),
    });
    getStream.mockResolvedValueOnce(stream);
    const socket = connect("projects/x/q.sage-jupyter2");
    await new Promise((resolve) => setImmediate(resolve));
    const [data, opts] = await request(socket, { cmd: "set" });
    expect(data).toBe(null);
    expect(opts?.headers).toMatchObject({ code: 413, oversized_seq: 7 });
    expect(opts?.headers?.oversized_epoch).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});
