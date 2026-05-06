/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { useHostRuntimeLog } from "./use-host-runtime-log";

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
  enabled = true,
  onValue,
}: {
  hub: {
    hosts: {
      getHostRuntimeLog: jest.Mock;
    };
  };
  hostId?: string;
  enabled?: boolean;
  onValue?: (value: ReturnType<typeof useHostRuntimeLog>) => void;
}) {
  const value = useHostRuntimeLog(hub, { hostId, enabled });
  onValue?.(value);
  return null;
}

describe("useHostRuntimeLog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale log responses after the viewer is disabled", async () => {
    const request = deferred<{ lines: string[] }>();
    const hub = {
      hosts: {
        getHostRuntimeLog: jest.fn().mockReturnValue(request.promise),
      },
    };
    let latest: ReturnType<typeof useHostRuntimeLog> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        hostId="host-1"
        enabled
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    await act(async () => {
      void latest?.load({ lines: 50 });
      await Promise.resolve();
    });

    expect(latest?.loading).toBe(true);

    rerender(
      <TestComponent
        hub={hub}
        hostId="host-1"
        enabled={false}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.loading).toBe(false);
    expect(latest?.log).toBeUndefined();
    expect(latest?.error).toBeUndefined();

    request.resolve({ lines: ["stale log"] });
    await flush();

    expect(latest?.loading).toBe(false);
    expect(latest?.log).toBeUndefined();
    expect(latest?.error).toBeUndefined();
  });
});
