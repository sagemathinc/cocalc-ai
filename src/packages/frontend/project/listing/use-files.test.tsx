jest.mock("@cocalc/util/async-utils", () => ({
  sleep: jest.fn(() => Promise.resolve()),
  withTimeout: jest.fn(async (promise: Promise<any>) => await promise),
}));

import { act, render, waitFor } from "@testing-library/react";
import { sleep, withTimeout } from "@cocalc/util/async-utils";
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
      getListing: jest
        .fn()
        .mockResolvedValue({ files: { "a.txt": { isDir: false, size: 1 } } }),
      listing: jest
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };

    const { rerender } = render(<TestComponent fs={fs} path="/alpha" />);

    await waitFor(() => {
      expect(fs.listing).toHaveBeenCalledTimes(1);
    });

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

    render(<TestComponent fs={fs} path="/snapshots" />);

    await waitFor(() => {
      expect(fs.getListing).toHaveBeenCalledTimes(2);
    });
    expect(sleep).toHaveBeenCalled();
    await waitFor(() => {
      expect(fs.listing).toHaveBeenCalledWith("/snapshots");
    });
  });
});
