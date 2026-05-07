/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { useHostRootfsImages } from "./use-host-rootfs-images";

type HostRootfsImage = { image: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function TestComponent({
  hub,
  hostId,
  onValue,
}: {
  hub: {
    hosts: {
      listHostRootfsImages: jest.Mock;
      pullHostRootfsImage: jest.Mock;
      deleteHostRootfsImage: jest.Mock;
      gcDeletedHostRootfsImages: jest.Mock;
    };
  };
  hostId?: string;
  onValue?: (value: ReturnType<typeof useHostRootfsImages>) => void;
}) {
  const value = useHostRootfsImages(hub, { hostId, enabled: true });
  onValue?.(value);
  return null;
}

describe("useHostRootfsImages", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("ignores stale refresh responses after the selected host changes", async () => {
    const host1List = deferred<HostRootfsImage[]>();
    const hub = {
      hosts: {
        listHostRootfsImages: jest
          .fn()
          .mockReturnValueOnce(host1List.promise)
          .mockResolvedValueOnce([{ image: "host-2.img" }]),
        pullHostRootfsImage: jest.fn(),
        deleteHostRootfsImage: jest.fn(),
        gcDeletedHostRootfsImages: jest.fn(),
      },
    };
    let latest: ReturnType<typeof useHostRootfsImages> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        hostId="host-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    rerender(
      <TestComponent
        hub={hub}
        hostId="host-2"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.entries).toEqual([{ image: "host-2.img" }]);
    expect(latest?.loading).toBe(false);

    host1List.resolve([{ image: "host-1.img" }]);
    await flush();

    expect(latest?.entries).toEqual([{ image: "host-2.img" }]);
    expect(latest?.error).toBeUndefined();
  });

  it("ignores stale action errors after switching hosts", async () => {
    const deleteRequest = deferred<{ removed: boolean }>();
    const hub = {
      hosts: {
        listHostRootfsImages: jest
          .fn()
          .mockResolvedValueOnce([{ image: "host-1.img" }])
          .mockResolvedValueOnce([{ image: "host-2.img" }]),
        pullHostRootfsImage: jest.fn(),
        deleteHostRootfsImage: jest.fn().mockReturnValue(deleteRequest.promise),
        gcDeletedHostRootfsImages: jest.fn(),
      },
    };
    let latest: ReturnType<typeof useHostRootfsImages> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        hostId="host-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    await act(async () => {
      void latest?.remove("host-1.img");
      await Promise.resolve();
    });

    expect(latest?.actionKey).toBe("delete:host-1.img");

    rerender(
      <TestComponent
        hub={hub}
        hostId="host-2"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.entries).toEqual([{ image: "host-2.img" }]);
    expect(latest?.actionKey).toBeUndefined();

    deleteRequest.reject(new Error("delete failed"));
    await flush();

    expect(latest?.entries).toEqual([{ image: "host-2.img" }]);
    expect(latest?.actionKey).toBeUndefined();
    expect(latest?.error).toBeUndefined();
  });
});
