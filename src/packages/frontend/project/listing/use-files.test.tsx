import { act, render, waitFor } from "@testing-library/react";
import useFiles from "./use-files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function TestComponent({ fs, path }: { fs: any; path: string }) {
  useFiles({ fs, path, throttleUpdate: 1 });
  return null;
}

describe("useFiles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("closes a stale listing that resolves after the path changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const firstListing = {
      files: { "a.txt": { isDir: false, size: 1 } },
      on: jest.fn(),
      close: jest.fn(),
    };
    const secondListing = {
      files: { "b.txt": { isDir: false, size: 1 } },
      on: jest.fn(),
      close: jest.fn(),
    };
    const fs = {
      listing: jest
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };

    const { rerender } = render(<TestComponent fs={fs} path="/alpha" />);

    rerender(<TestComponent fs={fs} path="/beta" />);

    await act(async () => {
      second.resolve(secondListing);
    });

    await waitFor(() => {
      expect(secondListing.on).toHaveBeenCalledWith(
        "change",
        expect.any(Function),
      );
    });

    await act(async () => {
      first.resolve(firstListing);
    });

    await waitFor(() => {
      expect(firstListing.close).toHaveBeenCalledTimes(1);
    });
    expect(secondListing.close).not.toHaveBeenCalled();
  });
});
