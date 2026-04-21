const mockStateSlots: any[] = [];
const mockEffectSlots: {
  deps?: unknown[];
  cleanup?: () => void;
}[] = [];
let mockHookIndex = 0;

function mockDepsChanged(prev: unknown[] | undefined, next: unknown[]) {
  return (
    prev == null ||
    prev.length !== next.length ||
    prev.some((value, i) => value !== next[i])
  );
}

function mockResetHookCursor() {
  mockHookIndex = 0;
}

function mockResetHooks() {
  for (const slot of mockEffectSlots) {
    slot?.cleanup?.();
  }
  mockStateSlots.length = 0;
  mockEffectSlots.length = 0;
  mockHookIndex = 0;
}

jest.mock("react", () => ({
  useEffect: (effect: () => void | (() => void), inputs: unknown[] = []) => {
    const i = mockHookIndex++;
    const slot = (mockEffectSlots[i] ??= {});
    if (!mockDepsChanged(slot.deps, inputs)) {
      return;
    }
    slot.cleanup?.();
    slot.deps = inputs;
    slot.cleanup = effect() ?? undefined;
  },
  useRef: (initial: unknown) => {
    const i = mockHookIndex++;
    if (mockStateSlots[i] == null) {
      mockStateSlots[i] = { current: initial };
    }
    return mockStateSlots[i];
  },
  useState: (initial: unknown) => {
    const i = mockHookIndex++;
    if (!(i in mockStateSlots)) {
      mockStateSlots[i] = typeof initial === "function" ? initial() : initial;
    }
    const setState = (next: unknown) => {
      mockStateSlots[i] =
        typeof next === "function" ? next(mockStateSlots[i]) : next;
    };
    return [mockStateSlots[i], setState];
  },
}));

jest.mock("@cocalc/util/async-utils", () => ({
  sleep: jest.fn(() => Promise.resolve()),
  withTimeout: jest.fn(async (promise: Promise<any>) => await promise),
}));

jest.mock("use-async-effect", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: function useAsyncEffectMock(
      effect: (isMounted: () => boolean) => Promise<void>,
      destroy: () => void,
      inputs: unknown[],
    ) {
      React.useEffect(() => {
        let mounted = true;
        void effect(() => mounted);
        return () => {
          mounted = false;
          destroy?.();
        };
      }, inputs);
    },
  };
});

import { sleep, withTimeout } from "@cocalc/util/async-utils";
import useFiles from "./use-files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushEffects() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function useFilesForTest({ fs, path }: { fs: any; path: string }) {
  mockResetHookCursor();
  return useFiles({ fs, path, throttleUpdate: 1 });
}

describe("useFiles", () => {
  beforeEach(() => {
    mockResetHooks();
    jest.clearAllMocks();
  });

  afterEach(() => {
    mockResetHooks();
  });

  it("closes a stale listing that resolves after the path changes", async () => {
    const firstSnapshot = deferred<any>();
    const secondSnapshot = deferred<any>();
    const first = deferred<any>();
    const second = deferred<any>();
    const firstListing = {
      files: { "a.txt": { mtime: 0, isDir: false, size: 1 } },
      on: jest.fn(),
      close: jest.fn(),
    };
    const secondListing = {
      files: { "b.txt": { mtime: 0, isDir: false, size: 1 } },
      on: jest.fn(),
      close: jest.fn(),
    };
    const fs = {
      getListing: jest.fn((path: string) =>
        path === "/alpha" ? firstSnapshot.promise : secondSnapshot.promise,
      ),
      listing: jest.fn((path: string) =>
        path === "/alpha" ? first.promise : second.promise,
      ),
    };

    useFilesForTest({ fs, path: "/alpha" });
    expect(fs.getListing.mock.calls.some(([path]) => path === "/alpha")).toBe(
      true,
    );
    firstSnapshot.resolve({
      files: { "a.txt": { mtime: 0, isDir: false, size: 1 } },
    });
    await flushEffects();

    expect(fs.listing.mock.calls.some(([path]) => path === "/alpha")).toBe(
      true,
    );

    useFilesForTest({ fs, path: "/beta" });
    secondSnapshot.resolve({
      files: { "b.txt": { mtime: 0, isDir: false, size: 1 } },
    });
    await flushEffects();

    expect(fs.getListing.mock.calls.some(([path]) => path === "/beta")).toBe(
      true,
    );
    expect(fs.listing.mock.calls.some(([path]) => path === "/beta")).toBe(true);

    second.resolve(secondListing);
    await flushEffects();

    expect(secondListing.on).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );

    first.resolve(firstListing);
    await flushEffects();

    expect(firstListing.close).toHaveBeenCalled();
    expect(secondListing.close).not.toHaveBeenCalled();
  });

  it("retries the initial snapshot load after a timeout", async () => {
    const listing = {
      files: {},
      on: jest.fn(),
      close: jest.fn(),
    };
    const timeoutErr = new Error("timeout");
    (withTimeout as jest.Mock)
      .mockRejectedValueOnce(timeoutErr)
      .mockImplementation(async (promise: Promise<any>) => await promise);

    const fs = {
      getListing: jest.fn().mockResolvedValue({ files: {} }),
      listing: jest.fn().mockResolvedValue(listing),
    };

    useFilesForTest({ fs, path: "/snapshots" });
    await flushEffects();

    expect(fs.getListing.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sleep).toHaveBeenCalled();
    expect(fs.listing).toHaveBeenCalledWith("/snapshots");
  });
});
