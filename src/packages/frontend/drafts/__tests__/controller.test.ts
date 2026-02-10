/** @jest-environment jsdom */

import { DraftController } from "../controller";
import type { DraftStorageAdapter } from "../types";

function makeAdapter(overrides?: Partial<DraftStorageAdapter>): DraftStorageAdapter {
  return {
    load: async () => undefined,
    save: async () => {},
    clear: async () => {},
    ...overrides,
  };
}

describe("DraftController", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("prefers newer remote draft on init", async () => {
    const controller = new DraftController({
      key: "k",
      adapter: makeAdapter({
        load: async () => ({
          text: "remote",
          updatedAt: 20,
          composing: true,
        }),
      }),
      initialText: "local",
      initialUpdatedAt: 10,
    });

    await controller.init();
    expect(controller.getSnapshot()).toEqual({
      text: "remote",
      updatedAt: 20,
      composing: true,
    });
  });

  it("saves local draft on init when local state is newer", async () => {
    const save = jest.fn(async () => {});
    const controller = new DraftController({
      key: "k",
      adapter: makeAdapter({
        load: async () => ({
          text: "remote",
          updatedAt: 5,
          composing: false,
        }),
        save,
      }),
      initialText: "local",
      initialUpdatedAt: 10,
      debounceMs: 50,
      ttlMs: 5000,
    });

    await controller.init();
    jest.advanceTimersByTime(50);
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      "k",
      expect.objectContaining({ text: "local", updatedAt: 10 }),
      { ttlMs: 5000 },
    );
  });

  it("debounces repeated edits and saves latest text once", async () => {
    const save = jest.fn(async () => {});
    const controller = new DraftController({
      key: "k",
      adapter: makeAdapter({ save }),
      debounceMs: 100,
      now: (() => {
        let t = 100;
        return () => ++t;
      })(),
    });

    controller.setText("a");
    controller.setText("ab");
    controller.setText("abc");
    expect(save).toHaveBeenCalledTimes(0);

    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    const firstCall = (save as jest.Mock).mock.calls[0] as any[];
    expect(firstCall[1]).toEqual(
      expect.objectContaining({ text: "abc" }),
    );
  });

  it("clear removes persisted draft and resets local state", async () => {
    const clear = jest.fn(async () => {});
    const controller = new DraftController({
      key: "k",
      adapter: makeAdapter({ clear }),
      now: () => 1234,
    });

    controller.setText("to delete", { persist: false });
    await controller.clear();

    expect(clear).toHaveBeenCalledWith("k");
    expect(controller.getSnapshot()).toEqual({
      text: "",
      composing: false,
      updatedAt: 1234,
    });
  });
});
