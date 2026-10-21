/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The persist server holds at most one resetHistory request per stream, with
// its payload (bounded history plan H1b-3 r4, LIMIT-H1B3P-2).  A request held
// while its stream opens keeps the stream's reset slot; any other reset of the
// same stream, on any socket (another backend, or the same one restarted, with
// any opId), is answered at once and its payload dropped.  The slot is
// released when the holder is answered, however it ends.

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

// Sends a request; resolves with what the server answered.
function request(socket: FakeSocket, headers: any, data?: any): Promise<any[]> {
  return new Promise((resolve) => {
    socket.emit("request", {
      headers,
      data,
      respondSync: (...args: any[]) => resolve(args),
    });
  });
}

// A stream whose resetHistory answers with result, or throws it.
function fakeStream(result: any) {
  return {
    on: jest.fn(),
    historyEpochNow: () => 3,
    resetHistory: jest.fn((opts) => {
      if (result instanceof Error) throw result;
      return { ...result, opId: opts?.opId };
    }),
  };
}

describe("the persist server's reset slot", () => {
  let listener: any;

  beforeEach(() => {
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

  // The stream of the first socket opens only when released.
  const holdOpen = (stream: any) => {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    getStream.mockImplementationOnce(async () => {
      await opened;
      return stream;
    });
    return release;
  };

  it("holds one reset per stream; others, on new sockets with other opIds, are refused at once", async () => {
    const held = fakeStream({ reset: true, history_epoch: 4, count: 1 });
    const release = holdOpen(held);
    const first = connect("projects/x/a.sage-jupyter2");
    const firstAnswer = request(
      first,
      { cmd: "resetHistory" },
      { opId: "op-1", seed: { raw: "x".repeat(1000) } },
    );

    // a restarted backend, twice, with different opIds
    const others: any[] = [];
    for (const opId of ["op-2", "op-3"]) {
      const open = fakeStream({ reset: true, history_epoch: 9, count: 0 });
      getStream.mockResolvedValueOnce(open);
      const socket = connect("projects/x/a.sage-jupyter2");
      await new Promise((resolve) => setImmediate(resolve));
      others.push({
        open,
        answer: await request(socket, { cmd: "resetHistory" }, { opId }),
      });
    }
    for (const { open, answer } of others) {
      expect(answer[0]).toEqual({
        reset: false,
        refused: "busy",
        history_epoch: 3,
        count: 0,
      });
      // never applied
      expect(open.resetHistory).not.toHaveBeenCalled();
    }

    // the holder is answered normally once its stream opens
    release();
    const [result] = await firstAnswer;
    expect(result).toEqual({
      reset: true,
      history_epoch: 4,
      count: 1,
      opId: "op-1",
    });
    expect(held.resetHistory).toHaveBeenCalledTimes(1);
  });

  it("a reset arriving while the slot is held and its own stream is not open yet is refused with 409", async () => {
    const release = holdOpen(
      fakeStream({ reset: true, history_epoch: 1, count: 0 }),
    );
    const first = connect("projects/x/b.sage-jupyter2");
    const firstAnswer = request(
      first,
      { cmd: "resetHistory" },
      { opId: "op-1" },
    );

    const release2 = holdOpen(
      fakeStream({ reset: true, history_epoch: 1, count: 0 }),
    );
    const second = connect("projects/x/b.sage-jupyter2");
    const [, headers] = await request(
      second,
      { cmd: "resetHistory" },
      { opId: "op-2" },
    );
    expect(headers?.headers?.code).toBe(409);
    expect(headers?.headers?.error).toContain("another reset");

    release();
    release2();
    await firstAnswer;
  });

  it("other streams are not affected", async () => {
    const release = holdOpen(
      fakeStream({ reset: true, history_epoch: 1, count: 0 }),
    );
    const first = connect("projects/x/c.sage-jupyter2");
    const firstAnswer = request(
      first,
      { cmd: "resetHistory" },
      { opId: "op-1" },
    );

    const other = fakeStream({ reset: true, history_epoch: 2, count: 0 });
    getStream.mockResolvedValueOnce(other);
    const socket = connect("projects/x/other.sage-jupyter2");
    const [result] = await request(
      socket,
      { cmd: "resetHistory" },
      { opId: "op-9" },
    );
    expect(result.reset).toBe(true);

    release();
    await firstAnswer;
  });

  describe("the slot is released on every outcome", () => {
    const cases: [string, any][] = [
      ["applied", { reset: true, history_epoch: 2, count: 1 }],
      [
        "refused",
        { reset: false, refused: "moved", history_epoch: 1, count: 0 },
      ],
      ["failed", Object.assign(new Error("disk full"), { code: 507 })],
    ];
    for (const [name, outcome] of cases) {
      it(name, async () => {
        const path = `projects/x/${name}.sage-jupyter2`;
        getStream.mockResolvedValueOnce(fakeStream(outcome));
        const socket = connect(path);
        await new Promise((resolve) => setImmediate(resolve));
        await request(socket, { cmd: "resetHistory" }, { opId: "op-1" });

        // the next reset of the same stream is admitted and runs
        const next = fakeStream({ reset: true, history_epoch: 5, count: 0 });
        getStream.mockResolvedValueOnce(next);
        const again = connect(path);
        await new Promise((resolve) => setImmediate(resolve));
        const [result] = await request(
          again,
          { cmd: "resetHistory" },
          { opId: "op-2" },
        );
        expect(result.reset).toBe(true);
        expect(next.resetHistory).toHaveBeenCalledTimes(1);
      });
    }
  });

  it("requests other than resetHistory never take or wait for the slot", async () => {
    const release = holdOpen(
      fakeStream({ reset: true, history_epoch: 1, count: 0 }),
    );
    const first = connect("projects/x/d.sage-jupyter2");
    const firstAnswer = request(
      first,
      { cmd: "resetHistory" },
      { opId: "op-1" },
    );

    const open = { ...fakeStream({}), keys: () => ["k"] };
    getStream.mockResolvedValueOnce(open);
    const socket = connect("projects/x/d.sage-jupyter2");
    await new Promise((resolve) => setImmediate(resolve));
    const [keys] = await request(socket, { cmd: "keys" });
    expect(keys).toEqual(["k"]);

    release();
    await firstAnswer;
  });
});
