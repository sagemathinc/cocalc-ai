import { EventEmitter } from "node:events";
import { EventIterator } from "@cocalc/util/event-iterator";
import { ReadFlow } from "./read-flow";

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
      const start = flow.start(message as any, 10000);
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
      const start = flow.start(message as any, 10000);
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
      const start = flow.start(message as any, 10000);
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
      await expect(flow.start(message as any, 10000)).rejects.toThrow(
        "timed out",
      );
    } finally {
      flow.close();
    }
  });
});
