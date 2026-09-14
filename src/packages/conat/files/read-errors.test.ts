const mockLogError = jest.fn();
jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({ debug: jest.fn(), error: mockLogError }),
}));

import { EventEmitter } from "node:events";
import { EventIterator } from "@cocalc/util/event-iterator";
import { createServer, close } from "./read";
import { ReadFlow, READ_PROTOCOL } from "./read-flow";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const project_id = "00000000-1000-4000-8000-000000000087";

describe("reader failure isolation", () => {
  let emitter: EventEmitter;
  let sub: EventIterator<any>;
  let start: jest.SpyInstance;
  let createReadStream: jest.Mock;

  function message(protocol: unknown = READ_PROTOCOL) {
    return {
      subject: "test-reader",
      data: { path: "/empty", fileReadProtocol: protocol },
      respond: jest.fn(async () => ({ count: 1 })),
      respondSync: jest.fn(() => {
        throw Error("reply unavailable");
      }),
    };
  }

  beforeEach(async () => {
    mockLogError.mockClear();
    emitter = new EventEmitter();
    sub = new EventIterator(emitter, "message", { map: ([value]) => value });
    // Model transport failure independently of the router's input validation.
    start = jest
      .spyOn(ReadFlow.prototype, "start")
      .mockResolvedValue(undefined);
    createReadStream = jest.fn(async function* () {});
    await createServer({
      client: { subscribe: async () => sub } as any,
      project_id,
      createReadStream,
      maxActiveStreams: 1,
    });
  });

  afterEach(async () => {
    sub.cancel();
    await close({ project_id });
    start.mockRestore();
  });

  async function assertHealthy() {
    const good = message();
    emitter.emit("message", good);
    await tick();
    expect(good.respond).toHaveBeenCalledWith(null, {
      headers: { done: true },
    });
    expect(good.respondSync).not.toHaveBeenCalled();
  }

  it("continues after a protocol rejection cannot be delivered", async () => {
    const bad = message("unsupported");
    emitter.emit("message", bad);
    await tick();
    expect(bad.respondSync).toHaveBeenCalled();
    expect(createReadStream).not.toHaveBeenCalled();
    await assertHealthy();
  });

  it("continues after a busy rejection cannot be delivered", async () => {
    let finish!: () => void;
    start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = message();
    emitter.emit("message", first);
    await tick();
    const busy = message();
    emitter.emit("message", busy);
    await tick();
    expect(busy.respondSync).toHaveBeenCalledWith(null, {
      headers: { error: "project file read service is busy" },
    });
    finish();
    await tick();
    expect(first.respond).toHaveBeenCalled();
    await assertHealthy();
  });

  it("releases a failed handshake even when its error reply throws", async () => {
    start.mockRejectedValueOnce(Error("handshake failed"));
    const bad = message();
    emitter.emit("message", bad);
    await tick();
    expect(bad.respondSync).toHaveBeenCalled();
    expect(createReadStream).not.toHaveBeenCalled();
    await assertHealthy();
  });

  it("contains completion-reply failure and releases the slot", async () => {
    const bad = message();
    bad.respond.mockRejectedValueOnce(Error("connection closed"));
    emitter.emit("message", bad);
    await tick();
    expect(bad.respondSync).toHaveBeenCalled();
    await assertHealthy();
  });

  it("observes an unexpected subscription failure", async () => {
    const err = Error("subscription failed");
    const cancel = jest.spyOn(sub, "cancel");
    sub.cancel(err);
    await tick();
    expect(mockLogError).toHaveBeenCalledWith(
      "reader subscription failed",
      expect.objectContaining({ err }),
    );
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
