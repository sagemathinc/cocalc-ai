import { EventEmitter } from "events";

const mockStreams: any[] = [];
jest.mock("./core-stream", () => ({
  CoreStream: class extends require("events").EventEmitter {
    messages = [];
    raw = [];
    init = jest.fn(async () => {});
    close = jest.fn();
    publishMany = jest.fn();
    constructor() {
      super();
      mockStreams.push(this);
    }
  },
}));

import { DStream } from "./dstream";

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: any) => void;
  const promise = new Promise<any>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function create(noAutosave = false) {
  const stream = new DStream({
    name: "close-test",
    client: new EventEmitter() as any,
    noInventory: true,
    noAutosave,
  });
  await stream.init();
  return { stream, core: mockStreams.at(-1) };
}

describe("DStream close autosave", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStreams.length = 0;
  });
  afterEach(() => jest.useRealTimers());

  it("drains an in-flight batch and later queued messages before closing", async () => {
    const { stream, core } = await create();
    const first = deferred();
    const second = deferred();
    core.publishMany
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    stream.push(389);
    stream.push(390);
    expect(core.publishMany).toHaveBeenCalledTimes(1);
    const closed = jest.fn();
    stream.on("closed", closed);
    const closing = stream.close();
    expect(stream.close()).toBe(closing);
    expect(() => stream.push(391)).toThrow("closed");
    expect(() => stream.publish(391)).toThrow("closed");
    expect(core.close).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    first.resolve([{ seq: 1, time: 1 }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(core.publishMany).toHaveBeenCalledTimes(2);
    expect(core.publishMany.mock.calls[1][0]).toEqual([
      { mesg: 390, options: { msgID: expect.any(String) } },
    ]);
    expect(core.close).not.toHaveBeenCalled();
    second.resolve([{ seq: 2, time: 2 }]);
    await closing;
    expect(stream.isClosed()).toBe(true);
    expect(core.close).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
  });

  it("closes clean streams and noAutosave streams synchronously", async () => {
    for (const noAutosave of [false, true]) {
      const { stream, core } = await create(noAutosave);
      if (noAutosave) stream.push(389);
      expect(stream.close()).toBeUndefined();
      expect(stream.isClosed()).toBe(true);
      expect(core.close).toHaveBeenCalledTimes(1);
      expect(core.publishMany).not.toHaveBeenCalled();
    }
  });

  it("reports write failures and still releases the socket", async () => {
    const { stream, core } = await create();
    const write = deferred();
    core.publishMany.mockReturnValue(write.promise);
    stream.push(389);
    const closing = stream.close();
    const result = expect(closing).rejects.toThrow("write failed");
    write.reject(Error("write failed"));
    await result;
    expect(stream.isClosed()).toBe(true);
    expect(core.close).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(core.publishMany).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled flush and does not send queued batches after timeout", async () => {
    const { stream, core } = await create();
    const write = deferred();
    core.publishMany.mockReturnValue(write.promise);
    stream.push(389, 390);
    const result = expect(stream.close()).rejects.toThrow(
      "close autosave timeout",
    );
    await jest.advanceTimersByTimeAsync(15_000);
    await result;
    expect(stream.isClosed()).toBe(true);
    expect(core.close).toHaveBeenCalledTimes(1);
    write.resolve([{ seq: 1, time: 1 }]);
    await jest.runAllTimersAsync();
    expect(core.publishMany).toHaveBeenCalledTimes(1);
  });
});
