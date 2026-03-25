import { createAdaptiveAsyncBatcher } from "./adaptive-batching";

describe("adaptive async batcher", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("flushes buffered items after the minimum delay", async () => {
    const published: string[][] = [];
    const batcher = createAdaptiveAsyncBatcher<string>({
      minDelayMs: 100,
      maxDelayMs: 1000,
      flush: async (items) => {
        published.push(items);
      },
    });

    batcher.add("a");
    batcher.add("b");

    await jest.advanceTimersByTimeAsync(99);
    expect(published).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    expect(published).toEqual([["a", "b"]]);
    expect(batcher.snapshot().nextDelayMs).toBe(100);
  });

  it("flushes immediately when requested", async () => {
    const published: string[][] = [];
    const batcher = createAdaptiveAsyncBatcher<string>({
      minDelayMs: 100,
      maxDelayMs: 1000,
      flush: async (items) => {
        published.push(items);
      },
    });

    batcher.add("a");
    batcher.add("b", { flush: true });
    await batcher.flush();

    expect(published).toEqual([["a", "b"]]);
  });

  it("backs off after a slow flush and returns to the floor after a fast one", async () => {
    const durations = [250, 10];
    const batcher = createAdaptiveAsyncBatcher<string>({
      minDelayMs: 100,
      maxDelayMs: 1000,
      ewmaAlpha: 1,
      latencyMultiplier: 2,
      flush: async () => {
        const duration = durations.shift() ?? 10;
        await new Promise((resolve) => setTimeout(resolve, duration));
      },
    });

    batcher.add("slow");
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(250);
    await batcher.flush();
    expect(batcher.snapshot().nextDelayMs).toBe(500);

    batcher.add("fast");
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(10);
    await batcher.flush();
    expect(batcher.snapshot().nextDelayMs).toBe(100);
  });

  it("flushes once the max item count is reached", async () => {
    const published: number[][] = [];
    const batcher = createAdaptiveAsyncBatcher<number>({
      minDelayMs: 100,
      maxDelayMs: 1000,
      maxItems: 3,
      flush: async (items) => {
        published.push(items);
      },
    });

    batcher.add(1);
    batcher.add(2);
    batcher.add(3);
    await batcher.flush();

    expect(published).toEqual([[1, 2, 3]]);
  });
});
