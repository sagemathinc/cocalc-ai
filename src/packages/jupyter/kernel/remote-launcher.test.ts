import { EventEmitter } from "node:events";
import {
  isReflectLauncher,
  stopReflectLauncher,
  trackKernelShutdown,
  waitForKernelShutdown,
} from "./remote-launcher";

it("only selects explicitly marked Reflect kernels", () => {
  expect(isReflectLauncher(undefined)).toBe(false);
  expect(isReflectLauncher({ kernel_spec: {} } as any)).toBe(false);
  expect(
    isReflectLauncher({
      kernel_spec: { metadata: { reflect: { remote: true } } },
    } as any),
  ).toBe(true);
});

it("waits for a graceful launcher exit", async () => {
  const child = Object.assign(new EventEmitter(), {
    kill: jest.fn(),
    exitCode: null,
    signalCode: null,
  });
  const stopped = stopReflectLauncher(child as any);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("exit", 0);
  await stopped;
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.listenerCount("exit")).toBe(0);
});

it("bounds an unresponsive launcher shutdown", async () => {
  jest.useFakeTimers();
  try {
    const child = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      exitCode: null,
      signalCode: null,
    });
    const stopped = stopReflectLauncher(child as any, 10, 20);
    jest.advanceTimersByTime(10);
    await Promise.resolve();
    jest.advanceTimersByTime(20);
    await stopped;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  } finally {
    jest.useRealTimers();
  }
});

it("does not admit a replacement until shutdown finishes", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  trackKernelShutdown("remote.ipynb", pending);
  let admitted = false;
  const waiting = waitForKernelShutdown("remote.ipynb").then(() => {
    admitted = true;
  });
  await waitForKernelShutdown("independent.ipynb");
  expect(admitted).toBe(false);
  finish();
  await waiting;
  expect(admitted).toBe(true);
});
