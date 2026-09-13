import { EventEmitter } from "node:events";
import { EventIterator } from "@cocalc/util/event-iterator";
import { ReadFlow, READ_HANDSHAKE_WAIT } from "./read-flow";

function channel() {
  const emitter = new EventEmitter();
  const controls = new EventIterator<any>(emitter, "control", {
    map: ([value]) => value,
  });
  const message = { respondMany: jest.fn(async () => controls) };
  const send = (data) => emitter.emit("control", { data });
  return { message, controls, send };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("file read flow control", () => {
  it("does not bank duplicate acknowledgements as future credit", async () => {
    const { message, send } = channel();
    const flow = new ReadFlow(10000);
    try {
      const start = flow.start(message as any);
      send({ seq: 0 });
      await start;
      send({ seq: 0 });
      send({ seq: 0 });
      await tick();
      let completed = false;
      const next = flow.wait(flow.expect(1)).then(() => {
        completed = true;
      });
      await tick();
      expect(completed).toBe(false);
      send({ seq: 1 });
      await next;
    } finally {
      flow.close();
    }
  });

  it("cancels while waiting for an acknowledgement", async () => {
    const { message, send, controls } = channel();
    const flow = new ReadFlow(10000);
    try {
      const start = flow.start(message as any);
      const rejected = expect(start).rejects.toThrow("cancelled");
      send({ cancel: true });
      await rejected;
    } finally {
      flow.close();
    }
    expect(controls.ended).toBe(true);
    expect(controls.queueSize()).toBe(0);
  });

  it("fails closed on a future acknowledgement", async () => {
    const { message, send } = channel();
    const flow = new ReadFlow(10000);
    try {
      const start = flow.start(message as any);
      const rejected = expect(start).rejects.toThrow("invalid");
      send({ seq: 5 });
      await rejected;
    } finally {
      flow.close();
    }
  });

  it("times out an absent consumer without leaving a rejected background task", async () => {
    const { message } = channel();
    const flow = new ReadFlow(20);
    try {
      await expect(flow.start(message as any)).rejects.toThrow("timed out");
    } finally {
      flow.close();
    }
  });

  it("refreshes idle time on consumption across many original deadlines", async () => {
    jest.useFakeTimers();
    const { message, send } = channel();
    const flow = new ReadFlow(80);
    try {
      const start = flow.start(message as any);
      send({ seq: 0 });
      await start;
      for (let seq = 1; seq <= 20; seq++) {
        const consumed = flow.wait(flow.expect(seq));
        await jest.advanceTimersByTimeAsync(50);
        send({ seq });
        await consumed;
        expect(flow.controller.signal.aborted).toBe(false);
      }
      const stalled = expect(flow.wait(flow.expect(21))).rejects.toThrow(
        "timed out",
      );
      await jest.advanceTimersByTimeAsync(81);
      await stalled;
    } finally {
      flow.close();
      jest.useRealTimers();
    }
  });

  it("does not let duplicate ACKs keep an idle stream alive", async () => {
    jest.useFakeTimers();
    const { message, send } = channel();
    const flow = new ReadFlow(80);
    try {
      const start = flow.start(message as any);
      send({ seq: 0 });
      await start;
      await jest.advanceTimersByTimeAsync(50);
      send({ seq: 0 });
      await jest.advanceTimersByTimeAsync(31);
      expect(flow.controller.signal.aborted).toBe(true);
    } finally {
      flow.close();
      jest.useRealTimers();
    }
  });

  it("caps pre-handshake admission even when the caller asks for an hour", async () => {
    jest.useFakeTimers();
    const { message } = channel();
    const flow = new ReadFlow(60 * 60 * 1000);
    try {
      const failed = expect(flow.start(message as any)).rejects.toThrow(
        "timed out",
      );
      await jest.advanceTimersByTimeAsync(READ_HANDSHAKE_WAIT + 1);
      await failed;
      expect(message.respondMany).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ timeout: READ_HANDSHAKE_WAIT }),
      );
    } finally {
      flow.close();
      jest.useRealTimers();
    }
  });
});
