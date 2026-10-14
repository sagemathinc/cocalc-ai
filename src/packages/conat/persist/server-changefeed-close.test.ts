/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A persistent stream is shared by every socket on its subject and stays open
// while any of them does. A closed socket's changefeed must stop listening to
// it, or the stream keeps the socket alive until the last one closes.

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
  subject = "persist.hub.server.0";
  state = "ready";
  write = jest.fn();
}

function request(socket: FakeSocket, headers: any): Promise<any[]> {
  return new Promise((resolve) => {
    socket.emit("request", {
      headers,
      respondSync: (...args: any[]) => resolve(args),
    });
  });
}

describe("persist server changefeed cleanup", () => {
  let listener: any;
  let stream: EventEmitter & { keys: () => string[] };

  beforeEach(() => {
    listener = new EventEmitter();
    const client: any = { socket: { listen: () => listener } };
    server({ client, clusterMode: true });
    stream = Object.assign(new EventEmitter(), { keys: () => [] });
    getStream.mockResolvedValue(stream);
  });

  afterEach(() => {
    getStream.mockReset();
  });

  function connect(): FakeSocket {
    const socket = new FakeSocket();
    listener.emit("connection", socket);
    return socket;
  }

  it("removes the change listener when a changefeed socket closes", async () => {
    const kept = connect();
    kept.emit("data", { storage: { path: "hub/x" }, changefeed: true });
    await request(kept, { cmd: "keys" });
    expect(stream.listenerCount("change")).toBe(1);

    for (let i = 0; i < 5; i++) {
      const socket = connect();
      socket.emit("data", { storage: { path: "hub/x" }, changefeed: true });
      await request(socket, { cmd: "keys" });
      socket.state = "closed";
      socket.emit("closed");
    }
    expect(stream.listenerCount("change")).toBe(1);

    stream.emit("change", { op: "delete", seqs: [1] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(kept.write).toHaveBeenCalledWith(
      [{ op: "delete", seqs: [1] }],
      expect.anything(),
    );
  });

  it("starts one changefeed per socket", async () => {
    const socket = connect();
    socket.emit("data", { storage: { path: "hub/y" } });
    await request(socket, { cmd: "keys" });
    await request(socket, { cmd: "changefeed" });
    await request(socket, { cmd: "changefeed" });
    expect(stream.listenerCount("change")).toBe(1);
    socket.state = "closed";
    socket.emit("closed");
    expect(stream.listenerCount("change")).toBe(0);
  });
});
