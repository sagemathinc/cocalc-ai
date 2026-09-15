import { EventEmitter } from "node:events";
import { SubscriptionEmitter, encode, type Client } from "./client";
import { DataEncoding } from "./codec";

function fixture(maxMessageBytes = 10) {
  const conn = new EventEmitter();
  const client = { conn, recvStats: jest.fn() } as unknown as Client;
  const sub = new SubscriptionEmitter({
    client,
    subject: "bounded",
    closeWhenOffCalled: false,
    receiveLimits: {
      maxMessageBytes,
      maxInflightBytes: 20,
      maxInflightMessages: 2,
    },
  });
  const received: any[] = [];
  sub.on("message", (message) => received.push(message));
  const chunk = (id: string, seq: number, done: number, buffer: Buffer) =>
    conn.emit("bounded", {
      subject: "bounded",
      data: [id, seq, done, DataEncoding.MsgPack, buffer, {}],
    });
  return { sub, received, chunk };
}

test("oversized fragmented input is dropped before assembly; later messages still work", () => {
  const { sub, received, chunk } = fixture();
  try {
    chunk("large", 0, 0, Buffer.alloc(8));
    chunk("large", 1, 1, Buffer.alloc(8));
    expect(received).toHaveLength(0);
    chunk(
      "small",
      0,
      1,
      Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg: "ok" })),
    );
    expect(received).toHaveLength(1);
    expect(received[0].data).toBe("ok");
  } finally {
    sub.close(true);
  }
});

test("wrong sequence frees fragment accounting and cannot emit partial content", () => {
  const { sub, received, chunk } = fixture();
  const warning = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    chunk("a", 0, 0, Buffer.alloc(10));
    chunk("a", 2, 1, Buffer.alloc(1));
    chunk("b", 0, 1, Buffer.alloc(10));
    chunk("c", 0, 1, Buffer.alloc(10));
    expect(received).toHaveLength(2);
  } finally {
    sub.close(true);
    warning.mockRestore();
  }
});

test("abandoned fragment expiry releases the aggregate budget", async () => {
  jest.useFakeTimers();
  const { sub, received, chunk } = fixture();
  const warning = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    chunk("a", 0, 0, Buffer.alloc(10));
    chunk("b", 0, 0, Buffer.alloc(10));
    chunk("c", 0, 1, Buffer.alloc(1));
    expect(received).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(120001);
    chunk("d", 0, 1, Buffer.alloc(10));
    expect(received).toHaveLength(1);
  } finally {
    sub.close(true);
    warning.mockRestore();
    jest.useRealTimers();
  }
});
