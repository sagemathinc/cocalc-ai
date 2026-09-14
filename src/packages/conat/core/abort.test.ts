import { getEventListeners } from "node:events";
import { abortable } from "./abort";

describe("abortable shared waits", () => {
  it("removes its listener on success or failure", async () => {
    const controller = new AbortController();
    expect(await abortable(Promise.resolve(123), controller.signal)).toBe(123);
    await expect(
      abortable(Promise.reject(Error("failed")), controller.signal),
    ).rejects.toThrow("failed");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("handles a losing rejection after cancellation", async () => {
    const controller = new AbortController();
    let fail!: (reason: Error) => void;
    const operation = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const waiting = abortable(operation, controller.signal);
    controller.abort(Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    fail(Error("late failure"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
