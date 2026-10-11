/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A socket whose stream failed to open must retry the open on later requests,
// including when the first attempt failed synchronously (as usage.add does
// when the per-user stream limit is exceeded).

import { EventEmitter } from "events";

const getStream = jest.fn();
const usageAdd = jest.fn();

jest.mock("./util", () => ({
  ...jest.requireActual("./util"),
  getStream: (...args: any[]) => getStream(...args),
}));

jest.mock("@cocalc/conat/monitor/usage", () => ({
  UsageMonitor: class {
    add = (...args: any[]) => usageAdd(...args);
    delete = jest.fn();
    close = jest.fn();
  },
}));

import { server } from "./server";

class FakeSocket extends EventEmitter {
  subject = "persist.hub.server.0";
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

describe("persist server stream open retry", () => {
  let now = 1_000_000;
  let socket: FakeSocket;

  beforeEach(() => {
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const listener = new EventEmitter() as any;
    const client: any = { socket: { listen: () => listener } };
    server({ client, clusterMode: true });
    socket = new FakeSocket();
    listener.emit("connection", socket);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    getStream.mockReset();
    usageAdd.mockReset();
  });

  it("retries after an open that failed synchronously", async () => {
    usageAdd.mockImplementationOnce(() => {
      throw Object.assign(new Error("too many streams"), { code: 429 });
    });
    getStream.mockResolvedValue({ keys: () => ["a"], on: jest.fn() });

    socket.emit("data", { storage: { path: "hub/x" } });
    const [, failed] = await request(socket, { cmd: "keys" });
    expect(failed?.headers?.error).toContain("too many streams");
    expect(getStream).not.toHaveBeenCalled();

    now += 1_500;
    const [keys, ok] = await request(socket, { cmd: "keys" });
    expect(ok?.headers?.error).toBeUndefined();
    expect(keys).toEqual(["a"]);
    expect(getStream).toHaveBeenCalledTimes(1);
  });

  it("retries after an asynchronous storage failure", async () => {
    getStream
      .mockRejectedValueOnce(new Error("Error: disk I/O error"))
      .mockResolvedValue({ keys: () => ["b"], on: jest.fn() });

    socket.emit("data", { storage: { path: "hub/y" } });
    const [, failed] = await request(socket, { cmd: "keys" });
    expect(failed?.headers?.code).toBe("SQLITE_IOERR");

    // Within the retry interval the error is reported without reopening.
    const [, again] = await request(socket, { cmd: "keys" });
    expect(again?.headers?.code).toBe("SQLITE_IOERR");
    expect(getStream).toHaveBeenCalledTimes(1);

    now += 1_500;
    const [keys] = await request(socket, { cmd: "keys" });
    expect(keys).toEqual(["b"]);
    expect(getStream).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permission failure", async () => {
    getStream.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: 403 }),
    );
    socket.emit("data", { storage: { path: "hub/z" } });
    await request(socket, { cmd: "keys" });
    now += 1_500;
    const [, denied] = await request(socket, { cmd: "keys" });
    expect(denied?.headers?.code).toBe(403);
    expect(getStream).toHaveBeenCalledTimes(1);
  });
});
