/** @jest-environment jsdom */

import {
  restoreSelectionWithRetry,
  retrySelectionApply,
} from "../selection-utils";

describe("markdown-input selection utilities", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("retries pending selection application until it succeeds", () => {
    const apply = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    retrySelectionApply({ apply, delayMs: 10 });

    expect(apply).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10);
    expect(apply).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(10);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("waits for readiness before attempting pending selection application", () => {
    const isReady = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const apply = jest.fn(() => true);

    retrySelectionApply({ apply, isReady, delayMs: 10 });

    expect(apply).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10);
    expect(apply).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("cancels pending selection retries cleanly", () => {
    const apply = jest.fn(() => false);

    const cancel = retrySelectionApply({ apply, delayMs: 10 });
    expect(apply).toHaveBeenCalledTimes(1);

    cancel();
    jest.advanceTimersByTime(50);

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("restores cached selection immediately when possible", () => {
    const setSelection = jest.fn();

    restoreSelectionWithRetry({
      getController: () => ({ setSelection, getSelection: () => null }),
      selection: "saved-selection",
      delayMs: 10,
    });

    expect(setSelection).toHaveBeenCalledWith("saved-selection");
  });

  it("retries cached selection restoration once after an initial failure", () => {
    const setSelection = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("not ready");
      })
      .mockImplementation(() => undefined);

    restoreSelectionWithRetry({
      getController: () => ({ setSelection, getSelection: () => null }),
      selection: "saved-selection",
      delayMs: 10,
    });

    expect(setSelection).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10);
    expect(setSelection).toHaveBeenCalledTimes(2);
  });

  it("retries cached selection restoration when the controller is not ready yet", () => {
    const setSelection = jest.fn();
    const isSelectionReady = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    restoreSelectionWithRetry({
      getController: () => ({
        setSelection,
        getSelection: () => null,
        isSelectionReady,
      }),
      selection: "saved-selection",
      delayMs: 10,
    });

    expect(setSelection).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10);
    expect(setSelection).toHaveBeenCalledWith("saved-selection");
  });
});
