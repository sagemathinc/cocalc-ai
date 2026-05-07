/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { useHosts } from "./use-hosts";

type Host = { name: string };

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
  adminView = false,
  showAll = false,
  onError,
  onValue,
}: {
  hub: {
    hosts: {
      listHosts: jest.Mock;
    };
    purchases: {
      getMembership: jest.Mock;
    };
  };
  adminView?: boolean;
  showAll?: boolean;
  onError?: (err: unknown) => void;
  onValue?: (value: ReturnType<typeof useHosts>) => void;
}) {
  const value = useHosts(hub, {
    adminView,
    showAll,
    onError,
    pollMs: 60_000,
  });
  onValue?.(value);
  return null;
}

describe("useHosts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale host list responses after the view options change", async () => {
    const request1 = deferred<Host[]>();
    const request2 = deferred<Host[]>();
    const hub = {
      hosts: {
        listHosts: jest
          .fn()
          .mockReturnValueOnce(request1.promise)
          .mockReturnValueOnce(request2.promise),
      },
      purchases: {
        getMembership: jest.fn().mockResolvedValue({
          entitlements: {
            features: {
              create_hosts: true,
            },
          },
        }),
      },
    };
    let latest: ReturnType<typeof useHosts> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        adminView={false}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    rerender(
      <TestComponent
        hub={hub}
        adminView
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    request2.resolve([{ name: "current-host" }]);
    await flush();
    expect(latest?.hosts).toEqual([{ name: "current-host" }]);

    request1.resolve([{ name: "stale-host" }]);
    await flush();

    expect(latest?.hosts).toEqual([{ name: "current-host" }]);
    expect(hub.hosts.listHosts.mock.calls).toEqual([
      [
        {
          admin_view: undefined,
          include_deleted: undefined,
          show_all: undefined,
        },
      ],
      [{ admin_view: true, include_deleted: undefined, show_all: undefined }],
    ]);
  });

  it("ignores stale host list errors after a newer refresh succeeds", async () => {
    const request1 = deferred<Host[]>();
    const request2 = deferred<Host[]>();
    const onError = jest.fn();
    const hub = {
      hosts: {
        listHosts: jest
          .fn()
          .mockReturnValueOnce(request1.promise)
          .mockReturnValueOnce(request2.promise),
      },
      purchases: {
        getMembership: jest.fn().mockResolvedValue({
          entitlements: {
            features: {
              create_hosts: true,
            },
          },
        }),
      },
    };
    let latest: ReturnType<typeof useHosts> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        showAll={false}
        onError={onError}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    rerender(
      <TestComponent
        hub={hub}
        showAll
        onError={onError}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    request2.resolve([{ name: "fresh-host" }]);
    await flush();

    request1.reject(new Error("stale failure"));
    await flush();

    expect(latest?.hosts).toEqual([{ name: "fresh-host" }]);
    expect(latest?.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});
