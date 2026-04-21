/** @jest-environment jsdom */

import { ReconnectCoordinator } from "./reconnect-coordinator";

describe("ReconnectCoordinator", () => {
  let hasFocusSpy: jest.SpyInstance<boolean, []>;

  beforeEach(() => {
    jest.useFakeTimers();
    hasFocusSpy = jest.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    hasFocusSpy.mockRestore();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("reconnects visible tabs on the normal backoff schedule", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const connect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect,
      isConnected: () => false,
    });

    try {
      coordinator.requestReconnect({ reason: "disconnect" });
      await jest.advanceTimersByTimeAsync(999);
      expect(connect).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("delays hidden tabs and expedites them when they become visible", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const connect = jest.fn(async () => {});
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect,
      isConnected: () => false,
    });

    try {
      coordinator.requestReconnect({ reason: "disconnect" });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(0);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));

      await jest.advanceTimersByTimeAsync(999);
      expect(connect).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("treats visible but unfocused tabs as background until focus returns", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const connect = jest.fn(async () => {});
    hasFocusSpy.mockReturnValue(false);
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect,
      isConnected: () => false,
    });

    try {
      coordinator.requestReconnect({ reason: "disconnect" });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(0);

      hasFocusSpy.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));

      await jest.advanceTimersByTimeAsync(999);
      expect(connect).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("queues resource reconnects until the transport is connected", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    let connected = false;
    const connect = jest.fn(async () => {});
    const resourceReconnect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect,
      isConnected: () => connected,
    });
    const resource = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: resourceReconnect,
    });

    try {
      resource.requestReconnect({ reason: "socket_closed" });
      await jest.runOnlyPendingTimersAsync();
      expect(resourceReconnect).toHaveBeenCalledTimes(0);

      connected = true;
      coordinator.noteConnected();
      await jest.advanceTimersByTimeAsync(999);
      expect(resourceReconnect).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(resourceReconnect).toHaveBeenCalledTimes(1);
    } finally {
      resource.close();
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("reconnects foreground resources before background ones", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const order: string[] = [];
    let connected = true;
    const connect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect,
      isConnected: () => connected,
    });
    const foreground = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: async () => {
        order.push("foreground");
      },
    });
    const background = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "background",
      reconnect: async () => {
        order.push("background");
      },
    });

    try {
      background.requestReconnect({ reason: "socket_closed" });
      foreground.requestReconnect({ reason: "socket_closed" });

      await jest.advanceTimersByTimeAsync(999);
      expect(order).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      expect(order).toEqual(["foreground"]);

      await jest.advanceTimersByTimeAsync(3_999);
      expect(order).toEqual(["foreground"]);
      await jest.advanceTimersByTimeAsync(1);
      expect(order).toEqual(["foreground", "background"]);

      connected = false;
    } finally {
      foreground.close();
      background.close();
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("reconnects multiple foreground resources in parallel", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const firstReconnect = jest.fn(
      () =>
        new Promise<void>(() => {
          // Keep this reconnect in flight so the test can observe concurrency.
        }),
    );
    const secondReconnect = jest.fn(
      () =>
        new Promise<void>(() => {
          // Keep this reconnect in flight so the test can observe concurrency.
        }),
    );
    const thirdReconnect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect: jest.fn(async () => {}),
      initialConcurrentResourceReconnects: 2,
      isConnected: () => true,
      maxConcurrentResourceReconnects: 2,
    });
    const first = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: firstReconnect,
    });
    const second = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: secondReconnect,
    });
    const third = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: thirdReconnect,
    });

    try {
      first.requestReconnect({ reason: "socket_closed" });
      second.requestReconnect({ reason: "socket_closed" });
      third.requestReconnect({ reason: "socket_closed" });

      await jest.advanceTimersByTimeAsync(999);
      expect(firstReconnect).toHaveBeenCalledTimes(0);
      expect(secondReconnect).toHaveBeenCalledTimes(0);
      expect(thirdReconnect).toHaveBeenCalledTimes(0);

      await jest.advanceTimersByTimeAsync(1);
      expect(firstReconnect).toHaveBeenCalledTimes(1);
      expect(secondReconnect).toHaveBeenCalledTimes(1);
      expect(thirdReconnect).toHaveBeenCalledTimes(0);
    } finally {
      first.close();
      second.close();
      third.close();
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("does not let a hung resource reconnect block the queue forever", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const hungReconnect = jest.fn(
      () =>
        new Promise<void>(() => {
          // Simulate a document reconnect promise waiting on an event that never fires.
        }),
    );
    const nextReconnect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect: jest.fn(async () => {}),
      initialConcurrentResourceReconnects: 1,
      isConnected: () => true,
      maxConcurrentResourceReconnects: 1,
      resourceReconnectTimeoutMs: 100,
    });
    const hung = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: hungReconnect,
    });
    const next = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect: nextReconnect,
    });

    try {
      hung.requestReconnect({ reason: "socket_closed" });
      next.requestReconnect({ reason: "socket_closed" });

      await jest.advanceTimersByTimeAsync(1_000);
      expect(hungReconnect).toHaveBeenCalledTimes(1);
      expect(nextReconnect).toHaveBeenCalledTimes(0);

      await jest.advanceTimersByTimeAsync(99);
      expect(nextReconnect).toHaveBeenCalledTimes(0);

      await jest.advanceTimersByTimeAsync(1);
      await jest.runOnlyPendingTimersAsync();
      expect(nextReconnect).toHaveBeenCalledTimes(1);
    } finally {
      hung.close();
      next.close();
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("caps resource priority when the tab itself is in the background", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const reconnect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect: jest.fn(async () => {}),
      isConnected: () => true,
    });
    const resource = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect,
    });

    try {
      resource.requestReconnect({ reason: "socket_closed" });
      await jest.advanceTimersByTimeAsync(4_999);
      expect(reconnect).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally {
      resource.close();
      coordinator.close();
      randomSpy.mockRestore();
    }
  });

  it("suppresses resource reconnects during soft standby until resume", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
    const connect = jest.fn(async () => {});
    const reconnect = jest.fn(async () => {});
    const coordinator = new ReconnectCoordinator({
      canReconnect: () => true,
      connect,
      isConnected: () => true,
    });
    const resource = coordinator.registerResource({
      isConnected: () => false,
      priority: () => "foreground",
      reconnect,
    });

    try {
      coordinator.softStandby();
      resource.requestReconnect({ reason: "socket_closed" });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(reconnect).toHaveBeenCalledTimes(0);

      coordinator.resume();
      await jest.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(0);
      expect(reconnect).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(0);
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally {
      resource.close();
      coordinator.close();
      randomSpy.mockRestore();
    }
  });
});
