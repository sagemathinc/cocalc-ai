import { act, renderHook } from "@testing-library/react";
import { useSettledTrue } from "../chat-log";

describe("useSettledTrue (newest-messages button)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("turns on only after the value stays true, and off at once", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledTrue(value, 200),
      { initialProps: { value: false } },
    );
    expect(result.current).toBe(false);

    rerender({ value: true });
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);

    rerender({ value: false });
    expect(result.current).toBe(false);
  });

  it("never shows while the value flickers faster than the delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledTrue(value, 200),
      { initialProps: { value: false } },
    );
    for (let i = 0; i < 20; i++) {
      rerender({ value: i % 2 === 0 });
      act(() => {
        jest.advanceTimersByTime(50);
      });
      expect(result.current).toBe(false);
    }
  });
});
