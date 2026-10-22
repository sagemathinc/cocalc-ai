import { EventEmitter } from "node:events";

const SIGNALS = ["exit", "SIGTERM", "SIGQUIT"] as const;

function removeAddedListeners(
  before: Record<(typeof SIGNALS)[number], Function[]>,
) {
  for (const signal of SIGNALS) {
    for (const listener of process.rawListeners(signal)) {
      if (!before[signal].includes(listener)) {
        process.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }
}

describe("persist child process lifecycle", () => {
  it("does not change process signal handling when merely imported", () => {
    const before = Object.fromEntries(
      SIGNALS.map((signal) => [signal, process.rawListeners(signal)]),
    ) as Record<(typeof SIGNALS)[number], Function[]>;

    try {
      jest.isolateModules(() => {
        require("./start-server");
      });
      for (const signal of SIGNALS) {
        expect(process.rawListeners(signal)).toEqual(before[signal]);
      }
    } finally {
      removeAddedListeners(before);
    }
  });

  it("installs forwarding handlers only after forking a child", () => {
    const child = new EventEmitter() as EventEmitter & {
      send: jest.Mock;
      kill: jest.Mock;
    };
    child.send = jest.fn();
    child.kill = jest.fn();
    const fork = jest.fn(() => child);
    jest.doMock("node:child_process", () => ({ fork }));

    const before = Object.fromEntries(
      SIGNALS.map((signal) => [signal, process.rawListeners(signal)]),
    ) as Record<(typeof SIGNALS)[number], Function[]>;

    try {
      jest.isolateModules(() => {
        const { createForkedPersistServer } = require("./start-server");
        createForkedPersistServer("persist-1");
      });
      expect(fork).toHaveBeenCalledTimes(1);
      for (const signal of SIGNALS) {
        expect(process.rawListeners(signal)).toHaveLength(
          before[signal].length + 1,
        );
      }
    } finally {
      removeAddedListeners(before);
      jest.dontMock("node:child_process");
    }
  });

  it("exits on SIGTERM once its children have exited", async () => {
    const child = new EventEmitter() as EventEmitter & {
      send: jest.Mock;
      kill: jest.Mock;
      exitCode: number | null;
      signalCode: string | null;
    };
    child.send = jest.fn();
    child.kill = jest.fn();
    child.exitCode = null;
    child.signalCode = null;
    const fork = jest.fn(() => child);
    jest.doMock("node:child_process", () => ({ fork }));
    const kill = jest.spyOn(process, "kill").mockImplementation(() => true);

    const before = Object.fromEntries(
      SIGNALS.map((signal) => [signal, process.rawListeners(signal)]),
    ) as Record<(typeof SIGNALS)[number], Function[]>;

    try {
      jest.isolateModules(() => {
        const { createForkedPersistServer } = require("./start-server");
        createForkedPersistServer("persist-1");
      });
      const handler = process
        .rawListeners("SIGTERM")
        .find((listener) => !before.SIGTERM.includes(listener)) as any;
      const done = handler();
      // Forwarded to the child; the hub waits for it before exiting.
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(kill).not.toHaveBeenCalled();
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await done;
      // With a handler installed Node no longer exits on the signal itself,
      // so the hub raises it again.
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      kill.mockRestore();
      removeAddedListeners(before);
      jest.dontMock("node:child_process");
    }
  });

  function forkOneChild({ exited = false } = {}) {
    const child = new EventEmitter() as EventEmitter & {
      send: jest.Mock;
      kill: jest.Mock;
      exitCode: number | null;
      signalCode: string | null;
    };
    child.send = jest.fn();
    child.kill = jest.fn();
    child.exitCode = exited ? 0 : null;
    child.signalCode = null;
    jest.doMock("node:child_process", () => ({ fork: jest.fn(() => child) }));
    const before = Object.fromEntries(
      SIGNALS.map((signal) => [signal, process.rawListeners(signal)]),
    ) as Record<(typeof SIGNALS)[number], Function[]>;
    jest.isolateModules(() => {
      require("./start-server").createForkedPersistServer("persist-1");
    });
    const handler = process
      .rawListeners("SIGTERM")
      .find((listener) => !before.SIGTERM.includes(listener)) as any;
    return {
      child,
      handler,
      cleanup: () => {
        removeAddedListeners(before);
        jest.dontMock("node:child_process");
      },
    };
  }

  it("exits at once on SIGTERM when its children have already exited", async () => {
    jest.useFakeTimers();
    const kill = jest.spyOn(process, "kill").mockImplementation(() => true);
    const { handler, cleanup } = forkOneChild({ exited: true });
    try {
      await handler();
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      // The grace timer is cleared: it must not keep the process alive.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      kill.mockRestore();
      cleanup();
      jest.useRealTimers();
    }
  });

  it("exits on SIGTERM after the grace period when a child never exits", async () => {
    jest.useFakeTimers();
    const kill = jest.spyOn(process, "kill").mockImplementation(() => true);
    const { handler, cleanup } = forkOneChild();
    try {
      const done = handler();
      await jest.advanceTimersByTimeAsync(9_999);
      expect(kill).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await done;
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      // Nothing left behind to keep the process alive.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      kill.mockRestore();
      cleanup();
      jest.useRealTimers();
    }
  });
});
