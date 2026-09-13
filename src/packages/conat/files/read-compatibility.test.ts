import { EventEmitter } from "node:events";
import { EventIterator } from "@cocalc/util/event-iterator";
import { readFile } from "./read";
import { READ_CHUNK_BYTES, READ_PROTOCOL } from "./read-flow";

function receiver() {
  const emitter = new EventEmitter();
  let sub: EventIterator<any>;
  const client = {
    requestMany: jest.fn(async (_subject, _data, opts) => {
      sub = new EventIterator(emitter, "data", {
        map: ([value]) => value,
        maxQueue: opts.maxQueue,
        maxQueueBytes: opts.maxQueueBytes,
        sizeOf: (message: any) => message.data?.length ?? 0,
        overflow: "throw",
      });
      return sub;
    }),
  };
  const reader = readFile({
    client: client as any,
    project_id: "00000000-1000-4000-8000-000000000098",
    path: "/tmp/example",
  });
  const send = (headers, data: any = null) =>
    emitter.emit("data", { headers, data });
  return { reader, send, subscription: () => sub!, emitter };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("read protocol compatibility and receive bounds", () => {
  it("accepts an old producer only within the bounded receive window", async () => {
    const { reader, send } = receiver();
    const first = reader.next();
    await tick();
    send({ seq: 1 }, Buffer.from("legacy"));
    expect((await first).value.toString()).toBe("legacy");
    send({ done: true });
    expect((await reader.next()).done).toBe(true);
  });

  it("fails closed instead of accumulating an old producer's whole file", async () => {
    const { reader, send, subscription, emitter } = receiver();
    const first = reader.next();
    await tick();
    send({ seq: 1 }, Buffer.alloc(READ_CHUNK_BYTES));
    await first;
    for (let seq = 2; seq <= 10; seq++)
      send({ seq }, Buffer.alloc(READ_CHUNK_BYTES));
    expect(subscription().queueBytes()).toBe(0);
    expect(subscription().ended).toBe(true);
    expect(emitter.listenerCount("data")).toBe(0);
    await expect(reader.next()).rejects.toThrow("maxQueue overflow");
  });

  it.each([{ seq: 2 }, { seq: 0 }, { seq: 1.5 }, {}])(
    "rejects malformed or missing sequence %j",
    async (headers) => {
      const { reader, send } = receiver();
      const next = reader.next();
      const rejected = expect(next).rejects.toThrow("lost data");
      await tick();
      send(headers, Buffer.from("data"));
      await rejected;
    },
  );

  it("does not turn subscription expiry before any data into successful EOF", async () => {
    const { reader, subscription } = receiver();
    const next = reader.next();
    const rejected = expect(next).rejects.toThrow("truncated");
    await tick();
    subscription().end();
    await rejected;
  });

  it("advertises flow control without acknowledging an unsupported handshake", async () => {
    const { reader, send } = receiver();
    const next = reader.next();
    const rejected = expect(next).rejects.toThrow();
    await tick();
    send({ fileReadProtocol: READ_PROTOCOL });
    await rejected;
  });
});
