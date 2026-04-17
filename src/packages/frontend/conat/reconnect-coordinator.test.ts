/** @jest-environment jsdom */

import { ReconnectCoordinator } from "./reconnect-coordinator";

describe("ReconnectCoordinator", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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
});
