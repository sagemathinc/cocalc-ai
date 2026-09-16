import { EventEmitter } from "node:events";
import { MessageData } from "./client";
import { DataEncoding } from "./codec";
import { EventIterator } from "@cocalc/util/event-iterator";

it.each([
  new ArrayBuffer(16),
  new Uint8Array(16),
  new DataView(new ArrayBuffer(16)),
  Buffer.alloc(16),
])("bounds browser and Node message payload bytes", async (raw) => {
  const emitter = new EventEmitter();
  const iterator = new EventIterator<MessageData>(emitter, "message", {
    map: ([message]) => message,
    maxQueueBytes: 8,
    sizeOf: (message) => message.length,
    overflow: "throw",
  });
  const message = new MessageData({
    encoding: DataEncoding.MsgPack,
    raw,
    headers: undefined,
  });
  expect(message.length).toBe(16);
  emitter.emit("message", message);
  expect(iterator.ended).toBe(true);
  expect(iterator.queueBytes()).toBe(0);
  await expect(iterator.next()).rejects.toThrow("maxQueue overflow");
});

it.each([{}, { length: NaN }, { byteLength: -1 }, { length: Infinity }])(
  "rejects malformed byte lengths",
  (raw) => {
    const message = new MessageData({
      encoding: DataEncoding.MsgPack,
      raw,
      headers: undefined,
    });
    expect(() => message.length).toThrow("invalid message byte length");
  },
);
